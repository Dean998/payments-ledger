import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isValidRoutingNumber } from '../ach/routing.js';
import { withTransaction, type Db, type Queryable, type Tx } from '../db/pool.js';
import { DomainError, errors } from '../errors.js';
import { getSettlementAccount, type Account } from '../ledger/accounts.js';
import { createEntry, lockAccounts, transitionEntry, type LineInput } from '../ledger/ledger.js';
import { Currency, fromDb, MinorUnits, toApiAmount } from '../money.js';
import { enqueueEvent } from '../outbox/outbox.js';
import {
  assertTransition,
  eventTypeFor,
  initialStatus,
  type TransferStatus,
  type TransferType,
} from './state.js';

export const ExternalAccountInput = z.object({
  routingNumber: z
    .string()
    .refine(isValidRoutingNumber, 'must be a valid 9-digit ABA routing number'),
  accountNumber: z.string().regex(/^\d{4,17}$/, 'must be 4-17 digits'),
  holderName: z.string().min(1).max(100),
});

const common = {
  amount: MinorUnits,
  currency: Currency,
  description: z.string().max(500).optional(),
};

export const CreateTransferInput = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('book'),
    ...common,
    sourceAccountId: z.uuid(),
    destinationAccountId: z.uuid(),
  }),
  z.object({
    type: z.literal('ach_push'),
    ...common,
    sourceAccountId: z.uuid(),
    externalAccount: ExternalAccountInput,
  }),
  z.object({
    type: z.literal('ach_pull'),
    ...common,
    destinationAccountId: z.uuid(),
    externalAccount: ExternalAccountInput,
  }),
]);
export type CreateTransferInput = z.infer<typeof CreateTransferInput>;

export interface Transfer {
  id: string;
  type: TransferType;
  status: TransferStatus;
  amount: bigint;
  currency: string;
  sourceAccountId: string | null;
  destinationAccountId: string | null;
  externalAccount: { routingNumber: string; accountNumberLast4: string; holderName: string } | null;
  description: string | null;
  entryId: string | null;
  reversalEntryId: string | null;
  achBatchId: string | null;
  bankReference: string | null;
  returnCode: string | null;
  returnReason: string | null;
  createdAt: Date;
  submittedAt: Date | null;
  settledAt: Date | null;
  returnedAt: Date | null;
  canceledAt: Date | null;
}

interface TransferRow {
  id: string;
  type: TransferType;
  status: TransferStatus;
  amount: string;
  currency: string;
  source_account_id: string | null;
  destination_account_id: string | null;
  external_account: Transfer['externalAccount'];
  description: string | null;
  entry_id: string | null;
  reversal_entry_id: string | null;
  ach_batch_id: string | null;
  bank_reference: string | null;
  return_code: string | null;
  return_reason: string | null;
  created_at: Date;
  submitted_at: Date | null;
  settled_at: Date | null;
  returned_at: Date | null;
  canceled_at: Date | null;
}

export function mapTransfer(r: TransferRow): Transfer {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    amount: fromDb(r.amount),
    currency: r.currency,
    sourceAccountId: r.source_account_id,
    destinationAccountId: r.destination_account_id,
    externalAccount: r.external_account,
    description: r.description,
    entryId: r.entry_id,
    reversalEntryId: r.reversal_entry_id,
    achBatchId: r.ach_batch_id,
    bankReference: r.bank_reference,
    returnCode: r.return_code,
    returnReason: r.return_reason,
    createdAt: r.created_at,
    submittedAt: r.submitted_at,
    settledAt: r.settled_at,
    returnedAt: r.returned_at,
    canceledAt: r.canceled_at,
  };
}

export function transferToApi(t: Transfer) {
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    amount: toApiAmount(t.amount),
    currency: t.currency,
    sourceAccountId: t.sourceAccountId,
    destinationAccountId: t.destinationAccountId,
    externalAccount: t.externalAccount,
    description: t.description,
    entryId: t.entryId,
    reversalEntryId: t.reversalEntryId,
    bankReference: t.bankReference,
    returnCode: t.returnCode,
    returnReason: t.returnReason,
    createdAt: t.createdAt.toISOString(),
    submittedAt: iso(t.submittedAt),
    settledAt: iso(t.settledAt),
    returnedAt: iso(t.returnedAt),
    canceledAt: iso(t.canceledAt),
  };
}

export async function getTransfer(
  db: Queryable,
  id: string,
  opts: { lock?: boolean } = {},
): Promise<Transfer> {
  const { rows } = await db.query<TransferRow>(
    `SELECT * FROM transfers WHERE id = $1 ${opts.lock ? 'FOR NO KEY UPDATE' : ''}`,
    [id],
  );
  if (!rows[0]) throw errors.notFound('transfer', id);
  return mapTransfer(rows[0]);
}

/** Transfers move money between wallet-like (credit-normal) customer accounts. */
function assertTransferable(accounts: Map<string, Account>, ids: string[], currency: string): void {
  for (const id of ids) {
    const a = accounts.get(id)!;
    if (a.currency !== currency) throw errors.currencyMismatch(a.currency, currency);
    if (a.systemKey !== null || a.normalBalance !== 'credit') {
      throw errors.validation(`account ${id} cannot be used in a transfer`);
    }
  }
}

