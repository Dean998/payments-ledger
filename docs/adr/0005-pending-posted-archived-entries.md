# 0005. Model in-flight money as pending entries, not holds

- Status: accepted
- Date: 2026-11-27

## Context

ACH transfers take days to settle and can be returned. Funds must be reserved on creation, not
counted until settlement for inflows, and released or reversed correctly on every outcome.

## Decision

A transfer creates its journal entry immediately with status `pending`. Settlement posts it;
a return before settlement archives it; a return after settlement creates a posted reversing
entry. Available balance = posted − pending outflows.

## Alternatives considered

- **A separate holds table plus a posted entry at settlement**: two mechanisms to reconcile, and
  the eventual entry isn't visible in the ledger while the money is in flight.
- **Post immediately, reverse on return**: simple, but it makes money from an ACH pull spendable
  before it has settled, which is exactly the risk ACH returns create.

## Consequences

- The ledger shows in-flight money explicitly, and every transfer status maps to exactly one entry
  status (checked by reconciliation).
- Late returns can overdraw a wallet. That's correct accounting (the customer owes the money); it
  appears as a reconciliation warning for collections, not as an error.
