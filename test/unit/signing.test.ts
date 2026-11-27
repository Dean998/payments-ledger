import { describe, expect, it } from 'vitest';
import { generateSecret, sign, signedHeaders, verify } from '../../src/webhooks/signing.js';

describe('webhook signing (Standard Webhooks)', () => {
  it('matches the reference test vector from the spec', () => {
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    expect(sign(secret, 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}')).toBe(
      'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    );
  });

  const secret = generateSecret();
  const body = JSON.stringify({ type: 'transfer.settled', data: { id: 't1' } });
  const now = new Date('2026-01-01T00:00:00Z');

  it('verifies its own signatures', () => {
    expect(verify(secret, signedHeaders(secret, 'evt_1', body, now), body, { now })).toBe(true);
  });

  it('rejects a tampered body, a wrong secret and a stale timestamp', () => {
    const headers = signedHeaders(secret, 'evt_1', body, now);
    expect(verify(secret, headers, body.replace('t1', 't2'), { now })).toBe(false);
    expect(verify(generateSecret(), headers, body, { now })).toBe(false);
    expect(verify(secret, headers, body, { now: new Date(now.getTime() + 10 * 60_000) })).toBe(
      false,
    );
  });

  it('accepts any of several signatures (key rotation)', () => {
    const headers = signedHeaders(secret, 'evt_1', body, now);
    const rotated = { ...headers, 'webhook-signature': `v1,AAAA ${headers['webhook-signature']}` };
    expect(verify(secret, rotated, body, { now })).toBe(true);
  });
});
