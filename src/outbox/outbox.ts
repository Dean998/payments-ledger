import { randomUUID } from 'node:crypto';
import { withTransaction, type Db, type Queryable } from '../db/pool.js';

/**
 * Records an event in the same transaction as the state change it describes.
 * If the transaction rolls back, the event never existed; if it commits, the
 * relay is guaranteed to see it. This avoids the dual-write problem of
 * "update the database, then publish", where either step can fail alone.
 */
export async function enqueueEvent(
  tx: Queryable,
  type: string,
  aggregateId: string,
  payload: unknown,
): Promise<string> {
  const eventId = randomUUID();
  await tx.query(
    'INSERT INTO outbox_events (event_id, type, aggregate_id, payload) VALUES ($1, $2, $3, $4)',
    [eventId, type, aggregateId, JSON.stringify(payload)],
  );
  return eventId;
}

/**
 * Moves unpublished events to their subscribers: one webhook_deliveries row
 * per matching endpoint. SKIP LOCKED lets several relays run in parallel
 * without handing out the same event twice.
 */
export async function relayOutbox(db: Db, opts: { batchSize?: number } = {}): Promise<number> {
  return withTransaction(db, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM outbox_events WHERE published_at IS NULL
        ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [opts.batchSize ?? 200],
    );
    if (rows.length === 0) return 0;
    const ids = rows.map((r) => r.id);
    await tx.query(
      `INSERT INTO webhook_deliveries (endpoint_id, event_id)
       SELECT w.id, o.event_id
         FROM outbox_events o
         JOIN webhook_endpoints w ON w.enabled AND (w.event_types IS NULL OR o.type = ANY (w.event_types))
        WHERE o.id = ANY ($1::bigint[])
       ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
      [ids],
    );
    await tx.query('UPDATE outbox_events SET published_at = now() WHERE id = ANY ($1::bigint[])', [
      ids,
    ]);
    return ids.length;
  });
}

/** Age of the oldest unpublished event, in seconds. A key health signal. */
export async function outboxLagSeconds(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ lag: number | null }>(
    `SELECT EXTRACT(EPOCH FROM now() - min(created_at))::float8 AS lag
       FROM outbox_events WHERE published_at IS NULL`,
  );
  return rows[0]?.lag ?? 0;
}
