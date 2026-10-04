# INFISICAL.md — Infisical Is the Sole Source of Truth (Usage Monitor)

Owner directive (2026-10-03): Infisical is the sole source of truth for this
app.  "Truth" means secrets AND env variables AND tunable settings knobs —
everything the app's behavior depends on that is not code.  This document is
the contract: what lives in Infisical, what does not, and how the runtime
honors it.  The fleet-wide canonical pattern lives in the
`infisical-sole-source-migration` goal references; this file is the
Usage-Monitor-specific application of it.

## Project

- Infisical project: `usage-monitor`, ID `86e35e51-91bc-4dfd-a045-4484726b9c40`
  (jays-services org), environments `dev` / `staging` / `prod`, secret path `/`.
- The shared fleet automation machine identity holds Admin on this project.
  The server authenticates with universal-auth as that identity
  (`INFISICAL_CLIENT_ID` / `INFISICAL_CLIENT_SECRET`, falling back to the
  `INFISICAL_AUTOMATION_CLIENT_ID` / `INFISICAL_AUTOMATION_CLIENT_SECRET`
  names); the values are provisioned through the existing env sync and are
  never committed, printed, or logged — names and metadata only.

## What lives in Infisical

Two delivery paths, one source of truth:

1. **Tunable knobs — runtime loader** (`src/lib/app-settings.ts`, 17 keys).
   Loaded at startup into an in-memory cache, refreshed in the background,
   writable by admins with write-through.  The schema (types, bounds, defaults)
   is `APP_SETTING_DEFS` in `src/lib/app-settings.ts`:

   | Key | Type | Default | What it tunes |
   |---|---|---|---|
   | `ADAPTER_HTTP_TIMEOUT_MS` | int | `30000` | Per-request timeout for provider poll fetches |
   | `ADAPTER_PROVIDER_TIMEOUT_MS` | int | `90000` | Outer per-provider budget in the 15-min poll loop |
   | `READY_DISK_WARN_FREE_BYTES` | int | `5368709120` | `/api/ready` `checks.disk` warn threshold (observability only) |
   | `OTLP_METRICS_INGEST_ENABLED` | bool | `true` | Emergency switch for the DB-writing OTLP metrics route |
   | `OTLP_SYSTEM_METRICS_INGEST_ENABLED` | bool | `false` | Opt-in persistence of host `system.*` OTLP metrics |
   | `INGEST_COST_DERIVATION_ENABLED` | bool | `false` | Derived-cost estimates on unpriced ingest events (metadata only) |
   | `USAGE_INGEST_REQUIRE_SCOPED_TOKENS` | bool | `false` | Deny unscoped `USAGE_INGEST_TOKEN` ingest |
   | `USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK` | bool | `false` | Break-glass read-route fallback in production |
   | `USAGE_SCHEDULER_ENABLED` | bool | `true` | Emergency switch for the 15-min poll scheduler |
   | `ALERT_MIN_SEVERITY` | enum | `warning` | Minimum delivered alert severity (`info`/`warning`/`critical`) |
   | `ALERT_EMAIL_ENABLED` | bool | `true` | Master enable for the email alert channel |
   | `ALERT_DISABLE_EMAIL` | bool | `false` | Hard-disable email alert delivery |
   | `ALERT_REMINDER_HOURS` | float | `24` | Re-reminder cadence for open incidents |
   | `ALERT_DELIVERY_TIMEOUT_MS` | float | `10000` | Per-channel alert delivery timeout |
   | `ALERT_DELIVERY_MAX_ATTEMPTS` | int | `3` | Max alert delivery attempts per channel |
   | `ALERT_UNASSIGNED_SPEND_FLOOR_USD` | float | `25` | Unassigned-spend floor for project-budget alerts |
   | `INFISICAL_SETTINGS_REFRESH_MS` | int | `300000` | Background cache refresh interval (restart-applied) |

   `INFISICAL_SETTINGS_REFRESH_MS` seeds the refresh timer at boot, so a
   change to it takes effect on the next restart — everything else is live
   within one refresh interval (default 5 minutes) with no redeploy.

