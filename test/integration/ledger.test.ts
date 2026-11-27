import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/pool.js';
import { DomainError } from '../../src/errors.js';
import { createAccount, getAccount } from '../../src/ledger/accounts.js';
import { computeBalances } from '../../src/ledger/balances.js';
import { createEntry, transitionEntry } from '../../src/ledger/ledger.js';
import { createTestDb, resetDb } from '../helpers.js';

const db = createTestDb();
afterAll(() => db.end());
beforeEach(() => resetDb(db));

async function twoAccounts() {
  const cash = await createAccount(db, {
    name: 'Cash',
    currency: 'USD',
    normalBalance: 'debit',
    allowNegative: true,
  });
  const wallet = await createAccount(db, { name: 'Wallet', currency: 'USD' });
  return { cash, wallet };
}

async function balances(id: string) {
  const a = await getAccount(db, id);
  return computeBalances(a.normalBalance, a);
}

describe('journal entries', () => {
  it('posts a balanced entry and updates both balances', async () => {
    const { cash, wallet } = await twoAccounts();
    await withTransaction(db, (tx) =>
      createEntry(tx, {
        status: 'posted',
        lines: [
          { accountId: cash.id, direction: 'debit', amount: 5000n },
          { accountId: wallet.id, direction: 'credit', amount: 5000n },
        ],
      }),
    );
    expect(await balances(cash.id)).toEqual({ posted: 5000n, pending: 5000n, available: 5000n });
    expect(await balances(wallet.id)).toEqual({ posted: 5000n, pending: 5000n, available: 5000n });
  });

  it('tracks pending entries separately until they post', async () => {
    const { cash, wallet } = await twoAccounts();
    const entry = await withTransaction(db, (tx) =>
      createEntry(tx, {
        status: 'pending',
        lines: [
          { accountId: cash.id, direction: 'debit', amount: 700n },
          { accountId: wallet.id, direction: 'credit', amount: 700n },
        ],
      }),
    );
    expect(await balances(wallet.id)).toEqual({ posted: 0n, pending: 700n, available: 0n });
    await withTransaction(db, (tx) => transitionEntry(tx, entry.id, 'posted'));
    expect(await balances(wallet.id)).toEqual({ posted: 700n, pending: 700n, available: 700n });
  });

  it('rejects an unbalanced entry in the service', async () => {
    const { cash, wallet } = await twoAccounts();
    await expect(
      withTransaction(db, (tx) =>
        createEntry(tx, {
          status: 'posted',
          lines: [
            { accountId: cash.id, direction: 'debit', amount: 100n },
            { accountId: wallet.id, direction: 'credit', amount: 99n },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'unbalanced_entry' });
  });

  it('the database itself refuses an unbalanced entry, even when the service is bypassed', async () => {
    const { cash, wallet } = await twoAccounts();
    const id = crypto.randomUUID();
    await expect(
      withTransaction(db, async (tx) => {
        await tx.query(`INSERT INTO journal_entries (id, status) VALUES ($1, 'posted')`, [id]);
        await tx.query(
          `INSERT INTO entry_lines (entry_id, account_id, direction, amount, currency)
           VALUES ($1, $2, 'debit', 100, 'USD'), ($1, $3, 'credit', 1, 'USD')`,
          [id, cash.id, wallet.id],
        );
      }),
    ).rejects.toThrow(/unbalanced/);
  });

  it('entry lines are append-only and posted entries are final', async () => {
    const { cash, wallet } = await twoAccounts();
    const entry = await withTransaction(db, (tx) =>
      createEntry(tx, {
        status: 'posted',
        lines: [
          { accountId: cash.id, direction: 'debit', amount: 100n },
          { accountId: wallet.id, direction: 'credit', amount: 100n },
        ],
      }),
    );
    await expect(
      db.query('UPDATE entry_lines SET amount = 1 WHERE entry_id = $1', [entry.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query('DELETE FROM entry_lines WHERE entry_id = $1', [entry.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`UPDATE journal_entries SET status = 'archived' WHERE id = $1`, [entry.id]),
    ).rejects.toThrow(/cannot become archived/);
  });

  it('refuses to overdraw an account unless it allows negative balances', async () => {
    const { cash, wallet } = await twoAccounts();
    const other = await createAccount(db, { name: 'Other', currency: 'USD' });
    const err = await withTransaction(db, (tx) =>
      createEntry(tx, {
        status: 'posted',
        lines: [
          { accountId: wallet.id, direction: 'debit', amount: 1n },
          { accountId: other.id, direction: 'credit', amount: 1n },
        ],
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe('insufficient_funds');

    // The cash account allows negative balances.
    await withTransaction(db, (tx) =>
      createEntry(tx, {
        status: 'posted',
        lines: [
          { accountId: wallet.id, direction: 'debit', amount: 1n },
          { accountId: cash.id, direction: 'credit', amount: 1n },
        ],
        allowOverdraft: true,
      }),
    );
    expect((await balances(cash.id)).posted).toBe(-1n);
  });
});
