# Failure modes

What happens when things go wrong, and which test proves it.

| Failure                                                         | Behaviour                                                                            | Covered by                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Client retries `POST /transfers` after a timeout                | Same key → stored response replayed, `Idempotent-Replayed: true`, no second transfer | `transfers.test.ts` › replays the original response                    |
| Two identical requests in flight at once                        | Second blocks on the unique index, then replays the first's response                 | › 20 concurrent requests with the same key                             |
| Same key, different body                                        | 422 `idempotency_key_reused`                                                         | › rejects a reused key                                                 |
| Many withdrawals race on one wallet                             | Serialised by row lock; exactly the affordable ones succeed                          | › never overdraws under concurrency                                    |
| Unbalanced entry written by buggy code or manual SQL            | Rejected at COMMIT by a deferred trigger                                             | `ledger.test.ts` › database itself refuses                             |
| Someone UPDATEs or DELETEs an entry line                        | Rejected by trigger                                                                  | › entry lines are append-only                                          |
| Balance columns modified outside the ledger                     | Reconciliation reports `balance_drift`                                               | `reconciliation.test.ts` › detects drift                               |
| Transfer status changed without its entry                       | Reconciliation reports `transfer_entry_mismatch`                                     | › detects a transfer whose status disagrees                            |
| API crashes mid-request                                         | Transaction rolls back: no transfer, no key, no event; client retries                | (Postgres atomicity)                                                   |
| Worker crashes after claiming an ACH batch, before upload       | Batch stays `created`; next run re-sends it with the same id                         | `ach.test.ts` › re-sends a batch that crashed                          |
| Bank sends the same update twice / out of date                  | Status re-checked under lock; duplicate is a no-op                                   | › applies duplicate and stale bank updates idempotently                |
| ACH return before settlement (R01, R02, R03)                    | Pending entry archived; balance restored                                             | › R01 return before settlement                                         |
| ACH return after settlement and after the money was spent (R10) | Posted reversal; wallet goes negative; reconciliation warns                          | › R10 late return                                                      |
| Client cancels after the batch was sent                         | 409 `transfer_not_cancelable`                                                        | `transfers.test.ts` › can cancel a pending ACH transfer                |
| Business logic fails after an event was enqueued                | Event rolls back with the transaction; nothing is published                          | `webhooks.test.ts` › an event exists only if its transaction committed |
| Webhook receiver returns 5xx or times out                       | Retried with exponential backoff + jitter, then `dead`                               | › retries failures with backoff                                        |
| Worker dies while sending a webhook                             | Lease expires (30 s); another worker re-sends; receiver dedupes on `webhook-id`      | (lease design; see dispatcher.ts)                                      |
| Webhook tampered with or replayed later                         | Signature or timestamp check fails at the receiver                                   | `signing.test.ts`                                                      |
| Postgres restarts                                               | Pool errors are absorbed; requests fail with 500 until it's back; no partial writes  | (pg pool `error` handler)                                              |
| Two worker replicas                                             | `SKIP LOCKED` hands each job's rows to one replica                                   | (design)                                                               |
