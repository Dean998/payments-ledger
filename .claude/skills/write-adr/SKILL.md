---
name: write-adr
description: Record an architecture decision for payments-ledger as an ADR in docs/adr. Use when a change picks between real alternatives (a library, a consistency model, a data shape, an infrastructure component) or when asked "why did we do X".
---

# Writing an ADR

Write one when someone could reasonably ask "why not the other way?" six months from now.

1. Find the next number: `ls docs/adr`. File: `docs/adr/NNNN-kebab-title.md`.
2. Use this template and keep it under a page:

```markdown
# NNNN. Title in the form of a decision

- Status: accepted | superseded by NNNN
- Date: YYYY-MM-DD

## Context

What forces are at play: requirements, constraints, what hurts today. Facts, not the solution.

## Decision

What we chose, in one or two sentences, then the details that matter.

## Alternatives considered

- **Option** — why not (be fair to it: when would it be the right choice?)

## Consequences

What gets easier, what gets harder, what we must now watch. Include the trigger that would
make us revisit this (e.g. "if outbox lag exceeds 5s at p99, move to logical replication").
```

3. Link it from the "Key decisions" list in `README.md` and from the relevant section of
   `docs/DESIGN.md`.
4. Never rewrite an accepted ADR's decision. Supersede it with a new one and update the old
   one's status line.
