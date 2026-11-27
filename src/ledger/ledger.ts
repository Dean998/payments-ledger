import { randomUUID } from 'node:crypto';
import type { Tx } from '../db/pool.js';
import { errors } from '../errors.js';
import { fromDb, toApiAmount } from '../money.js';
import { mapAccount, type Account, type AccountRow } from './accounts.js';
import { applyLine, computeBalances, type Direction, type LineEffect } from './balances.js';

export type EntryStatus = 'pending' | 'posted' | 'archived';

export interface LineInput {
  accountId: string;
  direction: Direction;
  amount: bigint;
}

export interface CreateEntryInput {
  lines: LineInput[];
  status: 'pending' | 'posted';
  description?: string | null;
  transferId?: string | null;
  reversesEntryId?: string | null;
  /**
   * Skip the available-balance check. Only for entries the platform cannot
   * refuse, such as reversing an ACH pull that was returned after settlement.
   * Reconciliation reports the resulting negative balances.
   */
  allowOverdraft?: boolean;
  /** Pre-generated id, so a caller can reference the entry before it exists. */
  id?: string;
  /** Accounts the caller already locked with lockAccounts in this transaction. */
  locked?: Map<string, Account>;
}

export interface JournalEntry {
  id: string;
  status: EntryStatus;
  description: string | null;
  transferId: string | null;
  reversesEntryId: string | null;
  lines: { accountId: string; direction: Direction; amount: bigint; currency: string }[];
  createdAt: Date;
}

/**
 * Locks the accounts in a fixed order (by id). Two transactions that touch
 * the same accounts always take the locks in the same order, so they can't
 * deadlock on each other.
 *
 * FOR NO KEY UPDATE, not FOR UPDATE: inserting a row that references an
 * account (a transfer, an entry line) makes Postgres take a FOR KEY SHARE lock
 * on the account for the foreign-key check, and FOR UPDATE conflicts with it.
 * Two concurrent withdrawals from one wallet then each hold KEY SHARE and wait
 * for the other's FOR UPDATE: a deadlock. The concurrency test caught exactly
 * that. We never change account keys, so NO KEY UPDATE is the right lock.
 */
export async function lockAccounts(tx: Tx, ids: string[]): Promise<Map<string, Account>> {
  const unique = [...new Set(ids)].sort();
  const { rows } = await tx.query<AccountRow>(
    'SELECT * FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE',
    [unique],
  );
  const byId = new Map(rows.map((r) => [r.id, mapAccount(r)]));
  for (const id of unique) if (!byId.has(id)) throw errors.notFound('account', id);
  return byId;
}

/** One UPDATE for all accounts in the entry, instead of one per account. */
async function writeBalances(tx: Tx, accounts: Iterable<Account>): Promise<void> {
  const values: string[] = [];
  const tuples = [...accounts].map((a, i) => {
    values.push(
      a.id,
      ...[a.postedDebits, a.postedCredits, a.pendingDebits, a.pendingCredits].map(String),
    );
    const o = i * 5;
    return `($${o + 1}::uuid, $${o + 2}::bigint, $${o + 3}::bigint, $${o + 4}::bigint, $${o + 5}::bigint)`;
  });
  if (tuples.length === 0) return;
  await tx.query(
    `UPDATE accounts a
        SET posted_debits = v.pd, posted_credits = v.pc, pending_debits = v.pnd, pending_credits = v.pnc
       FROM (VALUES ${tuples.join(', ')}) AS v (id, pd, pc, pnd, pnc)
      WHERE a.id = v.id`,
    values,
  );
}

function applyAll(
  accounts: Map<string, Account>,
  lines: { accountId: string; direction: Direction; amount: bigint }[],
  effect: LineEffect,
): Map<string, Account> {
  const next = new Map([...accounts].map(([id, a]) => [id, { ...a }]));
  for (const line of lines) {
    const a = next.get(line.accountId)!;
    Object.assign(a, applyLine(a, line.direction, line.amount, effect));
  }
  return next;
}

function assertNoOverdraft(before: Map<string, Account>, after: Map<string, Account>): void {
  for (const [id, a] of after) {
    if (a.allowNegative) continue;
    const prev = computeBalances(a.normalBalance, before.get(id)!).available;
    const next = computeBalances(a.normalBalance, a).available;
    // Only refuse changes that make availability worse; an account that is
    // already negative (after a late return) can still receive money.
    if (next < 0n && next < prev) throw errors.insufficientFunds(id, prev, prev - next);
  }
}

