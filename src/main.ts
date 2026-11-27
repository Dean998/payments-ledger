import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL, config.DB_POOL_SIZE);
const app = buildApp({ db, logger: { level: config.LOG_LEVEL } });

async function shutdown(signal: string) {
  app.log.info({ signal }, 'shutting down');
  await app.close(); // stops accepting connections, waits for in-flight requests
  await db.end();
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.PORT, host: config.HOST });
