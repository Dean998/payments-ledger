import { createPool, withTransaction, type Db } from '../src/db/pool.js';
import { createAccount, type Account } from '../src/ledger/accounts.js';
import { createTransfer } from '../src/transfers/transfers.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://ledger:ledger@localhost:54320/ledger_test';

export function createTestDb(): Db {
  return createPool(TEST_DATABASE_URL, 40);
}

export async function resetDb(db: Db): Promise<void> {
  await db.query(`TRUNCATE accounts, transfers, journal_entries, entry_lines, transfer_events, ach_batches,
    idempotency_keys, outbox_events, webhook_endpoints, webhook_deliveries, reconciliation_runs RESTART IDENTITY CASCADE`);
}

/** A valid ABA routing number (checksum passes) and a test account. */
export const EXTERNAL_ACCOUNT = {
  routingNumber: '021000021',
  accountNumber: '000123456789',
  holderName: 'Ada Lovelace',
};

/** A treasury account that may go negative, used to fund test wallets instantly. */
export async function treasury(db: Db, currency = 'USD'): Promise<Account> {
  return createAccount(db, { name: 'Treasury', currency, allowNegative: true });
}

export async function fundedWallet(
  db: Db,
  amount: number,
  opts: { name?: string; from?: Account } = {},
) {
  const from = opts.from ?? (await treasury(db));
  const wallet = await createAccount(db, { name: opts.name ?? 'Wallet', currency: from.currency });
  if (amount > 0) {
    await withTransaction(db, (tx) =>
      createTransfer(tx, {
        type: 'book',
        amount,
        currency: from.currency,
        sourceAccountId: from.id,
        destinationAccountId: wallet.id,
      }),
    );
  }
  return wallet;
}
