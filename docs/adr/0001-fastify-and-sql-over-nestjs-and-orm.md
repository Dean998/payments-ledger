# 0001. Fastify + Zod + raw SQL instead of NestJS + an ORM

- Status: accepted
- Date: 2026-11-27

## Context

The hard parts of this service are transaction boundaries, lock order and SQL-level guarantees
(triggers, `SKIP LOCKED`, `ON CONFLICT`). Those need to be visible in the code, not hidden behind
framework or ORM abstractions. At the time of writing, NestJS 12 relies on decorator metadata, an
area where the TypeScript 7 native compiler and the lint toolchain were still catching up.

## Decision

Fastify 5 for HTTP, Zod 4 schemas for validation (through `fastify-type-provider-zod`), and
hand-written SQL through `pg`. Each service function takes either `db` (manages its own
transaction) or `tx` (runs inside the caller's).

## Alternatives considered

- **NestJS + TypeORM/Prisma**: strong conventions and DI, familiar to many teams. Prisma's
  transaction API makes `SELECT … FOR NO KEY UPDATE` and savepoints awkward, and it would hide
  exactly what this project needs to show. The right choice for a large CRUD-heavy codebase with
  many contributors.
- **Kysely (typed SQL builder)**: a good middle ground. Not used, to keep dependencies minimal;
  it's a reasonable next step if queries multiply.

## Consequences

- The SQL is explicit and reviewable, and every lock is visible in the source.
- No compile-time checking of SQL against the schema; the integration tests (real Postgres) cover it.
- Revisit if the number of queries grows enough that typed query building pays for itself.
