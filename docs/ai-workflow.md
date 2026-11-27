# AI-assisted development in this repo

This repo is set up so AI coding agents can work on it productively **without being trusted
blindly**. The setup is part of the engineering, the same way CI is.

## The pieces

| Piece             | File                                                                            | What it does                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent guide       | [`AGENTS.md`](../AGENTS.md) (imported by [`CLAUDE.md`](../CLAUDE.md))           | Commands, layout, conventions, and the 8 money invariants an agent must never break. Tool-agnostic (Claude Code, Codex, Cursor).                             |
| Skills            | [`.claude/skills/`](../.claude/skills)                                          | Step-by-step playbooks for recurring tasks, loaded only when relevant: `add-endpoint`, `new-migration`, `write-adr`, `load-test`, `investigate-discrepancy`. |
| Guardrail hook    | [`protect-migrations.sh`](../.claude/hooks/protect-migrations.sh)               | `PreToolUse`: blocks any edit to a committed migration (exit 2), so an agent can't rewrite schema history.                                                   |
| Feedback hook     | [`lint-changed-file.sh`](../.claude/hooks/lint-changed-file.sh)                 | `PostToolUse`: formats and lints each edited `.ts` file and feeds errors straight back to the agent, so it fixes them immediately.                           |
| Reviewer subagent | [`.claude/agents/ledger-reviewer.md`](../.claude/agents/ledger-reviewer.md)     | A focused reviewer that only hunts for money-safety bugs: atomicity, lock order, idempotency, state machine, immutability.                                   |
| CI review         | [`.github/workflows/claude-review.yml`](../.github/workflows/claude-review.yml) | Runs the same review on every PR (needs an `ANTHROPIC_API_KEY` secret; skipped otherwise).                                                                   |
| Permissions       | [`.claude/settings.json`](../.claude/settings.json)                             | Pre-approves the safe, read-only and test commands; denies reading `.env`.                                                                                   |

## Design principles

1. **Put invariants where machines enforce them.** "Never edit a migration" is a hook, not just a
   sentence. "Entries balance" is a database trigger, not just a code review comment. Agents (and
   people) skip prose; they can't skip a trigger.
2. **Fast feedback beats long instructions.** The lint hook catches errors per edit instead of at
   the end of a long task.
3. **Skills hold procedure; AGENTS.md holds rules.** The always-loaded file stays short. Detailed
   playbooks load only when a task needs them.
4. **Specialised review over generic review.** A generic "review this code" prompt finds style
   nits. The ledger reviewer has a checklist of the specific ways this system can lose money.
5. **Tests are the real reviewer.** Concurrency and idempotency bugs are caught by integration
   tests against real Postgres, not by reading code.

## Bugs the test suite caught during development

These were caught by tests, not by review, which is the point of writing them first:

- **Deadlock under concurrent withdrawals.** Locking accounts with `FOR UPDATE` conflicted with
  the `FOR KEY SHARE` locks Postgres takes for foreign-key checks when inserting the transfer row.
  The "50 parallel withdrawals" test hung. Fix: `FOR NO KEY UPDATE`
  ([ADR 0006](adr/0006-row-locks-over-serializable.md)).
- **Clock-skew flake.** ACH tests computed "now" from the host clock, while `submitted_at` came
  from Postgres inside the Docker VM. A few ms of drift flipped a "settles after exactly 1000 ms"
  assertion about once in five runs. Fix: anchor simulated time to the database's clock. The suite
  then passed 22 consecutive runs.
- **Throughput.** A profile under load showed the API CPU-bound with 17 round trips per transfer.
  Cutting it to 12 dropped median latency at 500 req/s from 394 ms to 8 ms
  ([benchmarks](benchmarks.md)).
