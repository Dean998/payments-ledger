import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/pool.js';
import { errors } from '../errors.js';
import { generateSecret } from './signing.js';

export async function createWebhookEndpoint(
  db: Queryable,
  input: { url: string; eventTypes?: string[] | undefined; secret?: string | undefined },
) {
  const { rows } = await db.query<{
    id: string;
    url: string;
    secret: string;
    event_types: string[] | null;
    created_at: Date;
  }>(
    `INSERT INTO webhook_endpoints (id, url, secret, event_types) VALUES ($1, $2, $3, $4) RETURNING *`,
    [randomUUID(), input.url, input.secret ?? generateSecret(), input.eventTypes ?? null],
  );
  const e = rows[0]!;
  return {
    id: e.id,
    url: e.url,
    secret: e.secret,
    eventTypes: e.event_types,
    createdAt: e.created_at.toISOString(),
  };
}

export async function listDeliveries(db: Queryable, endpointId: string, limit = 50) {
  const exists = await db.query('SELECT 1 FROM webhook_endpoints WHERE id = $1', [endpointId]);
  if (exists.rowCount === 0) throw errors.notFound('webhook endpoint', endpointId);
  const { rows } = await db.query<{
    id: string;
    event_id: string;
    type: string;
    status: string;
    attempts: number;
    next_attempt_at: Date;
    last_status_code: number | null;
    last_error: string | null;
    delivered_at: Date | null;
  }>(
    `SELECT d.*, o.type FROM webhook_deliveries d JOIN outbox_events o ON o.event_id = d.event_id
      WHERE d.endpoint_id = $1 ORDER BY d.id DESC LIMIT $2`,
    [endpointId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    eventId: r.event_id,
    eventType: r.type,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.status === 'pending' ? r.next_attempt_at.toISOString() : null,
    lastStatusCode: r.last_status_code,
    lastError: r.last_error,
    deliveredAt: r.delivered_at?.toISOString() ?? null,
  }));
}
