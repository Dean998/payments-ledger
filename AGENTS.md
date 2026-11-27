# Agent guide: payments-ledger

Instructions for AI coding agents (Claude Code, Codex, Cursor…) and humans new to the repo.
`CLAUDE.md` imports this file.

## What this is

A double-entry ledger with ACH-style transfers. Money correctness is the product: a bug that loses
a cent is worse than a bug that returns a 500. Read `docs/DESIGN.md` before changing anything in
`src/ledger`, `src/transfers`, `src/ach` or `src/idempotency`.

## Commands

| Task                       | Command                                                     |
| -------------------------- | ----------------------------------------------------------- |
| Start Postgres only        | `docker compose up -d postgres` (host port **54320**)       |
| Whole stack + demo         | `docker compose up -d --build && npm run demo`              |
| All tests (needs Postgres) | `npm test`                                                  |
| Unit tests only (no DB)    | `npm run test:unit`                                         |
| Types / lint / format      | `npm run typecheck && npm run lint && npm run format:check` |
| Load test                  | `npm run load` (see `.claude/skills/load-test`)             |

Use Node 24 (`nvm use`). Run the full check before saying a change is done:
`npm run typecheck && npm run lint && npm test`.

## Invariants: never break these

1. **Amounts are integers in minor units.** `bigint` inside, `number` (safe integer) at the API. Never floats.
2. **Every journal entry balances per currency.** The service checks it, and a deferred trigger re-checks at COMMIT.
3. **`entry_lines` are append-only; posted entries are final.** Fix mistakes with a reversing entry (`reverseEntry`), never with UPDATE/DELETE. Triggers enforce this.
4. **Balances change only through `createEntry` / `transitionEntry`**, in the same transaction as the lines. Never `UPDATE accounts SET posted_*` by hand.
5. **Lock accounts with `lockAccounts`**: sorted ids, `FOR NO KEY UPDATE`. Not `FOR UPDATE`, which deadlocks against foreign-key checks (see the comment in `src/ledger/ledger.ts`).
6. **Side effects go through the outbox.** Never call an external service (bank, webhook) inside a DB transaction; enqueue an event with `enqueueEvent(tx, …)` and let a worker do it.
7. **Mutating money endpoints are idempotent.** Wrap them in `runIdempotent`. Business errors are stored and replayed; infrastructure errors roll back.
8. **Applied migrations are immutable.** Add `NNN_description.sql`; never edit an existing file (a hook blocks it).

## Layout

```
src/
  ledger/          accounts, balances (pure), createEntry/transitionEntry/reverseEntry
  transfers/       state machine (pure), transfer service, routes
  ach/             bank network interface, mock bank, batch submit + poll jobs
  idempotency/     runIdempotent: key row in the same tx as the effect
  outbox/          enqueueEvent + relay (fan-out to webhook deliveries)
  webhooks/        Standard Webhooks signing, backoff, dispatcher
  reconciliation/  re-derives balances from lines; cross-table invariants
  jobs/            worker loop scheduler
  app.ts           Fastify app (routes, error mapping, metrics)
  main.ts          API entry; worker.ts: background jobs entry
test/unit          pure logic, no DB
test/integration   real Postgres; concurrency, idempotency races, ACH lifecycle
docs/              DESIGN.md, adr/, failure-modes.md, benchmarks.md
```

## Conventions

- Expected failures are `DomainError` (from `src/errors.ts`) with a stable `code`. Anything else becomes a 500.
- Functions that run inside a transaction take `tx: Tx` as the first argument. Functions that manage their own transaction take `db: Db`.
- Background jobs are plain async functions that take `now` and their collaborators as arguments, so tests can control time. No `setTimeout` inside business logic.
- Integration tests that depend on time anchor "now" to the database clock (`max(submitted_at)`), not `Date.now()`; the DB runs in a VM whose clock drifts.
- Write tests at the level the bug would appear: a race condition needs a concurrent integration test, not a mock.
- Comments explain _why_ (a constraint, an incident, a trade-off), not _what_.
