# Litestream WAL Replication (production → Backblaze B2)

Continuous SQLite backup via [Litestream](https://litestream.io) **0.5.x**. Streams
writes to `/data/prod.db` as LTX files. **Production** (Hetzner + Coolify +
GitHub Actions, since the 2026-08-07 cutover) replicates to **Backblaze B2**
(bucket `jays-usage-monitor-eu`, S3 endpoint
`https://s3.eu-central-003.backblazeb2.com`, object prefix
`api-usage-monitor/prod.db` in `litestream.yml`).  The retired Oracle
container path lives under `deploy/retired/oracle/`; do not redeploy it.

**Cloudflare R2 is weekly archive only** (bucket `usage-monitor-prod-v3`
prefix `weekly/`).  Frequent replica is Backblaze B2.  Historic Litestream LTX
on that bucket was deleted 2026-08-16 after B2 + a verified weekly existed.
Litestream 0.5 supports **one active replica** — do not dual-write R2 and B2
from the same host.  The receipts bucket (`usage-monitor-receipts` / `evidence/`)
is a separate product store, not a database replica.

**Hetzner/Coolify Garage is retired** as a replica (PR #869). Do not point
production `LITESTREAM_S3_*` at Garage.

The suspended Render service is a deliberate, owner-directed rollback host only
(see `render.yaml` and `deploy/retired/render/RETIRED-rollback.md`). If ever revived, it
must use a **separate** R2 bucket/lineage so two hosts never write the same
replica prefix.

**Opt-in, with fail-closed configuration.** With `LITESTREAM_S3_*` unset and
`LITESTREAM_REQUIRED=false`, `scripts/start-with-litestream.sh` still creates
and integrity-checks a bounded local snapshot of an existing SQLite database
before `migrate-safe.mjs`, then starts without a litestream process. Setting
the four required `LITESTREAM_S3_*` env vars
(BUCKET/ENDPOINT/ACCESS_KEY_ID/SECRET_ACCESS_KEY; REGION is optional) turns
replication (and restore-on-fresh-disk) on. Partial credentials, an unverified
local pre-migration snapshot, or a configured replica with a missing/unverified
binary stop startup. Production runs `LITESTREAM_REQUIRED=true`, so an
entirely missing replica also stops startup and makes `/api/ready` fail.

### R2 free-tier auto-shutoff (hard 70%)

Maintenance (`src/lib/r2-usage.ts`) queries Cloudflare GraphQL **account-wide**
analytics each tick for R2 **storage**, **Class A**, and **Class B** against the
forever free tier (10 GiB / 1M Class A / 10M Class B).

| Metric | Trip condition |
|--------|----------------|
| **Storage** | **Absolute** ≥ 70% from **live S3 ListObjects** (not laggy GraphQL). GraphQL storage samples >90 min old are ignored |
| **Class A / B** | Absolute MTD ≥ 70% **or** linear month-end pace ≥ 70% |

On trip: write kill flag, Pushover, stop R2 Litestream. **Fail-closed** if
analytics credentials missing or GraphQL fails in production
(`LITESTREAM_REQUIRED=true` or `NODE_ENV=production`).

Requires `R2_USAGE_ACCOUNT_ID` + `R2_USAGE_API_TOKEN` (or `CLOUDFLARE_JAY_*`).
Local pre-migration snapshots on `/data` still exist.


> **0.5.x note:** Litestream 0.5 only supports a **single replica per database**. It
> also replaced the `snapshots`/`generations` model with **LTX files** — inspect them
> with `litestream ltx`, not `litestream snapshots`.

## How it fits into this repo

- `scripts/fetch-litestream.sh` — runs at image build time (Oracle Dockerfile;
  formerly `render.yaml`'s `buildCommand`). Downloads a pinned Litestream
  release (currently v0.5.13, selecting linux-x86_64 or linux-arm64 from the
  build host) into `./bin/litestream`, verifying its sha256 against a pin in
  the script. Idempotent (skips if the right version is already there) and safe
  to run even when replication is never enabled — the binary just sits unused.
- `litestream.yml` — the replica config: `/data/prod.db`, single S3-type replica
  populated entirely from `LITESTREAM_S3_*` env vars. **Disaster recovery only**
  for this app: `snapshot.interval: 24h`, `snapshot.retention: 24h`,
  `sync-interval: 1h`, `part-size: 10MB`, `concurrency: 2` (see `litestream.yml`).
  Product compaction is **L1-only**: a single top-level `levels:` entry
  (`interval: 30s`) so `Config.Levels` `MaxLevel() == 1` and L2/L3 monitors
  never start (same form as Socratic.Trade `litestream.coolify.yml`).  Omitting
  `levels:` would restore DefaultConfig L1/L2/L3 on the next image bake.
  Not multi-day continuous PITR — Backblaze B2 is the live host/disk-death
  replica, not “rewind to 3h42m ago.”  Cloudflare R2 is weekly archive only.
  Historic multi-level LTX on R2 re-breached the 10 GiB free tier
  (2026-08-04 / 2026-08-06); maintenance tip-prunes non-tip LTX at 50% storage
  before the 70% kill when the endpoint is R2. Off-site backup health is
  observability only on `/api/ready` (does not gate product readiness).
- `scripts/start-with-litestream.sh` — the container entrypoint. If all four
  required `LITESTREAM_S3_*` vars are set and `bin/litestream` exists: restores
  first if `/data/prod.db` doesn't exist yet (fresh disk or disaster recovery).
  In both enabled and disabled modes it then runs
  `backup-sqlite-before-migrate.mjs` and `migrate-safe.mjs` in that order.
  **R2 endpoints:** litestream runs as a sibling of `npm start` so the free-tier
  kill switch can stop replication without taking down the app. **Non-R2 S3:**
  `exec litestream replicate -exec "npm start"` (litestream is PID 1).
- `prisma.config.ts` — declares Litestream's `_litestream_seq` and
  `_litestream_lock` tables as externally managed. Startup schema sync must
  preserve their exact schema and state; `migrate-safe.mjs` never retries with
  Prisma's broad `--accept-data-loss` flag.
- `scripts/backup-sqlite-before-migrate.mjs` — transaction-consistent SQLite
  `VACUUM INTO` snapshot plus `PRAGMA integrity_check` inside a child process
  with a bounded deadline, private file modes, atomic promotion, and bounded
  same-disk retention.  `SQLITE_PRE_MIGRATION_BACKUP_TIMEOUT_MS` is an Infisical
  env-sync startup knob (default 300000 ms, maximum 900000 ms); timeout fails
  startup closed.  It is the immediate schema rollback layer; Litestream/B2
  remains the off-disk disaster-recovery replica.
- `scripts/litestream-restore.sh` — manual disaster-recovery restore to a
  scratch path, run inside the production app container (see below).
- `scripts/replica-status-heartbeat.sh` + `run-app-with-replica-heartbeat.sh` —
  in-container LTX tip probe under Infisical-injected env (Coolify-safe).
  Lists `ltx -json` at continuous levels 0–3 plus snapshot level 9 so leftover
  L2/L3 objects stay visible; product compaction itself is L1-only.
- `deploy/coolify/replica-status-probe.sh` — **production Hetzner** host timer
  (Coolify UUID container).  Tries `docker exec --once`, then a host
  `--env-file` fallback from the litestream PID environ.  Never puts
  `LITESTREAM_S3_*` on `docker exec` argv.
- `deploy/retired/oracle/replica-status-probe.sh` — **legacy Oracle** script.
  The Hetzner box runs the byte-identical script from
  `deploy/coolify/replica-status-probe.sh` via
  `coolify/usage-monitor-replica-status.{service,timer}`.  Without a live
  heartbeat, backup reports `env_active_unverified`.
- Operator runbook: `docs/runbooks/replica-status-probe.md` (reasons, fallback
  trust rules after #1354/#1355, Coolify verify commands).

## Production setup (host → Backblaze B2)

Runtime config lives in the Infisical `usage-monitor` project (env `prod`) as
the sole source of truth — see `DEPLOY.md` "Runtime env: Infisical is the
source of truth" and `deploy/README.md` for the canonical deploy index.  The
retired Oracle-era runbook is preserved under `deploy/retired/oracle/` for
historical reference only. Set there:

```
# Primary (B2) — write key fleet-usage-monitor-backup (not the read-only monitor key)
LITESTREAM_S3_BUCKET=jays-usage-monitor-eu
LITESTREAM_S3_REGION=eu-central-003
LITESTREAM_S3_ENDPOINT=https://s3.eu-central-003.backblazeb2.com
LITESTREAM_S3_ACCESS_KEY_ID=...   # B2_UM_KEY_ID
LITESTREAM_S3_SECRET_ACCESS_KEY=...  # B2_UM_APPLICATION_KEY
LITESTREAM_REQUIRED=true
```

**R2 free-tier kill** (`/data/r2-disabled-70pct.flag`, `R2_WRITES_DISABLED`) only
disables litestream when the endpoint hostname is R2. On B2 it is ignored so a
historic R2 trip cannot stop B2 DR.

Infisical may also set the unified `AWS_*` names (`AWS_S3_ENDPOINT`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET_NAME`,
`AWS_REGION`). The startup wrapper normalizes `AWS_*` into `LITESTREAM_S3_*`
for `litestream.yml` expansion.

All four of bucket/endpoint/access-key-id/secret-access-key must be set
together. The startup wrapper rejects partial configuration, and it rejects
full configuration when the verified binary is unavailable.
`LITESTREAM_S3_REGION` is optional for R2 (empty → Litestream falls back to
`us-east-1`, which R2 accepts for SigV4). Prefer `auto` to be explicit.

Deploy env preflight (`deploy/retired/oracle/usage-monitor-sync-env.sh`, run on the
Hetzner box — see `deploy/README.md` for the canonical install path) requires the
B2 bucket name `jays-usage-monitor-eu` (or historic R2 `usage-monitor-prod-v3`
during cutover only). **Account-wide free-tier analytics** still count every
**R2** bucket on the Cloudflare account for the historic free-tier card; that
does not apply to B2 storage.

Replica uploads use `part-size: 10MB` and `concurrency: 2` in
`litestream.yml` (the 2026-08-27 B2 multipart checksum-mismatch fix).

Changing any of these values: edit them in Infisical, run
`sudo /usr/local/sbin/usage-monitor-env-sync` (or wait for the 15-minute
timer), then recreate the container (`sudo systemctl restart usage-monitor`)
or let the next deploy pick them up. There is no dashboard that "triggers a
redeploy" on Oracle.

### Verify

From the host (or see `docs/runbooks/replica-status-probe.md`):

```bash
# Refresh and verify the replica probe verdict via host script:
sudo /usr/local/sbin/usage-monitor-replica-status

# Status file (Coolify volume or inside the container):
# host:
cat /var/lib/docker/volumes/*usage-data*/_data/.litestream-replica-status.json
# or:
#   sudo docker exec "$UM_CONTAINER" cat /data/.litestream-replica-status.json
curl -fsS https://usage.jays.services/api/ready | jq .checks.backup
```

`checks.backup` is **observability only**.  It does not gate overall
`/api/ready` `ok` (or `?strict=1` HTTP status).  Product readiness is
database + databaseFile + scheduler + startup.  A replica listing timeout
can leave `replicaOk=false` / `reason=list_timeout` while the app stays
ready.

Healthy side-channel: `active=true`, `envOnly=false`, `replicaOk=true`.
`reason` may be `null` (continuous LTX) or `snapshot_only` (level-9 tip
only).  Do not require `reason=null`.  `envOnly:true` means no status
file path is configured (`LITESTREAM_REPLICA_STATUS_PATH` unset).

Offline fixtures: `bash scripts/test-replica-status-probe.sh` and
`bash scripts/replica-status-heartbeat.sh --self-test`.

### Coolify/Hetzner host timer install

```bash
sudo install -o root -g root -m 0755 deploy/coolify/replica-status-probe.sh \
  /usr/local/sbin/usage-monitor-replica-status
sudo install -o root -g root -m 0644 deploy/coolify/usage-monitor-replica-status.service \
  /etc/systemd/system/usage-monitor-replica-status.service
sudo install -o root -g root -m 0644 deploy/coolify/usage-monitor-replica-status.timer \
  /etc/systemd/system/usage-monitor-replica-status.timer
sudo systemctl daemon-reload
sudo systemctl enable --now usage-monitor-replica-status.timer
sudo /usr/local/sbin/usage-monitor-replica-status
```

Infisical `usage-monitor` / `prod` must include
`LITESTREAM_REPLICA_STATUS_PATH=/data/.litestream-replica-status.json` (also
exported by `start-with-litestream.sh` after the next deploy).

In `sudo docker logs "$UM_CONTAINER"`, look for the
`[start-with-litestream] replication ENABLED` line and a
`[sqlite-pre-migration-backup] verified ...` line at boot, followed by
litestream's own `replicating to type=s3 bucket=...` and periodic
`ltx file uploaded` / `replica sync` lines.  If instead you see
`[start-with-litestream] replication DISABLED`, all required `LITESTREAM_S3_*`
vars are unset and the boot must be treated as misconfigured (production
requires them).  Partial values or a missing binary are startup errors; check
`fetch-litestream.sh` and startup logs.

Confirm `/api/ready` reports `checks.backup.required=true`,
`checks.backup.active=true`, and `checks.backup.replicaOk=true` (the heartbeat
side-channel).  `envOnly:true` means `LITESTREAM_REPLICA_STATUS_PATH` is
unset so Next.js cannot read a probe verdict.  That is an ops gap, not a
product-down signal: backup still does not gate overall `ok`.  Operator
reasons and the Coolify `--once` vs `--env-file` fallback are in
`docs/runbooks/replica-status-probe.md`.

### Product compaction is L1-only (2026-09-04)

Litestream 0.5.x has no disable-L2 flag.  `litestream.yml` sets a single
top-level `levels:` entry (`interval: 30s` = L1), matching Socratic.Trade.
`Config.Levels` is L1..N in list order (`cmd/litestream/main.go`
`CompactionLevels()`).  One entry makes `MaxLevel() == 1` and `NextLevel(1)`
the snapshot level.  DefaultConfig would otherwise start L2 at 5m and L3 at
1h, so a bake without this key would re-enable L2/L3 even if Housekeeper's
live overlay currently holds them off.

There is also **no compaction-backoff yaml key**.  Removing L2/L3 is the
backoff: remaining L1 retries every 30s against a small L0 window.  Snapshot
stays `24h` / `24h`.  Replica `sync-interval: 1h`, `part-size: 10MB`, and
`concurrency: 2` are unchanged.  Backup health-check wiring is unchanged
(probes still list 0–3 + 9; leftover L2/L3 objects do not mean those
monitors are running).  Do **not** add `verify-compaction: true`.

### Free-tier growth (what to expect)

R2 storage is **not** “one copy of `prod.db`.”  Litestream keeps LTX files for
the retention window; a ~0.4 GiB DB can still fill ~9 GiB under a 24h window
when L1/L2/L3 each hold large intermediates.  Product compaction is now
L1-only (L2/L3 monitors off), so that growth mode should not return on B2.
Historic R2 refill used `retention: 6h` + `sync-interval: 2h`, plus automatic
tip-prune at 50% absolute storage (keep newest tip per level).  Manual
tip-prune (ops): delete non-tip `.ltx` under
`api-usage-monitor/prod.db/{0000..0009}/`.  Multi-day retention is what filled
15+ GiB in August 2026 — do not raise retention without measuring.


## Rollback host only (Render)

The suspended `api-usage-monitor` Render service keeps its own R2 bucket
(`api-usage-monitor-backups`) and credentials, configured through Render's
Environment tab with `sync: false` placeholders in `render.yaml`. That
dashboard flow applies to a deliberate, owner-directed revival of the rollback
host only — never to production. A host rollback requires quiescing Oracle and
restoring the latest verified **R2** lineage before transferring
scheduler/writer authority; never reverse DNS onto Render's stale database.
On the rollback host, `LITESTREAM_REPLICA_VERIFICATION_REQUIRED=false` is the
sanctioned way to run without the Oracle heartbeat probe.

## Disaster recovery

For the specific incident where the live database file has been deleted or
replaced underneath the running writer (readiness reasons
`database_file_unlinked` / `database_file_missing` /
`database_file_replaced`), **stop — do not restart anything** — and follow
`docs/runbooks/sqlite-data-loss-incident.md`. A restart destroys the open
descriptor that may be the only remaining copy. The steps below are the
general replica-restore path for a database that is merely lost or corrupt.

`scripts/litestream-restore.sh` restores the latest replica to a scratch file — it
never overwrites the live `/data/prod.db` directly. Run it inside the app
container on the Oracle VM (R2 credentials and the `/data` disk are only
reachable there):

```bash
sudo docker exec usage-monitor-app-1 bash scripts/litestream-restore.sh /data/prod.db.restored

# Verify:
sudo sqlite3 /data/prod.db.restored 'PRAGMA integrity_check;'
sudo sqlite3 /data/prod.db.restored 'SELECT count(*) FROM "UsageSnapshot";'

# Activate (keep a timestamped backup of the old file first):
sudo cp -a /data/prod.db /data/prod.db.bak-$(date +%Y%m%d-%H%M%S)
sudo cp /data/prod.db.restored /data/prod.db
sudo chown 1000:1000 /data/prod.db && sudo chmod 0600 /data/prod.db
# Then restart through the mount-gated systemd unit (never `docker restart`;
# the container's restart policy is deliberately `no`) so the running process
# and litestream reopen the swapped-in file:
sudo systemctl restart usage-monitor
```

Point-in-time restore (0.5.x): pass `-timestamp 2026-06-21T18:00:00Z` or
`-txid <hex>` — see the flags printed at the end of `litestream-restore.sh`'s output,
or `bin/litestream restore -h`.

If the disk is wiped entirely (new volume, container recreated), you don't
need to run this manually at all: `scripts/start-with-litestream.sh` already
calls `litestream restore -if-db-not-exists -if-replica-exists` before
`migrate-safe.mjs` on every boot, so a fresh empty disk recovers from R2
automatically as long as `LITESTREAM_S3_*` is set.

### Restore verification

Restore is exercised continuously, not just at drills:

- Every production deploy hard-gates LTX freshness (≤ 10800s / 3h) plus an
  authenticated restore dry-run, and acceptance performs a full authenticated
  replica restore with a complete SQLite integrity scan
  (`deploy/retired/oracle/deploy-production.sh`).
- The fleet-sentry-monitor singleton runs an authenticated dry-run every 15
  minutes and a weekly full-integrity restore to a fixed Oracle scratch path
  (`deploy/retired/oracle/README.md` "Backup monitoring").

Still run a **manual** drill quarterly and after any Litestream version bump —
a wrong `-config` path, a stale/incompatible LTX generation, or a
read-permission gap only surfaces on the exact command an operator would type
during an incident:

1. `sudo docker exec usage-monitor-app-1 bash scripts/litestream-restore.sh /data/prod.db.restore-drill`
2. `sudo sqlite3 /data/prod.db.restore-drill 'PRAGMA integrity_check;'` — expect `ok`.
3. Compare `SELECT count(*) FROM "UsageSnapshot";` (or another frequently-written
   table) between the restored file and the live `/data/prod.db` — restored count
   should be close to (at or slightly behind) live, never ahead of it.
4. `sudo rm /data/prod.db.restore-drill` — do not leave the scratch file on the
   disk, and do not `cp` it over the live DB as part of a drill.
5. Record the outcome (date, litestream version, integrity result, count delta) as a
   `docs/rollouts/YYYY-MM-DD-litestream-restore-drill.md` note, matching this repo's
   existing `docs/rollouts/` convention.

## Monitoring

```bash
sudo docker exec "$UM_CONTAINER" /app/bin/litestream ltx -json -config /app/litestream.yml -level 0 /data/prod.db | tail
cat /data/.litestream-replica-status.json
```

Or tail `sudo docker logs "$UM_CONTAINER"` and watch for repeated `replica sync`
lines without errors.  `/api/ready?strict=1` still does **not** fail HTTP
on `checks.backup` (same `ok` as the default body).  Alert on
`checks.backup.replicaOk` / `checks.backup.reason` independently, or via
the fleet-sentry-monitor Sentry cron check-in.
