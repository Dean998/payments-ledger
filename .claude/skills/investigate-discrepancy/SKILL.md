---
name: investigate-discrepancy
description: Runbook for a reconciliation mismatch or a suspicious balance in payments-ledger. Use when reconciliation reports status=mismatch, a negative-balance warning appears, or someone asks "why is this account's balance X".
---

# Investigating a ledger discrepancy

**Rule zero: never "fix" a balance with UPDATE.** Balances are derived; entries are history.
Corrections are new, reversing or adjusting entries, posted with a description that references
the incident.

## 1. Read the report

`curl -s localhost:3000/reconciliation/runs/latest | jq` and classify each discrepancy:

| kind                      | meaning                                         | usual cause                                                                                                |
| ------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `balance_drift`           | stored balance columns ≠ sum of entry lines     | something wrote `accounts` outside `createEntry`/`transitionEntry`, or a manual SQL change                 |
| `trial_balance`           | posted debits ≠ posted credits for a currency   | should be impossible (the deferred trigger checks this); suspect a disabled trigger or a restored backup   |
| `transfer_entry_mismatch` | transfer status disagrees with its entry status | a status change that skipped `moveTransfer`, or a crash between two transactions that should have been one |

`negative_balance` **warnings** are not ledger errors: usually a late ACH return (R10/R29) after
the customer spent the money. That's a collections/risk problem, not a bug.

## 2. Find when it started

```sql
-- Lines for one account, oldest first, with a running balance (credit-normal)
SELECT l.id, e.created_at, e.status, l.direction, l.amount,
       SUM(CASE WHEN l.direction = 'credit' THEN l.amount ELSE -l.amount END)
         FILTER (WHERE e.status = 'posted') OVER (ORDER BY l.id) AS running_posted
  FROM entry_lines l JOIN journal_entries e ON e.id = l.entry_id
 WHERE l.account_id = :account
 ORDER BY l.id;

-- Previous reconciliation runs: when did it last pass?
SELECT finished_at, status, jsonb_array_length(discrepancies) FROM reconciliation_runs ORDER BY finished_at DESC LIMIT 20;

-- Audit trail of a transfer
SELECT * FROM transfer_events WHERE transfer_id = :transfer ORDER BY id;
```

## 3. Find the code path

Search for writes that bypass the ledger API:
`grep -rn "UPDATE accounts\|UPDATE transfers\|UPDATE journal_entries" src` should only hit
`src/ledger/ledger.ts` and `src/transfers/transfers.ts` (plus `ach_batch_id` bookkeeping in
`src/ach/jobs.ts`). Anything else is a suspect.

## 4. Fix forward

1. Write a failing integration test that reproduces the drift.
2. Fix the code path.
3. Correct the data with entries (e.g. `reverseEntry`, or a posted adjustment against a suspense
   account), never by editing rows.
4. Run reconciliation again and confirm `status: ok`.
5. Write a short incident note: what drifted, since when, why, how it was corrected.
