---
name: oauth-oidc
description: Review OAuth 2.0 and OpenID Connect flows for redirect, state, nonce, PKCE, token, code, client, and account-linking weaknesses. Use when recon discovers authorization endpoints, callbacks, social login, SSO, mobile deep links, or token exchange APIs.
---

# OAuth and OIDC

Map the complete browser and back-channel flow before testing. Use operator-controlled identities and clients; never capture or reuse another person's authorization code or token.

## Workflow

1. Record issuer, authorization endpoint, token endpoint, user-info endpoint, JWKS URI, client ID, redirect URI, response type/mode, scopes, state, nonce, and PKCE method.
2. Build a state diagram from login start through callback, code exchange, session creation, refresh, logout, and account linking.
3. Test exact redirect URI matching, parser ambiguity, duplicate parameters, fragment/query handling, and allowed scheme/host/path boundaries.
4. Verify state is session-bound and single-use; verify nonce is checked for ID tokens; verify PKCE uses S256 and the verifier is bound to the code and client.
5. Check code replay, token audience/issuer/type confusion, refresh rotation, revoked-session behavior, and client mix-up without sending tokens to untrusted hosts.
6. For account linking, verify the application requires fresh proof for both identities and cannot be driven by an untrusted email claim alone.

## Evidence and stopping rules

- Redact codes, cookies, tokens, and personal claims in previews and reports.
- Prefer invalid synthetic values before valid-token tests.
- Stop before completing a login or link that affects an account you do not control.
- Distinguish provider behavior from relying-party behavior and record the exact component that accepted the invalid transition.

Report the flow diagram, failed invariant, minimal reproduction, impact preconditions, and targeted remediation. Put uncertain observations in manual follow-up rather than findings.
