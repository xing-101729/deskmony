<div align="center">

# Deskmony

**A desktop control room for AI coding agents — built so they can run unattended for hours without going off the rails.**

![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-44-47848F?style=flat-square&logo=electron&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-workspaces-F69220?style=flat-square&logo=pnpm&logoColor=white)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20(CLI)-0078D6?style=flat-square&logo=windows&logoColor=white)
![i18n](https://img.shields.io/badge/i18n-4%20languages-6f42c1?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

**[English](README.md)** · **[繁體中文](README.zh-Hant.md)**

</div>

---

Deskmony lets you run AI coding agents — not one chatbot in a sidebar — on a backend of your choice (Claude Code, Codex, OpenCode, or any CLI you already have), with a safety shield underneath so you can watch, or not have to.

> **2026-10-02:** the product was simplified (see [`DECISIONS.md` §H](docs/DECISIONS.md)). Agent profiles, teams, the task board and git-worktree-per-task are gone. In their place, Deskmony finds the agent CLIs already installed on your machine and starts a session from any of them directly, and every session can find the available agents, start new sessions, and message any other session.

## Why Deskmony

Most multi-agent coding tools give you two options: approve every permission prompt yourself, or switch on full auto-approve and hope. Deskmony takes a third path.

The thesis is simple: **letting agents run unattended isn't about trusting them more — it's about circuit breakers that don't care how much you trust them.** Three independent breakers sit underneath every agent, every message, and every dollar spent. Any one of them can halt a runaway on its own. The cost and message breakers cannot be switched off remotely; the permission breaker reached remote/local parity on 2026-08-25 — a deliberate, documented reversal (see [`DECISIONS.md` §G](docs/DECISIONS.md)), spelled out under "The remote boundary" below.

The four directories that exist purely to serve the safety shield — `permissions/`, `cost/`, `enforcement/`, `recovery/` — are **1,331 lines of actual code (blanks and comments excluded), 26% of the orchestration core** (5,033 lines; the share was 22% before the team and task layer was removed on 2026-10-02, 29% right after, and fell back as the agent catalog and the session network were added to the core). That is before counting the decision plumbing inside the session manager, and the message breaker (`session/message-chain-budget.ts`), which lives in `session/` rather than in those four directories.

(That figure deliberately excludes comments. This codebase is roughly 30% comments; counting them gives a nicer-looking number — but a comment has never blocked a tool call, so citing it as evidence of safety investment would be dishonest. **Line counts can't prove safety anyway**: what actually should convince you is the decision flow below, and the per-category assertions in `scripts/e2e-hard-deny.mjs`.)

## ✨ Highlights

- 🛡️ **Independent circuit breakers** — permissions, messages and cost. Default-deny throughout, with a hard-deny list that no auto-mode can bypass — the one deliberate exception is an explicit, typed-confirmation "true-unrestricted" tier, covered below.
- 🌱 **Every session can find agents, start sessions and message any other session** — Deskmony detects the agent CLIs already on your machine; a new session is just an agent, an optional model and a working folder, with no profile to set up. Sessions that can run tools (the embedded Claude Agent SDK and every ACP agent: Codex, Gemini, and OpenCode via `opencode acp`) get five tools from a `deskmony` MCP server — `list_agents`, `list_sessions`, `read_session`, `create_session`, `send_to_session`. Nothing is routed back automatically: whoever receives a message decides whether to reply, and to whom. Starting a session and sending a message are deliberately *not* on the auto-allow list — they go through the same permission ladder as any other tool call — and a per-chain message budget stops runaway ping-pong.
- 🖥️ **A real desktop IDE** — streaming markdown, inline diffs, an embedded terminal, todo tracking, image tool output, interactive question prompts, and a "forward to…" button that hands any assistant reply to another session.
- 🔌 **Four adapters, one interface** — embedded Claude Agent SDK, ACP, OpenCode HTTP/SSE, and a raw PTY fallback for anything else.
- 🔄 **Crash recovery that doesn't guess** — orphaned sessions are reconciled on startup and triaged by a human. Nothing auto-resumes, by design.
- 🌐 **Remote-capable, with a clear line on what stays local** — connect from a browser or phone over token auth; remote now shares session control and policy edits with local (2026-08-25), but never provider settings (which can hold API keys) or network binding.
- 🌍 **Localized** — English, Traditional Chinese, Japanese, Spanish.

## 🛡️ The safety shield

### Breaker 1 — Permissions

Every tool call an agent makes runs this ladder. The order is fixed and cannot be reconfigured:

```mermaid
flowchart TB
    Req["Tool call<br/>(name, input, workingDir, providerId)"] --> TU{"0 · true-unrestricted?"}
    TU -- yes --> Allow0["ALLOW — bypasses everything,<br/>including hard-deny"]
    TU -- no --> HD{"1 · hard-deny hit?"}
    HD -- no --> Rules{"2 · config rules,<br/>in order"}
    HD -- "yes + remote or auto-mode" --> Deny["DENY — hard floor"]
    HD -- "yes + local + human present<br/>+ auto-mode off" --> Strong["ESCALATE-STRONG<br/>red-framed confirm<br/>never eligible for 'always allow'"]
    HD -- "yes + nobody watching" --> Deny
    Rules -- "deny rule" --> Deny2["DENY"]
    Rules -- "allow rule" --> Allow["ALLOW"]
    Rules -- "no match" --> Auto{"3 · auto-mode on?"}
    Auto -- yes --> Allow2["ALLOW — unclassified middle ground"]
    Auto -- no --> Esc["4 · ESCALATE<br/>default-deny"]
```

**Four hard-deny categories, not overridable by config:** writes or deletes outside the session's working directory · reading secret paths (`~/.ssh`, `~/.aws`, `~/.deskmony`, `**/.env*`, `**/id_rsa*`, `**/credentials`) · dangerous git (`push --force`, deleting remote branches, `branch -D`) · network calls to non-allowlisted hosts.

A few properties worth stating plainly:

- **YOLO mode differs from auto mode in exactly one way**: it additionally skips config `deny` rules. **Neither skips hard-deny.** YOLO also expires after 30 minutes.
- **Anything the engine can't classify escalates.** Never allows. That's the last line of `decide()`.
- **OpenCode is forced through the same ladder.** OpenCode allows every tool by default and only asks for the ones its own config marks `"ask"` — and most people's config marks none — so left alone its bash/edit/webfetch/MCP calls would never reach the engine. When Deskmony launches OpenCode (both the `opencode` and `opencode-acp` providers) it injects an `OPENCODE_CONFIG_CONTENT` that sets every tool to `ask`, merged over whatever you already have (yours is kept, Deskmony's permission rules win). The visible consequence: an OpenCode session in `always-ask` now stops to ask where it used to run silently; auto/YOLO behave as usual. One limitation: on the `opencode-acp` provider the `task` (subagent) tool is turned off, because `opencode acp` never forwards a subagent's permission requests and the subagent would hang forever.
- **Timeout semantics depend on who's around.** Someone watching → a pending request times out into a deny. Nobody watching → **no timer at all**; the session sits in `waiting` until a human answers. Treating "no reply" as "denied" would throw away an entire night's work. The cost breaker is what stops that from hanging forever.
- **"Always allow" has three rules**: write the narrowest possible rule (`commandEquals` / `pathUnder`); write it to both the config file and memory so behaviour is identical before and after a restart; and hard-deny escalations are **never** eligible — the core strips `rememberRule` even if a client sends one.
- **Rules can be scoped to an agent** (`providerId`, e.g. a rule that only applies to Codex sessions). Rules left over from the profile era — scoped to a profile id or role in an older `config.json` — can no longer match anything, so they fail toward safety: such `allow` rules stop matching (the call escalates instead), and such `deny` rules now apply to every session, so a scoped deny never goes quiet and turns into an automatic allow under auto mode. Core logs each affected rule at startup.
- **One explicit, audited exception can cross the hard-deny floor**: a session-scoped "true-unrestricted" tier, layered on top of YOLO, gated behind a typed confirmation phrase, available locally *and* remotely since 2026-08-25 (see [`DECISIONS.md` §G](docs/DECISIONS.md)). It's the only path through `decide()` that skips hard-deny — it only arms per session, only once that session is already in YOLO, and only after a human types the confirmation phrase; enabling it fires a desktop notification and an audit-log entry.

### Breaker 2 — Messages

Once agents can message each other, the failure to guard against is a loop: A answers B, B answers A, forever — or one agent fanning out new sessions without end. The original budget (a core-derived context id plus a per-context ceiling) went away with the message bus on 2026-10-02 (see [`DECISIONS.md` §H](docs/DECISIONS.md)); the breaker was rebuilt on a different unit, the **message chain**:

- A prompt typed by a human — or a forward from the UI — starts a **new chain**. Every `send_to_session` / `create_session` an agent makes while handling a message stays on the chain of the turn that triggered it.
- A chain may carry up to `messageBudget.maxMessagesPerContext` agent-to-agent messages (default 50; the key name is kept from the earlier design so existing configs still parse). A soft warning (audit entry + notification, no halt) fires at `warnAtPercent`.
- **The first message over the ceiling trips the breaker**: it is refused, the tool result tells the agent the chain has tripped and a human has to step in, and the audit log plus a desktop notification record it (once per chain, so a retrying agent can't spam you). `create_session` on a tripped chain doesn't spawn anything.
- The trip stops **agent-to-agent** delivery only. You can still type into any session, and doing so starts a fresh chain; a UI forward is a human action, so it also opens a new chain and is never counted or blocked.
- Counters live in memory (core restart resets them) and the setting is not in the remotely editable subset — remote clients can't turn this breaker off.

### Breaker 3 — Cost

| Component | Signal | Trips on | What it halts |
|---|---|---|---|
| **TurnLimiter** | `tool-call` events + wall clock — **no usage data needed** | 30 min or 200 tool calls in one turn | Interrupts immediately |
| **CostGovernor** (daily kill-switch) | `usage` events | Spend for the day | Interrupts every session, blocks further prompts |
| **WaitingWatchdog** T1 | Time in `waiting` | 6 hours | Notifies only — no halt |
| **WaitingWatchdog** T2 | Time in `waiting` | 72 hours | Disposes the process; the conversation history is preserved |

> **TurnLimiter matters most.** Measured against real Claude Code over ACP: the bridge reports **zero** usage — not a config problem, a structural gap. For that backend, every usage-based budget is inert, and the turn hard-cap is the only protection left.

### The remote boundary

`isLocal` is decided by the core from the connection's own address and is **never taken from the client's word for it**. Tunnelled connections (Tailscale, WireGuard) are not loopback and count as **remote** — a tunnel secures transport, it doesn't put an operator in the room.

Remote clients **can** watch, send prompts, approve or deny escalations, switch a session to auto/YOLO, edit the policy allowlist, and attach an "always allow" rule to an approval — parity with local as of 2026-08-25, a deliberate, documented reversal of the earlier remote restriction (see [`DECISIONS.md` §G](docs/DECISIONS.md)). Remote can even arm the "true-unrestricted" tier described above, through the same typed-confirmation gate as local. What remote still **cannot** do: edit provider settings (their environment variables can carry API keys and are merged into every agent process), edit the general config file, or change the network bind address. That's enforced at the dispatch layer, not by hiding buttons in the UI — a raw request bypassing the UI gets rejected the same way.

Binding to a non-loopback address without `DESKMONY_AUTH_TOKEN` **refuses to start**. The token is deliberately not a config-file field, so editing config can't widen exposure — it comes only from the env var, or (desktop shell only) a value the Settings "remote access" panel keeps encrypted at rest via Electron's `safeStorage`, letting you copy a stable token to hand to a browser or phone.

The WebSocket upgrade also carries a **same-origin check independent of the token** (added 2026-09-04). Browsers are not bound by same-origin policy when opening a `ws://` connection — any web page can reach your local gateway, and its source address genuinely *is* 127.0.0.1, so it is correctly judged "local". With no token set, that makes "visit one malicious page" enough to take over. The rule now: requests with no `Origin` (non-browser clients — phone apps, scripts) pass, browser UIs same-origin with `Host` pass, `file://` and loopback origins pass **only when a token is enabled** (the desktop shell always sets one; a sandboxed iframe can't obtain it), everything else is rejected at the upgrade.

## 🏗️ Architecture

Three tiers. The desktop shell is deliberately just one client of the core — the same WebSocket gateway serves a browser or a phone.

```mermaid
flowchart TB
    subgraph SHELL["apps/desktop — Electron 44 + React 18"]
        direction LR
        Views["views/ chat · recovery"]
        Stores["stores/ zustand × 2"]
    end

    subgraph CORE["apps/core — headless orchestration server"]
        GW["gateway/ — 39 RPC methods + 8 push channels"]
        subgraph DOMAIN["domain"]
            direction LR
            Sess["session/"]
            Agents["agents/"]
        end
        subgraph SHIELD["safety shield · 26% of core"]
            direction LR
            Perm["permissions/"]
            Cost["cost/"]
            Enf["enforcement/"]
            Rec["recovery/"]
        end
    end

    subgraph PKG["packages/"]
        direction LR
        Adapters["adapters/ — 4 adapters + 1 MCP server"]
        Shared["shared/ — zod, single source of truth"]
        Db["db/ — 5 tables"]
    end

    SHELL -- "WebSocket + token auth" --> GW
    GW --> DOMAIN
    GW --> SHIELD
    SHIELD --> DOMAIN
    DOMAIN --> Adapters
    CORE --> Db
```

**Dependency rule:** `packages/*` must never import `apps/*`. What the adapters need from the core is declared as interfaces in `packages/shared` (`SessionNetworkPort` for the session tools, `McpBridgeTokenPort` for the ACP bridge's scoped tokens) and injected at construction time.

### Adapters

Four adapters are registered. Every one implements the same interface, so permissions and the session manager never need to know which CLI is on the other end.

| Adapter | Transport | Backends today | Capability tier |
|---|---|---|---|
| `ClaudeAgentSdkAdapter` | Claude Agent SDK, embedded in-process | Claude Code | Deepest — hooks, in-process session tools, fine-grained permission events, live model and effort switching |
| `AcpAdapter` | [Agent Client Protocol](https://agentclientprotocol.com) over stdio JSON-RPC | Gemini CLI, Codex (via the `@agentclientprotocol/codex-acp` bridge package — the official `codex` binary doesn't speak ACP natively), other ACP-native agents | Structured events |
| `OpenCodeAdapter` | OpenCode's HTTP + SSE server | OpenCode | Native server, works remotely |
| `GenericPtyAdapter` | Raw `node-pty` passthrough | Claude Code CLI, Aider, any interactive CLI | **Fallback — no permission events** |

The user-facing layer is a **provider catalog** of seven entries, each guaranteed at the type level to map onto one of those four: `claude-agent-sdk`, `claude-cli` → PTY, `gemini` → ACP, `opencode`, `opencode-acp` → ACP (OpenCode driven through `opencode acp`, which is what gives it the session tools), `codex` → ACP (via the `@agentclientprotocol/codex-acp` bridge, not a locally installed codex CLI), `aider` → PTY. The manual "type any command" entry (`custom-pty`) was removed on 2026-10-02: a session can only be started from an agent Deskmony itself detected, and nothing on the gateway can add a command.

**The PTY tier's missing permission events are a security boundary, not a to-do item.** It's raw stdin passthrough — structurally unmanageable by the policy engine. Until a real execution sandbox exists, PTY agents stay read-only with no unattended autonomy. Deskmony deliberately does **not** try to intercept shell commands: `bash -c`, `$()`, and base64 defeat that in seconds, and shipping it would be security theater.

**Capability reporting is honest about what it doesn't know.** Usage and context reporting are tri-state — `supported` / `unsupported` / `unknown` — because whether a connection reports usage is decided by the agent that got spawned, not the adapter. The same `AcpAdapter` forwards usage faithfully for one agent and never sees a single event from another. A static boolean would mean lying to the UI in one direction or the other, so consumers must converge on the truth from what a session actually observed.

### Agents and sessions

There are no profiles. `AgentCatalog` (`apps/core/src/agents/`) is the one place that knows which agents can start a session:

- **Detection.** Core scans for the agents in the catalog in the background at startup (it never blocks startup); "Re-detect" in the sidebar or in Settings re-scans. Settings still lets you disable an agent, reorder them, pick which models are offered and set per-agent environment variables — that is where an API key goes.
- **Starting a session** is `session.create` with an agent (`providerId`), an optional model and effort (effort only applies to the Claude Agent SDK), and a working folder. The desktop sidebar has those four pickers plus a "New conversation" button; the CLI has `--agent <providerId>` (default `claude-agent-sdk`), `--model` and `--effort`. If no agent is detected, the sidebar says so and offers to re-detect.
- **A session carries its own launch information** (its provider, plus the command and arguments for the CLI-based ones), so continuing it after a restart never depends on anything else. If the agent is no longer detected, the stored command is used. Sessions created before this change are backfilled from their old profile the first time core starts; the old `agent_profiles` table is only ever read, never modified.
- Every session starts in `always-ask`. The switch to auto/YOLO stays per session, as before.

### Session network

Sessions that can run tools get five tools from a `deskmony` MCP server (Claude shows them as `mcp__deskmony__<name>`):

| Tool | What it does | Permission |
|---|---|---|
| `list_agents` | Which agents can start a session right now (id, label, models, default model, whether that agent can use tools) | auto-allowed |
| `list_sessions` | **Every** session, not just your own children: id, title, agent, model, status, working folder, parent, whether it is you, whether it can message back. No conversation content | auto-allowed |
| `read_session` | The last N messages (default 20, max 100) of any session — user and assistant turns only, each cut at 4,000 characters | auto-allowed |
| `create_session` | Start a session with a chosen agent and send it a first message | goes through the permission ladder |
| `send_to_session` | Send a message to any other session. If it is busy the message waits in a queue until its current turn ends; a closed, errored or missing target is a clear error, never a silent success | goes through the permission ladder |

Four rules shape how this behaves:

- **Everyone can see everyone.** No parent/child restriction, no per-folder restriction. A session started with `create_session` is shown nested under its creator in the sidebar — for display and provenance only; it is otherwise a peer. You can also open a new session under any session by hand.
- **Nothing is sent back automatically.** A message arrives wrapped in an envelope saying who sent it and that it will not be answered unless the receiver chooses to. Whether to reply — and to whom, which need not be the sender — is the receiving agent's decision, made with `send_to_session`. The earlier "child finished, so inject its result into the parent" behaviour is gone.
- **Identity can't be forged.** Who is calling comes from the adapter (in-process) or from the bridge token (ACP), never from a tool argument. The envelope is added only when the message reaches the agent; the saved history keeps the original text plus its origin.
- **Not every agent can send.** The Claude Agent SDK (in-process) and every ACP agent — Codex, Gemini CLI, OpenCode via the `opencode-acp` provider — can call the tools. OpenCode over HTTP and PTY agents (Claude Code CLI, Aider) can *receive* messages but not send them; `list_agents` and `list_sessions` report `canUseTools: false` so a sender knows they can't answer.

In the desktop app a received message shows an "From <session>" tag (or "Forwarded from <session>"), and every assistant message has a "Forward to…" action: pick any other session, add an optional note, and the target receives it as a message from you. Agent-to-agent traffic is bounded by Breaker 2 above.

## 📋 Task flow — removed 2026-10-02

The task board (backlog → assigned → in-progress → review → merging → done), the per-task git worktree, the machine acceptance gate, the human review gate and the human-approved merge were removed together with teams — see [`DECISIONS.md` §H](docs/DECISIONS.md). Existing `tasks` / `workspaces` tables in your SQLite file are left untouched; nothing reads them any more.

## 🔄 Crash recovery

The expensive thing — an agent's accumulated reasoning and context — lives in the backend process, not the database. Replaying an event log rebuilds your ledger, not the agent's mind. So recovery here is **reconciliation plus human triage**, not replay.

On startup, before the gateway accepts a single connection, sessions that weren't closed cleanly are marked `interrupted` and written to the audit log. Then a human decides, per session: **continue** (only where the backend genuinely persists sessions to disk — re-verified by the core, never trusted from a stale client snapshot), **take over** (restart from a summary), or **abandon** (the session is closed but its history is preserved — reclaiming isn't discarding). **Nothing is ever silently thrown away, and nothing auto-resumes.**

## 🚀 Getting started

### Prerequisites

- **Node.js ≥ 20** and **pnpm 10** (the repo pins `pnpm@10.13.1` — `corepack enable` picks it up)
- Windows for the packaged desktop installer. **The core and the CLI also run on Linux** — a `ubuntu-latest` CI job builds them and runs the CLI end-to-end suite on every PR. Be precise about what that proves: the core + CLI path works there, against a fake backend that needs no credentials. It does *not* prove that every adapter drives every real backend on Linux — nobody has tested that yet.
- At least one agent backend that Deskmony can detect: log into the Claude Code CLI, set an `OPENAI_API_KEY`/`CODEX_API_KEY` (or use ChatGPT login) for Codex — it runs through a bundled `@agentclientprotocol/codex-acp` bridge, no separate codex CLI install needed — or install OpenCode, Gemini CLI or Aider. Core finds them on startup; there is nothing to configure per agent except credentials. **Deskmony orchestrates agents; it does not ship model access.**

### Install

```bash
git clone https://github.com/xing-101729/deskmony.git
cd deskmony
pnpm install
```

### Run in development

Three terminals, easiest for watching both sides:

```bash
pnpm dev:core       # headless core — WebSocket gateway on :4317
pnpm dev:desktop    # Vite dev server for the UI
pnpm dev:electron   # Electron shell
```

Or just `pnpm dev:electron` — the main process spawns core for you.

### Headless, no desktop shell

```bash
pnpm start:core
```

Then open `http://127.0.0.1:4317/`. The core serves the same UI as a static page over the same port it uses for the WebSocket gateway, so a browser or phone needs nothing installed. The static page needs no auth to download; the WebSocket behind it still does.

### The `deskmony` CLI

The desktop shell was always meant to be *one* client of the core, not the only one. The CLI is the third — same WebSocket gateway, same safety shield. It runs on Linux and in Windows `cmd.exe`.

```bash
deskmony serve                 # run the headless core in the foreground
deskmony                       # interactive REPL (same as `deskmony chat`)
deskmony run "find the TODOs"  # one-shot: stream the answer, then exit
deskmony run - < prompt.txt    # read the prompt from stdin
deskmony --agent codex run -   # pick the agent (a provider id; default claude-agent-sdk)
deskmony session list --json   # NDJSON, for scripts
deskmony doctor                # detect agent backends, check the connection
```

`--agent <providerId>` (with `--model` and `--effort`) chooses what the new session runs on; `deskmony doctor` shows which agents were detected.

`serve` and the clients are separate on purpose: the core owns a SQLite database, and two cores on one data directory is a real hazard. Start `serve` in one terminal (or leave the desktop app running) and point the others at it with `--url` / `DESKMONY_URL`.

Exit codes are stable enough to branch on: `0` success, `1` runtime error, `2` bad usage, `3` cannot connect or auth failed, `4` a permission request was denied. **`4` matters more than it looks** — a denied turn ends with exactly the same events as a successful one, so a CLI that only watched the event stream would report success for a turn that did nothing. `run` tracks its own denials instead.

Outside a TTY, `run` never invents permission for itself: it denies, names the tool on stderr, and exits `4`. To automate, say so explicitly with `--permission-mode auto-accept-edits`, which maps onto the core's existing `session.setPermissionMode`. There is no silent-approval path.

#### The full-screen view

```bash
deskmony tui
```

`chat` and `run` show you one session. `tui` shows every session, and that difference is the reason it exists: **a permission request raised by a session you are not currently watching is invisible in a line-oriented REPL, and unattended requests never time out.** A second agent can sit blocked for hours while you read the first one's output. The TUI puts a cross-session pending count on screen no matter which session has focus, and `a` walks the queue one request at a time — showing the tool's actual arguments, not just its name, because the name alone ("Write file") tells you nothing you could judge.

Escalations that hit the hard-deny list look different and behave differently: no "always allow", and a typed `yes` rather than a keystroke.

It needs **Node 22** (an Ink requirement, checked at startup with a clear message on older versions) and a real terminal. `deskmony chat` remains the right tool when piping, scripting, or working on a terminal that cannot do full-screen — the TUI is additive, not a replacement.

**Getting `deskmony` onto your PATH.** pnpm does not put a workspace package's `bin` in the root `node_modules/.bin`, so installing dependencies is not enough:

```bash
node apps/cli/dist/bin.js --help   # always works, no install
cd apps/cli && npm link            # puts `deskmony` on PATH
```

`npm link` is the recommended route: npm's global prefix (`%APPDATA%\npm` on Windows, `~/.npm-global` or similar elsewhere) is already on PATH in a standard Node install, so no environment changes are needed. Verified by running `deskmony --help` in a real Windows console — Chinese output and column alignment render correctly. `pnpm link --global` also exists, but it needs `pnpm setup` first on machines where `PNPM_HOME` is unset, and that rewrites your PATH.

### Build a Windows installer

```bash
pnpm package        # NSIS installer
pnpm package:dir    # unpacked, for quick local testing
```

The packaged core runs on Electron's bundled Node with `better-sqlite3` rebuilt for that ABI, so **end users don't need Node installed**.

## 🧱 Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict), every package |
| Desktop shell | Electron 44 |
| UI | React 18 + Zustand + Tailwind + Vite |
| Terminal | xterm.js + node-pty |
| Chat rendering | react-markdown + remark-gfm + react-syntax-highlighter + a custom diff-hunk viewer |
| i18n | i18next / react-i18next — en, zh-Hant, ja, es |
| Core | Node.js headless, WebSocket gateway (`ws`) |
| Database | SQLite via better-sqlite3 + Drizzle ORM, 5 tables |
| Validation | zod schemas in `packages/shared` as the single source of truth for both sides |
| Agent protocols | Claude Agent SDK, ACP, OpenCode HTTP/SSE, raw PTY |
| Monorepo | pnpm workspaces |

## 📁 Project layout

```
Deskmony/
├─ apps/
│  ├─ desktop/          # Electron + React shell
│  │  ├─ views/         # chat, recovery, dialogs
│  │  ├─ stores/        # zustand × 2
│  │  ├─ ui/            # design system (incl. ErrorBoundary)
│  │  └─ locales/       # en, zh-Hant, ja, es
│  └─ core/             # headless orchestration server
│     ├─ session/ agents/                          # domain (sessions, agent catalog)
│     ├─ permissions/ cost/ enforcement/ recovery/ # safety shield
│     ├─ gateway/ http/ config/ detect/ settings/  # plumbing
├─ packages/
│  ├─ adapters/         # 4 adapters + the `deskmony` session-network MCP server
│  ├─ db/               # Drizzle schema, idempotent migrations
│  └─ shared/           # types, gateway protocol, zod schemas
├─ scripts/             # 15 e2e suites, the runner, the build-freshness guard, fake backends, packaging
├─ .github/workflows/   # CI (build → typecheck → the 14 deterministic suites)
└─ docs/                # architecture, decisions, layered design, dev log
```

## 🧪 Testing

```bash
pnpm test          # typecheck + build + the 14 deterministic suites
pnpm test:e2e      # just the suites (requires a current pnpm build)
pnpm test:e2e:live # e2e-gateway.mjs — needs real Claude Code credentials, spends real tokens
```

**Fifteen end-to-end suites.** Fourteen of them are *deterministic* — they drive a real headless core over the WebSocket gateway (**never through Electron**) against three fake backends (`fake-acp-agent`, `fake-opencode-server`, `fake-pty-echo`), so they reproduce identically on a machine with no credentials at all. Those fourteen are what `pnpm test` and CI run: **228 assertions, all of which must pass.** (The count fell from 221 to 180 on 2026-10-02 when the team, task and message-bus suites were removed along with the features, then rose as `e2e-agent-catalog.mjs` and `e2e-session-network.mjs` — which replaced the sub-agent suite — were added.) The session-network suite also asserts that the tool names, descriptions and parameter schemas of the in-process server and the ACP bridge subprocess are word-for-word identical.

`e2e-gateway.mjs` is excluded from the default run on purpose. It needs real Claude Code credentials, costs real money, and carries a *model-behavior* group whose assertions depend on what a model chose to say that run — the file marks those as known-flaky. A CI that goes red because a model rephrased itself is a CI people learn to ignore.

Two guards keep the suite honest:

- **Build freshness.** The suites exercise `dist/`, not `src/`. Before this was checked, forgetting `pnpm build` meant the tests would quietly validate *stale* code and pass — worse than failing. `scripts/lib/require-fresh-build.mjs` now blocks that.
- **`e2e-hard-deny.mjs`** covers all four hard-deny categories. Three of them (secret paths, dangerous git, network allowlist) had zero coverage until 2026-09-04 — and they are precisely the ones built from string and regex matching, i.e. the ones that can actually be wrong. It also pins the *known* bypasses (base64, variable splicing) as deliberate assertions, so if that behaviour ever changes the docs get updated with it.

`package-smoke.mjs` is a packaging regression test: it launches the built executable with system Node.js stripped from `PATH` and verifies the core subprocess still starts and authenticates.
## 📚 Documentation

| Doc | What's in it |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | **How the system is actually built** — derived from the source tree, every section maps to real files |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | **Why** — the authoritative design-decision record behind the safety shield |
| [`docs/LAYER-3-hld/`](docs/LAYER-3-hld/) → [`docs/LAYER-4-detail-design/`](docs/LAYER-4-detail-design/) | High-level → detail design per subsystem |
| [`docs/DEVLOG.md`](docs/DEVLOG.md) | The round-by-round build log — what shipped, what broke, what got corrected |
| [`SECURITY.md`](SECURITY.md) | **Threat model and reporting** — what counts as a vulnerability, what is knowingly accepted (no PTY sandbox, hard-deny is pattern matching, the true-unrestricted tier…), and how to harden your own install |
| [`LICENSE`](LICENSE) | MIT |

## 🗺️ Status

Built, and guarded by end-to-end tests that CI runs on every push and PR (see Testing above): agent detection and starting a session from any detected agent, the session network (agent-to-agent tools, message envelopes, UI forwarding), the desktop IDE, browser/remote access with token auth, all three breakers of the safety shield (permissions, per-chain messages, cost), crash recovery, desktop and webhook notifications, a self-service policy allowlist UI, and the true-unrestricted bypass tier. Removed on 2026-10-02 (see [`DECISIONS.md` §H](docs/DECISIONS.md)): agent profiles, teams, the task board, git-worktree-per-task isolation, the acceptance gate, the message bus (its breaker was rebuilt for session-to-session messages), and the "child finished, so inject its result into the parent" sub-agent behaviour.

Open by design, and worth knowing before you rely on it:

- **No execution sandbox for the PTY tier.** Until there is one, PTY agents stay read-only — that's the honest consequence, not an oversight.
- **No mid-turn cost cutoff.** The only adapter that emits usage does so as a turn ends, so there is no observable "usage arrived mid-turn" case to build against. Branching on it would be inventing behaviour.
- **Only some agents can send messages on their own.** Claude Agent SDK sessions (in-process) and every ACP agent (Codex, Gemini CLI, OpenCode via the `opencode-acp` provider — through a bridge subprocess holding a scoped, per-session token) get the five session tools. The `opencode` provider (bespoke HTTP/SSE) and PTY agents (Claude Code CLI, Aider) mount no tools: they can *receive* messages, but can't call `send_to_session` or `create_session`, so they can't answer unless a human relays it.
- **Messages queued for a busy session live in memory.** If core restarts before the target's turn ends, the queued message is lost (the sender was already told it was queued, not that it was read).
- **The agent list is fixed.** Detection covers the Claude Agent SDK, Claude Code CLI, Gemini CLI, OpenCode, Codex and Aider. The manual "type a command" entry was removed deliberately; supporting another agent means adding a catalog entry.
- **Provider secrets are masked over the wire but stored in plaintext locally**, the same trade-off Paseo makes with its config file.
- **Orphaned agent processes are only reclaimed on the next start.** If core is SIGKILLed, force-quit, or loses power, the graceful shutdown path never runs and spawned agents — plus the MCP grandchildren they started — keep running. Their pids are now recorded in `<dataDir>/child-pids.json` and reaped at the next start after matching the process creation time (**no match, no kill** — pid reuse must never cost you an unrelated process). Reclaiming them at the moment of death needs a Windows Job Object, which means a native dependency; this project deliberately does not require an MSVC toolchain on the packaging machine.
- **SQLite migrations can only add columns.** `packages/db/src/client.ts` is a handful of hand-rolled "check `PRAGMA table_info` → `ALTER TABLE ADD COLUMN`" functions with no version table. Type changes, renames, drops and new constraints are all out of reach; a destructive migration would need a real migration mechanism first.
- **The chat view keeps at most 2,000 items in memory.** Older ones are dropped (the full history stays in SQLite and reloads when you switch away and back). This bounds what a runaway loop can do to renderer memory; ordinary conversations never come close.
- **Windows packaging only** so far.

---

<div align="center">

**[English](README.md)** · **[繁體中文](README.zh-Hant.md)**

</div>