2. **Secrets and service config — deploy-time env sync.**  The
   Infisical→Coolify env sync remains the deployment path: the same
   `usage-monitor` project carries the tokens, keys, DSNs, database URL,
   encryption keys, dashboard password, cron secret, integration endpoints,
   feature flags, and provider credentials; the sync materializes them into
   `process.env` at deploy time.  Infisical is still the source of truth —
   the sync is the delivery mechanism, not a second truth.  Representative
   (not exhaustive) keys: `DATABASE_URL`, `ENCRYPTION_KEY`,
   `DASHBOARD_PASSWORD`, `CRON_SECRET`, `SESSION_SECRET`,
   `USAGE_INGEST_TOKEN`, `USAGE_READ_TOKEN`, `USAGE_INGEST_PRODUCER_TOKENS`,
   `BILLING_RECEIPT_*`, `RECEIPT_INBOX_*`, `OWNER_EXPENSE_TOKEN`,
   `BILLS_CALENDAR_TOKEN`, `*_API_KEY` / `*_API_TOKEN` provider credentials,
   `SENTRY_*`, `DD_*`, `NEXT_PUBLIC_*`, APNS/PagerDuty/Pushover/Slack/Resend
   credentials.  The full inventory is `.env.example` (local-dev names and
   semantics; never production values).

Deliberately NOT yet on the runtime loader (still env-sync, still Infisical
as SOT): shell-read startup knobs (`LITESTREAM_REQUIRED`,
`STARTUP_WRAPPER_REQUIRED`, `SQLITE_PRE_MIGRATION_BACKUP_RETENTION` — read by
`scripts/start-with-litestream.sh` before Node boots, so they cannot go
through the Node settings service), build-time `NEXT_PUBLIC_*` vars (Next.js
inlines them at build; a runtime Infisical read cannot reach the client
bundle), and further tunable knobs that are migration candidates for a
follow-up (`OPENROUTER_CREDIT_CHECK_INTERVAL_MS`, `SCHEDULER_STALE_AFTER_MS`,
`BUDGET_STATUS_CACHE_TTL_MS`, `EXTERNAL_USAGE_EVENT_RAW_RETENTION_DAYS`,
`ALERT_DELIVERY_RETRY_BASE_MS`, ...).  The schema in `src/lib/app-settings.ts`
is the extension point — add the key there, replace the `process.env` read,
add a test.

## What does NOT live in Infisical

- **Per-user settings.**  Notification preferences, per-device APNs tokens,
  dashboard UI preferences, per-user API keys, and all domain data
  (providers, plans, subscriptions, projects, budgets, alert incidents) live
  in the app's own SQLite store.  They are explicitly out of scope and are
  never written to Infisical.
- **Local dev overrides.**  Documented in `.env.example`; never commit real
  values.  Copy it to `.env` for local development.
- **Build-time constants** that never change at runtime.

## Runtime contract

1. **Load at startup.**  `src/instrumentation.ts` `register()` calls
   `await appSettings.init()` on the nodejs runtime before anything else
   boots.  With universal-auth credentials present it fetches the full
   secret set for the resolved environment (`UM_INFISICAL_ENV`, else
   `NODE_ENV=production → prod`, else `dev`) into memory.  With no
   credentials (local dev, CI, `next build`) it stays in env-fallback mode
   and reads `process.env` live — zero network.  If the Infisical load
   itself fails at boot, it logs LOUDLY and stays in env-fallback mode:
   the deploy-time env sync already carries Infisical values, so serving
   from them is safer than a failed boot.  (Deliberate, documented deviation
   from the pilot's fail-fast boot: this app's sync guarantees values.)
