# 2026-09-01 — Sentry fleet adoption leftovers (Grok, `grok/sentry-fleet-adoption`)

## Context

`docs/rollouts/2026-09-01-sentry-structured-logs-enablement.md` already landed
`enableLogs: true` and the replay-gate normalization.  Server tracing was already
real (230k spans).  Remaining holes from the 2026-09-01 fleet adoption report:
zero client replays, a stale metrics-discontinued comment class, sparse health
logs still on `console.warn` only, and the `usage-monitor-scheduler` cron
monitor flapping `error`/`missed`.

## Changes

- **Replay defaults confirmed (admin app, not ST opt-in).**  100% on error,
  10% of sessions, `maskAllText` / `blockAllMedia`.  Default ON unless
  `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED` is an explicit falsy.
- **Client DSN is a Coolify build-time env.**  Next inlines `NEXT_PUBLIC_*` at
  `npm run build`.  Dockerfile now `ARG`/`ENV` `NEXT_PUBLIC_SENTRY_DSN` so a
  Coolify `is_buildtime=true` value actually reaches the browser bundle.
  Runtime Infisical inject covers `SENTRY_DSN` (server spans) but cannot bake
  the client DSN.  Same project DSN; it is a public client DSN.
- **Cron monitor schedule matches the job.**  The in-process scheduler ticks
  every 15 minutes (`POLL_INTERVAL_MS`).  The 2026-08-31 heartbeat upserted
  Sentry as 1 minute + 5 minute margin, so a healthy tick looked missed.
  `maxRuntime` 10 was not the failure (zero timeouts).  Check-ins were firing;
  the advertised cadence was wrong.  Monitor is kept (`usage-monitor-scheduler`).
- **Sparse Sentry logs + Application Metrics.**  Scheduler outcomes and ingest
  500s go to `Sentry.logger` and `Sentry.metrics.count("scheduler.tick" |
  "ingest.failed")`.  Token/cost time series stay in Usage Monitor.  Datadog
  stays the log warehouse.  Application Metrics shipped in 2026; the
  "discontinued metrics ingestion" wording is gone.

## Verification

- `npm run verify` (Node 24 from `.node-version`).
- Coolify env listed with `reveal=false` for `NEXT_PUBLIC_SENTRY_DSN` and
  `SENTRY_DSN` (lengths only).
- Sentry cron `usage-monitor-scheduler` recent check-ins: misses were schedule
  mismatch, not a dead job.

## Follow-up

A Coolify rebuild is required after `NEXT_PUBLIC_SENTRY_DSN` is set as
build-time, otherwise the already-running image stays client-dark.  Do not
print DSN values.