export async function createTransfer(tx: Tx, input: CreateTransferInput): Promise<Transfer> {
  const id = randomUUID();
  const entryId = randomUUID();
  const amount = BigInt(input.amount);
  const status = initialStatus(input.type);

  const source = input.type === 'ach_pull' ? null : input.sourceAccountId;
  const destination = input.type === 'ach_push' ? null : input.destinationAccountId;
  const customerIds = [source, destination].filter((x): x is string => x !== null);
  if (source && source === destination)
    throw errors.validation('source and destination accounts must differ');

  // ACH entries balance against the platform's settlement account.
  const bank = input.type === 'book' ? null : await getSettlementAccount(tx, input.currency);

  // Lock every account once, up front, and validate the locked rows: the
  // values we check can't change before we write.
  const locked = await lockAccounts(tx, [...customerIds, ...(bank ? [bank.id] : [])]);
  assertTransferable(locked, customerIds, input.currency);

  const lines: LineInput[] =
    input.type === 'book'
      ? [
          { accountId: source!, direction: 'debit', amount },
          { accountId: destination!, direction: 'credit', amount },
        ]
      : input.type === 'ach_push'
        ? // Money leaves the customer's wallet and our bank account.
          [
            { accountId: source!, direction: 'debit', amount },
            { accountId: bank!.id, direction: 'credit', amount },
          ]
        : // Money arrives in our bank account and the customer's wallet.
          [
            { accountId: bank!.id, direction: 'debit', amount },
            { accountId: destination!, direction: 'credit', amount },
          ];

  let external: Transfer['externalAccount'] = null;
  let externalNumber: string | null = null;
  if (input.type !== 'book') {
    const { routingNumber, accountNumber, holderName } = input.externalAccount;
    external = { routingNumber, accountNumberLast4: accountNumber.slice(-4), holderName };
    externalNumber = accountNumber;
  }

  // entry_id points at an entry inserted just below; the FK is checked at COMMIT.
  const { rows } = await tx.query<TransferRow>(
    `INSERT INTO transfers (id, type, status, amount, currency, source_account_id, destination_account_id,
                            external_account, external_account_number, description, entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [
      id,
      input.type,
      status,
      String(amount),
      input.currency,
      source,
      destination,
      external && JSON.stringify(external),
      externalNumber,
      input.description ?? null,
      entryId,
    ],
  );
  await createEntry(tx, {
    id: entryId,
    lines,
    locked,
    status: input.type === 'book' ? 'posted' : 'pending',
    transferId: id,
    description: input.description ?? `${input.type} transfer ${id}`,
  });
  const transfer = mapTransfer(rows[0]!);
  await tx.query(
    'INSERT INTO transfer_events (transfer_id, from_status, to_status) VALUES ($1, NULL, $2)',
    [id, status],
  );
  await enqueueEvent(tx, eventTypeFor(status), id, transferToApi(transfer));
  return transfer;
}

const TIMESTAMP_COLUMN: Partial<Record<TransferStatus, string>> = {
  submitted: 'submitted_at',
  settled: 'settled_at',
  returned: 'returned_at',
  canceled: 'canceled_at',
};

/**
 * Applies a status change to a transfer that the caller has locked: checks
 * the state machine, stamps the matching timestamp, appends to the audit trail
 * and publishes the event, all in the caller's transaction.
 */
export async function moveTransfer(
  tx: Tx,
  transfer: Transfer,
  to: TransferStatus,
  patch: {
    bankReference?: string;
    returnCode?: string;
    returnReason?: string;
    reversalEntryId?: string;
  } = {},
  reason?: string,
): Promise<Transfer> {
  assertTransition(transfer.type, transfer.status, to);
  const column = TIMESTAMP_COLUMN[to];
  await tx.query(
    `UPDATE transfers SET
        status = $2,
        updated_at = now(),
        bank_reference = COALESCE($3, bank_reference),
        return_code = COALESCE($4, return_code),
        return_reason = COALESCE($5, return_reason),
        reversal_entry_id = COALESCE($6, reversal_entry_id)
        ${column ? `, ${column} = now()` : ''}
      WHERE id = $1`,
    [
      transfer.id,
      to,
      patch.bankReference ?? null,
      patch.returnCode ?? null,
      patch.returnReason ?? null,
      patch.reversalEntryId ?? null,
    ],
  );
  await tx.query(
    'INSERT INTO transfer_events (transfer_id, from_status, to_status, reason) VALUES ($1, $2, $3, $4)',
    [transfer.id, transfer.status, to, reason ?? null],
  );
  const updated = await getTransfer(tx, transfer.id);
  await enqueueEvent(tx, eventTypeFor(to), transfer.id, transferToApi(updated));
  return updated;
}

export async function cancelTransfer(db: Db, id: string): Promise<Transfer> {
  return withTransaction(db, async (tx) => {
    const transfer = await getTransfer(tx, id, { lock: true });
    assertTransition(transfer.type, transfer.status, 'canceled');
    if (transfer.achBatchId) {
      throw new DomainError(
        'transfer_not_cancelable',
        'transfer is already in a batch being sent to the bank and can no longer be canceled',
        409,
      );
    }
    await transitionEntry(tx, transfer.entryId!, 'archived');
    return moveTransfer(tx, transfer, 'canceled', {}, 'canceled by client');
  });
}

export async function listTransferEvents(db: Queryable, id: string) {
  await getTransfer(db, id);
  const { rows } = await db.query<{
    id: string;
    from_status: string | null;
    to_status: string;
    reason: string | null;
    created_at: Date;
  }>('SELECT * FROM transfer_events WHERE transfer_id = $1 ORDER BY id', [id]);
  return rows.map((r) => ({
    id: r.id,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    reason: r.reason,
    createdAt: r.created_at.toISOString(),
  }));
}
