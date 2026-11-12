# 2026-08-10 — ST OOM-loop + Usage Monitor fleet ops visibility

## Context & Objective
Owner: ST down again; UM cannot see current services. Stabilize host + expand Operations.

## Ops (host)
- Root cause: ST memcg OOM exit 137 (litestream ~3GB RSS in 4g limit).
- Raised limits_memory to 6g; pruned /data/backups keep 3; KEEP_COUNT on fleet-sqlite-backup.sh.
- UM env: COOLIFY_HOST + COOLIFY_SERVER_STATS (read-only).

## Code
- Full ST /api/health parse + Coolify fleet Operations card.

## Verification
- tsc + operations tests 13/13.
