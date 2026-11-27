import pg from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
/** Anything that can run a query: the pool or a client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max });
  // An idle client can error (e.g. Postgres restarts). Without a listener this
  // would crash the process; the next query will get a fresh connection.
  pool.on('error', () => {});
  return pool;
}

// serialization_failure, deadlock_detected: safe to retry the whole transaction.
const RETRYABLE_CODES = new Set(['40001', '40P01']);

function isRetryable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    RETRYABLE_CODES.has((err as { code?: string }).code ?? '')
  );
}

export interface TransactionOptions {
  isolation?: 'read committed' | 'repeatable read' | 'serializable';
  readOnly?: boolean;
  retries?: number;
}

/**
 * Runs fn inside a transaction. The whole function is retried on
 * serialization failures and deadlocks, so fn must not have side effects
 * outside the database.
 */
export async function withTransaction<T>(
  db: Db,
  fn: (tx: Tx) => Promise<T>,
  opts: TransactionOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const client = await db.connect();
    try {
      const mode = [
        `ISOLATION LEVEL ${(opts.isolation ?? 'read committed').toUpperCase()}`,
        opts.readOnly ? 'READ ONLY' : 'READ WRITE',
      ].join(' ');
      await client.query(`BEGIN ${mode}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (attempt < retries && isRetryable(err)) {
        await sleep(Math.random() * 20 * 2 ** attempt);
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
