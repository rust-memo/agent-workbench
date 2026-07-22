---
name: business-logic
description: Model and test application workflow invariants, limits, ordering, pricing, coupons, inventory, approvals, and state transitions. Use when the target has multi-step transactions or rules that generic scanners cannot understand.
---

# Business Logic

Treat the application as a state machine. The goal is to prove one violated invariant with the least possible side effect, not to fuzz every field.

## Workflow

1. Name actors, assets, states, transitions, trust boundaries, counters, and irreversible actions.
2. Write expected invariants such as “total is recalculated server-side,” “approval precedes fulfillment,” or “a coupon is consumed once per account.”
3. Capture a normal operator-controlled transaction and identify which request advances each state.
4. Test one mutation at a time: skip, repeat, reorder, race, substitute identity, exceed a limit, change a derived value, or replay after completion.
5. Re-read server state after each attempt. UI messages are not evidence of durable impact.
6. Restore or abandon test data safely and record every side effect.

## Priority heuristics

Prioritize payment/credit changes, cross-tenant workflow actions, approval bypass, inventory or quota creation, identity verification, and irreversible state changes. Treat cosmetic inconsistencies and client-only checks without server impact as low priority.

## Guardrails and output

- Use test accounts, minimum quantities, and non-production payment methods.
- Require explicit approval before concurrency, repeated requests, billing, messages, or irreversible operations.
- Never test denial-of-service or exhaust shared inventory.

Return a state diagram, invariant table, attempted transitions, observed server state, impact confidence, and the next smallest manual experiment.
