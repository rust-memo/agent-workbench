---
name: recon
description: External recon playbook for a web target — subdomain enumeration, live-host probing, tech fingerprinting, and a first pass at content discovery. Use when the user gives you a root domain or apex and wants attack surface mapping.
---

# Recon

The goal: turn a root domain into a clean, deduplicated list of live hosts and
a sense of what's worth attacking — without hammering the target.

Use `${SKILL_DIR}` references only if present; otherwise rely on tools below.

## Workflow

1. **Passive recon (do this first, it's quiet):**
   - Subdomain enumeration via certificate transparency. `crt.sh` is flaky and
     frequently answers with a `502`/HTML page or an empty body instead of
     JSON — piping that straight into `jq` is what throws
     `jq: parse error: Invalid numeric literal`. Validate the response is JSON
     before parsing, and retry:

     ```bash
     # Robust crt.sh subdomain pull. Guards against 502/HTML/empty responses.
     crtsh() {
       domain="$1"
       for attempt in 1 2 3; do
         resp=$(curl -fsS --max-time 30 -H 'Accept: application/json' \
           "https://crt.sh/?q=%25.${domain}&output=json" 2>/dev/null)
         # Only parse when the body is valid JSON (jq -e . succeeds).
         if printf '%s' "$resp" | jq -e . >/dev/null 2>&1; then
           printf '%s' "$resp" \
             | jq -r '.[].name_value' \
             | sed 's/\*\.//g' \
             | tr 'A-Z' 'a-z' | tr -d '\r' \
             | sort -u
           return 0
         fi
         sleep 3   # back off; crt.sh is rate-limited / returns 502 under load
       done
       echo "crt.sh returned no JSON for ${domain} (502/empty) — try again later or use another source" >&2
       return 1
     }
     crtsh "$TARGET"
     ```

     - `name_value` is newline-separated and may include wildcard (`*.`) entries —
       the `sed`/`sort -u` above normalizes and dedupes them.
     - Certificate transparency sends no packets to the target itself.
   - Other passive sources to corroborate / fill gaps: `subfinder`, `amass`
     (passive mode), `assetfinder`, and the `web_search` tool.

2. **Resolve + probe for live hosts:**
   - Resolve the candidate list (`dig +short`, `dnsx`) and drop non-resolving
     names.
   - Probe what's alive over HTTP/S with `httpx` (or `curl -sI` per host) to get
     status codes, titles, and redirects. Keep only responsive hosts.

3. **Fingerprint the surface:**
   - Identify server, framework, and CDN/WAF (`httpx -title -tech-detect`,
     response headers, favicon hashes). Note auth surfaces (login, SSO, APIs).
   - Diff environments where they exist (prod vs. staging/dev) — they often
     share code but differ in hardening.

4. **First-pass content discovery (only once you have live hosts):**
   - Light, polite directory/endpoint discovery on the highest-value hosts.
     Prefer curl + a small wordlist; reach for `ffuf`/`gobuster` only when the
     user asks and the target is in scope.

## Notes

- Stay strictly within the authorized scope. Certificate transparency and
  passive sources are safe; anything that sends traffic to the target needs to
  be in scope.
- Record findings as you go so later phases (webvuln, ssrf, …) can pick up the
  live-host list and parameters without re-crawling.
