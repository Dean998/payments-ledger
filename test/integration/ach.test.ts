import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyAchUpdate, pollAchNetwork, submitAchBatches } from '../../src/ach/jobs.js';
import { MockAchNetwork } from '../../src/ach/mock-network.js';
import type { AchNetwork } from '../../src/ach/network.js';
import { withTransaction } from '../../src/db/pool.js';
import { createAccount, getAccount } from '../../src/ledger/accounts.js';
import { computeBalances } from '../../src/ledger/balances.js';
import { runReconciliation } from '../../src/reconciliation/reconcile.js';
import {
  createTransfer,
  getTransfer,
  type CreateTransferInput,
} from '../../src/transfers/transfers.js';
import { createTestDb, EXTERNAL_ACCOUNT, fundedWallet, resetDb } from '../helpers.js';

const db = createTestDb();
afterAll(() => db.end());
beforeEach(() => resetDb(db));

const SETTLE = 1_000;
const LATE = 5_000;
const network = new MockAchNetwork({ settleAfterMs: SETTLE, lateReturnAfterMs: LATE });
/**
 * Simulated time is measured from the latest submission as recorded by
 * Postgres, not from Date.now(): the database runs in a VM whose clock can
 * drift from the host's by a few milliseconds, enough to flip "exactly
 * SETTLE ms later" assertions.
 */
async function poll(msAfterSubmission: number) {
  const { rows } = await db.query<{ at: Date }>('SELECT max(submitted_at) AS at FROM transfers');
  const now = new Date(rows[0]!.at.getTime() + msAfterSubmission);
  return pollAchNetwork(db, network, { returnWindowMs: 60_000, now });
}

const create = (input: CreateTransferInput) =>
  withTransaction(db, (tx) => createTransfer(tx, input));
async function balances(id: string) {
  const a = await getAccount(db, id);
  return computeBalances(a.normalBalance, a);
}

describe('ACH lifecycle', () => {
  it('pull: funds show as pending, become available only when the bank settles', async () => {
    const wallet = await createAccount(db, { name: 'W', currency: 'USD' });
    const t = await create({
      type: 'ach_pull',
      amount: 50_000,
      currency: 'USD',
      destinationAccountId: wallet.id,
      externalAccount: EXTERNAL_ACCOUNT,
    });
    expect(await balances(wallet.id)).toEqual({ posted: 0n, pending: 50_000n, available: 0n });

    expect(await submitAchBatches(db, network)).toEqual({ batches: 1, transfers: 1 });
    expect((await getTransfer(db, t.id)).status).toBe('submitted');
    expect(await poll(SETTLE / 4)).toBe(0); // not yet

    expect(await poll(SETTLE)).toBe(1);
    expect((await getTransfer(db, t.id)).status).toBe('settled');
    expect(await balances(wallet.id)).toEqual({
      posted: 50_000n,
      pending: 50_000n,
      available: 50_000n,
    });
  });

  it('push: funds are held immediately and leave on settlement', async () => {
    const wallet = await fundedWallet(db, 10_000);
    await create({
      type: 'ach_push',
      amount: 4_000,
      currency: 'USD',
      sourceAccountId: wallet.id,
      externalAccount: EXTERNAL_ACCOUNT,
    });
    expect(await balances(wallet.id)).toEqual({
      posted: 10_000n,
      pending: 6_000n,
      available: 6_000n,
    });
    await submitAchBatches(db, network);
    await poll(SETTLE);
    expect(await balances(wallet.id)).toEqual({
      posted: 6_000n,
      pending: 6_000n,
      available: 6_000n,
    });
  });

  it('R01 return before settlement voids the pending entry', async () => {
    const wallet = await createAccount(db, { name: 'W', currency: 'USD' });
    const t = await create({
      type: 'ach_pull',
      amount: 10_001,
      currency: 'USD',
      destinationAccountId: wallet.id,
      externalAccount: EXTERNAL_ACCOUNT,
    });
    await submitAchBatches(db, network);
    await poll(SETTLE / 2);
    const returned = await getTransfer(db, t.id);
    expect(returned).toMatchObject({
      status: 'returned',
      returnCode: 'R01',
      reversalEntryId: null,
    });
    expect(await balances(wallet.id)).toEqual({ posted: 0n, pending: 0n, available: 0n });
    expect((await runReconciliation(db)).status).toBe('ok');
  });

  it('R10 late return after the customer spent the money: reversal overdraws, reconciliation warns', async () => {
    const wallet = await createAccount(db, { name: 'W', currency: 'USD' });
    const elsewhere = await createAccount(db, { name: 'Merchant', currency: 'USD' });
    const t = await create({
      type: 'ach_pull',
      amount: 25_010,
      currency: 'USD',
      destinationAccountId: wallet.id,
      externalAccount: EXTERNAL_ACCOUNT,
    });
    await submitAchBatches(db, network);
    await poll(SETTLE);
    expect((await getTransfer(db, t.id)).status).toBe('settled');

    // Customer spends it all.
    await create({
      type: 'book',
      amount: 25_010,
      currency: 'USD',
      sourceAccountId: wallet.id,
      destinationAccountId: elsewhere.id,
    });

    // Then the bank sends R10.
    expect(await poll(LATE)).toBe(1);
    const returned = await getTransfer(db, t.id);
    expect(returned).toMatchObject({ status: 'returned', returnCode: 'R10' });
    expect(returned.reversalEntryId).not.toBeNull();
    expect((await balances(wallet.id)).available).toBe(-25_010n);

    const report = await runReconciliation(db);
    expect(report.status).toBe('ok'); // the books still balance...
    expect(report.warnings).toEqual([
      expect.objectContaining({ kind: 'negative_balance', subject: wallet.id }),
    ]); // ...but the money is owed
  });

  it('applies duplicate and stale bank updates idempotently', async () => {
    const wallet = await createAccount(db, { name: 'W', currency: 'USD' });
    const t = await create({
      type: 'ach_pull',
      amount: 1_000,
      currency: 'USD',
      destinationAccountId: wallet.id,
      externalAccount: EXTERNAL_ACCOUNT,
    });
    await submitAchBatches(db, network);
    expect(await applyAchUpdate(db, { transferId: t.id, kind: 'settled' })).toBe(true);
    expect(await applyAchUpdate(db, { transferId: t.id, kind: 'settled' })).toBe(false);
    expect((await balances(wallet.id)).posted).toBe(1_000n);
  });

  it('re-sends a batch that crashed after being claimed but before being confirmed', async () => {
    const wallet = await fundedWallet(db, 1_000);
    const t = await create({
      type: 'ach_push',
      amount: 100,
      currency: 'USD',
      sourceAccountId: wallet.id,
      externalAccount: EXTERNAL_ACCOUNT,
    });

    let calls = 0;
    const flaky: AchNetwork = {
      submitBatch: (batchId, items) => {
        calls++;
        if (calls === 1) return Promise.reject(new Error('connection reset'));
        return network.submitBatch(batchId, items);
      },
      fetchUpdates: (items, now) => network.fetchUpdates(items, now),
    };
    await expect(submitAchBatches(db, flaky)).rejects.toThrow('connection reset');
    expect((await getTransfer(db, t.id)).status).toBe('pending');

    // The batch is now stuck in 'created'; the next run picks it up again.
    expect(await submitAchBatches(db, flaky, { stuckAfterMs: 0 })).toEqual({
      batches: 1,
      transfers: 1,
    });
    expect((await getTransfer(db, t.id)).status).toBe('submitted');
  });
});
