# Render runbook — RETIRED, rollback host only

> **Status: Retired.** Production runs on the Oracle A1 VM (see `DEPLOY.md`
> and `deploy/oracle/README.md`). The Render service `api-usage-monitor` is
> **suspended and kept only as a rollback host**. The Oracle deploy gate
> verifies on every deploy that the service stays user-suspended, auto-deploy
> stays disabled, and `USAGE_SCHEDULER_ENABLED=false` stays set — do not
> resume the service, re-enable auto-deploy, or change its environment except
> as part of a deliberate, owner-directed rollback.
>
> A rollback is NOT "resume Render + flip DNS": the Render database is stale
> the moment Oracle is the sole writer. A host rollback requires quiescing
> Oracle, restoring the latest verified Garage lineage, and only then
> transferring scheduler/writer authority (see `deploy/oracle/README.md`,
> final section).
>
> Everything below is the historical Render runbook, preserved verbatim for
> rollback reference only. Steps that reference "production" describe the
> pre-Oracle architecture.

---

# Deployment Guide (historical Render version)

## Prerequisites
- Render workspace with a Starter web service (persistent disks are not a free-tier feature)
- Cloudflare account managing `jays.services` zone
- Git repository pushed to GitHub

## Step 1: Deploy to Render
1. Go to https://dashboard.render.com
2. Click "New +" > "Blueprint"
3. Connect your GitHub repo
4. Render will read `render.yaml` and create a single resource:
   - `api-usage-monitor` web service, with a 1GB persistent disk mounted at
     `/data` holding a SQLite database file. Usage polling that used to run
     as a separate `fetch-all-usage` cron job now runs in-process inside
     this web service on a 15-minute interval (see
     `src/instrumentation.ts` / `src/lib/usage-recorder.ts`).
5. Sync the Blueprint and confirm the service settings match `render.yaml`:
   Node `24.14.1`, `npm ci` build, `scripts/start-with-litestream.sh` start,
   `/api/health` liveness check, and auto-deploy only after CI checks pass.
   Strict database/scheduler/backup diagnostics remain at `/api/ready`, but
   must not be the process restart trigger: restarting during an exclusive
   SQLite operation can repeat the operation and livelock the sole instance.
6. Wait for the first deploy. At runtime, the startup wrapper optionally
   restores a missing database, creates a transaction-consistent SQLite Online
   Backup API snapshot of any existing database, verifies it with
   `PRAGMA integrity_check`, and only then runs `scripts/migrate-safe.mjs`.
   Backup or verification failure stops startup before schema changes. The
   migration applies additive changes and refuses destructive drift; there is
   no `--accept-data-loss` startup path.

## Step 2: Add Custom Domain on Render
1. Go to the `api-usage-monitor` service in Render Dashboard
2. Click "Settings" > "Custom Domain"
3. Add: `usage.jays.services`
4. Render will give you a verification value (e.g., `render-verify=abc123`)

## Step 3: Add DNS CNAME Record on Cloudflare
1. Go to Cloudflare Dashboard > `jays.services` > DNS > Records
2. Add record:
   - Type: CNAME
   - Name: usage
   - Target: api-usage-monitor.onrender.com
   - Proxy status: **Proxied (orange cloud)**
   - TTL: Auto
3. Wait for DNS propagation (~1-5 minutes)

Cloudflare terminates the public connection and uses Render as the HTTPS
origin. Keep Cloudflare SSL/TLS mode at **Full (strict)**. The current live
hostname is proxied; changing this should be an explicit networking decision,
not copied from the obsolete gray-cloud setup.

## Step 4: Verify
1. `curl -fsS https://usage.jays.services/api/health | jq` and confirm the
   expected `revision`.
2. `curl -fsS https://usage.jays.services/api/ready | jq` and confirm database,
   scheduler, startup, and backup checks. A non-ready dependency returns 503.
3. Visit https://usage.jays.services
4. You'll be redirected to `/login`. Go to the `api-usage-monitor` service in Render Dashboard > Environment, copy the auto-generated `DASHBOARD_PASSWORD` value, and use it to log in.
5. Confirm the dashboard, Settings, provider detail, subscription, and budget
   views load and show the same combined month-to-date spend.

