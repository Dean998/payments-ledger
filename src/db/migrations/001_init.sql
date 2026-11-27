-- Payments ledger schema.
--
-- Invariants enforced by the database itself (defence in depth: the service
-- enforces them too, but a bug or a manual query must not be able to break them):
--   1. Every journal entry balances: sum(debits) = sum(credits) per currency.
--   2. Entry lines are append-only. Corrections are new reversing entries.
--   3. An entry's status only moves pending -> posted | archived.

CREATE TABLE accounts (
  id               uuid PRIMARY KEY,
  name             text        NOT NULL,
  -- 'credit' for liabilities such as customer wallets, 'debit' for assets.
  normal_balance   text        NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  currency         char(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  allow_negative   boolean     NOT NULL DEFAULT false,
  -- Set for platform-owned accounts, e.g. 'bank:USD'. NULL for customer accounts.
  system_key       text        UNIQUE,
  -- Materialised balance columns, maintained in the same transaction as the
  -- entry lines and re-verified by reconciliation. Pending columns hold only
  -- amounts that are not yet posted.
  posted_debits    bigint      NOT NULL DEFAULT 0 CHECK (posted_debits >= 0),
  posted_credits   bigint      NOT NULL DEFAULT 0 CHECK (posted_credits >= 0),
  pending_debits   bigint      NOT NULL DEFAULT 0 CHECK (pending_debits >= 0),
  pending_credits  bigint      NOT NULL DEFAULT 0 CHECK (pending_credits >= 0),
  metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transfers (
  id                       uuid PRIMARY KEY,
  type                     text        NOT NULL CHECK (type IN ('book', 'ach_push', 'ach_pull')),
  status                   text        NOT NULL CHECK (status IN ('posted', 'pending', 'submitted', 'settled', 'returned', 'canceled')),
  amount                   bigint      NOT NULL CHECK (amount > 0),
  currency                 char(3)     NOT NULL,
  source_account_id        uuid        REFERENCES accounts (id),
  destination_account_id   uuid        REFERENCES accounts (id),
  -- Routing number, last four digits and holder name only. The full account
  -- number lives in its own column so it is never serialised by accident; in
  -- production it would be a token from a vault.
  external_account         jsonb,
  external_account_number  text,
  description              text,
  entry_id                 uuid,
  reversal_entry_id        uuid,
  ach_batch_id             uuid,
  bank_reference           text        UNIQUE,
  return_code              text,
  return_reason            text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  submitted_at             timestamptz,
  settled_at               timestamptz,
  returned_at              timestamptz,
  canceled_at              timestamptz,
  CHECK (type <> 'book' OR (source_account_id IS NOT NULL AND destination_account_id IS NOT NULL)),
  CHECK (type <> 'ach_push' OR (source_account_id IS NOT NULL AND external_account IS NOT NULL)),
  CHECK (type <> 'ach_pull' OR (destination_account_id IS NOT NULL AND external_account IS NOT NULL))
);

CREATE INDEX transfers_ach_unbatched ON transfers (created_at)
  WHERE status = 'pending' AND ach_batch_id IS NULL AND type <> 'book';
CREATE INDEX transfers_in_flight ON transfers (status, settled_at)
  WHERE status IN ('submitted', 'settled');
CREATE INDEX transfers_source ON transfers (source_account_id);
CREATE INDEX transfers_destination ON transfers (destination_account_id);

CREATE TABLE journal_entries (
  id                 uuid PRIMARY KEY,
  status             text        NOT NULL CHECK (status IN ('pending', 'posted', 'archived')),
  description        text,
  transfer_id        uuid        REFERENCES transfers (id),
  reverses_entry_id  uuid        REFERENCES journal_entries (id),
  effective_at       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX journal_entries_transfer ON journal_entries (transfer_id);

-- Deferred: a transfer and its entry reference each other and are inserted in
-- the same transaction, so the check waits until COMMIT.
ALTER TABLE transfers
  ADD CONSTRAINT transfers_entry_fk FOREIGN KEY (entry_id) REFERENCES journal_entries (id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT transfers_reversal_entry_fk FOREIGN KEY (reversal_entry_id) REFERENCES journal_entries (id);

CREATE TABLE entry_lines (
  id          bigserial PRIMARY KEY,
  entry_id    uuid    NOT NULL REFERENCES journal_entries (id),
  account_id  uuid    NOT NULL REFERENCES accounts (id),
  direction   text    NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount      bigint  NOT NULL CHECK (amount > 0),
  currency    char(3) NOT NULL
);

CREATE INDEX entry_lines_account ON entry_lines (account_id, id);
CREATE INDEX entry_lines_entry ON entry_lines (entry_id);

-- Invariant 2: entry lines are append-only.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (attempted %)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER entry_lines_append_only
  BEFORE UPDATE OR DELETE ON entry_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Invariant 3: only status/updated_at may change, and only out of 'pending'.
CREATE FUNCTION guard_entry_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'journal_entries are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.transfer_id IS DISTINCT FROM OLD.transfer_id
     OR NEW.reverses_entry_id IS DISTINCT FROM OLD.reverses_entry_id
     OR NEW.effective_at <> OLD.effective_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'journal entry % is immutable except for status', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'journal entry % is % and cannot become %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER journal_entries_guard
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION guard_entry_update();

-- Invariant 1: checked at COMMIT (deferred), once all lines of the entry exist.
CREATE FUNCTION assert_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bad record;
BEGIN
  SELECT currency,
         SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) AS net
    INTO bad
    FROM entry_lines
   WHERE entry_id = NEW.entry_id
   GROUP BY currency
  HAVING SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) <> 0
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal entry % is unbalanced in % by %', NEW.entry_id, bad.currency, bad.net
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER entry_lines_balanced
  AFTER INSERT ON entry_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- Audit trail of every transfer state change.
CREATE TABLE transfer_events (
  id           bigserial PRIMARY KEY,
  transfer_id  uuid        NOT NULL REFERENCES transfers (id),
  from_status  text,
  to_status    text        NOT NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX transfer_events_transfer ON transfer_events (transfer_id, id);

-- ACH submissions are grouped into batches, like NACHA files. A batch is
-- recorded before it is sent so that a crash mid-upload can be retried safely.
CREATE TABLE ach_batches (
  id              uuid PRIMARY KEY,
  status          text        NOT NULL CHECK (status IN ('created', 'sent')),
  transfer_count  integer     NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);

ALTER TABLE transfers
  ADD CONSTRAINT transfers_ach_batch_fk FOREIGN KEY (ach_batch_id) REFERENCES ach_batches (id);

CREATE TABLE idempotency_keys (
  scope            text        NOT NULL,
  key              text        NOT NULL,
  request_hash     text        NOT NULL,
  response_status  integer,
  response_body    jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at);

-- Transactional outbox: written in the same transaction as the state change.
CREATE TABLE outbox_events (
  id            bigserial PRIMARY KEY,
  event_id      uuid        NOT NULL UNIQUE,
  type          text        NOT NULL,
  aggregate_id  uuid        NOT NULL,
  payload       jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);

CREATE INDEX outbox_unpublished ON outbox_events (id) WHERE published_at IS NULL;

CREATE TABLE webhook_endpoints (
  id           uuid PRIMARY KEY,
  url          text        NOT NULL,
  secret       text        NOT NULL,
  event_types  text[],
  enabled      boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id                bigserial PRIMARY KEY,
  endpoint_id       uuid        NOT NULL REFERENCES webhook_endpoints (id),
  event_id          uuid        NOT NULL REFERENCES outbox_events (event_id),
  status            text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead')),
  attempts          integer     NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  last_status_code  integer,
  last_error        text,
  delivered_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id)
);

CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

CREATE TABLE reconciliation_runs (
  id                uuid PRIMARY KEY,
  status            text        NOT NULL CHECK (status IN ('ok', 'mismatch')),
  accounts_checked  integer     NOT NULL,
  discrepancies     jsonb       NOT NULL,
  warnings          jsonb       NOT NULL,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz NOT NULL
);

CREATE INDEX reconciliation_runs_finished ON reconciliation_runs (finished_at DESC);
