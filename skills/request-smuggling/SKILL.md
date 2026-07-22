---
name: request-smuggling
description: Triage HTTP request desynchronization and request-smuggling signals conservatively across front-end and back-end parsers. Use only when the operator explicitly requests it and infrastructure suggests proxy chains, HTTP/1 downgrade, ambiguous framing, connection reuse, or Burp evidence of CL/TE disagreement.
---

# Request Smuggling

This is an explicit-user-only playbook because unsafe probes can poison shared back-end connections. Confirm written authorization and use a dedicated test account and low-traffic endpoint.

## Decision flow

1. Map protocol negotiation and intermediaries without ambiguous requests: client protocol, edge/CDN, load balancer, reverse proxy, cache, and origin.
2. Prefer non-invasive parser comparison and timing evidence. Repeat controls to distinguish network noise.
3. If authorization permits a desync probe, use a unique inert marker, one connection at a time, a short timeout, and an endpoint that cannot mutate state.
4. Confirm with a self-contained technique that affects only the operator's next request. Never target another user's response or poison a shared cache.
5. Stop immediately on cross-user content, unexpected state changes, elevated latency, or evidence that the marker reached unrelated traffic.

## Evidence standard

Record raw bytes, line endings, protocol versions, connection reuse, proxy headers, timing controls, and repeat count. Do not report a timeout alone as request smuggling. Separate front-end rejection, origin parsing differences, and genuine queue desynchronization.

Return risk prerequisites, safe control results, confidence, and a manual Burp follow-up. Require explicit approval for every active ambiguous-framing request.
