import { randomUUID } from 'node:crypto';
import { withTransaction, type Db } from '../db/pool.js';
import { reverseEntry, transitionEntry } from '../ledger/ledger.js';
import { fromDb } from '../money.js';
import { achTransfersSubmitted, achUpdatesApplied } from '../observability/metrics.js';
import { getTransfer, moveTransfer } from '../transfers/transfers.js';
import type { AchNetwork, AchUpdate } from './network.js';

/**
 * Sends pending ACH transfers to the bank in three steps, so a crash at any
 * point is recoverable without double-sending:
 *   1. (tx) claim unbatched transfers into a new batch, status 'created'
 *   2. upload the batch; the network is idempotent on batch id
 *   3. (tx) mark the transfers submitted and the batch 'sent'
 * A batch stuck in 'created' (crash between 1 and 3) is simply sent again.
 */
export async function submitAchBatches(
  db: Db,
  network: AchNetwork,
  opts: { batchSize?: number; stuckAfterMs?: number } = {},
): Promise<{ batches: number; transfers: number }> {
  const stuck = await db.query<{ id: string }>(
    `SELECT id FROM ach_batches WHERE status = 'created' AND created_at < now() - make_interval(secs => $1)`,
    [(opts.stuckAfterMs ?? 60_000) / 1000],
  );
  const batchIds = stuck.rows.map((r) => r.id);
  const fresh = await createBatch(db, opts.batchSize ?? 500);
  if (fresh) batchIds.push(fresh);

  let transfers = 0;
  for (const batchId of batchIds) transfers += await sendBatch(db, network, batchId);
  return { batches: batchIds.length, transfers };
}

async function createBatch(db: Db, size: number): Promise<string | null> {
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM transfers
        WHERE status = 'pending' AND type <> 'book' AND ach_batch_id IS NULL
        ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [size],
    );
    if (rows.length === 0) return null;
    const batchId = randomUUID();
    await tx.query(
      `INSERT INTO ach_batches (id, status, transfer_count) VALUES ($1, 'created', $2)`,
      [batchId, rows.length],
    );
    await tx.query(
      'UPDATE transfers SET ach_batch_id = $1, updated_at = now() WHERE id = ANY ($2::uuid[])',
      [batchId, rows.map((r) => r.id)],
    );
    return batchId;
  });
}

async function sendBatch(db: Db, network: AchNetwork, batchId: string): Promise<number> {
  const { rows } = await db.query<{
    id: string;
    type: 'ach_push' | 'ach_pull';
    amount: string;
    currency: string;
    external_account: { routingNumber: string; holderName: string };
    external_account_number: string;
  }>(`SELECT * FROM transfers WHERE ach_batch_id = $1 AND status = 'pending' ORDER BY id`, [
    batchId,
  ]);

  const receipts = await network.submitBatch(
    batchId,
    rows.map((r) => ({
      transferId: r.id,
      type: r.type,
      amount: fromDb(r.amount),
      currency: r.currency,
      routingNumber: r.external_account.routingNumber,
      accountNumber: r.external_account_number,
      holderName: r.external_account.holderName,
    })),
  );

  let submitted = 0;
  await withTransaction(db, async (tx) => {
    submitted = 0;
    for (const receipt of [...receipts].sort((a, b) => a.transferId.localeCompare(b.transferId))) {
      const transfer = await getTransfer(tx, receipt.transferId, { lock: true });
      if (transfer.status !== 'pending') continue;
      await moveTransfer(
        tx,
        transfer,
        'submitted',
        { bankReference: receipt.bankReference },
        `batch ${batchId}`,
      );
      submitted++;
    }
    await tx.query(`UPDATE ach_batches SET status = 'sent', sent_at = now() WHERE id = $1`, [
      batchId,
    ]);
  });
  achTransfersSubmitted.inc(submitted);
  return submitted;
}

/**
 * Asks the bank about every transfer that is in flight or still inside its
 * return window, and applies the answers. Each update is applied in its own
 * transaction under a row lock and re-checks the current status, so
 * duplicate or stale updates are no-ops.
 */
export async function pollAchNetwork(
  db: Db,
  network: AchNetwork,
  opts: { returnWindowMs: number; now?: Date; limit?: number },
): Promise<number> {
  const now = opts.now ?? new Date();
  const { rows } = await db.query<{
    id: string;
    bank_reference: string;
    amount: string;
    status: 'submitted' | 'settled';
    submitted_at: Date;
  }>(
    `SELECT id, bank_reference, amount, status, submitted_at FROM transfers
      WHERE status = 'submitted' OR (status = 'settled' AND settled_at > $1)
      ORDER BY submitted_at LIMIT $2`,
    [new Date(now.getTime() - opts.returnWindowMs), opts.limit ?? 1000],
  );
  if (rows.length === 0) return 0;

  const updates = await network.fetchUpdates(
    rows.map((r) => ({
      transferId: r.id,
      bankReference: r.bank_reference,
      amount: fromDb(r.amount),
      status: r.status,
      submittedAt: r.submitted_at,
    })),
    now,
  );

  let applied = 0;
  for (const update of updates) if (await applyAchUpdate(db, update)) applied++;
  return applied;
}

export async function applyAchUpdate(db: Db, update: AchUpdate): Promise<boolean> {
  const applied = await withTransaction(db, async (tx) => {
    const transfer = await getTransfer(tx, update.transferId, { lock: true });

    if (update.kind === 'settled') {
      if (transfer.status !== 'submitted') return false;
      await transitionEntry(tx, transfer.entryId!, 'posted');
      await moveTransfer(tx, transfer, 'settled', {}, 'settled by bank');
      return true;
    }

    const patch = { returnCode: update.returnCode, returnReason: update.returnReason };
    const reason = `returned ${update.returnCode}: ${update.returnReason}`;
    if (transfer.status === 'submitted') {
      // Never settled: void the pending entry.
      await transitionEntry(tx, transfer.entryId!, 'archived');
      await moveTransfer(tx, transfer, 'returned', patch, reason);
      return true;
    }
    if (transfer.status === 'settled') {
      // Already posted: book a reversing entry. For a pull, the customer may
      // have spent the money already, so this can overdraw their account.
      const reversal = await reverseEntry(tx, transfer.entryId!, {
        description: `${update.returnCode} return of transfer ${transfer.id}`,
        allowOverdraft: true,
      });
      await moveTransfer(
        tx,
        transfer,
        'returned',
        { ...patch, reversalEntryId: reversal.id },
        reason,
      );
      return true;
    }
    return false;
  });
  if (applied) {
    achUpdatesApplied.inc({
      kind: update.kind,
      return_code: update.kind === 'returned' ? update.returnCode : '',
    });
  }
  return applied;
}
