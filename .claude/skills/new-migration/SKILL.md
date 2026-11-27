---
name: new-migration
description: Create a Postgres schema migration for payments-ledger safely (new file, never edit applied ones; lock-aware DDL; backfills; tests). Use whenever a table, column, index, constraint or trigger changes.
---

# Writing a migration

Applied migrations are immutable: a PreToolUse hook blocks edits to committed files in
`src/db/migrations/`. Always add a new file.

1. **Name it** `src/db/migrations/NNN_short_description.sql` with the next number (zero-padded to
   three digits). The runner applies files in lexical order, each in its own transaction, and
   records them in `schema_migrations`.

2. **Think about locks.** This table may be hot in production.
   - `ADD COLUMN` with a constant default is instant. A volatile default rewrites the table.
   - `CREATE INDEX` blocks writes. Prefer `CREATE INDEX CONCURRENTLY`, but it cannot run inside a
     transaction, and the runner wraps every file in one. If you need it, say so and split the
     migration out to be run by hand; don't silently switch to a blocking build.
   - Adding `NOT NULL` or a `CHECK` to a big table: add it `NOT VALID` first, then
     `VALIDATE CONSTRAINT` in a later migration.

3. **Keep the invariants in the database.** If the change adds a new kind of entry or status,
   update the triggers in a new migration and the checks in `src/reconciliation/reconcile.ts`.

4. **Backfills** go in their own migration after the DDL, batched if the table is large. Never
   backfill balance columns: balances are derived from `entry_lines` by the ledger code.

5. **Update `resetDb`** in `test/helpers.ts` if you added a table.

6. **Verify**: `npm test` (the global setup recreates the test DB and applies every migration from
   scratch), then `npm run migrate` against the dev DB to check it applies on top of existing data.
