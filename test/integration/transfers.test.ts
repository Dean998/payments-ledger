import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { submitAchBatches } from '../../src/ach/jobs.js';
import { MockAchNetwork } from '../../src/ach/mock-network.js';
import { buildApp } from '../../src/app.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { runReconciliation } from '../../src/reconciliation/reconcile.js';
import { createTestDb, EXTERNAL_ACCOUNT, fundedWallet, resetDb, treasury } from '../helpers.js';

const db = createTestDb();
const app = buildApp({ db });
beforeAll(() => app.ready());
afterAll(async () => {
  await app.close();
  await db.end();
});
beforeEach(() => resetDb(db));

let keyCounter = 0;
function post(body: object, key: string | null = `key-${++keyCounter}`) {
  return app.inject({
    method: 'POST',
    url: '/transfers',
    headers: key ? { 'idempotency-key': key } : {},
    payload: body,
  });
}

async function available(id: string): Promise<number> {
  const res = await app.inject({ method: 'GET', url: `/accounts/${id}` });
  return res.json<{ balances: { available: number } }>().balances.available;
}

describe('POST /transfers', () => {
  it('book transfers post immediately and move the money', async () => {
    const from = await fundedWallet(db, 10_000);
    const to = await createAccount(db, { name: 'To', currency: 'USD' });
    const res = await post({
      type: 'book',
      amount: 2_500,
      currency: 'USD',
      sourceAccountId: from.id,
      destinationAccountId: to.id,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ type: 'book', status: 'posted', amount: 2_500 });
    expect(await available(from.id)).toBe(7_500);
    expect(await available(to.id)).toBe(2_500);
  });

  it('requires an Idempotency-Key header', async () => {
    const from = await fundedWallet(db, 100);
    const res = await post(
      {
        type: 'ach_push',
        amount: 1,
        currency: 'USD',
        sourceAccountId: from.id,
        externalAccount: EXTERNAL_ACCOUNT,
      },
      null,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'validation_error' } });
  });

  it('validates routing numbers', async () => {
    const from = await fundedWallet(db, 100);
    const res = await post({
      type: 'ach_push',
      amount: 1,
      currency: 'USD',
      sourceAccountId: from.id,
      externalAccount: { ...EXTERNAL_ACCOUNT, routingNumber: '021000022' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('replays the original response for a repeated key and creates one transfer', async () => {
    const from = await fundedWallet(db, 10_000);
    const body = {
      type: 'ach_push',
      amount: 1_000,
      currency: 'USD',
      sourceAccountId: from.id,
      externalAccount: EXTERNAL_ACCOUNT,
    };
    const first = await post(body, 'same-key');
    const second = await post(body, 'same-key');
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(await available(from.id)).toBe(9_000);
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM transfers WHERE type = $1',
      ['ach_push'],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('rejects a reused key with a different body', async () => {
    const from = await fundedWallet(db, 10_000);
    const body = {
      type: 'ach_push',
      amount: 1_000,
      currency: 'USD',
      sourceAccountId: from.id,
      externalAccount: EXTERNAL_ACCOUNT,
    };
    await post(body, 'k');
    const res = await post({ ...body, amount: 2_000 }, 'k');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'idempotency_key_reused' } });
  });

  it('stores and replays business errors such as insufficient funds', async () => {
    const from = await fundedWallet(db, 100);
    const body = {
      type: 'ach_push',
      amount: 101,
      currency: 'USD',
      sourceAccountId: from.id,
      externalAccount: EXTERNAL_ACCOUNT,
    };
    const first = await post(body, 'poor');
    expect(first.statusCode).toBe(422);
    expect(first.json()).toMatchObject({ error: { code: 'insufficient_funds' } });
    const replay = await post(body, 'poor');
    expect(replay.statusCode).toBe(422);
    expect(replay.headers['idempotent-replayed']).toBe('true');
  });

  it('20 concurrent requests with the same key create exactly one transfer', async () => {
    const from = await fundedWallet(db, 10_000);
    const body = {
      type: 'ach_push',
      amount: 100,
      currency: 'USD',
      sourceAccountId: from.id,
      externalAccount: EXTERNAL_ACCOUNT,
    };
    const results = await Promise.all(Array.from({ length: 20 }, () => post(body, 'race')));
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    expect(new Set(results.map((r) => r.json<{ id: string }>().id)).size).toBe(1);
    expect(await available(from.id)).toBe(9_900);
  });

  it('never overdraws under concurrency: 50 parallel withdrawals of 30 from a balance of 1000', async () => {
    const from = await fundedWallet(db, 1_000);
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        post({
          type: 'ach_push',
          amount: 30,
          currency: 'USD',
          sourceAccountId: from.id,
          externalAccount: EXTERNAL_ACCOUNT,
        }),
      ),
    );
    const ok = results.filter((r) => r.statusCode === 201).length;
    const rejected = results.filter(
      (r) => r.json<{ error?: { code: string } }>().error?.code === 'insufficient_funds',
    ).length;
    expect(ok).toBe(33);
    expect(rejected).toBe(17);
    expect(await available(from.id)).toBe(10);
    expect((await runReconciliation(db)).status).toBe('ok');
  });

  it('can cancel a pending ACH transfer, but not once it is batched for the bank', async () => {
    const from = await fundedWallet(db, 1_000);
    const body = {
      type: 'ach_push',
      amount: 400,
      currency: 'USD',
      sourceAccountId: from.id,
      externalAccount: EXTERNAL_ACCOUNT,
    };
    const a = (await post(body)).json<{ id: string }>();
    expect(await available(from.id)).toBe(600);

    const cancel = await app.inject({ method: 'POST', url: `/transfers/${a.id}/cancel` });
    expect(cancel.json()).toMatchObject({ status: 'canceled' });
    expect(await available(from.id)).toBe(1_000);

    const b = (await post(body)).json<{ id: string }>();
    await submitAchBatches(
      db,
      new MockAchNetwork({ settleAfterMs: 1000, lateReturnAfterMs: 2000 }),
    );
    const late = await app.inject({ method: 'POST', url: `/transfers/${b.id}/cancel` });
    expect(late.statusCode).toBe(409);
  });

  it('rejects transfers between accounts of different currencies', async () => {
    const usd = await fundedWallet(db, 1_000);
    const eur = await fundedWallet(db, 0, { from: await treasury(db, 'EUR') });
    const res = await post({
      type: 'book',
      amount: 1,
      currency: 'USD',
      sourceAccountId: usd.id,
      destinationAccountId: eur.id,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'currency_mismatch' } });
  });

  it('records an audit trail of state changes', async () => {
    const from = await fundedWallet(db, 1_000);
    const t = (
      await post({
        type: 'ach_push',
        amount: 10,
        currency: 'USD',
        sourceAccountId: from.id,
        externalAccount: EXTERNAL_ACCOUNT,
      })
    ).json<{ id: string }>();
    await submitAchBatches(
      db,
      new MockAchNetwork({ settleAfterMs: 1000, lateReturnAfterMs: 2000 }),
    );
    const events = await app.inject({ method: 'GET', url: `/transfers/${t.id}/events` });
    expect(events.json<{ data: { toStatus: string }[] }>().data.map((e) => e.toStatus)).toEqual([
      'pending',
      'submitted',
    ]);
  });
});