2. **Never fetch per-request.**  All runtime reads (`get`, `getBool`,
   `getInt`, `getFloat`) come from the in-memory cache in Infisical mode.
   A per-request (or per-tick, per-event) Infisical call is the one forbidden
   pattern.
3. **Background refresh.**  The cache refreshes every
   `INFISICAL_SETTINGS_REFRESH_MS` (default 5 minutes) and on demand:
   `kill -HUP <pid>` (SIGHUP handler in `instrumentation.ts`) and
   `POST /api/settings/runtime` ("Reload settings" admin action).  Refresh
   failures log loudly and keep serving the last-known-good cache.
4. **Write-through on admin save.**  Admin changes go through
   `appSettings.set(key, value)`: schema-validated, written to Infisical
   FIRST, then the cache is updated.  A failed Infisical write rejects
   (`InfisicalWriteError`) and the cache is untouched — the two never
   diverge silently.  In env-fallback mode `set()` writes `process.env`
   (local-dev parity).

Implementation: `src/lib/app-settings.ts` builds on the fleet-shared
zero-dependency `createInfisicalSettings` from
`@jaywedgeworth22/congress-trading-shared`
(`github:Simple-With-Us/congress-trading-shared#semver:^2.7.1`).

## Admin gating

This app is single-admin: the dashboard session (`DASHBOARD_PASSWORD` login)
IS the admin role — there is no parallel auth system.  The admin surfaces:

- `GET /api/settings/runtime` — knob inventory with effective values, types,
  defaults, and sources (`infisical` / `env` / `default`).  Values are
  non-secret knobs only; secret keys are never listed here.
- `PUT /api/settings/runtime` — `{ key, value }` write-through save.
  Unknown keys and schema violations are 400; a failed Infisical write is
  502 and the save is rejected.
- `POST /api/settings/runtime` — on-demand refresh.
- `PUT /api/settings` (existing) — alert knobs `ALERT_EMAIL_ENABLED` /
  `ALERT_DISABLE_EMAIL` / `ALERT_MIN_SEVERITY` now write through to
  Infisical instead of mutating `process.env` ephemerally.  Pushover
  credentials in the same route stay `process.env`-only: they are secrets,
  and secrets ride the env sync.

Every one of these returns **403** without a valid dashboard session; the
surface is hidden from non-admins entirely.

## Clients

- **iOS / macOS:** the iOS companion syncs from `GET /api/quota-windows`
  with `USAGE_READ_TOKEN` and cannot safely hold a universal-auth client
  secret, so per the canonical pattern the backend owns the Infisical read
  and serves settings-derived state over the existing API.  No Swift
  settings client is needed or wanted.  (`macos/` is historical reference
  only — the menu bar app now lives in the AgentBar repo.)
- **Cloudflare workers** (`workers/receipt-inbox/`): separate deployment
  unit; its config is worker env via wrangler, out of scope for this
  server's settings service.

## Rotation

1. Change the value in the Infisical `usage-monitor` project (right
   environment, path `/`) — via the Infisical dashboard or the CLI with the
   machine identity.  Knobs take effect within one refresh interval (or
   `POST /api/settings/runtime`, or SIGHUP); no redeploy.
2. Secrets rotated in Infisical flow through the existing Infisical→Coolify
   env sync; trigger a redeploy (or wait for the sync's auto-restart) so the
   new value reaches `process.env`.
3. Never put the new value in code, chat, logs, or PR bodies.  Verify with
   names/metadata only (`GET /api/settings/runtime` shows knob values to
   admins; secret values are never exposed by any endpoint).

## For agents

See the "Infisical sole source of truth" section in `AGENTS.md`.  Rules that
bite: no new direct `process.env` reads for keys in `APP_SETTING_DEFS` (read
them through `appSettings`); no per-request Infisical fetches; no per-user
data in Infisical; no secret values in code, logs, or PR text.  When adding a
tunable knob, add it to `APP_SETTING_DEFS`, replace the `process.env` read,
and extend `src/lib/__tests__/app-settings.test.ts`.
