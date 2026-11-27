// Load test for POST /transfers.
//   SCENARIO=spread  transfers between 200 random wallets (normal traffic)
//   SCENARIO=hot     every transfer debits ONE wallet (worst-case lock contention)
// Run: npm run load            (or SCENARIO=hot npm run load)
import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const SCENARIO = __ENV.SCENARIO || 'spread';
const RATE = Number(__ENV.RATE || 500);
const WALLETS = 200;
const json = { headers: { 'content-type': 'application/json' } };

export const options = {
  scenarios: {
    transfers: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '60s',
      preAllocatedVUs: 100,
      maxVUs: 400,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:create_transfer}': ['p(95)<100', 'p(99)<250'],
  },
};

function post(path, body, key) {
  const headers = { ...json.headers, ...(key && { 'idempotency-key': key }) };
  return http.post(`${BASE}${path}`, JSON.stringify(body), {
    headers,
    tags: { name: path === '/transfers' ? 'create_transfer' : 'setup' },
  });
}

export function setup() {
  const treasury = post('/accounts', {
    name: 'Load treasury',
    currency: 'USD',
    allowNegative: true,
  }).json();
  const wallets = [];
  for (let i = 0; i < WALLETS; i++) {
    const w = post('/accounts', { name: `wallet-${i}`, currency: 'USD' }).json();
    post(
      '/transfers',
      {
        type: 'book',
        amount: 100_000_000,
        currency: 'USD',
        sourceAccountId: treasury.id,
        destinationAccountId: w.id,
      },
      uuidv4(),
    );
    wallets.push(w.id);
  }
  return { wallets };
}

export default function ({ wallets }) {
  const pick = () => wallets[Math.floor(Math.random() * wallets.length)];
  const source = SCENARIO === 'hot' ? wallets[0] : pick();
  let destination = pick();
  while (destination === source) destination = pick();
  const res = post(
    '/transfers',
    {
      type: 'book',
      amount: 1 + Math.floor(Math.random() * 500),
      currency: 'USD',
      sourceAccountId: source,
      destinationAccountId: destination,
    },
    uuidv4(),
  );
  check(res, { created: (r) => r.status === 201 });
}
