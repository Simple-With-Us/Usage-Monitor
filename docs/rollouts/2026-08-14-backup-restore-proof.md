# 2026-08-14 — Fleet backup restore proof [GROK]

Non-destructive Litestream restore drill on `fleet-hetzner-nbg1` (`<PROD_ORIGIN_IP>`).  Each restore wrote a temp file beside the live DB, never over it, then the temp file was deleted.  Live files stayed in place.

## Results

| App | Daemon | `.litestream-disabled` | B2 replica | Newest remote LTX age | Latest restore | Notes |
|-----|--------|------------------------|------------|------------------------|----------------|-------|
| **Usage Monitor** | **PASS** (`/app/bin/litestream replicate`) | absent | `s3.eu-central-003.backblazeb2.com` prefix `api-usage-monitor/prod.db` | **3124s** (level 0 @ `2026-08-14T01:02:11Z`; 1h sync) | **PASS** | integrity `ok`; schema match 24/24 tables; pages live 68531 vs restore 68015 (WAL tip ahead of last replica) |
| **Socratic.Trade** | **PASS** (`/app/data/.bin/litestream`, socket `/app/data/litestream.sock`) | absent | same B2 host, prefix `trading-live/app.db` | **~0–35s** (level 0 @ `2026-08-14T02:01:00Z`; 60s sync) | **FAIL** | latest plan: non-contiguous LTX `43206` → `43225`; last contiguous txid `43206` restore **failed integrity_check** (rowid/page corruption) |
| **Congress.Trade** | **PASS** (`/app/bin/litestream replicate`) | absent | same B2 host, prefix `congress-trade/db.sqlite` | **337s** (level 0 @ `2026-08-14T01:52:31Z`; 5m sync) | **PASS** | integrity `ok`; schema match 65/65; pages exact 465342 |

No host systemd Litestream unit.  All three daemons run in-container.

## Usage Monitor — PASS

- Container `<UM_COOLIFY_APP_UUID>-…`, live `/data/prod.db` 280 MB, integrity `ok`.
- Restore 2026-08-14T01:54:00Z–01:54:15Z → 278 589 440 bytes, integrity `ok`, then deleted.
- `/api/ready` at drill time: `checks.backup.ok=true` but `gatesOverallOk` was **hard-coded `false`** while `backupLayers.local/primary/r2Historic` were all `ok`.  That is the “humans think backup failed” lie.  Fixed in this rollout: `gatesOverallOk` is now the AND of the three layer `.ok` flags and still does **not** flip top-level ready `ok`.

## Socratic.Trade — FAIL (latest + last contiguous snapshot)

- Daemon + socket exist.  Live `/api/health` `litestreamSource=ipc`, `litestreamStatus=replicating`, age 57s.  This is **not** an IPC/path bug.
- `storageDegraded=true` because `litestreamCompactionLogFailureCount=1`: level-2 `compaction failed` / non-contiguous txids `(43206) → (43225)`.  Same gap that blocks restore.
- PRs **#2683** (durable remote inventory) and **#2685** (loud compaction failures) are already **merged**.  No duplicate inventory work.  No socket-client change.
- `litestream restore` latest: `cannot calc restore plan: non-contiguous ltx files`.
- `litestream restore -txid 0000000000043206` (last contiguous L9+L1, ~00:00Z): wrote 3.78 GiB, schema 101/101 match, then **integrity_check failed** (`2nd reference to page`, rowids out of order, unused pages).  Temp file deleted.
- Secondary local path (not Litestream): host 6h dump `/data/backups/socratic/socratic-app-20260814T001501Z.db` age **3606s**, `PRAGMA quick_check=ok`, pages 923824, schema match.  That is the current restorable copy until B2 L1/L2 is rebuilt cleanly.

Follow-up (not done here): wait for L2/L3 rebuild after the 2026-08-13 surgical L1 delete, or another owner-authorized LTX repair.  Do not restore over the live ST DB.

## Congress.Trade — PASS (B2).  R2 weekly archive still 401

- Container `congress-app-c11c5hdhuczureb6w2pg20p0-…`, live `/data/congress-trade/db.sqlite` 1.91 GiB.
- Restore 2026-08-14T01:55:55Z–01:58:08Z → exact size/pages, integrity `ok`, then deleted.
- Pipeline `status=stalled` is dead-letter/extraction, not backup.

### Owner action — CT R2 weekly archive token

Do **not** invent or copy a token.  Permanent R2 S3 tokens are dashboard-only.  Existing scripts / `CLOUDFLARE_CT_API_TOKEN` / fleet token cannot mint one without a secret-print path.

Infisical project `congress-trade` (`f61a79de-8d77-4f0b-9361-4b7208598290`), env `prod`, path `/`.  Keys already exist (names verified; values not printed).  The current `R2_ARCHIVE_ACCESS_KEY_ID` / `R2_ARCHIVE_SECRET_ACCESS_KEY` pair is the revoked shared `CLOUDFLARE_R2_*` / `AWS_ACCESS_KEY_ID` signer and **401s** on the CT account.

**Mint** on the **Congress.Trade** Cloudflare account (not JAY / ST / shared): Dashboard → R2 → Manage R2 API Tokens → Object Read & Write scoped to `congress-trade-bucket`.

**Overwrite only these two** in Infisical CT prod (value-blind `scripts/infisical-secrets-safe.sh set`):

- `R2_ARCHIVE_ACCESS_KEY_ID`
- `R2_ARCHIVE_SECRET_ACCESS_KEY`

**Confirm these stay CT-account-shaped** (do not copy UM’s pair):

- `R2_ARCHIVE_ENDPOINT` = `https://<CLOUDFLARE_CT_ACCOUNT_ID>.r2.cloudflarestorage.com`
- `R2_ARCHIVE_BUCKET` = `congress-trade-bucket`
- `R2_ARCHIVE_REGION` = `auto`
- `R2_ARCHIVE_PREFIX` = `weekly/`

Optional if the weekly job is wired later:

- `R2_ARCHIVE_DB_PATH` = `/data/congress-trade/db.sqlite`
- `R2_ARCHIVE_STATUS_PATH` (job default is fine)
- `R2_ARCHIVE_KEEP_GENERATIONS` (already present)
- `R2_ARCHIVE_IGNORE_KILL_SWITCH` (only if a CT R2 kill flag would block the weekly PUT)

Prove with ListObjectsV2 status + object count only.  Then revoke/delete the leftover shared `CLOUDFLARE_R2_*` copy if it is still stored under `R2_ARCHIVE_*`.

## What this PR changes (UM only)

- `checks.backup.gatesOverallOk` reports `local.ok && primary.ok && r2Historic.ok`.
- Top-level `/api/ready` `ok` is unchanged (backup stays observability-only).
- Tests pin the AND, including an all-layers-green case that must stay `ok: true`.
