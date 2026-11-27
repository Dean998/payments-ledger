@AGENTS.md

## Claude Code specifics

- Skills in `.claude/skills/`: `add-endpoint`, `new-migration`, `write-adr`, `load-test`, `investigate-discrepancy`. Use them when a task matches.
- Hooks in `.claude/settings.json`: edits to applied migrations are blocked; every edited `.ts` file is linted and errors are fed back to you. Fix what they report; don't work around them.
- Before finishing a change that touches money movement, run the `ledger-reviewer` subagent on the diff.
