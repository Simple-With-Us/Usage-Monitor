# Deployment Guide

**Production (2026-08-07+):** Production fleet box running Coolify (see private `jaywedgeworth22/fleet-ops:ATTACK-MAP.md`).
SSH: `ssh coolify` (see `~/.ssh/config` Host `coolify` / `host.jays.services`).
Public edge: Cloudflare → `usage.jays.services`.

Fleet ops sheet: `/Users/jay/apps/COOLIFY.md` and Socratic
`docs/rollouts/2026-08-07-hetzner-fleet-cutover.md`.

**Legacy Oracle** runbook (auto-deploy timer, preflight, litestream host
scripts) remains under **[`deploy/retired/oracle/`](deploy/retired/oracle/)**
for history / emergency reference — **Oracle is not the live writer** after the
Hetzner cutover.  See `deploy/README.md` for the canonical deploy index and
the entry-point banner at `deploy/retired/oracle/RETIRED.md` for the explicit
"Do not enable the Oracle auto-deploy timer on any host" warning.

The former Render deployment is **retired and suspended as a rollback host
only**; its historical runbook lives in
[`deploy/retired/render/RETIRED-rollback.md`](deploy/retired/render/RETIRED-rollback.md)
and `render.yaml` is kept functional solely so that host can be revived in a
deliberate rollback.

## Operational invariants

1. **Sole writer.** Exactly one app container may run against the SQLite
   database at any time. Only `usage-monitor.service` starts the app (the
   container's Docker restart policy is permanently `no` so the daemon can
   never start a writer before the `/data` block volume mounts), and the
   deploy transaction stops the old writer before accepting the new one.
   Never run a second instance — including a Render resume — against
   production data.
2. **Infisical is the source of truth for runtime config; secrets materialize
   only to tmpfs.** All runtime secrets and non-secret runtime config live in
   the Infisical `usage-monitor` project (env `prod`, path `/`) and are synced
   to `/run/usage-monitor/usage-monitor.env` (tmpfs, root-only, mode 0600) by
   `usage-monitor-env-sync`. The only secret kept on disk is the Infisical
   machine-identity bootstrap at
   `/etc/usage-monitor/infisical-bootstrap.env` (root-owned, mode 0600). The
   legacy `/etc/usage-monitor/usage-monitor.env` remains only as the
   pre-migration fallback/rollback path (see "Runtime env" below).
   `/etc/usage-monitor/host.env` holds only deploy-written host state
   (`USAGE_MONITOR_REVISION`). No production SSH key or cloud credential is
   stored in GitHub; the deploy model is pull-based.
