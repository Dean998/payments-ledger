import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { enqueueEvent, relayOutbox } from '../../src/outbox/outbox.js';
import { createTransfer } from '../../src/transfers/transfers.js';
import { dispatchWebhooks, fetchSender, type HttpSender } from '../../src/webhooks/dispatcher.js';
import { createWebhookEndpoint } from '../../src/webhooks/endpoints.js';
import { verify } from '../../src/webhooks/signing.js';
import { createTestDb, EXTERNAL_ACCOUNT, fundedWallet, resetDb } from '../helpers.js';

const db = createTestDb();
afterAll(() => db.end());
beforeEach(() => resetDb(db));

async function deliveries() {
  const { rows } = await db.query<{
    status: string;
    attempts: number;
    next_attempt_at: Date;
    last_error: string | null;
  }>('SELECT status, attempts, next_attempt_at, last_error FROM webhook_deliveries ORDER BY id');
  return rows;
}

describe('transactional outbox', () => {
  it('an event exists only if its transaction committed', async () => {
    const id = crypto.randomUUID();
    await expect(
      withTransaction(db, async (tx) => {
        await enqueueEvent(tx, 'transfer.created', id, {});
        throw new Error('business logic failed after enqueue');
      }),
    ).rejects.toThrow();
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox_events');
    expect(rows[0]!.n).toBe(0);
  });

  it('fans events out only to endpoints subscribed to that type', async () => {
    await createWebhookEndpoint(db, { url: 'http://all.example' });
    await createWebhookEndpoint(db, {
      url: 'http://settled-only.example',
      eventTypes: ['transfer.settled'],
    });
    const wallet = await fundedWallet(db, 1_000); // one transfer.posted event
    await withTransaction(db, (tx) =>
      createTransfer(tx, {
        type: 'ach_push',
        amount: 1,
        currency: 'USD',
        sourceAccountId: wallet.id,
        externalAccount: EXTERNAL_ACCOUNT,
      }),
    ); // one transfer.created event
    expect(await relayOutbox(db)).toBe(2);
    expect(await deliveries()).toHaveLength(2); // both to the catch-all endpoint
    expect(await relayOutbox(db)).toBe(0);
  });
});

describe('webhook dispatcher', () => {
  it('delivers signed payloads a receiver can verify', async () => {
    const received: { headers: IncomingHttpHeaders; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;

    try {
      const endpoint = await createWebhookEndpoint(db, { url: `http://127.0.0.1:${port}/hooks` });
      await createAccount(db, { name: 'x', currency: 'USD' });
      await fundedWallet(db, 500);
      await relayOutbox(db);
      expect(await dispatchWebhooks(db, fetchSender)).toBe(1);

      expect(received).toHaveLength(1);
      const { headers, body } = received[0]!;
      expect(verify(endpoint.secret, headers as Record<string, string>, body)).toBe(true);
      expect(JSON.parse(body)).toMatchObject({
        type: 'transfer.posted',
        data: { amount: 500, status: 'posted' },
      });
      expect((await deliveries())[0]).toMatchObject({ status: 'delivered', attempts: 1 });
    } finally {
      server.close();
    }
  });

  it('retries failures with backoff and gives up after maxAttempts', async () => {
    await createWebhookEndpoint(db, { url: 'http://receiver.invalid' });
    await fundedWallet(db, 500);
    await relayOutbox(db);

    const failing: HttpSender = () => Promise.resolve({ status: 503 });
    let now = new Date();
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await dispatchWebhooks(db, failing, { maxAttempts: 3, now })).toBe(1);
      const [d] = await deliveries();
      if (attempt < 3) {
        expect(d).toMatchObject({ status: 'pending', attempts: attempt, last_error: 'HTTP 503' });
        // Not due again until the backoff has passed.
        expect(await dispatchWebhooks(db, failing, { maxAttempts: 3, now })).toBe(0);
        now = new Date(d!.next_attempt_at.getTime() + 1);
      } else {
        expect(d).toMatchObject({ status: 'dead', attempts: 3 });
      }
    }
  });

  it('treats network errors and timeouts as failures', async () => {
    await createWebhookEndpoint(db, { url: 'http://receiver.invalid' });
    await fundedWallet(db, 500);
    await relayOutbox(db);
    const throwing: HttpSender = () =>
      Promise.reject(new Error('The operation was aborted due to timeout'));
    await dispatchWebhooks(db, throwing);
    expect((await deliveries())[0]).toMatchObject({
      status: 'pending',
      last_error: expect.stringContaining('timeout'),
    });
  });
});
