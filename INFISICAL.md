# INFISICAL.md — Infisical Is the Sole Source of Truth (Usage Monitor)

Owner directive (2026-10-03): Infisical is the sole source of truth for this
app.  "Truth" means secrets AND env variables AND tunable settings knobs —
everything the app's behavior depends on that is not code.  This document is
the contract: what lives in Infisical, what does not, and how the runtime
honors it.  The fleet-wide canonical pattern lives in the
`infisical-sole-source-migration` goal references; this file is the
Usage-Monitor-specific application of it.

## Project

- Infisical project: `usage-monitor`, environment `prod` only (owner directive
  2026-10-10: `dev` and `staging` are being retired), secret path `/`.  Every
  selector resolves to `prod` and refuses anything else: `resolveInfisicalEnvironment()`
  and the provider-sync and secrets-probe `INFISICAL_ENV` override log one warning
  and ignore a non-prod value; `scripts/infisical-run.mjs` and
  `scripts/cursor-cloud-start.sh` exit non-zero on one.  Deployment-specific project identifiers are maintained
  in the private operations inventory, not committed here.
- Authentication is an explicit project connection: either a dedicated machine identity or scoped service tokens.  The shared fleet Automation identity is never a fallback.  Settings → Connections → Infisical Connections manages the choice for each project use.

## Connection Credentials And Folder Routes

Saved connections use the existing AES-GCM encryption key and server-only `AppSetting` rows.  No schema migration is required.  The dashboard session gates every connection API; read responses return configured flags and scope metadata without credentials.  Blank credential fields preserve an existing value only when its project, identity and folder/permission coordinates remain unchanged.  Removing a token from the submitted list explicitly removes that saved route.  Disable Connection persists an encrypted disabled marker, removes saved credentials, suppresses environment-authentication fallback for that source, and immediately stops the Usage Monitor settings client when applicable.  Saving newly verified credentials explicitly enables the connection again.

Service-token connections accept at most two unique tokens for an Infisical project across the app's source aliases, counting effective environment routes as well as saved connections and deduplicating token reuse.  This limit is checked in the save transaction.  Declare exact read and write folders, and each token's exact permissions and folders.  The application verifies the token's own `/api/v2/service-token` metadata, including project, `prod` environment, complete scope set, permission set and expiry, before using it.  A successful secret-path query is never scope proof.  Root `/` does not include child folders; globs, imports, ambiguous routing and duplicate mapped names across folders are rejected.  Provider sync reads all declared read folders.  A read-only token cannot perform a write.  Unexpanded secret references fail closed rather than becoming provider credentials or runtime settings.

Machine-identity connections verify read access before saving.  Declared machine-identity write permissions remain explicitly unverified in the API metadata and editor; Infisical must authorize each real settings write.  The application never creates or deletes a probe secret to test a grant.

An unreadable connection is reported separately so healthy project uses remain manageable.  Replace it by entering all credentials, or disable it to suppress its environment fallback; blank fields cannot reuse credentials from unreadable saved data.  Replacements retain the original saved-row revision so a concurrent edit or disable wins.  Project token counting tolerates malformed routes when the project and token inventory remain readable, but an unknown project or encrypted inventory still blocks service-token saves until that source is replaced or disabled; machine-identity saves add no service tokens.

The value-blind secrets helper accepts only `INFISICAL_UM_WRITE_TOKEN` with verified service-token write metadata for token-based writes; generic `INFISICAL_TOKEN` remains a read alias.  Opaque bearer tokens cannot attest write permissions.  The helper also retains its explicit UM machine-identity login path, whose real operations are authorized by Infisical without claiming a service-token permission check.

Legacy raw responses can omit project/environment/folder fields.  Only a token whose own verified metadata contains one exact folder makes those omissions unambiguous; any returned contradictory identity is rejected.  A multi-folder token must receive the exact identity fields in each response, or the operation fails closed.

