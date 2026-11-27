---
name: add-endpoint
description: Add or change an HTTP endpoint in payments-ledger (Fastify + Zod), including validation, error mapping, idempotency for money-moving POSTs, tests and README API table. Use when asked to expose new functionality over the API.
---

# Adding an endpoint

1. **Decide where it lives.** Routes sit next to their domain: `src/<domain>/routes.ts`, registered
   in `src/app.ts`. Business logic goes in a service function, not in the handler.

2. **Schema first.** Define params/query/body with Zod in the route's `schema`. Reuse `Currency`
   and `MinorUnits` from `src/money.ts` for money. Use `z.looseObject` for headers (a plain
   `z.object` strips every other header).

3. **Service function.**
   - Reads: take `db: Queryable`.
   - Writes: take `tx: Tx` and let the caller own the transaction (`withTransaction`).
   - Money-moving POSTs MUST go through `runIdempotent` with a scope like `'POST /things'` and
     require the `idempotency-key` header. See `src/transfers/routes.ts`.
   - State changes that others care about: `enqueueEvent(tx, 'thing.happened', id, payload)` in
     the same transaction.

4. **Errors.** Throw `DomainError` (add a factory to `errors` in `src/errors.ts` if it is new) with
   a stable snake_case `code` and the right status: 400 validation, 404 not found, 409 state
   conflict, 422 business rule. Never return raw database errors.

5. **Serialization.** Convert `bigint` with `toApiAmount`, dates with `toISOString()`. Never expose
   `external_account_number` or secrets other than at creation.

6. **Tests** in `test/integration/<domain>.test.ts` using `app.inject`:
   - happy path with exact response shape
   - each error code you introduced
   - for POSTs: replay with the same key returns the same body + `idempotent-replayed: true`
   - for money movement: a concurrent test if two requests could race

7. **Docs.** Add the endpoint to the API table in `README.md`. If the change alters a flow in
   `docs/DESIGN.md`, update the sequence diagram.

8. Run `npm run typecheck && npm run lint && npm test`.
