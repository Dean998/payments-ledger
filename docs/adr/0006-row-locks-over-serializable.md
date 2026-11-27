# 0006. Ordered row locks (FOR NO KEY UPDATE) instead of SERIALIZABLE

- Status: accepted
- Date: 2026-11-27

## Context

Concurrent transfers on the same account must not overdraw it or lose updates.

## Decision

READ COMMITTED transactions that lock every affected account first, sorted by id, with
`SELECT … FOR NO KEY UPDATE`, then read, decide and write.

## Alternatives considered

- **SERIALIZABLE everywhere**: correct, with less to think about, but under contention it aborts
  transactions at commit, and clients see retries or errors. On a hot wallet that degrades into a
  retry storm. Queuing on a lock degrades into latency instead.
- **Optimistic concurrency (a version column + retry)**: same failure mode under contention.
- **`FOR UPDATE`**: conflicts with the `FOR KEY SHARE` locks Postgres takes for foreign-key checks
  when inserting transfers and lines. The concurrency test deadlocked with it. `NO KEY UPDATE` is
  the correct strength because account keys never change.

## Consequences

- No deadlocks between ledger transactions (fixed lock order), and no overdrafts (decision made
  under the lock). Both are proven by concurrent integration tests.
- Throughput on a single account is bounded by lock hold time. Keeping transactions short
  (12 round trips) matters, and very hot accounts need sharding (DESIGN §9).
