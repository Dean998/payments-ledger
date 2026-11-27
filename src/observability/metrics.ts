import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency by route and status code',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const transfersCreated = new client.Counter({
  name: 'ledger_transfers_created_total',
  help: 'Transfers created (idempotent replays excluded)',
  labelNames: ['type'] as const,
  registers: [registry],
});

export const transferRejections = new client.Counter({
  name: 'ledger_transfer_rejections_total',
  help: 'Transfer requests rejected with a business error',
  labelNames: ['code'] as const,
  registers: [registry],
});

export const achUpdatesApplied = new client.Counter({
  name: 'ledger_ach_updates_applied_total',
  help: 'Bank network updates applied to transfers',
  labelNames: ['kind', 'return_code'] as const,
  registers: [registry],
});

export const achTransfersSubmitted = new client.Counter({
  name: 'ledger_ach_transfers_submitted_total',
  help: 'ACH transfers sent to the bank network',
  registers: [registry],
});

export const webhookAttempts = new client.Counter({
  name: 'ledger_webhook_delivery_attempts_total',
  help: 'Webhook delivery attempts by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const outboxLag = new client.Gauge({
  name: 'ledger_outbox_lag_seconds',
  help: 'Age of the oldest unpublished outbox event',
  registers: [registry],
});

export const reconciliationDiscrepancies = new client.Gauge({
  name: 'ledger_reconciliation_discrepancies',
  help: 'Discrepancies found by the latest reconciliation run',
  registers: [registry],
});

export const jobDuration = new client.Histogram({
  name: 'ledger_job_duration_seconds',
  help: 'Background job run duration',
  labelNames: ['job', 'result'] as const,
  buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 30],
  registers: [registry],
});
