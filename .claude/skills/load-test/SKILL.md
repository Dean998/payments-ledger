---
name: load-test
description: Run the k6 load tests for payments-ledger, interpret latency/throughput/contention, and record results in docs/benchmarks.md. Use when asked about performance, capacity, or to verify an optimisation.
---

# Load testing

1. **Fresh stack** so earlier data doesn't skew results:
   `docker compose down -v && docker compose up -d --build`, then wait for
   `curl localhost:3000/health`.

2. **Run the scenarios** (k6 runs in Docker; no local install needed):
   - Normal traffic across 200 wallets: `RATE=300 npm run load`
   - Hot wallet (every transfer debits one account): `SCENARIO=hot RATE=150 npm run load`
   - Override duration with `DURATION=60s`. Run each configuration at least twice; laptop
     numbers vary by 30–50%.

   Note: `npm run load` passes only `BASE_URL` into the container. To pass `SCENARIO`/`RATE`, use
   `docker run --rm -i -e BASE_URL=http://host.docker.internal:3000 -e SCENARIO=hot -e RATE=150 grafana/k6 run - < load/transfers.k6.js`.

3. **Find the bottleneck before optimising.** While a test runs:
   - `docker stats --no-stream`: is the API container pinned near 100% (one Node core)?
   - `SELECT state, wait_event_type, wait_event, count(*) FROM pg_stat_activity GROUP BY 1,2,3;`
     Many `idle in transaction` means the app is slow between queries (CPU or round trips). Many
     `Lock / transactionid` means row-lock contention (hot accounts).
   - `curl localhost:9464/metrics | grep ledger_job_duration`: is a background job hogging the DB?

4. **Record results** in `docs/benchmarks.md`: date, commit, machine, scenario, rate, median, p95,
   dropped iterations, error rate, and one sentence on what limited throughput. Keep old rows;
   the history is the point.

5. Never claim a speed-up without a before/after run of the same scenario on the same machine.
