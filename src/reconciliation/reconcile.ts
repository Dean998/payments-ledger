import { randomUUID } from 'node:crypto';
import { withTransaction, type Db, type Queryable } from '../db/pool.js';
import { reconciliationDiscrepancies } from '../observability/metrics.js';

export interface Discrepancy {
  kind: 'balance_drift' | 'trial_balance' | 'transfer_entry_mismatch';
  subject: string;
  detail: Record<string, unknown>;
}

export interface ReconciliationReport {
  id: string;
  status: 'ok' | 'mismatch';
  accountsChecked: number;
  discrepancies: Discrepancy[];
  /** Not errors in the ledger, but things a human should look at. */
  warnings: { kind: 'negative_balance'; subject: string; detail: Record<string, unknown> }[];
  startedAt: string;
  finishedAt: string;
}

/**
 * Re-derives every balance from the immutable entry lines and compares it with
 * the materialised columns, then checks the cross-table invariants. Runs in one
 * REPEATABLE READ snapshot so concurrent writes can't produce false alarms.
 *
 * This is a full scan: fine for this service, but at scale it would become
 * incremental (checkpointed per-account sums, or per-day partitions).
 */
export async function runReconciliation(db: Db): Promise<ReconciliationReport> {
  const startedAt = new Date();
  const result = await withTransaction(
    db,
    async (tx) => {
      const discrepancies: Discrepancy[] = [];

      const drift = await tx.query<{
        id: string;
        stored: Record<string, string>;
        derived: Record<string, string>;
      }>(`
        WITH derived AS (
          SELECT l.account_id,
                 COALESCE(SUM(l.amount) FILTER (WHERE e.status = 'posted'  AND l.direction = 'debit'),  0) AS posted_debits,
                 COALESCE(SUM(l.amount) FILTER (WHERE e.status = 'posted'  AND l.direction = 'credit'), 0) AS posted_credits,
                 COALESCE(SUM(l.amount) FILTER (WHERE e.status = 'pending' AND l.direction = 'debit'),  0) AS pending_debits,
                 COALESCE(SUM(l.amount) FILTER (WHERE e.status = 'pending' AND l.direction = 'credit'), 0) AS pending_credits
            FROM entry_lines l JOIN journal_entries e ON e.id = l.entry_id
           GROUP BY l.account_id
        )
        SELECT a.id,
               jsonb_build_object('postedDebits', a.posted_debits::text, 'postedCredits', a.posted_credits::text,
                                  'pendingDebits', a.pending_debits::text, 'pendingCredits', a.pending_credits::text) AS stored,
               jsonb_build_object('postedDebits', COALESCE(d.posted_debits, 0)::text, 'postedCredits', COALESCE(d.posted_credits, 0)::text,
                                  'pendingDebits', COALESCE(d.pending_debits, 0)::text, 'pendingCredits', COALESCE(d.pending_credits, 0)::text) AS derived
          FROM accounts a LEFT JOIN derived d ON d.account_id = a.id
         WHERE a.posted_debits   <> COALESCE(d.posted_debits, 0)
            OR a.posted_credits  <> COALESCE(d.posted_credits, 0)
            OR a.pending_debits  <> COALESCE(d.pending_debits, 0)
            OR a.pending_credits <> COALESCE(d.pending_credits, 0)`);
      for (const r of drift.rows) {
        discrepancies.push({
          kind: 'balance_drift',
          subject: r.id,
          detail: { stored: r.stored, derived: r.derived },
        });
      }

      // Across the whole ledger, posted debits must equal posted credits.
      const trial = await tx.query<{ currency: string; net: string }>(`
        SELECT l.currency, SUM(CASE WHEN l.direction = 'debit' THEN l.amount ELSE -l.amount END)::text AS net
          FROM entry_lines l JOIN journal_entries e ON e.id = l.entry_id
         WHERE e.status = 'posted'
         GROUP BY l.currency
        HAVING SUM(CASE WHEN l.direction = 'debit' THEN l.amount ELSE -l.amount END) <> 0`);
      for (const r of trial.rows) {
        discrepancies.push({ kind: 'trial_balance', subject: r.currency, detail: { net: r.net } });
      }

      // Each transfer status implies exactly one state of its ledger entry.
      const mismatched = await tx.query<{
        id: string;
        status: string;
        entry_status: string | null;
      }>(`
        SELECT t.id, t.status, e.status AS entry_status
          FROM transfers t LEFT JOIN journal_entries e ON e.id = t.entry_id
         WHERE NOT COALESCE(
                 (t.status IN ('pending', 'submitted') AND e.status = 'pending')
              OR (t.status IN ('posted', 'settled')    AND e.status = 'posted')
              OR (t.status = 'canceled'                AND e.status = 'archived')
              OR (t.status = 'returned' AND (e.status = 'archived' OR (e.status = 'posted' AND t.reversal_entry_id IS NOT NULL))),
               false)`);
      for (const r of mismatched.rows) {
        discrepancies.push({
          kind: 'transfer_entry_mismatch',
          subject: r.id,
          detail: { transferStatus: r.status, entryStatus: r.entry_status },
        });
      }

      // Accounts that went negative even though they shouldn't, which a late
      // ACH return can cause. The ledger is still correct; the money is owed.
      const negative = await tx.query<{ id: string; available: string }>(`
        SELECT id, (posted_credits - posted_debits - pending_debits)::text AS available
          FROM accounts
         WHERE NOT allow_negative AND normal_balance = 'credit'
           AND posted_credits - posted_debits - pending_debits < 0`);

      const count = await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM accounts');
      return {
        discrepancies,
        warnings: negative.rows.map((r) => ({
          kind: 'negative_balance' as const,
          subject: r.id,
          detail: { available: r.available },
        })),
        accountsChecked: count.rows[0]!.n,
      };
    },
    { isolation: 'repeatable read', readOnly: true },
  );

  const report: ReconciliationReport = {
    id: randomUUID(),
    status: result.discrepancies.length === 0 ? 'ok' : 'mismatch',
    accountsChecked: result.accountsChecked,
    discrepancies: result.discrepancies,
    warnings: result.warnings,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  };
  await db.query(
    `INSERT INTO reconciliation_runs (id, status, accounts_checked, discrepancies, warnings, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      report.id,
      report.status,
      report.accountsChecked,
      JSON.stringify(report.discrepancies),
      JSON.stringify(report.warnings),
      report.startedAt,
      report.finishedAt,
    ],
  );
  reconciliationDiscrepancies.set(report.discrepancies.length);
  return report;
}

export async function latestReconciliation(db: Queryable): Promise<ReconciliationReport | null> {
  const { rows } = await db.query<{
    id: string;
    status: 'ok' | 'mismatch';
    accounts_checked: number;
    discrepancies: Discrepancy[];
    warnings: ReconciliationReport['warnings'];
    started_at: Date;
    finished_at: Date;
  }>('SELECT * FROM reconciliation_runs ORDER BY finished_at DESC LIMIT 1');
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    accountsChecked: r.accounts_checked,
    discrepancies: r.discrepancies,
    warnings: r.warnings,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at.toISOString(),
  };
}
