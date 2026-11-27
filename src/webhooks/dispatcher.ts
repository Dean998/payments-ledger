import type { Db } from '../db/pool.js';
import { webhookAttempts } from '../observability/metrics.js';
import { backoffMs } from './backoff.js';
import { signedHeaders } from './signing.js';

export type HttpSender = (
  url: string,
  init: { headers: Record<string, string>; body: string; timeoutMs: number },
) => Promise<{ status: number }>;

export const fetchSender: HttpSender = async (url, { headers, body, timeoutMs }) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  });
  await res.body?.cancel();
  return { status: res.status };
};

export interface DispatchOptions {
  batchSize?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  /** How long a claimed delivery is hidden from other dispatchers. */
  leaseMs?: number;
  now?: Date;
}

interface ClaimedDelivery {
  id: string;
  attempts: number;
  url: string;
  secret: string;
  event_id: string;
  type: string;
  payload: unknown;
  created_at: Date;
  sequence: string;
}

/**
 * Delivers due webhooks with at-least-once semantics.
 *
 * Claiming is one UPDATE that pushes next_attempt_at forward by a lease. No
 * transaction is held open during the HTTP call; if this process dies
 * mid-send, the lease expires and another dispatcher retries. Receivers
 * dedupe on the webhook-id header.
 */
export async function dispatchWebhooks(
  db: Db,
  send: HttpSender,
  opts: DispatchOptions = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const maxAttempts = opts.maxAttempts ?? 8;
  const { rows } = await db.query<ClaimedDelivery>(
    `WITH due AS (
       SELECT id FROM webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= $1
        ORDER BY next_attempt_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE webhook_deliveries d
        SET next_attempt_at = $1::timestamptz + make_interval(secs => $3), attempts = d.attempts + 1
       FROM due, webhook_endpoints e, outbox_events o
      WHERE d.id = due.id AND e.id = d.endpoint_id AND o.event_id = d.event_id
     RETURNING d.id, d.attempts, e.url, e.secret, o.event_id, o.type, o.payload, o.created_at, o.id AS sequence`,
    [now, opts.batchSize ?? 50, (opts.leaseMs ?? 30_000) / 1000],
  );

  await Promise.all(
    rows.map(async (d) => {
      const body = JSON.stringify({
        id: d.event_id,
        type: d.type,
        // Deliveries can arrive out of order after retries; receivers can use
        // the sequence to ignore stale updates for the same transfer.
        sequence: Number(d.sequence),
        createdAt: d.created_at.toISOString(),
        data: d.payload,
      });
      let status: number | null = null;
      let error: string | null = null;
      try {
        ({ status } = await send(d.url, {
          headers: { ...signedHeaders(d.secret, d.event_id, body, now) },
          body,
          timeoutMs: opts.timeoutMs ?? 5_000,
        }));
        if (status < 200 || status >= 300) error = `HTTP ${status}`;
      } catch (err) {
        error = (err as Error).message;
      }

      if (!error) {
        webhookAttempts.inc({ outcome: 'delivered' });
        await db.query(
          `UPDATE webhook_deliveries SET status = 'delivered', delivered_at = $2, last_status_code = $3, last_error = NULL
            WHERE id = $1`,
          [d.id, now, status],
        );
      } else if (d.attempts >= maxAttempts) {
        webhookAttempts.inc({ outcome: 'dead' });
        await db.query(
          `UPDATE webhook_deliveries SET status = 'dead', last_status_code = $2, last_error = $3 WHERE id = $1`,
          [d.id, status, error],
        );
      } else {
        webhookAttempts.inc({ outcome: 'retry' });
        await db.query(
          `UPDATE webhook_deliveries SET next_attempt_at = $2, last_status_code = $3, last_error = $4 WHERE id = $1`,
          [d.id, new Date(now.getTime() + backoffMs(d.attempts)), status, error],
        );
      }
    }),
  );
  return rows.length;
}
