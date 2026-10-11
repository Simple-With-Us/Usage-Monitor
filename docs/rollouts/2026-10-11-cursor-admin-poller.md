# Cursor Admin API poller (2026-10-11)

Billed Cursor usage was the gap left by #1654 and #1656.  The hook script (`scripts/agent-hook-otlp.mjs`) records turns on `AgentTurn`.  It does not see charged cents.  This poller is the billed ledger.

## What it calls

Docs fetched 2026-10-11:

- https://cursor.com/docs/account/teams/admin-api
- https://cursor.com/docs/api

`POST https://api.cursor.com/teams/filtered-usage-events`.  Basic auth, `CURSOR_ADMIN_API_KEY` as the username and an empty password.  The key is Infisical-managed (`usage-monitor`, env `prod`, path `/`).  Do not commit it.  Jay must add `CURSOR_ADMIN_API_KEY` there if it is not already present.  A missing key logs a warning and skips.  The scheduler does not crash.

The docs describe the endpoint as hourly aggregated, with a 60 request/minute limit.  The poller therefore runs at most once an hour from the existing 15-minute tick.  `429` honors `Retry-After` and caps the wait at 20 seconds, then retries up to four attempts.  A failed hour does not move the watermark.  The current hour stays open and is re-read on the next successful poll.

## What it stores

One `ExternalUsageEvent` per usage event:

- `sourceApp=cursor-admin`, `provider=cursor`, `metricType=cost`
- `costUsd = chargedCents / 100` (includes the Cursor Token Rate)
- `keyRef` = model, `label` = kind (`Usage-based`, `Included in Business`, …)
- metadata: user email, kind, source, input/output/cache tokens, charged cents, cursor token fee, and ids when the API sent them
- `service`: `cursor-client`, `cursor-headless`, or `cursor-cloud-agent`

The published event has no editor-versus-CLI field.  A connected editor session and the CLI both land as `cursor-client` unless `isHeadless` or `cloudAgentId` says otherwise.

The API has no event id.  The idempotency key is `cursor-admin:` plus a length-prefixed SHA-256 of the identity fields, so a rerun does not double count.  `windowStart` / `windowEnd` are left unset so a later window cannot collide with the same event.

Daily-usage-data has no dollar field.  `/teams/spend` is a billing-cycle total of the same `chargedCents`.  Neither is persisted.  Budget math uses `max(snapshot variable cost, pushed usage)`, so a second copy of those cents would double count.

Included-plan events still carry Cursor's `chargedCents` (the docs' included example is not zero).  That number is Cursor's attributed usage value.  It is not a second copy of the seat fee.  The existing Cursor Pro subscription (`scripts/add-cursor-subscription.mjs`) stays the seat.  A provider row named `cursor` is seeded only when one is missing, with type `generic` so the snapshot poller does not also fetch it.  The API key is not written onto that row.

## What it does not double count

- Hook turns stay on `AgentTurn`.  This poller never writes `AgentTurn`.
- gen_ai metrics whose platform is `cursor` or `cursor-agent` are in `OVERLAP_SOURCE_APPS`.  They are skipped unless `OTLP_GEN_AI_ALLOW_OVERLAP` is set.  An allowlist does not override that block.
- BotFleet v2 events with provider `cursor` keep their own `sourceApp` and are not suppressed.

## Sentry

New rows are summarized through the existing `fanoutPersistedUsage(..., "poll")` path.  Emails and the API key are not in that payload.  Cron monitor `usage-monitor-cursor-admin` is a 60-minute interval, 15-minute check-in margin, 5-minute max runtime, UTC.  A missing key checks in `ok` (the job ran; there was nothing to poll).  An HTTP, parse, or persist failure checks in `error`.
