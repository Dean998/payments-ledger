import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { TEST_DATABASE_URL } from './helpers.js';

/** Creates a fresh test database and applies the migrations once per run. */
export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  const name = url.pathname.slice(1);
  if (!/^[a-z_]+$/.test(name)) throw new Error(`refusing to recreate database "${name}"`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${name}`);
  await client.end();

  const db = createPool(TEST_DATABASE_URL, 1);
  await migrate(db);
  await db.end();
}
