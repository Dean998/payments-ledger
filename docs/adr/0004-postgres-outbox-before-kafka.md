# 0004. A polled Postgres outbox, not Kafka, for event delivery

- Status: accepted
- Date: 2026-11-27

## Context

Every state change must eventually produce a webhook, exactly once from the ledger's point of
view, without ever publishing an event for a change that rolled back.

## Decision

Write events to `outbox_events` in the business transaction. A worker relays them into per-endpoint
`webhook_deliveries` rows (`FOR UPDATE SKIP LOCKED`), and a dispatcher sends them with leases,
retries and signatures.

## Alternatives considered

- **Publish to Kafka/SNS after commit**: the dual-write problem (crash between commit and publish
  loses the event).
- **Kafka with Debezium (CDC on the outbox)**: the right answer at higher scale or with many
  consumers. Adds a cluster, connectors and schema management for a single consumer today.
- **`LISTEN/NOTIFY`**: lower latency, but notifications are lost if no one is listening; it would
  still need the table as the source of truth. A possible optimisation to wake the relay early.

## Consequences

- No new infrastructure. Latency is bounded by the poll interval (500 ms by default).
- **Revisit when** outbox lag p99 exceeds ~5 s (`ledger_outbox_lag_seconds`), or a second consumer
  (analytics, fraud) needs the stream.