## Environment Variables
- `DATABASE_URL` set to a static path on the service's Render disk
  (`file:/data/prod.db`) - not a secret, just a file path
- `SQLITE_PRE_MIGRATION_BACKUP_RETENTION` (defaults to `3`, valid `1`-`10`;
  newest verified local snapshots retained under
  `/data/.pre-migration-backups` before startup schema synchronization)
- `ENCRYPTION_KEY` (auto-generated 64-char hex)
- `CRON_SECRET` (auto-generated; the `/api/cron/fetch-all` route still checks
  this, kept as an authenticated manual-trigger/debug endpoint even though
  nothing calls it on a schedule anymore)
- `USAGE_INGEST_TOKEN` (auto-generated; copy this into reporting apps as their usage monitor ingest
  token — this is also the token Claude Code's OTLP exporter authenticates with against
  `POST /api/otlp/v1/metrics`, see AGENTS.md's "Claude Code OTLP ingest" section)
- `USAGE_READ_TOKEN` (optional distinct read-only token for `/api/budget-status`;
  falls back to `USAGE_INGEST_TOKEN`)
- `DASHBOARD_PASSWORD` (auto-generated; after the first deploy, copy this value from Render's Environment tab to log in at `/login`)
- `SESSION_SECRET` (auto-generated; session cookies are HKDF-derived from this instead
  of `DASHBOARD_PASSWORD`, so a leaked session token can't be used to verify password guesses and the
  password can be rotated without invalidating existing sessions. Setting or changing it invalidates
  all existing sessions at once (the owner just re-logs in); it does not revoke individual sessions.)
- `SENTRY_READ_TOKEN` (optional; enables the read-only Sentry Health dashboard card, an org-auth
  token or internal integration token with `project:read`/`event:read` scope — never sent to the
  client, absent by default)
- `SENTRY_ORG` (optional; Sentry org slug for the Health card, defaults to `jays-services`)
- `ALERT_SLACK_WEBHOOK_URL` / `ALERT_WEBHOOK_URL` / `ALERT_RESEND_API_KEY` +
  `ALERT_EMAIL_FROM` + `ALERT_EMAIL_TO` / `ALERT_PAGERDUTY_ROUTING_KEY` (optional delivery
  destinations; Resend needs all three email values)
- `ALERT_MIN_SEVERITY` (optional; `info`, `warning`, or `critical`; defaults to `warning`)
- `ALERT_REMINDER_HOURS` (optional; defaults to `24`, applied independently per destination)
- `ALERT_DELIVERY_TIMEOUT_MS` / `ALERT_DELIVERY_MAX_ATTEMPTS` /
  `ALERT_DELIVERY_RETRY_BASE_MS` (optional; defaults `10000` / `3` / `250`; timeout max 60s,
  attempts max 5, and exponential waits cap at 5s)
- `USAGE_SNAPSHOT_RAW_RETENTION_DAYS` (optional; defaults to `45`, after which raw snapshots are
  rolled up daily and pruned)
- `EXTERNAL_USAGE_EVENT_RAW_RETENTION_DAYS` (optional; defaults to `90`; current UTC-month events
  are always retained because `/api/budget-status` reads them directly)
- `EXTERNAL_USAGE_EVENT_TOMBSTONE_RETENTION_DAYS` (legacy compatibility setting, still reported
  by maintenance results but no longer used to delete tombstones; rolled-up idempotency keys are
  retained permanently so late producer retries cannot be counted twice)
- `DATA_RETENTION_ENABLE_VACUUM` (optional, defaults off; full SQLite compaction
  is operator-only because it takes an exclusive lock and rewrites the database)
- `BUDGET_STATUS_CACHE_TTL_MS` (optional; defaults to `60000`; stale-while-revalidate TTL for
  `computeBudgetStatus`, the sole read path for `/api/providers`, `/api/projects`, and
  `/api/budget-status`'s combined poll+pushed+subscription spend. A request always gets the last
  computed value immediately; a background refresh runs once it's older than this)
- `DATA_RETENTION_DISABLE_VACUUM` (legacy override; any true value prevents the
  opt-in compaction above)
- `ADAPTER_HTTP_TIMEOUT_MS` / `ADAPTER_PROVIDER_TIMEOUT_MS` (optional bounded
  upstream-request and per-provider polling budgets)
- `INFISICAL_ST_GEMINI_BOOTSTRAP_ENABLED` (optional, defaults to `false`;
  one-time create-only bootstrap for the fixed current SocraticTrade.com Gemini
  provider into the fixed ST `prod` `/` `GEMINI_API_KEY`). It never updates or
  deletes an Infisical secret. Enable only for the reviewed migration run and
  disable immediately after its sanitized result is observed.
- `INFISICAL_ST_PRIMARY_SYNC_ENABLED` (optional, defaults to `false`) plus the
  dedicated `INFISICAL_ST_PRIMARY_CLIENT_ID` / `_CLIENT_SECRET`. This read-only
  identity is fixed to the SocraticTrade.com Infisical project, `prod`, and
  `/usage-monitor/st-primary/v1`; it cannot be redirected with project/path env
  variables. Enable only after the writer has published a reviewed strict
  `BRIDGE_MANIFEST_V1` complete set.
- `USAGE_SCHEDULER_ENABLED` (optional, defaults to `true`; emergency isolation
  switch for the in-process provider polling scheduler). Setting it to `false`
  stops automatic provider snapshots but does not disable pushed usage/OTLP
  ingest. Use only to isolate scheduler/SQLite contention, and restore `true`
  only after a complete provider tick plus DB-backed ingest/replay smoke succeeds.
- `OTLP_METRICS_INGEST_ENABLED` (optional, defaults to `true`; emergency
  isolation switch for database-writing `POST /api/otlp/v1/metrics`). Setting it
  to `false` returns authenticated requests admitted by the IP limiter `503`
  plus `Retry-After: 300` before reading their body or touching SQLite; excess
  requests receive `429` with the same backoff. Generic `/api/ingest/usage`
  remains available. Restore `true` only after the database stays healthy and a
  controlled OTLP ingest/replay succeeds.
- `LITESTREAM_S3_*` (optional replica credentials; set all four required values
  together or none—partial configuration fails startup)
- `LITESTREAM_REQUIRED` (`false` initially; set `true` only after credentials are
  installed and a restore drill succeeds; then readiness fails if replication is absent)

## SSL/TLS
- Cloudflare proxy: enabled for `usage.jays.services`
- Cloudflare mode: **Full (strict)**
- Render origin certificate: enabled
- HTTP is redirected to HTTPS; application responses also set HSTS, CSP,
  framing, MIME-sniffing, referrer, and permissions headers

## Migrating from the old Postgres + cron setup

This app used to run as 3 billed Render resources (web service + a separate
Postgres database + a separate cron job). It now runs as a single web
service with a SQLite database on a Render disk, to cut hosting cost. If
you're moving an existing deployment from the old architecture to this one,
follow these steps IN ORDER - this involves real production data, so don't
skip the verification step before deleting anything.

1. **Land a fully verified change and sync the Blueprint.** Render will read
   `render.yaml` and provision the new disk for the `api-usage-monitor` web
   service. **Render Blueprint sync does NOT auto-delete resources that were
   removed from `render.yaml`** - the old `databases:` and `cron:` entries
   are gone from the file, but the actual `api-usage-monitor-db` Postgres
   database and `fetch-all-usage` cron job resources keep existing (and keep
   running/billing) in your Render dashboard until you manually delete/suspend
   them. The runtime's safe migration wrapper creates/synchronizes a fresh
   SQLite database on a new disk; it never accepts destructive data loss.
2. **Immediately suspend the old `fetch-all-usage` cron job** (Render
   dashboard -> select the cron job -> Settings -> Suspend, or delete it
   outright). Do this right after step 1, before doing anything else below.
   Until you do, the old cron keeps firing on its own schedule against the
   old Postgres database at the same time the new web service's in-process
   scheduler (see `src/instrumentation.ts` / `src/lib/usage-recorder.ts`)
   starts polling providers from SQLite - two independent pollers hitting
   the same provider APIs concurrently, causing duplicate external API calls
   and, once you cut over, duplicate/conflicting usage data. Do not skip
   this step or delay it until after the migration.
3. **Before deleting the old Postgres database**, run the one-time migration
   script once to copy every row over. Open the Render dashboard's **Shell**
   tab for the `api-usage-monitor` web service and run:
   ```
   SOURCE_DATABASE_URL="<copy the old Postgres connection string from Render's dashboard for api-usage-monitor-db>" node scripts/migrate-postgres-to-sqlite.mjs
   ```
   `DATABASE_URL` is already set correctly in that shell's environment, so
   you only need to supply `SOURCE_DATABASE_URL`. This must be run from
   Render's Shell for the web service - the destination SQLite file lives on
   a disk that's only reachable from that Render instance itself, so this
   cannot be run from a local machine or CI. The script writes to SQLite
   inside a single transaction, so if it fails partway through it's safe to
   just fix the underlying issue and re-run it from the top (see
   "Migration script failure/resume" below).
4. **Verify in the dashboard UI** that providers, plans, and usage history
   all look correct (visit https://usage.jays.services and check Settings
   and the provider detail pages).
5. **Only after confirming step 4**, delete the `api-usage-monitor-db`
   Postgres database in Render's dashboard (Databases -> select it ->
   Delete) to actually stop that recurring charge. If you haven't already
   deleted the `fetch-all-usage` cron resource itself (as opposed to just
   suspending it in step 2), delete it now too.

### Migration script failure/resume

`scripts/migrate-postgres-to-sqlite.mjs` writes all destination rows inside
a single `prisma.$transaction`. If it fails partway through (network blip,
a bad row, etc.), Prisma rolls back every row written so far, so the
destination SQLite database is left exactly as it was before that run (empty,
on a first attempt) - there's no partially-migrated state to clean up.

To retry after a failed run, just fix whatever caused the failure (check the
error output) and re-run the same command again from the top:
```
SOURCE_DATABASE_URL="..." node scripts/migrate-postgres-to-sqlite.mjs
```

### SQLite backup layers (Render era)

Every startup with an existing DB runs
`scripts/backup-sqlite-before-migrate.mjs` before `migrate-safe.mjs`. It opens
the source read-only, uses SQLite's Online Backup API (safe with WAL), checks
the destination with `PRAGMA integrity_check`, atomically promotes only a
verified file, and retains the newest
`SQLITE_PRE_MIGRATION_BACKUP_RETENTION` snapshots. The default three files live
under `/data/.pre-migration-backups`. Failure to create, verify, or bound the
backup stops production startup before migration. These same-disk snapshots
are schema rollback protection, not protection from disk loss.

Render automatically takes an encrypted disk snapshot every 24 hours and keeps
snapshots for at least seven days. Render also warns against restoring a disk
snapshot for a custom database because the filesystem image might not be
transaction-consistent. Treat those snapshots as last-resort infrastructure
recovery, not a SQLite logical/PITR backup. [Litestream](https://litestream.io/)
continuously replicates `/data/prod.db` to Cloudflare R2 with transaction-aware
restore points. It is opt-in until credentials and a restore drill exist. With
all replica vars unset and `LITESTREAM_REQUIRED=false`, the wrapper still takes
the verified local pre-migration snapshot, then runs the safe migration and app
without Litestream. Partial credentials or a configured replica with no
verified binary fail closed.

To enable it: create an R2 bucket + token and set the `LITESTREAM_S3_*`
vars in the Render dashboard's Environment tab (they already exist in
`render.yaml` with `sync: false` so Render won't prompt for or generate
them). The four of `LITESTREAM_S3_BUCKET` / `_ENDPOINT` / `_ACCESS_KEY_ID` /
`_SECRET_ACCESS_KEY` must all be set to enable replication;
`LITESTREAM_S3_REGION` is optional (an empty region is fine for R2). After a
successful restore drill, set `LITESTREAM_REQUIRED=true`. Full setup,
verification, and disaster-recovery restore steps
(including a restore-drill runbook) live in `docs/litestream.md`. Relevant
files: `scripts/fetch-litestream.sh` (build-time binary download),
`litestream.yml` (replica config), `scripts/start-with-litestream.sh` (the
new `startCommand`), `scripts/litestream-restore.sh` (manual restore).
