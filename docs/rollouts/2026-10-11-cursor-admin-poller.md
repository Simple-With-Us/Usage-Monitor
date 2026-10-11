# Cursor Admin API poller (2026-10-11)

Billed Cursor usage was the gap left by #1654 and #1656.  The hook script (`scripts/agent-hook-otlp.mjs`) records turns on `AgentTurn`.  It does not see charged cents.  This poller is the billed ledger.

## What it calls

Docs fetched 2026-10-11:

- https://cursor.com/docs/account/teams/admin-api
- https://cursor.com/docs/api

`POST https://api.cursor.com/teams/filtered-usage-events`.  Basic auth, `CURSOR_ADMIN_API_KEY` as the username and an empty password.  The Admin API is team-plan only.  The poller ships inactive.  It runs only when `CURSOR_ADMIN_POLLER_ENABLED` is `true`, `1`, `on`, or `yes` and `CURSOR_ADMIN_API_KEY` is set.  Leave both unset to keep this seat off.  The key, when used, is Infisical-managed (`usage-monitor`, env `prod`, path `/`).  Do not commit it.  Enabled without the key throws `CURSOR_ADMIN_API_KEY is required` at scheduler registration, before the interval is armed.  A disabled process does not register the job or its Sentry cron monitor.

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

New rows are summarized through the existing `fanoutPersistedUsage(..., "poll")` path.  Emails and the API key are not in that payload.  Cron monitor `usage-monitor-cursor-admin` is a 60-minute interval, 15-minute check-in margin, 5-minute max runtime, UTC.  It is upserted only when the poller is enabled and a poll checks in.  While the flag is unset there is no check-in and no hourly skip log.  An HTTP, parse, or persist failure on an enabled poller checks in `error`.  Enabled without the key fails startup and does not check in.

## Changes

- `src/lib/cursor-admin-config.ts`: opt-in gate.  `CURSOR_ADMIN_POLLER_ENABLED` must be `true`, `1`, `on`, or `yes`.  Enabled without `CURSOR_ADMIN_API_KEY` throws `CursorAdminPollerConfigError`.
- `src/lib/cursor-admin-poller.ts`: hourly Admin API poller.  Zod-strict page and event schemas.  `import "server-only"`.  Seeds a generic `cursor` provider when none exists.  Disabled returns `skipped` / `disabled` with no log and no check-in.  Enabled without a key throws and does not check in.
- `src/lib/cursor-admin-fixtures.ts`: doc fixtures for filtered usage events and the documented 429 body.
- `src/lib/usage-recorder.ts`: calls the poller from the 15-minute tick only when the flag is on.  A runtime failure stays isolated so it cannot fail maintenance or readiness.  `startUsagePollingScheduler` asserts the key before arming the interval.
- `src/lib/sentry-ops.ts`: cron monitor `usage-monitor-cursor-admin` at 60 minutes.  `recordCursorAdminPollerCheckIn` no-ops while the flag is unset, so the monitor is not registered.
- `src/lib/otlp/gen-ai-mapper.ts`: `cursor` and `cursor-agent` are overlap platforms so estimated gen_ai rows do not sit beside billed cents.
- `src/test-shims/server-only.ts` and `vitest.config.ts`: Node test runner stand-in for the `server-only` package.
- Tests: `src/lib/__tests__/cursor-admin-poller.test.ts`, plus scheduler, Sentry cron, gen_ai mapper, and OTLP metrics route coverage.
- Docs and env: this note, `docs/observability/producer-coverage-matrix.md`, `AGENTS.md`, `.env.example`, `INFISICAL.md`.

## Verification

Local, before the review follow-up:

- `npx eslint` on the touched TypeScript files passed.
- `npx tsc --noEmit` passed.
- `npx vitest run` on the poller, Sentry cron, gen_ai mapper, scheduler timeout, and OTLP metrics route tests passed (104 tests).
- GitHub `CI / verify` on `5297d2a` passed, including the production build.
- After the review follow-up, `npx eslint` on the poller and its test passed, and the poller plus Sentry cron tests passed (31 tests).  The poller module starts with `import "server-only"`.
- After the opt-in change, `npx eslint` and `npx tsc --noEmit` passed, and the poller, Sentry cron, scheduler boot, and provider-timeout tests passed (75 tests).  Disabled does not check in.  Enabled without a key throws before the interval is armed.

## Next steps

- This deploy stays inactive.  Jay is not on a Cursor team plan, so do not set `CURSOR_ADMIN_POLLER_ENABLED` or `CURSOR_ADMIN_API_KEY` for this seat.  The scheduler keeps running and the Cursor cron monitor is not created.
- A team-plan operator enables it by setting `CURSOR_ADMIN_POLLER_ENABLED=true` and `CURSOR_ADMIN_API_KEY` together (Infisical `usage-monitor`, env `prod`, path `/`) and restarting.  The flag without the key fails startup.
- After the first successful poll on an enabled seat, confirm a provider row named `cursor` exists and that `ExternalUsageEvent` rows with `sourceApp=cursor-admin` are the billed totals.  The seat subscription stays separate.
- On an enabled seat, watch the Sentry cron `usage-monitor-cursor-admin`.  An upstream or parse failure is `error`.  A disabled seat has no check-ins.
