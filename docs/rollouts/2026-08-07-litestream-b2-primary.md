# 2026-08-07 — Litestream primary → Backblaze B2 (R2 historic)

## Objective
Point production SQLite DR replication at **Backblaze B2** bucket
`jays-usage-monitor-eu`. Leave **Cloudflare R2** objects in place as a historic
archive until B2 restore is proven (owner will delete R2 later).

## Why
R2 free-tier thrash (70% kill, tip-prune, 6h retention) made continuous DR
fragile. B2 has a dedicated EU fleet bucket + write key `fleet-usage-monitor-backup`.
Litestream 0.5 supports **one** active replica — no dual-write.

## Code / config
| File | Change |
|------|--------|
| `litestream.yml` | Comments + 24h retention + 1h sync; B2 expected env values |
| `scripts/start-with-litestream.sh` | R2 kill never disables B2 endpoints |
| `deploy/oracle/deploy-production.sh` | Preflight accepts `jays-usage-monitor-eu` (warns if still on R2) |
| `deploy/oracle/usage-monitor-sync-env.sh` | Bucket + backblazeb2.com endpoint invariants |
| `docs/litestream.md`, `DEPLOY.md`, `.env.example` | B2 primary docs |

## Local cleanup
- Removed `temp_large.db` / `temp_large_backup.db` (~400 MiB junk) from the
  developer machine (already gitignored). Keep at most one `prisma/dev.db` for
  local dev. Production same-disk pre-migration retention remains **1**.

## Host / Infisical (required to go live)
Set Infisical `usage-monitor` / `prod` (or host env materialization):

```
LITESTREAM_S3_BUCKET=jays-usage-monitor-eu
LITESTREAM_S3_ENDPOINT=https://s3.eu-central-003.backblazeb2.com
LITESTREAM_S3_REGION=eu-central-003
LITESTREAM_S3_ACCESS_KEY_ID=<B2_UM_KEY_ID>
LITESTREAM_S3_SECRET_ACCESS_KEY=<B2_UM_APPLICATION_KEY>
LITESTREAM_REQUIRED=true
```

Use **write** key `fleet-usage-monitor-backup` from
`~/.secrets/backblaze-app-keys.env` — **not** the read-only monitor key.

Redeploy or restart the app so `start-with-litestream.sh` picks up env.
Verify: `litestream ltx` / B2 list under `api-usage-monitor/prod.db`, and
`/api/ready` backup observability.

## Do not
- Delete R2 buckets yet
- Point litestream at Garage
- Leave dual writers on one replica prefix
