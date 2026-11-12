# `agent-hook-otlp.mjs` -- shared hook-to-OTLP shim

`scripts/agent-hook-otlp.mjs` is a small, dependency-free Node script that lets three
coding-agent CLIs with a native hook mechanism but no OTel exporter of their own --
Antigravity CLI (`agy`), Cursor, and GitHub Copilot CLI -- send a narrow, allowlisted
slice of their hook events to Sentry `agent-sessions` (OTLP logs) **or** Usage Monitor
`POST /api/otlp/v1/traces` / the fleet-telemetry-relay (`{ turns: [...] }`).  Claude Code
and Codex CLI export OTLP natively (`~/.claude/settings.json`, `~/.codex/config.toml
[otel]`) and are never wired through this script.

## Why v1 never delivered

1. `isTrustedSentryEndpoint` rejected every non-`sentry.io` URL, so pointing the shim at
   `usage.jays.services` or a relay was a silent no-op.
2. Missing credentials (env trio or the chmod-600 file) is also a silent no-op -- a hook
   must never fail the agent.  Run `node scripts/agent-hook-otlp.mjs --self-test`.
3. Cursor Cloud / non-interactive CLI often never fires `afterAgentResponse` / `stop`.
   The in-repo `.cursor/hooks.json` template wires those plus `afterFileEdit` for Cloud
   Agents (in-repo `node scripts/...` path, not the Mac pinned copy).
4. Sentry Logs does not index unknown resource attrs such as `agent.platform` the way
   UM traces does -- a 200 can still look like "nothing landed" in the Sentry UI.

v2 trusts `sentry.io`, `usage.jays.services`, loopback, and extra hosts in
`AGENT_HOOK_OTLP_ALLOWED_HOSTS`.  Prompt/response stay off unless
`AGENT_HOOK_OTLP_INCLUDE_CONTENT=1`.

The script's own header comment is the source of truth for the allowlist, the
credential-resolution order, and the exact (platform, event) pairs each CLI wires.  This
doc covers the two operational properties that comment can only summarize: why sends are
detached, and why the installed copy is pinned outside any git worktree.

## Why the network POST runs in a detached child, not the hook process itself

Every wiring here runs under a **3 second host hook timeout** (agy, Cursor, and Copilot
CLI each set `timeout: 3` / `timeoutSec: 3` in their own hooks.json).  The script's own
outbound POST is bounded to `HTTP_TIMEOUT_MS = 2000`.

On 2026-09-24/25, under this Mac's heavy concurrent-agent load (load average
400-700+), a **cold `node` start alone** was observed taking 2.0-3.85 seconds --
close enough to the 2s fetch timeout, and past the 3s host budget, that a real share of
agy hook invocations were killed by the host before the POST could even land.  agy's own
CLI logs showed 44 `jsonhook__agent-hook-otlp_*_0_0 failed: ... killed` lines across two
bursts that night.  Each kill drops the telemetry record AND stalls the host's hook wait
for the full timeout -- a cost paid by the live agent turn, not just by telemetry.

The fix (landed 2026-09-25): the foreground process now only builds the OTLP log record
and *schedules* the send -- `scheduleBackgroundSend()` spawns
`node <pinned-copy> --send` **detached** (`detached: true`, own stdio pipe for input,
`unref()`ed) and returns immediately.  `spawn()`'s underlying fork/exec is synchronous,
so the child already exists as an independent OS process before the caller returns; the
grandchild reads `{credentials, body}` off its own stdin and performs the actual
`postOtlp()` call fully decoupled from the parent's lifetime.  The foreground process's
own exit no longer depends on how long that fetch (or that child's own cold start) takes.

Regression coverage: `scripts/__tests__/agent-hook-otlp.test.mjs` proves this with a
real (non-mocked) child process that deliberately sleeps past the assertion window, and
asserts the calling code returns before the child's work is done.

## Why the installed copy is pinned outside any git worktree

Every hooks.json below points at `~/.local/share/agent-hook-otlp/agent-hook-otlp.mjs`,
**never** a path inside `~/Code/Usage-Monitor`.  That tree is the human integration
tree: a daemon resets it, and it can be checked out on any branch at any time (it was
checked out on an unrelated feature branch, `grok/deepseek-payg-mac-pill`, when this was
caught).  A hook wired directly at a path inside it would silently break
(`MODULE_NOT_FOUND`, hard failure exit) the moment that tree moved off a commit that has
this file, and would silently **reintroduce an already-fixed bug** for however long the
tree happened to be checked out between two commits that touched it.

`scripts/install-agent-hook-otlp.mjs` installs the pinned copy by reading the file's
content straight out of `origin/main` via `git show` -- never off whatever the working
tree happens to have checked out -- and writes it to the stable path, `chmod 755`.  It is
idempotent; run it any time, and always after a merge that touches
`scripts/agent-hook-otlp.mjs`:

```bash
node scripts/install-agent-hook-otlp.mjs
```

It prints only the destination path and a byte count -- there is nothing secret in this
file.

## Wiring reference

| Platform | Config | Events wired | Notes |
|---|---|---|---|
| agy (Antigravity CLI) | `~/.gemini/config/hooks.json`, top-level key `agent-hook-otlp` | `PostInvocation`, `Stop` | `PostToolUse` is **not** a recognized agy hook event in the installed CLI build -- confirmed via `agy -p "/hooks" --output-format json`, with and without an added `"matcher"` key on the entry; it never appears in the `/hooks` listing either way.  Do not re-add it without first confirming a CLI update actually recognizes it the same way.  agy's own `moshi-hook` entries (`PreInvocation`, `Stop`) are a separate top-level key in the same file and must stay untouched. |
| Cursor | `~/.cursor/hooks.json` | `afterFileEdit`, `afterAgentResponse`, `stop` | Alongside `moshi-hook` and `mac-process-check.sh` entries for the same events; fire-and-forget, prints nothing. |
| Copilot CLI | `~/.copilot/hooks/agent-hook-otlp.json` | `postToolUse`, `sessionEnd`, `errorOccurred` | Native hook support confirmed via Copilot CLI 1.0.68's own `[WARNING] postToolUse hook from ".../agent-hook-otlp.json"` log line.  As of 2026-09-25, only `postToolUse` has been observed firing live in Sentry; `sessionEnd`/`errorOccurred` wiring is present and structurally identical, but live firing is unconfirmed (not necessarily broken -- those events may simply not have occurred yet in a real session). |

## Credential regeneration

See the script's own header comment for the exact one-liner.  It reuses the same
`x-sentry-auth` header Claude Code sends to `agent-sessions`, writes a chmod-600 JSON
file, and never prints the header value.
