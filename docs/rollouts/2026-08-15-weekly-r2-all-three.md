# Rollout — Weekly R2 running on UM, ST, and CT

## Summary

Owner design: each live app keeps **frequent Backblaze B2** (Litestream).
**Cloudflare R2 is weekly archive only** — not a live replica, not leftover
LTX.  Jay Old is not a backup target (`10042` / R2 not enabled; UM #1216).

This unit made that design true in production, not just on the Platforms card.

## Live receipts (2026-08-15)

| App | Frequent B2 | Weekly R2 | How it runs |
|-----|-------------|-----------|-------------|
| Usage Monitor | Yes — replica ~4 min | Yes — `weekly/prod-2026-08-12T23-57-10Z.db.gz` (~3 d, inside 8 d) | Coolify cron `scripts/ops/r2-weekly-archive.mjs` |
| Socratic.Trade | Yes — Litestream to B2 `jays-socratic-trade-eu` prefix `trading-live/app.db` | Health ok on `cold-snapshots/app-2026-08-09.db` (2.37 GB).  Week `2026-08-16` job claimed 21:27Z and uploading a fresh `app-2026-08-15.db` | In-app Sunday 03:17 UTC due-job |
| Congress.Trade | Yes — host Litestream | Yes — `weekly/congress-trade-20260815T211942Z.db` (1.91 GB, integrity ok, gz 361 MB) | Host `fleet-sqlite-backup.sh` Sunday rclone `[r2]` |

Jay Old GraphQL leftovers are ignored.  Platforms still flags Congress.Trade
Class A *pace* past 70% — that is ops-pace, not this weekly-archive lane.

## What was broken

- **CT weekly 401.**  Host rclone `[r2]` still held the revoked shared
  `CLOUDFLARE_R2` key.  Bucket-item-only tokens listed `weekly/` but PUT
  `AccessDenied`.  Account-level Workers R2 Storage Write works.
- **ST health `archive_not_run`.**  Aug 9 snapshot was already in the bucket
  (2.37 GB) but `r2coldsnap:lastSuccess` was never persisted (health PR #2713
  landed after that run).  Health reads the setting, not R2.
- **ST leftover LTX.**  GraphQL still showed ~4.1 GB because
  `trading-live/*` LTX (~1.8 GB, leftover from the pre-B2 R2 replica) sat
  beside the Aug 9 cold snapshot.  Current Litestream writes `trading-live/`
  on **B2**, not R2.
- **ST process.**  Coolify app was exited/unhealthy; `socratictrade.com` 503.
  Started; site healthy.

## What we did (ops; no invented tokens)

1. Started the ST Coolify app (`d83b1aykr03uwr32yhgzaiay`).
2. Minted a CT-account R2 token (`ct-weekly-r2-archive-acct-write`, Storage
   Write).  First bucket-item-only token was revoked after AccessDenied.
3. Wrote S3 creds to `~/.secrets/ct-r2-weekly-archive.env` (0600) and
   `/root/.ct-r2-weekly-archive.env`.  Updated host rclone `[r2]`.
4. Overwrote Infisical CT prod `R2_ARCHIVE_ACCESS_KEY_ID` /
   `SECRET` / `ENDPOINT` / `BUCKET` (presence verified; values never printed).
5. Uploaded a verified CT snapshot
   `/data/backups/congress/congress-trade-20260815T211942Z.db` to
   `r2:congress-trade-bucket/weekly/` and wrote
   `/data/congress-trade/.r2-archive-status.json`.  Live
   `GET /api/health` `r2Weekly.ok=true`.
6. Synced host `fleet-sqlite-backup.sh` from the CT repo so next Sunday writes
   the same receipt.
7. Inserted ST `r2coldsnap:lastSuccess` from the Aug 9 object so health is
   honest inside the 8-day window.
8. Deleted 17 leftover ST R2 `trading-live/` LTX objects.  REST list now
   shows only `cold-snapshots/app-2026-08-09.db`.
9. Bumped ST due-job `week-2026-08-16` so a fresh weekly runs now.  First
   attempt finished the 4.47 GB local backup then Coolify restarted the
   container at 22:04Z (orphaned claim).  Requeued; attempt 2 claimed
   22:11Z with lease through 00:30Z.  ST PR #2737 (retain 1) stays
   unmerged until this upload finishes so another deploy cannot kill it.

## Owner follow-up (optional)

- Revoke `ct-weekly-r2-archive-acct-write` from the Cloudflare dashboard if a
  tighter token is minted later.  Do not reuse the revoked shared R2 key.
- Platforms Class A pace on Congress.Trade is a separate lane.

## Related

- UM #1216 `b8017489` — Jay Old not enabled (live `15e4d3b6`)
- `docs/rollouts/2026-08-15-r2-old-not-enabled.md`
- `docs/rollouts/2026-08-12-r2-weekly-verified-archive.md`
- `docs/rollouts/2026-08-14-backup-restore-proof.md`
