# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

First public release of pentesterflow — an agentic offensive-security CLI for
security engineers, professional penetration testers, and bug hunters.

### Added

- **Kimi provider support** — first-class `kimi` backend, default Moonshot API
  settings, model listing, secret API-key prompt in the provider picker, and
  Kimi-compatible request shaping.
- **Burp bridge runtime** — `pentesterflow --burp [port]`, `/burp [port]`, Burp
  task ingestion, issue import endpoints, and Browser Capture tools for reading
  queued Burp requests and confirmed issues from the CLI session.
- **Context snapshots and session memory** — compacted engagement memory,
  `/compact`, `/memory`, `/snapshot`, automatic five-minute context snapshots,
  persisted memory in session files, and status-bar memory counters.
- **Coverage-driven next steps** — `/next [objective]` uses coverage state to
  propose concrete untested endpoint / parameter / vulnerability-class checks
  without running tools.
- **Improved terminal UX** — full-width dynamic banner layout, framed input
  prompt lines, better multi-line history behavior, and clearer context usage
  display.
- **LLM backends** — Ollama and OpenAI-compatible clients (LM Studio, vLLM,
  llama.cpp server, remote providers) with NDJSON / SSE streaming, abort-aware
  fetch, a `ready` / `disconnected` health probe, and error classification.
- **Eleven built-in tools** — `shell` / `BashTool`, `file_read` / `file_write` /
  `file_edit` (with PascalCase aliases), `GlobTool`, `GrepTool`, `http`,
  `web_fetch`, `web_search`, `ask_user`, `confirm_finding`, `coverage`,
  `load_skill`, and the `browser_capture_*` family.
- **Ten skills** — `recon`, `webvuln`, `ssrf`, `ssti`, `jwt`, `graphql`, `race`,
  `takeover`, `supabase`, and `deserialize`, loaded on demand from markdown
  playbooks. Scaffold new ones with `/skills new`.
- **Scope-locked system prompt** — penetration testing / bug bounty / code
  review / coding only, calibrated against OWASP Top 10, the Bugcrowd VRT, and
  PortSwigger research (markers pinned in tests).
- **Agent loop** — autonomous plan → act → observe → verify → report with
  `AbortSignal` cancellation, error recovery, `@file` mention expansion, and
  session save on every history mutation.
- **MCP integration** via `@modelcontextprotocol/sdk`, including one-flag Browser
  MCP and a standalone `pentesterflow-browser-mcp` stdio server with a local
  capture-ingest endpoint.
- **Findings workflow** — verified bugs written to `./findings/<slug>.md` with a
  copy-pasteable PoC, impact, and remediation.
- **Safety rails** — shell denylist, sensitive-path gating, and credential
  redaction on `/compact` and `/export`.
- **Terminal UI** — banner, scrollback transcript, multi-line input with
  bracketed-paste, slash-command completion menu, `@file` mention picker,
  markdown rendering, status bar, and permission / question modals.
- **Configuration** — zod-validated `~/.pentesterflow/config.json` with
  crash-safe atomic saves; resumable sessions; structured JSON-lines logs.
- **Quality** — 300+ unit and integration tests (vitest), typecheck, and lint
  gated by `npm run ci`.
- **Distribution** — tsup ESM bundle, single-file binaries, and GitHub Actions
  for CI (Node 20 + 22 on Ubuntu + macOS) and tagged releases (npm +
  cross-platform binaries).

### Changed

- **CLI bridge naming** — `--browser-ingest` is now a deprecated alias for
  `--burp`, keeping old commands working while making Burp integration clearer.
- **Kimi tool-call compatibility** — Kimi OpenAI-compatible requests disable
  provider-side thinking to avoid tool-call failures caused by missing
  `reasoning_content`.
