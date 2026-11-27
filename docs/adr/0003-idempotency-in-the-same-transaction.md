# 0003. Store idempotency keys in the same transaction as the effect

- Status: accepted
- Date: 2026-11-27

## Context

Clients retry `POST /transfers` after timeouts. A retry must not move money twice, and two
in-flight requests with the same key must not both succeed.

## Decision

Insert the `(scope, key, request_hash)` row at the start of the business transaction with
`ON CONFLICT DO NOTHING`. A concurrent duplicate blocks on the unique index until the first
transaction ends, then reads the stored response. Business logic runs inside a savepoint: a
`DomainError` rolls back to the savepoint and its response is stored. Any other error rolls back
the whole transaction, key included. Keys expire after 24 h.

## Alternatives considered

- **Idempotency in Redis / a separate store**: two systems to keep in step; a crash between
  "effect committed" and "key stored" breaks the guarantee.
- **An "in progress" status row committed first, then the work**: needs lock timeouts and recovery
  for abandoned keys. Letting Postgres' unique index do the waiting removes that state entirely.
- **Natural idempotency (client-supplied transfer id)**: also valid; the key approach is the
  industry convention (Stripe, Adyen) and works for every endpoint uniformly.

## Consequences

- Exactly-once effect per key, proven by a test that fires 20 concurrent identical requests.
- A long-running first request holds the duplicate's connection while it waits. Acceptable
  because transactions are short; revisit with a lock timeout if requests ever do slow I/O.
