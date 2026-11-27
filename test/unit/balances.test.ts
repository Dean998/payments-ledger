import { describe, expect, it } from 'vitest';
import { applyLine, computeBalances, type BalanceColumns } from '../../src/ledger/balances.js';

const zero: BalanceColumns = {
  postedDebits: 0n,
  postedCredits: 0n,
  pendingDebits: 0n,
  pendingCredits: 0n,
};

describe('computeBalances', () => {
  it('credit-normal: pending outflows reduce available, pending inflows do not add to it', () => {
    const c = {
      postedDebits: 200n,
      postedCredits: 1000n,
      pendingDebits: 300n,
      pendingCredits: 500n,
    };
    expect(computeBalances('credit', c)).toEqual({ posted: 800n, pending: 1000n, available: 500n });
  });

  it('debit-normal accounts mirror the signs', () => {
    const c = {
      postedDebits: 1000n,
      postedCredits: 200n,
      pendingDebits: 500n,
      pendingCredits: 300n,
    };
    expect(computeBalances('debit', c)).toEqual({ posted: 800n, pending: 1000n, available: 500n });
  });
});

describe('applyLine', () => {
  it('moves a pending amount to posted', () => {
    const pending = applyLine(zero, 'credit', 100n, 'create-pending');
    expect(pending.pendingCredits).toBe(100n);
    const posted = applyLine(pending, 'credit', 100n, 'post');
    expect(posted).toEqual({ ...zero, postedCredits: 100n });
  });

  it('archiving removes the pending amount without posting it', () => {
    const pending = applyLine(zero, 'debit', 100n, 'create-pending');
    expect(applyLine(pending, 'debit', 100n, 'archive')).toEqual(zero);
  });

  it('refuses to drive pending totals negative', () => {
    expect(() => applyLine(zero, 'debit', 1n, 'post')).toThrow(/negative/);
  });
});
