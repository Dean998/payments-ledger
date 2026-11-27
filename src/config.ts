import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().default('postgres://ledger:ledger@localhost:54320/ledger'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  WORKER_METRICS_PORT: z.coerce.number().int().default(9464),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DB_POOL_SIZE: z.coerce.number().int().positive().default(20),

  ACH_SUBMIT_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  ACH_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  // How long after settlement a late return (e.g. R10) can still arrive. Real
  // ACH allows up to 60 days for unauthorised consumer debits.
  ACH_RETURN_WINDOW_MS: z.coerce.number().int().positive().default(120_000),
  MOCK_BANK_SETTLE_AFTER_MS: z.coerce.number().int().positive().default(10_000),
  MOCK_BANK_LATE_RETURN_AFTER_MS: z.coerce.number().int().positive().default(30_000),

  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  WEBHOOK_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  RECONCILIATION_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().positive().default(24),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}