The request contract was checked against upstream [v3 raw routes](https://github.com/Infisical/infisical/blob/6a8bdfa882308e53e119b20c2b66a662c825e225/backend/src/server/routes/v3/deprecated-secret-router.ts#L238-L245) and [v4 routes](https://github.com/Infisical/infisical/blob/6a8bdfa882308e53e119b20c2b66a662c825e225/backend/src/server/routes/v4/secret-router.ts#L134-L141).  V3 uses `workspaceId` and `include_imports`; v4 uses `projectId` and `includeImports`.  Both request exact folders with expansion and recursion disabled.  The v3 handler rewrites a single exact service-token scope to its own project/environment/folder, reinforcing why a successful path query is insufficient scope proof.  Source review and offline request assertions do not establish live deployment compatibility.

Environment bootstrap remains separate from the encrypted UI store because the app must receive its encryption key before opening that store.  Set an explicit app client pair (`INFISICAL_CLIENT_ID` and `INFISICAL_CLIENT_SECRET`, or the complete `INFISICAL_UM_*` pair) or `INFISICAL_UM_READ_TOKEN`.  Provider scopes consume `INFISICAL_{ST,CT,SHARED,UM}_READ_TOKEN` and optional `_WRITE_TOKEN`; `_READ_PATHS` and `_WRITE_PATHS` declare comma-separated exact folders and default to that scope's `_SECRET_PATH` (or `/`).  Environment read tokens are read-only and environment write tokens are write-only; the connection editor also supports explicitly declared read-and-write tokens.  `INFISICAL_ST_PRIMARY_READ_TOKEN` serves only the existing exact bridge folder when its opt-in sync is enabled.  Routine ST, CT and Shared pulls do not need write tokens; the separate opt-in ST Gemini bootstrap needs its explicit ST root write route.

Runtime settings read all declared read folders and write each existing key back to its exact original folder.  A new key targets the primary read folder and needs a write grant for that folder.  Saving the Usage Monitor connection verifies and loads its replacement client before persisting and atomically switching the runtime cache; verification or persistence failure keeps the previous client.  Concurrent edits are rejected instead of overwriting a newer saved connection.

Do not deploy the removal of an existing Automation bootstrap until the replacement service-token access, required concrete secret values, injected app startup and token registry entries have been verified through the authorized migration task.  Inventory root secret references before choosing scopes; do not grant recursive access to bypass a reference failure.  This implementation does not mint, rotate or revoke tokens, change provider permissions, or migrate live credentials by itself.

Bootstrap and runtime share the explicit UM selectors.  `INFISICAL_UM_PROJECT_ID` takes precedence over `INFISICAL_PROJECT_ID` and `INFISICAL_APP_PROJECT_ID`; `INFISICAL_UM_SECRET_PATH` takes precedence over `INFISICAL_PATH`.  A generic `INFISICAL_TOKEN` beginning with `st.` is an explicit UM read-token alias only: the runner verifies its exact project/prod/folder/read metadata before normalizing the child environment to `INFISICAL_UM_READ_TOKEN`.  It is never borrowed by ST, CT or Shared.  For machine-identity credentials, the UM pair is selected whenever either UM half is set; both halves must then be present, and the resolver does not fill a missing half from the generic pair.  Only when both UM halves are absent may the complete generic pair be selected.  This makes a partial UM pair fail closed even when a generic pair is complete.  A machine-identity access token without its explicit client pair does not establish a writable runtime connection.

An initial saved-connection outage or expiration preserves deploy-time environment reads and rejects settings writes until the connection is verified again.  Verify And Save remains strict and leaves the previous active connection intact on failure.  Disable persists a tombstone that suppresses ambient authentication, including across restart; a concurrent earlier verification cannot overwrite it.  The standalone secret helpers retain explicit UM machine identities or separate UM read/write tokens, verify service-token metadata, and send copied secret values through stdin rather than process arguments.

## What lives in Infisical

Two delivery paths, one source of truth:

1. **Tunable knobs — runtime loader** (`src/lib/app-settings.ts`, 18 keys).
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
   | `USAGE_SCHEDULER_ENABLED` | bool | `true` | Emergency switch for the 15-min poll scheduler (boot-applied; a change takes effect on restart) |
   | `ALERT_MIN_SEVERITY` | enum | `warning` | Minimum delivered alert severity (`info`/`warning`/`critical`) |
   | `ALERT_EMAIL_ENABLED` | bool | `true` | Master enable for the email alert channel |
   | `ALERT_DISABLE_EMAIL` | bool | `false` | Hard-disable email alert delivery |
   | `ALERT_REMINDER_HOURS` | float | `24` | Re-reminder cadence for open incidents |
   | `ALERT_DELIVERY_TIMEOUT_MS` | float | `10000` | Per-channel alert delivery timeout |
   | `ALERT_DELIVERY_MAX_ATTEMPTS` | int | `3` | Max alert delivery attempts per channel |
   | `ALERT_UNASSIGNED_SPEND_FLOOR_USD` | float | `25` | Unassigned-spend floor for project-budget alerts |
   | `INFISICAL_SETTINGS_REFRESH_MS` | int | `300000` | Background cache refresh interval (restart-applied) |
   | `PROVIDER_MANIFEST_JSON` | string | `'{"version":"1","providers":[]}'` | Backend-driven provider display registry (key, label, icon hint, sort order, aliases, quota terms) served via `/api/quota-windows` `providerGroups[]`; display/config only, no secrets |

   `INFISICAL_SETTINGS_REFRESH_MS` seeds the refresh timer at boot, so a
   change to it takes effect on the next restart — everything else is live
   within one refresh interval (default 5 minutes) with no redeploy, with
   one exception: `USAGE_SCHEDULER_ENABLED` is evaluated once at boot (the
   evaluated gate is recorded and `/api/ready` answers with that boot value),
   so flipping it takes effect on the next restart.  Readiness never
   disagrees with the running process about whether the scheduler is up.

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
   `CODECAPS_PUSH_REGISTRATION_TOKEN`,
   `BILLS_CALENDAR_TOKEN`, `CURSOR_ADMIN_API_KEY` (optional; only with `CURSOR_ADMIN_POLLER_ENABLED=true` on a Cursor team plan — leave both unset to keep the poller off), `*_API_KEY` / `*_API_TOKEN` provider credentials,
   `SENTRY_*`, `DD_*`, `NEXT_PUBLIC_*`, APNS/PagerDuty/Pushover/Slack/Resend
   credentials.  The full inventory is `.env.example` (local-dev names and
   semantics; never production values).

Deliberately NOT yet on the runtime loader (still env-sync, still Infisical
as SOT): shell-read startup knobs (`LITESTREAM_REQUIRED`,
`STARTUP_WRAPPER_REQUIRED`, `SQLITE_PRE_MIGRATION_BACKUP_RETENTION`,
`SQLITE_PRE_MIGRATION_BACKUP_TIMEOUT_MS` — read by the startup path before
Node app boot, so they cannot go through the Node settings service).  The
backup timeout defaults to 300000 ms (5 minutes) and is clamped to 1000-900000
ms (15 minutes maximum).  Build-time `NEXT_PUBLIC_*` vars (Next.js
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
  values.  Run local development through the Infisical-backed launcher
  (`node scripts/infisical-run.mjs -- npm run dev`); do not create or load
  a local dotenv file.
- **Build-time constants** that never change at runtime.

## Runtime contract

1. **Load at startup.**  `src/instrumentation.ts` `register()` calls
   `await appSettings.init()` on the nodejs runtime before anything else
   boots.  With universal-auth credentials present it fetches the full
   secret set for the `prod` environment (a `UM_INFISICAL_ENV` override with
   any other value is refused: warning, then ignored) into memory.  With no
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
(`github:jaywedgeworth22/congress-trading-shared#v2.7.1`, the fleet pin; same commit as the org tag).

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