3. **Backups replicate to Backblaze B2** (bucket `jays-usage-monitor-eu`,
   endpoint `https://s3.eu-central-003.backblazeb2.com`). Litestream continuously
   replicates `/data/prod.db` there. **Cloudflare R2 is weekly archive only**
   (`weekly/` on `usage-monitor-prod-v3`).  Historic Litestream LTX on that
   bucket was deleted 2026-08-16. **Hetzner/Coolify Garage is
   retired** (PR #869). Layered backup story: same-disk pre-migration snapshots
   (retention 1) → deploy-time offline snapshots → Litestream/B2 DR with
   external verification. R2 free-tier monitoring still watches the weekly
   bucket; the 70% kill switch only stops litestream when the endpoint is R2, not B2.
   See `docs/litestream.md`.
4. **Deploys are automatic; the live Coolify path is not CI-gated (known
   gap, board `d0f5f1db`).** The preflight-gated `usage-monitor-auto-deploy.timer`
   (exact `main` SHA with valid signature, merged-PR provenance, green GitHub
   Actions, healthy current database / sole scheduler / backup replica /
   `/data` headroom / public readiness, Render retirement proof) was the
   **retired Oracle host's** mechanism — see
   [`deploy/retired/oracle/`](deploy/retired/oracle/) — and is **not** what
   runs on the live Coolify host. Coolify's own GitHub auto-deploy fires on
   every push to `main` via a per-app webhook (`/Users/jay/apps/COOLIFY.md`
   "GitHub auto-deploy" row), independent of GitHub Actions outcome.
   `production-deploy-verify.yml` only **observes** after the fact — it
   confirms production reaches a SHA once CI on that SHA is green, but it
   cannot block or delay the webhook-triggered deploy that already started.
   A commit that lands on `main` with CI still red (or not yet dispatched)
   can therefore reach production before anyone is paged. There is no
   `/etc/usage-monitor/auto-deploy.paused`-equivalent freeze switch or
   host-side eligibility check on this host today; restoring one (or gating
   the Coolify trigger itself on a `workflow_run`-dispatched deploy call)
   needs Coolify dashboard/API access to implement and verify — tracked on
   the board rather than assumed fixed by this note. The historical
   `usage-monitor-auto-deploy.timer` from the Oracle era is preserved under
   [`deploy/retired/oracle/`](deploy/retired/oracle/) for forensic reference
   only and must not be `enable --now`'d on any host — see
   `deploy/retired/oracle/RETIRED.md`.
5. **Rollback never restores an old database over new writes.** Automatic
   rollback changes code/image only. A full host rollback requires quiescing
   the writer and restoring the latest verified **B2** lineage (or the weekly
   R2 archive if B2 is gone) before transferring writer authority — never just re-point
   DNS at a stale host.

## Verify a deployment

1. `curl -fsS https://usage.jays.services/api/health | jq` — confirm the
   expected `revision`.
2. `curl -fsS "https://usage.jays.services/api/ready?strict=1" | jq` —
   confirm database, scheduler, startup, and backup checks; observability
   blocks (`disk`, `budgetControls`, `admission`, `usageReadToken`) never
   gate `ok`. A non-ready dependency returns 503 with `strict=1`.
3. On the host: `sudo cat /var/lib/usage-monitor-deploy/current.json` for the
   deployment receipt, and
   `sudo journalctl -u usage-monitor-auto-deploy.service --since today` for
   gate decisions.
4. Visit https://usage.jays.services and log in at `/login` with
   `DASHBOARD_PASSWORD` (sourced from the Infisical `usage-monitor` project,
   synced to `/run/usage-monitor/usage-monitor.env` on the host).

## Runtime env: Infisical is the source of truth

All production runtime config — secrets **and** non-secrets — lives in the
Infisical `usage-monitor` project, environment `prod`, path `/`. The host
never edits a runtime `.env` file; it materializes one:

- `/usr/local/sbin/usage-monitor-env-sync` is installed on the Hetzner box.
  The reference implementation lives at
  [`deploy/retired/oracle/infisical-env-sync.sh`](deploy/retired/oracle/infisical-env-sync.sh)
  (Oracle-era, byte-identical to the Hetzner install); the historical
  filename is preserved so anyone diffing against the retired Oracle stack
  can see the script is unchanged.  The script logs in with the `automation`
  universal-auth machine identity, exports the project as JSON, validates the
  required keys, and atomically writes
  `/run/usage-monitor/usage-monitor.env` (tmpfs, root-owned, mode 0600, raw
  `KEY=value` lines) plus `/run/usage-monitor/sync-metadata.json` (counts and
  scope only, never values). `/run` is tmpfs, so no secret ever persists on
  disk and every boot starts from a fresh sync.
- **The one on-disk secret** is `/etc/usage-monitor/infisical-bootstrap.env`
  (root-owned, mode 0600): the machine identity's client ID/secret, the
  project ID, and optional `INFISICAL_BASE_URL` / `INFISICAL_UM_SECRET_PATH` /
  `INFISICAL_ENV` overrides. A single shared machine identity is used because
  of the owner's Infisical machine-identity cap; it is read-only on this one
  project/path/env.
- **Boot wiring:** `usage-monitor-env-sync.service` (oneshot) is
  `Requires`/`Before` `usage-monitor.service`, so Docker Compose never
  evaluates `env_file` against a missing tmpfs file. A 15-minute
  `usage-monitor-env-sync.timer` keeps the file fresh between deploys. The
  auto-deploy service is only `Wants`/`After` the sync unit because the
  deploy transaction re-runs the sync itself (see fallback below). On hosts
  without the bootstrap file the sync unit is condition-skipped and the
  legacy flow is untouched.
- **Fallback semantics:** if the sync fails during a deploy, the transaction
  continues only when a previous `/run/usage-monitor/usage-monitor.env` exists
  and is younger than 25 hours (so container restarts between deploys survive
  an Infisical outage); otherwise it fails closed before any preflight. A
  failed boot-time sync stops `usage-monitor.service` rather than starting
  the app on stale or missing config.
- **Adding or changing a variable:** edit it in the Infisical project (env
  `prod`, path `/`), then either run
  `sudo /usr/local/sbin/usage-monitor-env-sync` or wait for the 15-minute
  timer. Changed values reach the app only on the next container recreate
  (next deploy, or `sudo systemctl restart usage-monitor` for an immediate
  pickup of non-image changes).
- **`USAGE_MONITOR_REVISION` stays host-side.** It is deploy-written state
  (the accepted exact-SHA reboot pointer), not configuration, so it is never
  in Infisical; `host.env` now holds only that key.
- **Rollback:** point `env_file` back at the legacy disk file and restore the
  previous systemd units (all in git history), or simply remove
  `/etc/usage-monitor/infisical-bootstrap.env` — its absence makes the deploy
  transaction and the sync unit fall back to
  `/etc/usage-monitor/usage-monitor.env` with no other changes. Keep that
  legacy file (renamed `usage-monitor.env.legacy`, root-owned mode 0600)
  until the Infisical path has survived several deploys.

## Environment variables

All of these are set in the Infisical `usage-monitor` project (env `prod`,
path `/`) and synced to `/run/usage-monitor/usage-monitor.env`; on
unmigrated hosts they live in `/etc/usage-monitor/usage-monitor.env`.
`USAGE_MONITOR_REVISION` is the exception: it stays in `host.env` as
deploy-written state. `.env.example` documents
defaults and valid values for local development.

- `DATABASE_URL` — `file:/data/prod.db` on the dedicated block volume (not a
  secret, just a file path)
- `SQLITE_PRE_MIGRATION_BACKUP_RETENTION` (defaults to `3`, valid `1`-`10`;
  newest verified local snapshots retained under
  `/data/.pre-migration-backups` before startup schema synchronization)
- `ENCRYPTION_KEY` (64-char hex)
- `CRON_SECRET` (the `/api/cron/fetch-all` route still checks this, kept as
  an authenticated manual-trigger/debug endpoint even though nothing calls it
  on a schedule anymore)
- `USAGE_INGEST_TOKEN` (legacy shared ingest token — used by default unless
  scoped producer tokens are configured)
- `USAGE_INGEST_PRODUCER_TOKENS` (optional comma-separated `producerId:token` pairs
  for per-producer isolation and dedicated rate-limit buckets)
- `USAGE_INGEST_REQUIRE_SCOPED_TOKENS` (optional `true`/`false`; when `true`, denies
  unscoped `USAGE_INGEST_TOKEN` ingest)
- `USAGE_READ_TOKEN` (**required in production** — the deploy preflight
  hard-fails without it; read-only token for `/api/budget-status` and
  `GET /api/subscriptions`)
- `DASHBOARD_PASSWORD` (gates `/login` and all non-ingest routes)
- `SESSION_SECRET` (session cookies are HKDF-derived from this instead
  of `DASHBOARD_PASSWORD`, so a leaked session token can't be used to verify password guesses and the
  password can be rotated without invalidating existing sessions. Setting or changing it invalidates
  all existing sessions at once (the owner just re-logs in); it does not revoke individual sessions.)
- `SENTRY_READ_TOKEN` (optional; enables the read-only Sentry Health dashboard card, an org-auth
  token or internal integration token with `project:read`/`event:read` scope — never sent to the
  client, absent by default)
- `SENTRY_ORG` (optional; Sentry org slug for the Health card, defaults to `simple-with-us`)
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
- `READY_DISK_WARN_FREE_BYTES` (optional; free-bytes warn threshold for the
  observability-only `checks.disk` block in `/api/ready`, default 5 GiB —
  aligned with the deploy preflight's `MIN_DATA_FREE_BYTES`)
- `STARTUP_WRAPPER_REQUIRED` (optional opt-out; in production,
  `/api/ready?strict=1` fails unless the process booted through
  `scripts/start-with-litestream.sh`. Set `false` only for disposable
  throwaway containers that never write to SQLite)
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
- `LITESTREAM_S3_*` (Backblaze B2 replica credentials; set all four required
  values together or none—partial configuration fails startup. Production
  targets bucket `jays-usage-monitor-eu` on
  `https://s3.eu-central-003.backblazeb2.com`; see `litestream.yml` and
  `docs/litestream.md`. Optional unified `AWS_*` names are normalized at startup.)
- `LITESTREAM_REQUIRED` (production: `true`; readiness fails if replication
  is absent or the replica side-channel is unhealthy)
- `R2_USAGE_ACCOUNT_ID` / `R2_USAGE_API_TOKEN` (optional; watches **historic** R2
  free-tier; kill switch only stops litestream when endpoint is R2, not B2.
  Fallbacks: `CLOUDFLARE_JAY_*` or `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`)

## SSL/TLS
- Cloudflare proxy: enabled for `usage.jays.services`
- Cloudflare terminates public TLS; Caddy renews its origin certificate via
  HTTP-01 (TLS-ALPN disabled) and keeps ports 80/443 reachable
- HTTP is redirected to HTTPS; application responses also set HSTS, CSP,
  framing, MIME-sniffing, referrer, and permissions headers

## SQLite backup layers

Every startup with an existing DB runs
`scripts/backup-sqlite-before-migrate.mjs` before `migrate-safe.mjs`. It opens
the source read-only, uses SQLite's Online Backup API (safe with WAL), checks
the destination with `PRAGMA integrity_check`, atomically promotes only a
verified file, and retains the newest
`SQLITE_PRE_MIGRATION_BACKUP_RETENTION` snapshots under
`/data/.pre-migration-backups`. Failure to create, verify, or bound the
backup stops production startup before migration. These same-disk snapshots
are schema rollback protection, not protection from disk loss.

Every deploy transaction additionally keeps the previous full-SHA image and
up to five verified offline SQLite snapshots for automatic code rollback.

[Litestream](https://litestream.io/) continuously replicates `/data/prod.db`
to **Backblaze B2** (bucket `jays-usage-monitor-eu`) with disaster-recovery
restore points (24 h snapshot retention, 24 h snapshot interval, 1 h
sync-interval — not continuous second-scale PITR; see `litestream.yml`).
**Cloudflare R2 remains historic** until the owner deletes it after B2 is
proven. The external singleton at
`/Users/jay/apps/fleet-sentry-monitor/monitor.py` verifies replica freshness
and restorability (see "Backup monitoring" in `deploy/README.md`'s
"Live production" table — the script is machine-level, not per-app; the
retired Oracle-era runbook lives under `deploy/retired/oracle/README.md`
and is not the source of operational truth anymore). Full setup and
disaster-recovery restore steps live in `docs/litestream.md`.
Relevant files: `scripts/fetch-litestream.sh` (build-time binary download),
`scripts/start-with-litestream.sh` (startup wrapper),
`scripts/litestream-restore.sh` (manual restore).

## Release-time data maintenance

Do not add the Claude cumulative-cost repair or subscription seed to automatic
startup. Both require production-specific review that an idempotency marker
cannot replace. See `docs/release-maintenance.md` for the evidence and the
requirements for any future marker-driven task.
