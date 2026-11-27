import { errors } from '../errors.js';

export type TransferType = 'book' | 'ach_push' | 'ach_pull';
export type TransferStatus =
  'posted' | 'pending' | 'submitted' | 'settled' | 'returned' | 'canceled';

/**
 * Book transfers move money between two accounts on this ledger and post
 * immediately. ACH transfers go through the bank network:
 *
 *   pending ──► submitted ──► settled ──► returned   (late return, e.g. R10)
 *      │             │
 *      ▼             ▼
 *   canceled      returned                          (e.g. R01 insufficient funds)
 *
 * "Settled" is not final in ACH: some returns arrive after settlement.
 */
const ACH_TRANSITIONS: Record<TransferStatus, readonly TransferStatus[]> = {
  pending: ['submitted', 'canceled'],
  submitted: ['settled', 'returned'],
  settled: ['returned'],
  returned: [],
  canceled: [],
  posted: [],
};

export function initialStatus(type: TransferType): TransferStatus {
  return type === 'book' ? 'posted' : 'pending';
}

export function canTransition(
  type: TransferType,
  from: TransferStatus,
  to: TransferStatus,
): boolean {
  if (type === 'book') return false;
  return ACH_TRANSITIONS[from].includes(to);
}

export function assertTransition(
  type: TransferType,
  from: TransferStatus,
  to: TransferStatus,
): void {
  if (!canTransition(type, from, to)) throw errors.invalidTransition('transfer', from, to);
}

export function isTerminal(type: TransferType, status: TransferStatus): boolean {
  return type === 'book' || ACH_TRANSITIONS[status].length === 0;
}

/** Event type published to the outbox when a transfer reaches a status. */
export function eventTypeFor(status: TransferStatus): string {
  return status === 'pending' ? 'transfer.created' : `transfer.${status}`;
}
