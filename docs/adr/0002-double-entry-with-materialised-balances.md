# 0002. Double-entry ledger with materialised balances and database-enforced invariants

- Status: accepted
- Date: 2026-11-27

## Context

Balances must be correct, auditable and fast to read. Overdraft checks need a consistent view of
the balance at the moment of the decision.

## Decision

- Every movement is a journal entry of at least two lines that balance per currency.
- Lines are append-only; entries move only `pending → posted | archived`.
- Each account row stores four running totals (posted/pending × debit/credit), updated in the same
  transaction as the lines, under a row lock.
- The database enforces balance (deferred constraint trigger) and immutability (triggers), in
  addition to the service code.
- Reconciliation re-derives the totals from the lines continuously.

## Alternatives considered

- **Compute balances with `SUM()` on read**: no drift is possible, but reads become O(history)
  and overdraft checks need either a lock on all of an account's lines or `SERIALIZABLE`.
  Fine at small scale.
- **Single-entry (just a balance column + a log)**: simpler, but nothing forces the other side of
  a movement to exist, and errors are silent.
- **Event sourcing with snapshots**: equivalent in spirit; more machinery than this needs.

## Consequences

- O(1) balance reads and a single row to lock for overdraft checks.
- The materialised totals can drift if anything writes them outside the ledger code, so
  reconciliation exists and the tests prove it detects tampering.
- Hot accounts (one row touched by many transfers) become the throughput ceiling; see DESIGN §9.
