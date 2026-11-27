import { createServer } from 'node:http';
import { pino } from 'pino';
import { pollAchNetwork, submitAchBatches } from './ach/jobs.js';
import { MockAchNetwork } from './ach/mock-network.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { purgeIdempotencyKeys } from './idempotency/idempotency.js';
import { startJobs } from './jobs/scheduler.js';
import { outboxLag, registry } from './observability/metrics.js';
import { outboxLagSeconds, relayOutbox } from './outbox/outbox.js';
import { runReconciliation } from './reconciliation/reconcile.js';
import { dispatchWebhooks, fetchSender } from './webhooks/dispatcher.js';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL, base: { service: 'ledger-worker' } });
const db = createPool(config.DATABASE_URL, config.DB_POOL_SIZE);
const network = new MockAchNetwork({
  settleAfterMs: config.MOCK_BANK_SETTLE_AFTER_MS,
  lateReturnAfterMs: config.MOCK_BANK_LATE_RETURN_AFTER_MS,
});

const jobs = startJobs(
  [
    {
      name: 'ach-submit',
      everyMs: config.ACH_SUBMIT_INTERVAL_MS,
      run: () => submitAchBatches(db, network),
    },
    {
      name: 'ach-poll',
      everyMs: config.ACH_POLL_INTERVAL_MS,
      run: () => pollAchNetwork(db, network, { returnWindowMs: config.ACH_RETURN_WINDOW_MS }),
    },
    {
      name: 'outbox-relay',
      everyMs: config.OUTBOX_POLL_INTERVAL_MS,
      run: async () => {
        const relayed = await relayOutbox(db);
        outboxLag.set(await outboxLagSeconds(db));
        return relayed;
      },
    },
    {
      name: 'webhook-dispatch',
      everyMs: config.WEBHOOK_POLL_INTERVAL_MS,
      run: () =>
        dispatchWebhooks(db, fetchSender, {
          maxAttempts: config.WEBHOOK_MAX_ATTEMPTS,
          timeoutMs: config.WEBHOOK_TIMEOUT_MS,
        }),
    },
    {
      name: 'reconciliation',
      everyMs: config.RECONCILIATION_INTERVAL_MS,
      run: async () => {
        const report = await runReconciliation(db);
        if (report.status !== 'ok') log.error({ report }, 'reconciliation found discrepancies');
        return { status: report.status };
      },
    },
    {
      name: 'idempotency-purge',
      everyMs: 60 * 60 * 1000,
      run: () => purgeIdempotencyKeys(db, config.IDEMPOTENCY_TTL_HOURS),
    },
  ],
  log,
);

const metricsServer = createServer((req, res) => {
  if (req.url !== '/metrics') return void res.writeHead(404).end();
  registry
    .metrics()
    .then((body) => res.writeHead(200, { 'content-type': registry.contentType }).end(body))
    .catch(() => res.writeHead(500).end());
}).listen(config.WORKER_METRICS_PORT);

log.info({ metricsPort: config.WORKER_METRICS_PORT }, 'worker started');

async function shutdown(signal: string) {
  log.info({ signal }, 'shutting down; finishing in-flight jobs');
  await jobs.stop();
  metricsServer.close();
  await db.end();
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
