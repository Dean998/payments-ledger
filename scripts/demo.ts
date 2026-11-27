/**
 * End-to-end walkthrough against a running stack (`docker compose up`).
 * Shows a deposit settling, a book transfer, a withdrawal, an R01 return,
 * signed webhooks and a reconciliation run.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { formatMinor } from '../src/money.js';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const SINK = process.env.SINK_URL ?? 'http://webhook-sink:4000/hooks';
const SINK_SECRET = 'whsec_ZGVtby1zZWNyZXQtZm9yLWxvY2FsLWRldmVsb3BtZW50';
const BANK = {
  routingNumber: '021000021',
  accountNumber: '000123456789',
  holderName: 'Alice Example',
};

type Json = Record<string, unknown>;

async function call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined && { 'content-type': 'application/json' }),
      ...(method === 'POST' && path === '/transfers' && { 'idempotency-key': crypto.randomUUID() }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const step = (msg: string) => console.log(`\n\x1b[1m▸ ${msg}\x1b[0m`);

async function balance(id: string) {
  const a = await call<{
    name: string;
    balances: { posted: number; pending: number; available: number };
  }>('GET', `/accounts/${id}`);
  const b = a.balances;
  console.log(
    `  ${a.name.padEnd(6)} posted ${formatMinor(b.posted, 'USD').padStart(12)}  pending ${formatMinor(b.pending, 'USD').padStart(12)}  available ${formatMinor(b.available, 'USD').padStart(12)}`,
  );
}

async function waitFor(id: string, statuses: string[]) {
  for (let i = 0; i < 60; i++) {
    const t = await call<{ status: string; returnCode: string | null }>('GET', `/transfers/${id}`);
    if (statuses.includes(t.status)) return t;
    await sleep(1000);
  }
  throw new Error(`transfer ${id} never reached ${statuses.join('/')}`);
}

step('Register a webhook endpoint (the webhook-sink container verifies signatures)');
await call('POST', '/webhook-endpoints', { url: SINK, secret: SINK_SECRET });

step('Open two wallets');
const alice = await call<{ id: string }>('POST', '/accounts', { name: 'Alice', currency: 'USD' });
const bob = await call<{ id: string }>('POST', '/accounts', { name: 'Bob', currency: 'USD' });

step('Alice deposits $500.00 by ACH pull. It is pending, not yet available');
const deposit = await call<{ id: string }>('POST', '/transfers', {
  type: 'ach_pull',
  amount: 50_000,
  currency: 'USD',
  destinationAccountId: alice.id,
  externalAccount: BANK,
});
await balance(alice.id);
console.log('  …waiting for the worker to batch it and the mock bank to settle it');
await waitFor(deposit.id, ['settled']);
await balance(alice.id);

step('Alice sends Bob $120.00 (book transfer, posts instantly)');
await call('POST', '/transfers', {
  type: 'book',
  amount: 12_000,
  currency: 'USD',
  sourceAccountId: alice.id,
  destinationAccountId: bob.id,
});
await balance(alice.id);
await balance(bob.id);

step('Bob withdraws $50.00 by ACH push. The funds are held immediately');
const withdrawal = await call<{ id: string }>('POST', '/transfers', {
  type: 'ach_push',
  amount: 5_000,
  currency: 'USD',
  sourceAccountId: bob.id,
  externalAccount: { ...BANK, holderName: 'Bob Example' },
});
await balance(bob.id);

step('Bob tries to deposit $100.01. The mock bank returns it with R01 (insufficient funds)');
const bounced = await call<{ id: string }>('POST', '/transfers', {
  type: 'ach_pull',
  amount: 10_001,
  currency: 'USD',
  destinationAccountId: bob.id,
  externalAccount: { ...BANK, holderName: 'Bob Example' },
});
const [w, r] = await Promise.all([
  waitFor(withdrawal.id, ['settled']),
  waitFor(bounced.id, ['returned']),
]);
console.log(`  withdrawal: ${w.status}; deposit: ${r.status} (${r.returnCode})`);
await balance(bob.id);

step('Run reconciliation: re-derive every balance from the entry lines');
const report = await call<{ status: string; accountsChecked: number; discrepancies: unknown[] }>(
  'POST',
  '/reconciliation/runs',
);
console.log(
  `  status=${report.status} accounts=${report.accountsChecked} discrepancies=${report.discrepancies.length}`,
);

step('Done. See the verified webhooks with: docker compose logs webhook-sink');
