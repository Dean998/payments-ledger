import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pollAchNetwork, submitAchBatches } from '../../src/ach/jobs.js';
import { MockAchNetwork } from '../../src/ach/mock-network.js';
import { withTransaction } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { runReconciliation } from '../../src/reconciliation/reconcile.js';
import { createTransfer } from '../../src/transfers/transfers.js';
import { createTestDb, EXTERNAL_ACCOUNT, fundedWallet, resetDb } from '../helpers.js';

const db = createTestDb();
afterAll(() => db.end());
beforeEach(() => resetDb(db));

async function someActivity() {
  const a = await fundedWallet(db, 100_000);
  const b = await createAccount(db, { name: 'B', currency: 'USD' });
  await withTransaction(db, async (tx) => {
    await createTransfer(tx, {
      type: 'book',
      amount: 1_234,
      currency: 'USD',
      sourceAccountId: a.id,
      destinationAccountId: b.id,
    });
    await createTransfer(tx, {
      type: 'ach_push',
      amount: 5_000,
      currency: 'USD',
      sourceAccountId: a.id,
      externalAccount: EXTERNAL_ACCOUNT,
    });
    await createTransfer(tx, {
      type: 'ach_pull',
      amount: 7_001,
      currency: 'USD',
      destinationAccountId: b.id,
      externalAccount: EXTERNAL_ACCOUNT,
    });
  });
  const network = new MockAchNetwork({ settleAfterMs: 1_000, lateReturnAfterMs: 5_000 });
  await submitAchBatches(db, network);
  // Measure simulated time from the database's clock (see ach.test.ts).
  const { rows } = await db.query<{ at: Date }>('SELECT max(submitted_at) AS at FROM transfers');
  await pollAchNetwork(db, network, {
    returnWindowMs: 60_000,
    now: new Date(rows[0]!.at.getTime() + 1_000),
  });
  return { a, b };
}

describe('reconciliation', () => {
  it('passes on a ledger with mixed activity', async () => {
    await someActivity();
    const report = await runReconciliation(db);
    expect(report).toMatchObject({ status: 'ok', discrepancies: [], warnings: [] });
    expect(report.accountsChecked).toBe(4); // treasury, a, b, settlement
  });

  it('detects a materialised balance that drifted from the entry lines', async () => {
    const { b } = await someActivity();
    await db.query('UPDATE accounts SET posted_credits = posted_credits + 1 WHERE id = $1', [b.id]);
    const report = await runReconciliation(db);
    expect(report.status).toBe('mismatch');
    expect(report.discrepancies).toEqual([
      expect.objectContaining({ kind: 'balance_drift', subject: b.id }),
    ]);
  });

  it('detects a transfer whose status disagrees with its ledger entry', async () => {
    await someActivity();
    await db.query(`UPDATE transfers SET status = 'settled' WHERE return_code = 'R01'`);
    const report = await runReconciliation(db);
    expect(report.discrepancies).toEqual([
      expect.objectContaining({ kind: 'transfer_entry_mismatch' }),
    ]);
  });
});
