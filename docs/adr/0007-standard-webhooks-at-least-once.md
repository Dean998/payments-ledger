# 0007. Standard Webhooks signatures with at-least-once delivery

- Status: accepted
- Date: 2026-11-27

## Context

Receivers must be able to verify a webhook came from us, wasn't modified or replayed, and handle
duplicates.

## Decision

Sign per the Standard Webhooks spec (`webhook-id`, `webhook-timestamp`,
`webhook-signature: v1,<base64 HMAC-SHA256 of id.timestamp.body>`), with a 5-minute timestamp
tolerance and support for several signatures during secret rotation. Deliver at least once, with
exponential backoff and jitter, then mark the delivery `dead`.

## Alternatives considered

- **A home-grown signature format**: every receiver would need custom verification code. The
  standard has libraries in most languages, and our implementation is tested against the spec's
  reference vector.
- **Exactly-once delivery**: impossible over HTTP without the receiver's cooperation. At-least-once
  plus an idempotency id is the honest contract.

## Consequences

- Receivers must dedupe on `webhook-id` and order by `sequence`. The bundled `webhook-sink` shows
  how.
- Dead deliveries need a replay endpoint (not built yet).
