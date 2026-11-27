export type Direction = 'debit' | 'credit';
export type NormalBalance = Direction;

/** The four materialised columns on an account row. Pending excludes posted. */
export interface BalanceColumns {
  postedDebits: bigint;
  postedCredits: bigint;
  pendingDebits: bigint;
  pendingCredits: bigint;
}

export interface Balances {
  /** Settled money only. */
  posted: bigint;
  /** Posted plus everything in flight, in both directions. */
  pending: bigint;
  /**
   * What the holder can spend now: posted minus pending outflows. Pending
   * inflows do not count until they post, because an incoming ACH pull can
   * still be returned.
   */
  available: bigint;
}

export function computeBalances(normal: NormalBalance, c: BalanceColumns): Balances {
  const sign = normal === 'credit' ? 1n : -1n;
  const posted = sign * (c.postedCredits - c.postedDebits);
  const pending = sign * (c.postedCredits + c.pendingCredits - (c.postedDebits + c.pendingDebits));
  const pendingOutflow = normal === 'credit' ? c.pendingDebits : c.pendingCredits;
  return { posted, pending, available: posted - pendingOutflow };
}

/**
 * How a line changes the balance columns:
 *  - create-pending: a new pending entry
 *  - create-posted:  a new entry that posts immediately
 *  - post:           a pending entry becomes posted
 *  - archive:        a pending entry is voided
 */
export type LineEffect = 'create-pending' | 'create-posted' | 'post' | 'archive';

export function applyLine(
  c: BalanceColumns,
  direction: Direction,
  amount: bigint,
  effect: LineEffect,
): BalanceColumns {
  const next = { ...c };
  const posted = direction === 'debit' ? 'postedDebits' : 'postedCredits';
  const pending = direction === 'debit' ? 'pendingDebits' : 'pendingCredits';
  switch (effect) {
    case 'create-pending':
      next[pending] += amount;
      break;
    case 'create-posted':
      next[posted] += amount;
      break;
    case 'post':
      next[pending] -= amount;
      next[posted] += amount;
      break;
    case 'archive':
      next[pending] -= amount;
      break;
  }
  if (next[pending] < 0n) throw new Error(`pending ${direction}s would go negative`);
  return next;
}
