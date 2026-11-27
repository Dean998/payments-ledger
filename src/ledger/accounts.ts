import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/pool.js';
import { errors } from '../errors.js';
import { fromDb, toApiAmount } from '../money.js';
import { computeBalances, type BalanceColumns, type NormalBalance } from './balances.js';

export interface Account extends BalanceColumns {
  id: string;
  name: string;
  normalBalance: NormalBalance;
  currency: string;
  allowNegative: boolean;
  systemKey: string | null;
  metadata: Record<string, string>;
  createdAt: Date;
}

export interface AccountRow {
  id: string;
  name: string;
  normal_balance: NormalBalance;
  currency: string;
  allow_negative: boolean;
  system_key: string | null;
  posted_debits: string;
  posted_credits: string;
  pending_debits: string;
  pending_credits: string;
  metadata: Record<string, string>;
  created_at: Date;
}

export function mapAccount(r: AccountRow): Account {
  return {
    id: r.id,
    name: r.name,
    normalBalance: r.normal_balance,
    currency: r.currency,
    allowNegative: r.allow_negative,
    systemKey: r.system_key,
    postedDebits: fromDb(r.posted_debits),
    postedCredits: fromDb(r.posted_credits),
    pendingDebits: fromDb(r.pending_debits),
    pendingCredits: fromDb(r.pending_credits),
    metadata: r.metadata,
    createdAt: r.created_at,
  };
}

export function accountToApi(a: Account) {
  const b = computeBalances(a.normalBalance, a);
  return {
    id: a.id,
    name: a.name,
    currency: a.currency,
    normalBalance: a.normalBalance,
    allowNegative: a.allowNegative,
    system: a.systemKey !== null,
    balances: {
      posted: toApiAmount(b.posted),
      pending: toApiAmount(b.pending),
      available: toApiAmount(b.available),
    },
    metadata: a.metadata,
    createdAt: a.createdAt.toISOString(),
  };
}

export interface CreateAccountInput {
  name: string;
  currency: string;
  normalBalance?: NormalBalance;
  allowNegative?: boolean;
  metadata?: Record<string, string>;
}

export async function createAccount(db: Queryable, input: CreateAccountInput): Promise<Account> {
  const { rows } = await db.query<AccountRow>(
    `INSERT INTO accounts (id, name, currency, normal_balance, allow_negative, metadata)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      randomUUID(),
      input.name,
      input.currency,
      input.normalBalance ?? 'credit',
      input.allowNegative ?? false,
      input.metadata ?? {},
    ],
  );
  return mapAccount(rows[0]!);
}

export async function getAccount(db: Queryable, id: string): Promise<Account> {
  const { rows } = await db.query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [id]);
  if (!rows[0]) throw errors.notFound('account', id);
  return mapAccount(rows[0]);
}

/**
 * The platform's settlement account at the bank for a currency. It is the
 * other side of every ACH entry. It is created on first use and allowed to go
 * negative (an asset account reflecting money owed by the bank).
 */
export async function getSettlementAccount(db: Queryable, currency: string): Promise<Account> {
  const key = `bank:${currency}`;
  const existing = await db.query<AccountRow>('SELECT * FROM accounts WHERE system_key = $1', [
    key,
  ]);
  if (existing.rows[0]) return mapAccount(existing.rows[0]);
  await db.query(
    `INSERT INTO accounts (id, name, currency, normal_balance, allow_negative, system_key)
     VALUES ($1, $2, $3, 'debit', true, $4)
     ON CONFLICT (system_key) DO NOTHING`,
    [randomUUID(), `Settlement account (${currency})`, currency, key],
  );
  const { rows } = await db.query<AccountRow>('SELECT * FROM accounts WHERE system_key = $1', [
    key,
  ]);
  return mapAccount(rows[0]!);
}

export interface LineView {
  id: string;
  entryId: string;
  entryStatus: string;
  direction: string;
  amount: number;
  currency: string;
  description: string | null;
  createdAt: string;
}

export async function listAccountLines(
  db: Queryable,
  accountId: string,
  opts: { limit: number; before?: string | undefined },
): Promise<{ data: LineView[]; nextCursor: string | null }> {
  await getAccount(db, accountId);
  const { rows } = await db.query<{
    id: string;
    entry_id: string;
    status: string;
    direction: string;
    amount: string;
    currency: string;
    description: string | null;
    created_at: Date;
  }>(
    `SELECT l.id, l.entry_id, e.status, l.direction, l.amount, l.currency, e.description, e.created_at
       FROM entry_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = $1 AND ($2::bigint IS NULL OR l.id < $2::bigint)
      ORDER BY l.id DESC
      LIMIT $3`,
    [accountId, opts.before ?? null, opts.limit + 1],
  );
  const page = rows.slice(0, opts.limit);
  return {
    data: page.map((r) => ({
      id: r.id,
      entryId: r.entry_id,
      entryStatus: r.status,
      direction: r.direction,
      amount: toApiAmount(fromDb(r.amount)),
      currency: r.currency,
      description: r.description,
      createdAt: r.created_at.toISOString(),
    })),
    nextCursor: rows.length > opts.limit ? page[page.length - 1]!.id : null,
  };
}
