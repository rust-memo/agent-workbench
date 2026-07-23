<div align="center">

# Agent Workbench

### Local AI security workbench and human-in-the-loop pentesting CLI.

Agent Workbench helps security engineers move through recon, enumeration,
validation, evidence collection, and reporting while keeping the analyst in
control.

<br/>

[![build](https://img.shields.io/github/actions/workflow/status/rust-memo/agent-workbench/ci.yml?branch=main&label=build&logo=github)](https://github.com/rust-memo/agent-workbench/actions)
[![release](https://img.shields.io/github/v/release/rust-memo/agent-workbench?include_prereleases&logo=github)](https://github.com/rust-memo/agent-workbench/releases)
[![node](https://img.shields.io/badge/node-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![license: Apache--2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![stars](https://img.shields.io/github/stars/rust-memo/agent-workbench?style=social)](https://github.com/rust-memo/agent-workbench/stargazers)

**[Install](#install) · [Web Workbench](#local-web-workbench-v050) · [Quickstart](#quickstart) · [Lifecycle](#pentest-lifecycle) · [Memory](#continuous-learning) · [Security](#security-model)**

</div>

---

```console
$ agent-workbench
╭────────────────────────────────────────────────╮
│  Agent Workbench                                 │
│  local agent · tools ready · analyst approved  │
╰────────────────────────────────────────────────╯

› /target https://app.example.com
  target set to https://app.example.com

› test the orders API for broken access control
⏺ Skill webvuln
  ⎿ loaded skill: webvuln
⏺ http GET https://app.example.com/api/v1/orders/1043
  ⎿ 200 OK
⏺ BashTool(curl -s -H "Authorization: Bearer $USER_B" ...)
  ⎿ cross-account response confirmed
⏺ Confirmed Finding (high) IDOR on /api/v1/orders/{id}
  ⎿ written to ./findings/idor-orders.md
```

## Overview

Agent Workbench is a local-first terminal assistant designed specifically for
authorized offensive-security work. It connects to local or hosted LLMs, plans
against a scoped target, uses real pentesting tools, asks for approval before
sensitive actions, remembers useful lessons across sessions, and writes
evidence-backed findings. The same project also provides a local browser
workbench, Browser MCP server, and Burp bridge alongside the CLI.

It is built around three ideas:

- **Analyst control**: the human approves sensitive actions and decides scope.
- **Transparent execution**: curl-first, reproducible commands, visible tool
  calls, saved evidence, and audit-friendly logs.
- **Operational learning**: local project and personal knowledge bases improve
  future sessions without retraining the model or adding user-facing complexity.

> [!WARNING]
> Use Agent Workbench only on systems where you have explicit authorization. The
> agent can run shell commands, make HTTP requests, edit files, and process
> captured traffic after approval.

## Why Agent Workbench

Current agentic AI systems often struggle with security-specific workflows,
hallucinated findings, weak context retention, poor tool integration, and limited
auditability. Agent Workbench addresses those gaps with:

| Challenge | Agent Workbench approach |
|---|---|
| Generic AI workflows | Built-in pentest skills for recon, web vulns, SSRF, SSTI, JWT, GraphQL, race, takeover, Supabase, and deserialization. |
| Hallucinated findings | `confirm_finding` should be used only after reproduction with request/response evidence. |
| Long engagements | Saved sessions, compaction, context snapshots, resume recap, and continuous local learning. |
| Real-world tooling | Shell/Bash, HTTP, Burp bridge, browser capture, MCP, file tools, grep/glob, and custom plugins. |
| Human oversight | Permission prompts, allow-once/session decisions, and explicit YOLO mode for labs. |
| Reproducibility | Copy-pasteable commands, Markdown findings, JSON-lines logs, and stable session files. |
| Large attack surfaces | Coverage tracking, `/next`, skills, captured traffic queries, and learned coverage gaps. |

## Core Capabilities

| Area | What it provides |
|---|---|
| Agent loop | Plan, act, observe, verify, report, and learn across scoped tasks. |
| Model backends | Ollama, LM Studio, Kimi, Groq, Gemini, and OpenAI-compatible APIs. |
| Tools | Shell/Bash, HTTP, file tools, search, browser capture, Burp ingest, MCP, and finding confirmation. |
| Skills | Markdown playbooks with methodology, payloads, constraints, and allowed tools. |
| Memory | Session memory, context snapshots, resume recap, and continuous local intelligence. |
| Reporting | Confirmed findings saved to `./findings/<slug>.md` with evidence, impact, PoC, and remediation. |
| UX | Full-width terminal UI, slash commands, compact transcripts, permission modals, and interactive provider/model setup. |

## Install

The installers download the latest standalone binary for your OS and verify the
published SHA-256 checksum when available.

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/rust-memo/agent-workbench/main/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/rust-memo/agent-workbench/main/install.ps1 | iex
```

Pin a release or choose an install directory:

```sh
AGENT_WORKBENCH_VERSION=v0.6.0 AGENT_WORKBENCH_INSTALL_DIR="$HOME/.local/bin" \
  sh -c "$(curl -fsSL https://raw.githubusercontent.com/rust-memo/agent-workbench/main/install.sh)"
```

Download binaries directly from
[GitHub Releases](https://github.com/rust-memo/agent-workbench/releases):

| OS | Assets |
|---|---|
| macOS | `agent-workbench-darwin-arm64`, `agent-workbench-darwin-x64` |
| Linux | `agent-workbench-linux-arm64`, `agent-workbench-linux-x64` |
| Windows | `agent-workbench-windows-x64.exe` |

The x64 standalone binaries are built with Bun's baseline runtime for older
x86_64 CPUs. They do not require AVX2.

## Quickstart

```sh
# Local model example
ollama pull qwen2.5-coder:32b
agent-workbench
```

Inside the CLI:

```text
/provider
/target https://app.example.com
map the authenticated API surface and test for IDOR
```

Resume a previous assessment:

```sh
agent-workbench --resume <session-id>
```

On resume, Agent Workbench automatically shows a recap of the previous session's
persistent memory so you can continue without manually reconstructing context.

## Local Web Workbench (v0.6.0)

The Web workbench keeps the existing CLI intact and adds an English-only,
terminal-style local interface. Web sessions use SQLite as their only source of
truth; CLI sessions continue to use the existing JSON store. There is no live
JSON/SQLite synchronization.

Requirements for the Web server:

- Node.js 22 or newer (the CLI remains compatible with Node.js 20).
- Docker Engine with permission for the local user to create containers.
- At least one provider: Ollama, Qwen Code, Codex CLI, Claude CLI, OpenCode, or OpenClaude.

```sh
npm install
npm run build
npm run scanner:build:all
npm run start:web
```

For a foreground, one-command launch from this source checkout, install the
project launcher once and run `aw` from any terminal:

```sh
ln -s "$PWD/scripts/agent-workbench-web" "$HOME/.local/bin/aw"
aw
```

`aw` prints a fresh single-use pairing URL and keeps the server attached to the
current terminal. Pressing `Ctrl+C` or closing that terminal shuts down the
server and invalidates its in-memory pairing token and browser authentication
sessions. Saved assessments remain in SQLite. If port 9099 already belongs to
this checkout, `aw` replaces that server cleanly; it refuses to terminate an
unrelated process.

The server binds only to:

```text
http://127.0.0.1:9099
```

Open the single-use pairing URL printed in the terminal. The fragment is
exchanged for an HttpOnly, SameSite=Strict session cookie and is removed from
the browser address bar immediately.

v0.6.0 extends the Recon-first workspace with a scope form, Quick/Standard/Advanced
profiles, persisted step-by-step runs, ranked live assets, manual-test recommendations,
and a compact audit terminal. A run moves through Scope, optional passive discovery,
DNS, HTTP probing, and deterministic analysis. Standard and Advanced profiles create
single-use approval proposals for deeper scanners; they never run those actions silently.

Recon runs also persist a structured result workspace. Every supported tool has
its own queued/running/saving/terminal lifecycle, raw and parsed artifacts, exit
metadata, and partial stdout/stderr on failure. Normalized assets are deduplicated
without losing source attribution. After passive discovery, the workbench writes
`combined/all-domains.txt`, `all-domains-with-sources.json`, and
`duplicates.json`; authorized in-scope domains then flow through DNSX and HTTPX.
HTTPX writes structured `live-hosts.jsonl`, a simple `live-hosts.txt`,
`failed-inputs.txt`, and `summary.json`.

Open **Recon Results** for searchable Assets, Tool Runs, Combined, HTTPX, Files,
and AI Review tabs. Text, JSON, JSONL, CSV, XML, and Markdown artifacts are
served only through authenticated, audited endpoints and can be searched or
viewed in paginated raw/redacted form. AI Review always shows a redacted,
hash-bound payload preview before dispatch and stores the response as an
auditable artifact linked to its exact input hashes.

The Web skill catalog now loads the core Agent Workbench skills plus curated
API authorization, OAuth/OIDC, business-logic, request-smuggling, and file-upload
playbooks. Each new playbook exposes provenance, a pinned source commit, license,
risk, and Web/CLI compatibility. Loading a skill adds it to the next agent turn;
it does not add shell access to the restricted Web runtime.

The workbench also includes general assistance, Plan and low-impact Recon modes, an
Ollama/Qwen Code/Codex CLI/Claude CLI/OpenCode/OpenClaude provider and checked-model switcher,
Subfinder, DNSX, HTTPX, Katana, Nuclei, FFUF, Nmap connect scanning, an opt-in
raw-socket Nmap profile, SQLite event replay, cancellation,
hash-addressed artifacts, approval proposals, Findings, and Coverage. The
safe scanners run in an ephemeral `agent-workbench-scanner-safe:0.6.0` container.
The server owns the image, entrypoint, flags, network mode, resource limits,
user, and capabilities; targets are sent through stdin. Safe scanner containers
are read-only, non-root, capability-free, `no-new-privileges`, resource-limited,
and receive no host mounts, Docker socket, home directory, or AI credentials.

Use the workspace switcher to move between the full-width **Recon Board** and
**AI Operator** workspace. Recon Board is a transcript-first console: persisted
runtime events stream into color-coded system, recon, scan, approval, artifact,
validation, and AI lines. Auto-scroll follows live work, Focus mode expands the
console and command input, and pending scanner approvals can be accepted or
declined inline. Scope policy, playbooks, and the detailed review inspector open
only on demand. The AI Operator **Run** page keeps the active operation,
pipeline progress, next steps, AI brief, and permission gate focused in one
uncluttered view. **Output & Evidence** separates the live event stream from
tool activity, artifacts, findings, coverage, and scanner health.

The rebuilt command-center UI uses a compact navigation rail for **AI Operator**,
**Output & Evidence**, and **Recon Board**; live Target/Mode/Provider/Scanner
Health cards; a terminal-style session transcript; and a dedicated evidence
rail. Provider and model selection live in a focused side panel so configuration
stays available without crowding the active operation.

The application shell keeps the primary workspace navigation visible while
Sessions, Scope, Providers, Reports, and Settings open as focused side panels.
The lower status card always exposes local-mode and service health, and the
operator canvas remains dedicated to the transcript and approval/evidence rail.
The operations rail uses expanded approval cards with explicit target, risk, and
single-use authorization details, followed by visual artifact, finding,
coverage, AI-assessment, and audit panels.

`Analyze evidence with AI` sends the selected provider a bounded evidence
envelope containing the current scope, run summary, recent typed-tool output,
artifact hashes, findings, coverage, and scanner status. Target and scanner
content is explicitly marked untrusted. Approval-gated scanners can be approved
once or declined; either decision is audited and a declined proposal cannot be
reused.

Subfinder is intentionally off until **Passive sources** is enabled for that
scope, because passive providers may receive the root domain. Existing scopes
can change this policy from either workspace. Enable **Subdomains in scope**
separately only when wildcard subdomains are part of the testing authorization;
otherwise discovered names are retained as discovery-only and are not passed to
active DNS/HTTP actions. Every policy edit increments the scope version and
expires stale pending approvals.

DNSX and HTTPX are low-impact Recon actions when direct recon is enabled.
Katana, Nuclei, FFUF, Nmap, and bounded finding validation create an
operator-visible proposal instead of executing in
the model turn. Approval uses canonical JSON plus the action, mode, and scope
version; it expires after ten minutes and is consumed exactly once. Editing any
argument or changing scope invalidates it. Cancellation removes the exact
ephemeral scanner container.

Nuclei v3.11.0 uses nuclei-templates commit
`7d66fa06cc0a5ad85f7bf35f18cf8ee9218fa9a5`. Only HTTP templates are loaded;
code, headless, file, JavaScript, TCP, Interactsh/OAST, redirects, custom
template paths, unsigned arbitrary templates, and high-impact tags are not
available through the Web action. Scanner matches are stored as
`needs_validation` (or informational), never as confirmed findings. Manual
confirmation is explicit and audited.

Nmap connect scanning uses the non-raw safe image. SYN scanning is isolated in
`agent-workbench-scanner-raw:0.6.0`, disabled by default, never uses
`--privileged`, and receives only `NET_RAW` after starting the server with
`AGENT_WORKBENCH_ENABLE_RAW_SCANNER=1`. FFUF uses the server-owned bounded
wordlist, request limits, and fixed argument builder; the model cannot choose a
wordlist path or command.

The Web workbench can list and import CLI JSON sessions from the fixed
`~/.agent-workbench/sessions` directory. Import is one-way, hash-tracked, and
never modifies the source JSON. Sessions can be exported as redacted JSON and
deleted only after exact-title confirmation. Finding validation supports
bounded GET or HEAD reproduction, saves the response as evidence, and still
requires a separate manual confirmation before a finding becomes confirmed.

Scope enforcement is fail-closed for action inputs and best-effort at the
network layer; it is not claimed to be complete egress isolation. Out-of-scope
discoveries are retained and classified but are never placed into the
active-action queue. A controlled egress proxy or network policy is still
required for a hard network-level scope guarantee.

Type `/` in the Web composer to open the terminal-style command menu. Web-safe
implementations include `/help`, `/provider`, `/model`, `/plan`, `/next`,
`/target`, `/compact`, `/memory`, `/snapshot`, `/skills`, `/maxsteps`,
`/thinking`, `/reset`, and `/clear`. Commands such as `/update`, `/burp`,
`/yolo`, and `/exit` are recognized but keep their privileged operation in the
trusted terminal. Slash commands are parsed as typed backend actions and never
as shell text.

Cancellation records an immediate `turn.cancel-requested` or
`action.cancel-requested` event. It kills the complete CLI-provider process
group or removes the exact scanner container. A short forced-kill fallback
prevents stuck turns while the final event records cancellation deterministically.

Configuration:

```sh
AGENT_WORKBENCH_WEB_PORT=9099 \
AGENT_WORKBENCH_OLLAMA_URL=http://127.0.0.1:11434 \
AGENT_WORKBENCH_OLLAMA_MODEL=qwen3:8b \
npm run start:web
```

Run the repeatable browser workflow with Playwright (set the Chrome path only
when Playwright's bundled Chromium is not installed):

```sh
AGENT_WORKBENCH_E2E_CHROME=/path/to/google-chrome npm run test:e2e
```

Qwen Code is launched with `--safe-mode`, sandboxing, structured JSON output,
and an empty temporary working directory. Codex uses non-interactive,
ephemeral, read-only execution. Claude CLI disables tools and uses plan mode;
when the official `claude` binary is absent, the `claude` provider can use the
installed OpenClaude-compatible CLI. OpenCode is loaded from
`~/.opencode/bin/opencode` by default and runs with `--pure --agent plan` in an
empty temporary directory. Prompt payloads are kept out of process arguments.
External CLI providers dispatch directly without a blocking browser confirmation.
Immediately before every cloud invocation, the exact outbound envelope is
credential-redacted, hashed, audited, and shown as a non-blocking Cloud Preview.
The raw pre-redaction payload is neither previewed nor persisted. Override the
server-owned paths only at startup with `AGENT_WORKBENCH_QWEN_PATH`,
`AGENT_WORKBENCH_CODEX_PATH`, `AGENT_WORKBENCH_CLAUDE_PATH`,
`AGENT_WORKBENCH_OPENCODE_PATH`, or `AGENT_WORKBENCH_OPENCLAUDE_PATH`.

New sessions inherit the provider and model currently selected in the top bar.
The compact terminal now has a dedicated operation progress dock that shows
queued, redacted, running, saving, completed, cancelled, and error states.
Both side panels are drag-resizable, terminal density can be switched live,
and scanner/profile health is visible in the inspector.

Web data is stored under `.agent-workbench/web/` and is intentionally ignored by
Git. Raw artifacts are kept until manually deleted. Preview is redacted by
default; opening or downloading raw evidence creates an audit record.

## Providers

Interactive setup:

```text
/provider
/model list
/model <id>
```

CLI examples:

```sh
# Ollama
agent-workbench --backend ollama --model qwen2.5-coder:32b

# LM Studio
agent-workbench --backend lmstudio --model zai-org/glm-4.7-flash

# OpenAI-compatible endpoint
agent-workbench --backend openai-compat \
  --base-url https://api.example.com/v1 \
  --api-key sk-...

# Kimi
MOONSHOT_API_KEY=sk-... agent-workbench --backend kimi --model kimi-k2.6

# Groq
GROQ_API_KEY=gsk_... agent-workbench --backend groq --model openai/gpt-oss-20b

# OpenRouter
OPENROUTER_API_KEY=sk-or-... agent-workbench --backend openrouter --model openrouter/auto

# DeepSeek
DEEPSEEK_API_KEY=sk-... agent-workbench --backend deepseek --model deepseek-v4-flash

# Gemini
GEMINI_API_KEY=AIza... agent-workbench --backend gemini --model models/gemini-3.5-flash
```

Notes:

- Groq sessions use a compact prompt and lower compaction threshold to avoid
  on-demand TPM errors during long assessments.
- LM Studio responses are protected with stop tokens and template-marker
  trimming to avoid repeated `<|user|>` / `<|observation|>` leakage.
- Gemini picker highlights recommended and cheap-cost models.

## Pentest Lifecycle

Agent Workbench is designed to assist across the full engagement:

1. **Scope**: set target URL, constraints, credentials, and authorization notes.
2. **Recon**: discover hosts, endpoints, technologies, files, APIs, and exposed
   metadata.
3. **Enumeration**: map parameters, roles, auth states, captured browser/Burp
   traffic, and attack surfaces.
4. **Validation**: reproduce candidate issues with deterministic requests and
   compare evidence.
5. **Coverage**: track tested endpoint/parameter/vulnerability-class tuples and
   ask `/next` for untested work.
6. **Reporting**: persist confirmed findings with PoC, evidence, impact, and
   remediation.
7. **Learning**: save reusable lessons silently so future sessions improve.

## Continuous Learning

Agent Workbench includes a local Continuous Learning System. It improves future
sessions without retraining model weights and without requiring users to manage
memory manually.

What it stores:

- User preferences and working style.
- Important decisions and project context.
- Successful workflows and proven commands.
- Mistakes, failed assumptions, and lessons learned.
- Coverage gaps, missed checks, and follow-up scenarios.
- Finding patterns and evidence requirements.
- Tool/config patterns that worked well.

Where it stores memory:

| Path | Purpose |
|---|---|
| `./.agent-workbench/intelligence/scenarios.jsonl` | Project-specific intelligence for the current engagement/workspace. |
| `~/.agent-workbench/intelligence/scenarios.jsonl` | Personal reusable intelligence across future projects. |

How it behaves:

- Learning runs in the background after completed turns and compactions.
- Retrieval is silent and injected as hidden context only when relevant.
- Duplicate project/personal memories are deduped before reaching the model.
- Secrets are redacted before storage.
- Learning failures are logged, not shown as user-facing task errors.

This keeps the user experience simple while making the agent more effective over
time.

## Session Memory And Resume

Agent Workbench saves sessions under `~/.agent-workbench/sessions/*.json`.

```sh
ls -lt ~/.agent-workbench/sessions/*.json | head
agent-workbench --resume <session-id>
```

Session continuity includes:

- Saved conversation history.
- Persistent compacted memory.
- Target state.
- Resume recap on startup.
- Context snapshots under `~/.agent-workbench/context/`.
- Five-minute automatic snapshots during active sessions.

Useful commands:

| Command | Purpose |
|---|---|
| `/compact` | Summarize the current session into persistent memory. |
| `/memory` | Show saved facts + the session checkpoint. |
| `/memory add <text>` | Save a durable fact (same as `#<text>`). |
| `/memory list` | List saved facts. |
| `/memory forget <text>` | Drop saved facts and checkpoint items matching the text. |
| `/snapshot` | Write a redacted context snapshot immediately. |
| `/next [objective]` | Ask for coverage-driven next steps. |

### Saved memory (`#` quick-add)

Type `#` followed by anything you want the agent to remember for the rest of
this session and beyond — for example `#orders API is IDOR-prone on
/api/orders/{id}`. Use `#!<text>` to save it to your **personal** scope instead
of the project.

- Saved facts are durable, human-readable Markdown — one file per fact with
  frontmatter — under `./.agent-workbench/memory/` (project) and
  `~/.agent-workbench/memory/` (personal), with a generated `MEMORY.md` index.
- The fact catalog is pinned into the system prompt on **every** turn, so it
  survives compaction; the facts most relevant to the current turn are recalled
  in full automatically (you'll see a `recalled memory: …` line).
- Secrets are redacted before a fact is written to disk.
- Manage them with `#<text>` / `/memory add`, `/memory list`, and
  `/memory forget <text>`.

## Burp Integration

Use the companion
[Agent Workbench repository](https://github.com/rust-memo/agent-workbench)
tool to send selected Burp traffic into the CLI and import confirmed findings
back into Burp.

Start the local Agent Workbench listener:

```sh
agent-workbench --burp
agent-workbench --burp 9999
```

From source:

```sh
npm run dev -- --burp 9999
```

The Burp/Agent Workbench bridge supports:

- Sending selected Burp requests into Agent Workbench.
- Queuing requests as scan tasks.
- Importing confirmed findings back into Burp issues.
- Preserving full raw requests for evidence and replay.
- Reading captured requests and issues through `browser_capture_*` tools.

The default listener is `http://127.0.0.1:9999`.

## Browser Capture And MCP

`agent-workbench --burp` starts a local ingest server for captured requests,
endpoints, and browser snapshots. The companion `agent-workbench-browser-mcp`
binary exposes the same capture data as an MCP server for compatible clients.

```json
{
  "mcpServers": {
    "agent-workbench-browser": {
      "command": "agent-workbench-browser-mcp",
      "args": []
    }
  }
}
```

## Slash Commands

| Command | Description |
|---|---|
| `/help` | Show keybindings and command reference. |
| `/provider` | Pick backend, API key, and model interactively. |
| `/model <id>` / `/model list` | Switch or list backend models. |
| `/plan [objective]` | Plan-only turn without tool execution. |
| `/next [objective]` | Coverage-driven next test suggestions. |
| `/target <url>` | Set or clear the engagement base URL. |
| `/compact` | Summarize into persistent session memory. |
| `/memory` | Show current persistent session memory. |
| `/snapshot` | Write a redacted context snapshot now. |
| `/burp [port]` | Start the local Burp/Agent Workbench bridge and print its URL + token. |
| `/skills [enable\|disable\|new <name>]` | Manage or scaffold skills. |
| `/maxsteps <n>` | Set the per-turn tool-call cap. |
| `/thinking on\|off` | Toggle visible reasoning guidance. |
| `/update [version]` | Install the latest or pinned release. |
| `/yolo [on\|off]` | Toggle auto-approval mode for labs. |
| `/reset` | Clear conversation and saved session state. |
| `/clear` | Clear only the on-screen transcript. |
| `/<skill-name>` | Load a skill into the next turn. |
| `/exit` | Quit. |

## Command-Line Flags

| Flag | Description |
|---|---|
| `--backend ollama\|lmstudio\|kimi\|groq\|openrouter\|deepseek\|gemini\|openai-compat` | Select the LLM backend. |
| `--model <id>` | Set the model id. |
| `--base-url <url>` / `--api-key <key>` | Configure remote or OpenAI-compatible backends. |
| `--skills <dirs>` | Load extra skill directories. |
| `--resume <session-id>` | Resume a saved session and show recap. |
| `--browser` | Enable Browser MCP tools for the current session. |
| `--burp [port]` | Start the local Burp/Agent Workbench bridge. |
| `--browser-ingest [port]` | Deprecated alias for `--burp`. |
| `--no-stream` | Disable streaming for providers with SSE/tool-call issues. |
| `--yolo` | YOLO mode: auto-approve non-sensitive tool calls (alias: `--dangerously-skip-permissions`). |
| `--list-tools` / `--list-skills` | Print registered tools or discovered skills. |
| `--log <path>` | Override the JSON-lines log path. |
| `--debug-session` | Write a full JSON-lines debug session log. |
| `--debug-session-path <path>` | Write debug session log to a custom path. |
| `--version` / `--help` | Print version or help. |

## Tools

| Tool | Purpose |
|---|---|
| `shell` / `BashTool` | Run shell commands with approval and safety checks. |
| `http` | Send HTTP/HTTPS requests against full URLs or active `/target`. |
| `file_read` / `file_write` / `file_edit` | Read, create, and patch files. |
| `GlobTool` / `GrepTool` | Discover files and search content. |
| `web_fetch` / `web_search` | Fetch pages or run web searches. |
| `ask_user` | Ask for a decision when scope or direction is ambiguous. |
| `confirm_finding` | Save verified findings to `./findings/<slug>.md`. |
| `coverage` | Track tested endpoint/parameter/vulnerability-class tuples. |
| `load_skill` | Load methodology playbooks into context. |
| `browser_capture_*` | Query captured browser/Burp traffic, endpoints, requests, issues, and snapshots. |

## Skills

Skills are Markdown playbooks that package methodology, payloads, and tool
constraints. Built-in skills include:

| Skill | Focus |
|---|---|
| `recon` | Subdomains, fingerprinting, content discovery, and attack-surface mapping. |
| `webvuln` | IDOR, broken access control, injection, auth, and session logic. |
| `ssrf` | Filter bypasses, metadata access, internal reachability, and blind SSRF. |
| `ssti` | Template-engine fingerprinting and escalation paths. |
| `jwt` | Algorithm confusion, `kid` abuse, weak secrets, and token validation flaws. |
| `graphql` | Introspection, authorization gaps, batching, and depth abuse. |
| `race` | TOCTOU issues, limit bypasses, and race-condition verification. |
| `takeover` | Dangling DNS and unclaimed cloud resources. |
| `supabase` | Row-Level Security and anonymous access mistakes. |
| `deserialize` | Unsafe deserialization sinks and gadget-chain testing. |

Discovery order:

1. Built-in `skills/`
2. Project-local `./.agent-workbench/skills/`
3. Personal `~/.agent-workbench/skills/`
4. Directories passed with `--skills`

Later entries win on name collisions.

## Reporting

The `confirm_finding` tool writes confirmed issues to:

```text
./findings/<slug>.md
```

Reports include:

- Title and severity.
- Affected URL, method, parameter, and payload when available.
- Response excerpt proving the issue.
- Impact and remediation.
- Copy-pasteable curl reproduction command.
- Raw request material for Burp issue import when available.

## Security Model

- **Authorized use only**: built for permitted security work.
- **Human-in-the-loop by default**: permission-gated tools require allow once,
  allow session, or deny.
- **Sensitive path protection**: high-risk local paths remain gated.
- **Shell safeguards**: catastrophic command patterns are blocked before
  execution.
- **Credential redaction**: compaction, snapshots, and learning paths redact
  common secret formats.
- **Transparent evidence**: findings should be backed by reproducible requests
  and observed responses.
- **Auditability**: sessions, logs, findings, coverage, and release artifacts are
  written to deterministic local paths.

## Configuration And Data

| Path | Contents |
|---|---|
| `~/.agent-workbench/config.json` | Backend, model, endpoint, and disabled-skill settings. |
| `~/.agent-workbench/sessions/*.json` | Saved sessions for `--resume`. |
| `~/.agent-workbench/context/*.md` | Redacted context snapshots. |
| `./.agent-workbench/intelligence/scenarios.jsonl` | Project intelligence learned from this workspace. |
| `~/.agent-workbench/intelligence/scenarios.jsonl` | Personal reusable intelligence across projects. |
| `~/.agent-workbench/builtin-skills/<name>/SKILL.md` | Installer-managed shipped skills. |
| `~/.agent-workbench/skills/<name>/SKILL.md` | Personal skills. |
| `./.agent-workbench/skills/<name>/SKILL.md` | Project-local skills. |
| `./findings/<slug>.md` | Confirmed findings for the current engagement. |
| `./findings/coverage-<session-id>.json` | Coverage state for endpoint/parameter/vulnerability-class testing. |
| `~/.agent-workbench/logs/agent-workbench.log` | Structured JSON-lines logs. |
| `~/.agent-workbench/debug/session-*.jsonl` | Opt-in full session debug logs. |

Enable complete debug logs when reproducing usage issues:

```sh
agent-workbench --debug-session
AGENT_WORKBENCH_DEBUG_SESSION=1 agent-workbench
AGENT_WORKBENCH_DEBUG_SESSION=1 AGENT_WORKBENCH_DEBUG_SESSION_PATH=/tmp/agent-workbench-debug.jsonl agent-workbench
```

Treat debug logs as sensitive because they can contain target data, command
output, and copied request material.

## Develop

```sh
npm install
npm run dev -- --version
npm run dev -- --burp 9999
npm run typecheck
npm run lint
npm run test
npm run build
node dist/cli.js
```

`npm run ci` runs typecheck, lint, tests, and build.

## Contributing

Issues and pull requests are welcome. Keep changes focused, include tests for
behavioral updates, and run `npm run ci` before opening a pull request. New
skills should include a `SKILL.md` and pass the skill conformance tests.

## License

[Apache-2.0](LICENSE). Use responsibly and only with authorization.

<div align="center">
<br/>

**[Report an issue](https://github.com/rust-memo/agent-workbench/issues)** ·
**[Request a feature](https://github.com/rust-memo/agent-workbench/issues/new)** ·
**[Releases](https://github.com/rust-memo/agent-workbench/releases)**

</div>
