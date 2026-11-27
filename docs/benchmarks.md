# Benchmarks

Measured with k6 (`load/transfers.k6.js`), `POST /transfers` with book transfers, 30 s per run,
constant arrival rate.

**Environment:** MacBook (Apple Silicon), Docker Desktop VM with 5 vCPUs shared by k6, one API
process, one worker, and Postgres 18. Other containers were running on the same VM, so the numbers
are indicative and vary by 30–50% between runs. Treat them as relative (before/after, spread vs hot),
not absolute. Every run had a 0.00% error rate.

## Round-trip reduction (2026-11-27)

The first profile showed the API process pinned at ~90% CPU (one Node core) and Postgres
connections mostly `idle in transaction`: the database was waiting on the app. A book transfer
made **17** database round trips. Cutting it to **12**:

- validate the locked account rows instead of reading them separately before locking
- one `UPDATE … FROM (VALUES …)` for all balance changes instead of one per account
- a deferred foreign key so the transfer row can be inserted with its entry id and `RETURNING *`,
  instead of insert → update → select
- the settlement-account lookup is a single `SELECT` on the common path

| 500 req/s, spread over 200 wallets, fresh DB | Before | After      |
| -------------------------------------------- | ------ | ---------- |
| Median latency                               | 394 ms | **8 ms**   |
| p95 latency                                  | 1.24 s | **293 ms** |
| Dropped iterations (couldn't keep up)        | 2,078  | **288**    |
| Achieved throughput                          | ~385/s | **~490/s** |

## Spread vs hot account (after the change)

| Scenario                | Rate  | Median   | p95        | Dropped     | Notes                    |
| ----------------------- | ----- | -------- | ---------- | ----------- | ------------------------ |
| Spread (200 wallets)    | 300/s | 6–8 ms   | 270–380 ms | 170–260     |                          |
| Spread (200 wallets)    | 450/s | 20–70 ms | 0.9–1.2 s  | 900–1,500   | API CPU-bound            |
| Hot (one source wallet) | 150/s | 9–12 ms  | 500–630 ms | 3–31        |                          |
| Hot (one source wallet) | 300/s | 1.6 s    | 3.5–3.9 s  | 2,500–3,000 | queueing on one row lock |

## What limits throughput

- **Spread traffic** is bound by the single API process's CPU. The API is stateless; the next
  step is more replicas behind the gateway, then PgBouncer.
- **A hot account** is bound by how long its row lock is held: capacity ≈ 1 / lock hold time. On
  this machine that's roughly 150–200 transfers/s on one account. This is why DESIGN §9 shards
  the settlement account (every ACH transfer touches it).
- The p95 tail at moderate rates comes from CPU contention on the shared VM, plus the
  reconciliation full scan every 60 s (0.3–0.9 s at ~280k lines).
