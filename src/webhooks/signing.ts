import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signatures follow the Standard Webhooks spec (standardwebhooks.com), so
 * receivers can verify them with an off-the-shelf library:
 *   webhook-id, webhook-timestamp, webhook-signature: "v1,<base64 HMAC-SHA256>"
 * The signed content is `${id}.${timestamp}.${body}`. The timestamp limits
 * replay attacks; the id lets receivers deduplicate at-least-once deliveries.
 */

const PREFIX = 'whsec_';

export function generateSecret(): string {
  return PREFIX + randomBytes(24).toString('base64');
}

function keyFrom(secret: string): Buffer {
  return Buffer.from(secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret, 'base64');
}

export function sign(secret: string, msgId: string, timestampSec: number, body: string): string {
  const mac = createHmac('sha256', keyFrom(secret))
    .update(`${msgId}.${timestampSec}.${body}`)
    .digest('base64');
  return `v1,${mac}`;
}

export interface WebhookHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

export function signedHeaders(
  secret: string,
  msgId: string,
  body: string,
  now = new Date(),
): WebhookHeaders {
  const ts = Math.floor(now.getTime() / 1000);
  return {
    'webhook-id': msgId,
    'webhook-timestamp': String(ts),
    'webhook-signature': sign(secret, msgId, ts, body),
  };
}

export function verify(
  secret: string,
  headers: Partial<WebhookHeaders>,
  body: string,
  opts: { toleranceSec?: number; now?: Date } = {},
): boolean {
  const id = headers['webhook-id'];
  const ts = Number(headers['webhook-timestamp']);
  const sigHeader = headers['webhook-signature'];
  if (!id || !sigHeader || !Number.isInteger(ts)) return false;
  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSec - ts) > (opts.toleranceSec ?? 300)) return false;

  const expected = Buffer.from(sign(secret, id, ts, body));
  // The header may hold several space-separated signatures during key rotation.
  return sigHeader.split(' ').some((candidate) => {
    const got = Buffer.from(candidate);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
