# Security Policy

Deskmony runs real coding agents on your machine, spawns child processes, and can
expose a WebSocket gateway to other devices. Security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private reporting instead:
[**Report a vulnerability**](https://github.com/xing-101729/deskmony/security/advisories/new)
(Security → Advisories → Report a vulnerability).

Please include:

- What an attacker can achieve, and what access they need to start (local user?
  a connected remote client with the token? an agent under prompt injection?)
- Steps to reproduce, ideally against a scratch workspace
- The commit you tested

You can expect an initial response within a week.

## Threat model — what is and isn't in scope

Deskmony's safety shield is three independent circuit breakers (permissions,
messages, cost). The shield sits on **the agent's tool calls**. Understanding that
boundary tells you what counts as a vulnerability:

**In scope**

- Any path that executes code, writes outside a worktree, or reads secrets
  **without passing through `PolicyEngine.decide()`** — bypassing the shield
  rather than being allowed by it
- A remote client (authenticated with `DESKMONY_AUTH_TOKEN`) doing something the
  local-only method list is meant to prevent — see `LOCAL_ONLY_METHODS` and
  `findRemoteForbiddenField()` in `apps/core/src/gateway/ws-gateway.ts`
- Auth bypass on the gateway, token leakage (logs, config files, push payloads),
  or a permission decision being applied to the wrong session
- A circuit breaker that can be reset, skipped, or silently made inert
- Path traversal out of a workspace, or command injection into a spawned process

**Known and accepted — not vulnerabilities**

- **The PTY adapter has no sandbox and no permission gate.** `GenericPtyAdapter`
  is raw stdin passthrough; it is structurally outside the policy engine. This is
  documented, and PTY agents are meant to stay read-only until an environment
  sandbox exists. See `docs/DECISIONS.md` §C7.
- **hard-deny is pattern matching, not semantic analysis.** It stops obvious
  mistakes, not a determined bypass via `bash -c`, `$()`, or base64. Deliberate:
  shell-command interception is security theater. See `docs/DECISIONS.md` §C7.
- **The "true-unrestricted" tier deliberately bypasses hard-deny.** It requires
  YOLO to already be on, a typed confirmation, and is audited. See
  `docs/DECISIONS.md` §G.
- **Remote clients have parity with local on permission mode and the policy
  allowlist** as of 2026-08-25 — a deliberate, documented reversal. The message
  and cost breakers remain non-disableable from remote. See `docs/DECISIONS.md` §G.
- **Provider API keys are stored in plaintext locally** (masked over the wire).
  Documented in the README's "deliberate gaps".
- Anything requiring an attacker who already has local code execution as your
  user — at that point they can edit the config directly.

If you think one of the "accepted" items is worse than documented, report it —
that judgement is exactly what a second pair of eyes is for.

## Hardening your own install

- `bindHost` defaults to `127.0.0.1`. Only change it if you understand the
  consequences, and always set `DESKMONY_AUTH_TOKEN` when you do.
- The gateway enforces a same-origin check on the WebSocket upgrade (see
  `verifySameOrigin()` in `apps/core/src/gateway/ws-gateway.ts`), so a random web
  page cannot drive it over `ws://127.0.0.1` even when no token is set. Requests
  with no `Origin` header — every non-browser client — still pass through to the
  token check, so **set `DESKMONY_AUTH_TOKEN` anyway** if the port is reachable
  by anything but you. The packaged desktop app always sets one; a bare
  `node dist/index.js` does not.
- Keep the policy allowlist narrow. Auto mode is for when you are watching a
  single session, not a substitute for a per-rule allowlist while you are away.