export async function createEntry(tx: Tx, input: CreateEntryInput): Promise<JournalEntry> {
  if (input.lines.length < 2) throw errors.validation('an entry needs at least two lines');
  for (const l of input.lines) {
    if (l.amount <= 0n) throw errors.validation('line amounts must be positive');
  }

  const ids = input.lines.map((l) => l.accountId);
  const accounts =
    input.locked && ids.every((id) => input.locked!.has(id))
      ? new Map(ids.map((id) => [id, input.locked!.get(id)!]))
      : await lockAccounts(tx, ids);

  // Balanced per currency. The database re-checks this at COMMIT.
  const net = new Map<string, bigint>();
  for (const l of input.lines) {
    const cur = accounts.get(l.accountId)!.currency;
    net.set(cur, (net.get(cur) ?? 0n) + (l.direction === 'debit' ? l.amount : -l.amount));
  }
  for (const [currency, value] of net)
    if (value !== 0n) throw errors.unbalancedEntry(currency, value);

  const after = applyAll(
    accounts,
    input.lines,
    input.status === 'posted' ? 'create-posted' : 'create-pending',
  );
  if (!input.allowOverdraft) assertNoOverdraft(accounts, after);

  const id = input.id ?? randomUUID();
  const { rows } = await tx.query<{ created_at: Date }>(
    `INSERT INTO journal_entries (id, status, description, transfer_id, reverses_entry_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING created_at`,
    [
      id,
      input.status,
      input.description ?? null,
      input.transferId ?? null,
      input.reversesEntryId ?? null,
    ],
  );

  const values: unknown[] = [];
  const tuples = input.lines.map((l, i) => {
    values.push(
      id,
      l.accountId,
      l.direction,
      String(l.amount),
      accounts.get(l.accountId)!.currency,
    );
    const o = i * 5;
    return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5})`;
  });
  await tx.query(
    `INSERT INTO entry_lines (entry_id, account_id, direction, amount, currency) VALUES ${tuples.join(', ')}`,
    values,
  );
  await writeBalances(tx, after.values());

  return {
    id,
    status: input.status,
    description: input.description ?? null,
    transferId: input.transferId ?? null,
    reversesEntryId: input.reversesEntryId ?? null,
    lines: input.lines.map((l) => ({ ...l, currency: accounts.get(l.accountId)!.currency })),
    createdAt: rows[0]!.created_at,
  };
}

export async function getEntry(
  tx: Pick<Tx, 'query'>,
  id: string,
  lock = false,
): Promise<JournalEntry> {
  const { rows } = await tx.query<{
    id: string;
    status: EntryStatus;
    description: string | null;
    transfer_id: string | null;
    reverses_entry_id: string | null;
    created_at: Date;
  }>(`SELECT * FROM journal_entries WHERE id = $1 ${lock ? 'FOR NO KEY UPDATE' : ''}`, [id]);
  const e = rows[0];
  if (!e) throw errors.notFound('journal entry', id);
  const lines = await tx.query<{
    account_id: string;
    direction: Direction;
    amount: string;
    currency: string;
  }>(
    'SELECT account_id, direction, amount, currency FROM entry_lines WHERE entry_id = $1 ORDER BY id',
    [id],
  );
  return {
    id: e.id,
    status: e.status,
    description: e.description,
    transferId: e.transfer_id,
    reversesEntryId: e.reverses_entry_id,
    lines: lines.rows.map((l) => ({
      accountId: l.account_id,
      direction: l.direction,
      amount: fromDb(l.amount),
      currency: l.currency,
    })),
    createdAt: e.created_at,
  };
}

/**
 * Moves a pending entry to posted or archived and updates the balances.
 * Neither change can lower an account's available balance (pending outflows
 * already count against it), so no overdraft check is needed.
 */
export async function transitionEntry(
  tx: Tx,
  entryId: string,
  to: 'posted' | 'archived',
): Promise<JournalEntry> {
  const entry = await getEntry(tx, entryId, true);
  if (entry.status !== 'pending') throw errors.invalidTransition('journal entry', entry.status, to);
  const accounts = await lockAccounts(
    tx,
    entry.lines.map((l) => l.accountId),
  );
  await writeBalances(
    tx,
    applyAll(accounts, entry.lines, to === 'posted' ? 'post' : 'archive').values(),
  );
  await tx.query('UPDATE journal_entries SET status = $2, updated_at = now() WHERE id = $1', [
    entryId,
    to,
  ]);
  return { ...entry, status: to };
}

/** A posted entry with every line's direction flipped. */
export async function reverseEntry(
  tx: Tx,
  entryId: string,
  opts: { description: string; transferId?: string; allowOverdraft?: boolean },
): Promise<JournalEntry> {
  const original = await getEntry(tx, entryId);
  if (original.status !== 'posted')
    throw errors.invalidTransition('journal entry', original.status, 'reversed');
  return createEntry(tx, {
    status: 'posted',
    description: opts.description,
    transferId: opts.transferId ?? original.transferId,
    reversesEntryId: original.id,
    allowOverdraft: opts.allowOverdraft ?? false,
    lines: original.lines.map((l) => ({
      accountId: l.accountId,
      direction: l.direction === 'debit' ? 'credit' : 'debit',
      amount: l.amount,
    })),
  });
}

export function entryToApi(e: JournalEntry) {
  return {
    id: e.id,
    status: e.status,
    description: e.description,
    transferId: e.transferId,
    reversesEntryId: e.reversesEntryId,
    lines: e.lines.map((l) => ({ ...l, amount: toApiAmount(l.amount) })),
    createdAt: e.createdAt.toISOString(),
  };
}
