import { describe, expect, it } from 'vitest';
import { MockAchNetwork } from '../../src/ach/mock-network.js';
import { isValidRoutingNumber } from '../../src/ach/routing.js';
import { hashRequest } from '../../src/idempotency/idempotency.js';
import { formatMinor, toApiAmount } from '../../src/money.js';
import { backoffMs } from '../../src/webhooks/backoff.js';

describe('routing numbers', () => {
  it('accepts valid ABA checksums and rejects typos', () => {
    expect(isValidRoutingNumber('021000021')).toBe(true);
    expect(isValidRoutingNumber('011000015')).toBe(true);
    expect(isValidRoutingNumber('021000022')).toBe(false);
    expect(isValidRoutingNumber('12345678')).toBe(false);
  });
});

describe('backoff', () => {
  it('grows exponentially within [ceiling/2, ceiling] and is capped', () => {
    expect(backoffMs(1, {}, () => 0)).toBe(500);
    expect(backoffMs(1, {}, () => 1)).toBe(1000);
    expect(backoffMs(4, {}, () => 0)).toBe(4000);
    expect(backoffMs(40, { maxMs: 60_000 }, () => 1)).toBe(60_000);
  });
});

describe('request hashing', () => {
  it('ignores key order but not values', () => {
    expect(hashRequest({ a: 1, b: { c: 2, d: 3 } })).toBe(hashRequest({ b: { d: 3, c: 2 }, a: 1 }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
  });
});

describe('money', () => {
  it('formats minor units and refuses unsafe numbers', () => {
    expect(formatMinor(-12345n, 'USD')).toBe('-123.45 USD');
    expect(formatMinor(5n, 'USD')).toBe('0.05 USD');
    expect(() => toApiAmount(2n ** 60n)).toThrow(RangeError);
  });
});

describe('mock ACH network', () => {
  const network = new MockAchNetwork({ settleAfterMs: 1000, lateReturnAfterMs: 5000 });
  const submittedAt = new Date('2026-01-01T00:00:00Z');
  const at = (ms: number) => new Date(submittedAt.getTime() + ms);
  const item = (amount: bigint, status: 'submitted' | 'settled' = 'submitted') => ({
    transferId: 't',
    bankReference: 'r',
    amount,
    status,
    submittedAt,
  });

  it('settles normal amounts after the delay', async () => {
    expect(await network.fetchUpdates([item(10000n)], at(999))).toEqual([]);
    expect(await network.fetchUpdates([item(10000n)], at(1000))).toEqual([
      { transferId: 't', kind: 'settled' },
    ]);
  });

  it('returns .01 amounts with R01 before settlement', async () => {
    expect(await network.fetchUpdates([item(10001n)], at(500))).toMatchObject([
      { kind: 'returned', returnCode: 'R01' },
    ]);
  });

  it('settles .10 amounts, then returns them late with R10', async () => {
    expect(await network.fetchUpdates([item(25010n)], at(1000))).toMatchObject([
      { kind: 'settled' },
    ]);
    expect(await network.fetchUpdates([item(25010n, 'settled')], at(4999))).toEqual([]);
    expect(await network.fetchUpdates([item(25010n, 'settled')], at(5000))).toMatchObject([
      { kind: 'returned', returnCode: 'R10' },
    ]);
  });
});
