# Rollout — Jay Old R2 leftovers are not live usage

## Summary

The Platforms / Ops R2 card treated Cloudflare GraphQL storage as live free-tier
usage for every configured account.  The retired `jay` account
(`CLOUDFLARE_OLD_ACCOUNT_ID` …`a9608c73`) no longer has the R2 product
(REST `10042` / “Please enable R2”).  GraphQL still emits leftover analytics
from when UM, ST, and CT all lived there (~116 GiB across
`api-usage-monitor`, `trading-live-backups`, congress feed prefixes).  That
made Jay (Old) look like 1,167% of the 10 GB free tier and marked the fleet
over the 70% guard.

The card now REST-confirms R2 is actually enabled before trusting GraphQL
storage that would trip the guard (and always confirms the `old` slot).
`10042` renders as **R2 not enabled**, with no usage bar and no guard trip.
ListBuckets is Class A, so the verdict is cached 24 hours.  A 403/10000
(token cannot list) is **not** treated as disabled — Usage.Jays.Services
GraphQL-reads fine while REST-list 403s on the JAY token.

Kill-switch path is unchanged (UM account only).

## Live backup design vs this card

Owner design: each of UM / ST / CT keeps **frequent Backblaze B2** (Litestream)
and a **weekly R2 archive**.  This change does not alter that.  Checked live
2026-08-15:

| App | Frequent B2 | Weekly R2 |
|-----|-------------|-----------|
| Usage Monitor | Yes — replica ~4 min | Yes — `weekly/prod-2026-08-12T23-57-10Z.db.gz` |
| Socratic.Trade | Yes — Litestream to B2 `trading-live/` | Health ok on `cold-snapshots/app-2026-08-09.db`.  Leftover R2 LTX deleted.  See `2026-08-15-weekly-r2-all-three.md` |
| Congress.Trade | Yes — host Litestream | Yes — `weekly/congress-trade-20260815T211942Z.db` after new account-write token |

Jay Old is not a backup target.

## Files

- `src/lib/r2-usage.ts` — `10042` detect, cached product probe, fleet snapshot
- `src/lib/platform-status/probes/storage.ts` — card copy, no bar
- `src/components/OperationsOverview.tsx` — Ops fleet block
- tests in `r2-usage`, `platform-status-storage`, `OperationsOverview`
