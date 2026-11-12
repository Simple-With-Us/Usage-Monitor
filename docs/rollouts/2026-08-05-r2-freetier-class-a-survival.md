# 2026-08-05 — R2 free-tier Class A survival + fleet labels [GROK]

## Context & objective

Align fleet R2 free-tier labels and cut Class A ListObjects waste while CT/ST
writes are already kill-switched or host-paused. Pair with ST rollout
`docs/rollouts/2026-08-05-r2-freetier-class-a-survival.md`.

## Discrepancy findings (UM vs ST cards)

| Topic | Usage Monitor | Socratic Trade admin |
|-------|---------------|----------------------|
| Labels | Socratic Trade ✓, **Congress Trade** (wrong), Usage Monitor ✓ | **Socratic.Trade** (wrong), Congress.Trade ✓, Usage Monitor ✓ |
| UM storage | Live S3 list **7.00 GiB** (prod-v3) | GraphQL adaptive **max** can show ~7.9+ GiB / stale orphan peaks |
| Class A limit | 1,000,000 / month | same (percent of 1M) |
| Pace while killed | Shows DISABLED + R2 writes paused | Pace still extrapolates early-month burn |

Live inventory (Oracle, S3 list, kill-on):

- `usage-monitor-prod-v3`: **7.00 GiB** / 156 objects (litestream path)
- `usage-monitor-bucket`: **0** objects (GraphQL still remembered historical max ~15 GiB)
- `usage-monitor-receipts`: ~0 GiB

## Changes

- Fleet label **Congress.Trade** (period, no space).
- `resolveR2StorageBucketNames`: primary litestream bucket + optional
  `R2_USAGE_EXTRA_BUCKETS` only (no hardcoded multi-bucket List every tick).
- `fetchLiveR2StorageViaS3`: **6h cache** (`R2_LIVE_LIST_CACHE_HOURS`); when
  kill-switch engaged, reuse cache up to 24h so maintenance (15m) stops burning
  Class A ListObjects for no benefit.

## Verification

```bash
npx vitest run src/lib/__tests__/r2-usage.test.ts src/components/__tests__/OperationsOverview.test.ts
```

25/25 pass.

## Host note

UM R2 kill flag remains: `/data/r2-disabled-70pct.flag`. Do not resume until
storage absolute is comfortably under 70% after any LTX prune/GC.
