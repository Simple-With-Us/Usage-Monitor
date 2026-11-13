# Complete telemetry from every platform (2026-10-26)

Tracking: UM-1637.  Related: UM-1614 (Mac telemetry hub), UM-1615 (MiniMax model gap), UM-1636 (Claude Code gap).

Goal: increase the completeness of the telemetry that reaches Usage Monitor and Sentry from every coding platform, on the Mac, on this server, and in the cloud where a source exists.

## Audit (2026-10-26, read-only)

Production, the Mac, and this server were inventoried by source, not by what the code could do in principle.

- MiniMax's desktop runtime writes an exact per-turn token ledger (`local_runtime_token_usage`) that nothing collected: 177,036 rows on the Mac, updated within a minute of the audit, and 1,443 rows on this server.  Only remaining-percent quota windows reached Usage Monitor.
- This server runs coding agents of its own and collected only Claude Code: the OpenCode store was live (6,346 session messages, updated during the audit) and Codex sessions existed (8000 token events in 30 days), but neither collector was scheduled here.  The collectors are generic, were already copied to the server, and only needed scheduling and tokens.
- Per-request telemetry (`AiRequest`: Codex, Claude Code, BotFleet, CI) reached Sentry not at all.  Only ledger rows fanned out, as aggregate `usage.persisted` counters in the fleet-infra project.  Two ingest failure counters (`ingest.scope_rejected`, `ingest.events_rejected`) also stopped at the usage-monitor project and were never mirrored.
- The telemetry hub (UM-1614) remains code-complete and uninstalled; it is still the only designed path that would put scrubbed per-event spans into the agent-sessions Sentry project for non-Claude platforms.  Nothing in this change installs it.

## Changes

### MiniMax runtime collector

`scripts/minimax-runtime-usage-collector.mjs` reads the runtime ledger read-only and sends one usage event per non-zero token type per turn, under the existing `minimax-code` producer, so it lands on the same platform as the quota windows without double counting them (quota rows are never token rows).

The Mac build leaves `model` empty on every row and `cost_usd` at 0, so those events carry no model and no cost; Usage Monitor derives an API-equivalent estimate from the tokens, as it does for Codex.  The server build does carry a model, which is normalized (`minimax/MiniMax-M3.1-Flash` becomes `MiniMax-M3.1-Flash`).

Measured dry runs: 42,051 token events for the last 24 hours on the Mac, 3,921 for the last three days on this server.

The Agents Overview MiniMax entry no longer claims there is no per-turn feed, and the producer-staleness rules now judge the `minimax-code` usage stream by its token rows, like the other token streams.

### Server collectors

The OpenCode and Codex collectors now run on this server on the same 15-minute cadence as the Claude Code collector, with producer-scoped tokens where one exists.  Before enabling them, the OpenCode sessions were checked for a BotFleet overlap: BotFleet reports its own child turns under the producer `botfleet`, and the standalone collectors must not also report them.

### Sentry fanout for per-request telemetry

Persisted `AiRequest` batches now fan out to the fleet-infra Sentry project as `ai.request` counters per harness and model, with mean duration and TTFT gauges where the harness reported them.  Nothing else leaves the process: no prompts, responses, tool arguments, session ids, or costs.

This follows the existing fanout contract (Usage Monitor stays the ledger; Sentry gets counts, durations, model names, and status), extended to the one telemetry class that previously reached Sentry not at all.

`ingest.scope_rejected` and `ingest.events_rejected` are now mirrored to fleet-infra as well, like `ingest.failed` already was, and a `ttft_ms` metric name is now classified as a gauge in the mirror.

## Sentry receipt, verified

With the `SENTRY_ADMIN` credential from the Mac's global API keys file (org read on `simple-with-us`), the fleet-infra project was queried directly after the deploy.

In the first day it held 160 `ai.request` events, 148 `ai.request_total`, 101 `ai.request.duration_ms`, and 95 `ai.request.ttft_ms`, alongside the existing `usage.persisted` stream, all timestamped after the deploy.

That closes the verification gap earlier audits hit: the app-side Sentry credentials available to a container subprocess returned 403 and 404 for project reads, so receipt could not be confirmed from there.  The admin credential is the read path for future telemetry audits; it stays where it is and is never moved into this repository or the app's environment.

## What is still missing, honestly

- The MiniMax model gap (UM-1615) is a producer-side bug in the desktop runtime: the column exists and is never written on the Mac build.  Until the runtime writes it, Mac MiniMax rows have tokens and agent names but no model.
- The telemetry hub (UM-1614) is still not installed, so scrubbed per-event spans for non-Claude platforms still do not reach the agent-sessions project.  Installing it, and repointing local producers at its loopback receiver, remains that item's phased rollout.
- Cursor, Copilot, and Kimi on the Mac have local footprints but no trustworthy local usage ledger; Cursor's billed feed stays the optional team-plan Admin API poller.
- Antigravity's exact token feed depends on its status-line sink writing snapshots; the quota feed is current, the token sink had nothing to send at audit time.

## Verification

- `npx vitest run scripts/__tests__/minimax-runtime-usage-collector.test.mjs src/lib/__tests__/usage-fanout.test.ts src/lib/__tests__/producer-staleness.test.ts src/lib/__tests__/agents-overview.test.ts src/app/api/otlp src/app/api/ingest` passes.
- Dry runs against both real runtime databases (above) parse without touching ingest.
- `npm run typecheck`, `npx eslint` on the changed files, `npm run test:session-token-collectors`, and `npm run test:collector-runtime` pass.
