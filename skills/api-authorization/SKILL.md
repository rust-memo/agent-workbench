---
name: api-authorization
description: Build evidence-driven BOLA, BFLA, IDOR, and object-property authorization tests for an authorized API. Use when endpoints expose object IDs, tenant boundaries, roles, admin functions, or user-owned resources and the operator needs a safe two-account test matrix.
---

# API Authorization

Use this playbook only inside the recorded scope. Prefer two operator-controlled accounts with different roles or tenants. Never access unrelated users' data when a synthetic object can prove the boundary.

## Workflow

1. Inventory each endpoint as `method + path + object type + action` and record the caller role, tenant, owner, and identifier source.
2. Create a matrix with rows for owner, peer user, other tenant, lower role, anonymous, and expired/revoked session. Mark impossible rows explicitly.
3. Establish a clean baseline with an object created by account A. Replay the minimum request with account B while changing only one authorization dimension.
4. Test object-level checks first, then function-level checks, nested object fields, bulk endpoints, exports, and alternate identifiers.
5. Compare status, body shape, side effects, timing, and subsequent reads. A different status alone is not proof.
6. Save a redacted request/response pair and reproduction note. Create a finding only when the unauthorized read or state change is reproducible.

## Guardrails

- Use inert records and the smallest possible data set.
- Do not enumerate random identifiers at scale; derive IDs from accounts you control.
- Treat GraphQL aliases, batch APIs, mobile versions, and alternate content types as separate authorization surfaces.
- Stop if a request could modify a real user's record, trigger billing, or expose sensitive third-party data.

## Output

Return the authorization matrix, untested gaps, strongest evidence, false-positive considerations, and prioritized manual follow-ups. Recommend `confirmed` only with a request and response or observable side effect proving the boundary failure.
