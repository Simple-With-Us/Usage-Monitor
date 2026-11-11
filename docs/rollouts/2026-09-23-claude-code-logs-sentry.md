# 2026-09-23 — Claude Code OTel logs move to Sentry `agent-sessions`

Claude Code emits two OpenTelemetry signal types: **metrics** (session/cost
counters) and **logs** (per-turn `api_request`, `user_prompt`, `tool_result`,
`tool_decision`, `api_error`, and internal lifecycle events like
`hook_execution_start`/`plugin_loaded`).  Both used to point at the same
generic OTLP endpoint config, which meant the Usage Monitor bearer token and
any future logs sink shared one set of env vars.  Usage Monitor's
`POST /api/otlp/v1/logs` route is an accept-and-drop stub (see "Claude Code
OTLP ingest" below), so per-turn log detail was never actually retained
anywhere.

## What changed

Claude Code's shared `~/.claude/settings.json` `env` block (this Mac only,
not a Usage Monitor app change) now splits OTLP config per signal instead of
using the generic `OTEL_EXPORTER_OTLP_*` vars for both signals:

- **Metrics** — unchanged intended destination (Usage Monitor), now on
  dedicated per-signal vars: `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`,
  `OTEL_EXPORTER_OTLP_METRICS_HEADERS`, `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL`.
  `OTEL_METRICS_EXPORTER=otlp` is unchanged.  The credential value is
  byte-identical to what was already configured — only the var names moved.
  **However**, see Verification below: that credential currently gets `401`
  from Usage Monitor in production, so metrics are configured to land here
  but are not actually succeeding right now — a pre-existing condition this
  rollout surfaced rather than caused.
- **Logs** — new destination, a dedicated Sentry project named
  `agent-sessions` in the `jays-services` org (US region), on
  `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`,
  `OTEL_EXPORTER_OTLP_LOGS_HEADERS`, `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json`.
  Sentry's direct OTLP logs ingest takes an `x-sentry-auth` header carrying
  the project's public DSN key (not a Usage Monitor credential, and not
  secret-sensitive the way an ingest bearer token is, but still handled as a
  config value rather than pasted around).  `OTEL_LOGS_EXPORTER` was
  previously `none`.
- The old generic `OTEL_EXPORTER_OTLP_ENDPOINT` / `_HEADERS` / `_PROTOCOL`
  vars were removed so neither signal can silently inherit the other
  signal's endpoint or credential.
- Privacy: `OTEL_LOG_USER_PROMPTS` is explicit `0` (prompt text is never
  exported — only the event name and structural attributes land in Sentry)
  and `OTEL_LOG_TOOL_DETAILS` stays unset.  Verified against the live
  `agent-sessions` events: prompt/tool bodies do not appear, only event
  names (`claude_code.user_prompt`, `claude_code.api_request`, etc.).

This is a **Mac config change only** — this repo (Usage Monitor) is
unmodified except for this doc and the `AGENTS.md` note below.  Every Claude
Code seat on this Mac shares `~/.claude/settings.json`, so all seats' logs
now flow to `agent-sessions`; metrics for all seats still *target* Usage
Monitor exactly as before, but see Verification below — that target is
currently rejecting the configured credential with `401`, so metrics are
not actually landing right now.

## Verification performed

- A synthetic OTLP/JSON logs payload posted directly to the
  `agent-sessions` project's OTLP logs endpoint returned `200`.
- `claude -p --model claude-haiku-4-5-20251001 "reply with the single word ok"`
  run from a scratch directory completed normally with no OTLP export
  errors on stderr.
- Sentry Logs Explore for `agent-sessions` (`dataset=logs`) showed
  `claude_code.api_request` and `claude_code.user_prompt` events from that
  run (plus lifecycle events from other concurrently running seats sharing
  the same settings file), with no prompt or tool-argument content in the
  event bodies.
- Metrics: a manual curl smoke test against Usage Monitor's
  `/api/otlp/v1/metrics` route returned `401 Unauthorized` for **both** the
  new per-signal header and the pre-existing (byte-identical) original
  header — i.e. the same credential behaves identically before and after
  this change, so this isn't a regression from the split.  It does mean the
  configured `USAGE_INGEST_TOKEN` should be checked against current
  Infisical/Coolify state (possible stale token, or
  `USAGE_INGEST_REQUIRE_SCOPED_TOKENS` now rejecting an unscoped token) —
  filed separately rather than fixed here, since this doc's scope is the
  logs split, not Usage Monitor's ingest auth.

## Claude Code OTLP ingest (cross-reference)

This repo's `AGENTS.md` § "Claude Code OTLP ingest" already documents
`POST /api/otlp/v1/logs` as an accept-and-drop stub and `POST
/api/otlp/v1/metrics` as the real database-writing route.  That split is
unchanged by this rollout — Claude Code (this Mac) simply no longer points
its logs exporter at the stub at all, since Sentry now gives that signal a
real destination with actual query/alerting value.

## Not done here

- No Usage Monitor code, schema, or route changed.
- No Coolify or Infisical change (Sentry env vars live only in this Mac's
  `~/.claude/settings.json`, which is out of scope for Infisical/Coolify).
- No spike-protection or rate-limit configuration was applied to the new
  Sentry project — see the recommendation in the handoff note.
