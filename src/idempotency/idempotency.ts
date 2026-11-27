import { createHash } from 'node:crypto';
import { withTransaction, type Db, type Queryable, type Tx } from '../db/pool.js';
import { DomainError, errors } from '../errors.js';

export interface IdempotentResult {
  status: number;
  body: unknown;
  replayed: boolean;
}

/** Stable hash of a JSON body: key order does not matter. */
export function hashRequest(body: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(body)))
    .digest('hex');
}

/**
 * Runs fn at most once per (scope, key) and replays the stored response for
 * later requests with the same key.
 *
 * The key row is inserted in the SAME transaction as the business change, so
 * "the effect happened" and "the response is stored" commit or roll back
 * together. A concurrent request with the same key blocks on the unique index
 * until the first transaction finishes, then reads its stored response; no
 * separate lock or "in progress" state is needed.
 *
 * Deterministic business failures (DomainError, e.g. insufficient funds) are
 * stored and replayed too, as Stripe does. Unexpected errors roll everything
 * back so the client can retry with the same key.
 */
export async function runIdempotent(
  db: Db,
  params: { scope: string; key: string; requestHash: string },
  fn: (tx: Tx) => Promise<{ status: number; body: unknown }>,
): Promise<IdempotentResult> {
  return withTransaction(db, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash) VALUES ($1, $2, $3)
       ON CONFLICT (scope, key) DO NOTHING RETURNING 1`,
      [params.scope, params.key, params.requestHash],
    );

    if (inserted.rowCount === 0) {
      const { rows } = await tx.query<{
        request_hash: string;
        response_status: number;
        response_body: unknown;
      }>(
        'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE scope = $1 AND key = $2',
        [params.scope, params.key],
      );
      const existing = rows[0]!;
      if (existing.request_hash !== params.requestHash) throw errors.idempotencyKeyReused();
      return { status: existing.response_status, body: existing.response_body, replayed: true };
    }

    let result: { status: number; body: unknown };
    await tx.query('SAVEPOINT idempotent_work');
    try {
      result = await fn(tx);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      await tx.query('ROLLBACK TO SAVEPOINT idempotent_work');
      result = { status: err.httpStatus, body: err.toResponse() };
    }
    await tx.query(
      'UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE scope = $1 AND key = $2',
      [params.scope, params.key, result.status, JSON.stringify(result.body)],
    );
    return { ...result, replayed: false };
  });
}

export async function purgeIdempotencyKeys(db: Queryable, ttlHours: number): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => $1)`,
    [ttlHours],
  );
  return rowCount ?? 0;
}
