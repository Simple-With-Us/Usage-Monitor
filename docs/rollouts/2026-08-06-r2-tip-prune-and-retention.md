# 2026-08-06 — R2 free-tier refill: tip-prune + 6h retention [GROK]

## Context

Kill switch tripped again at **89.19%** live storage
(`2026-08-06T13:26:08Z`, flag `/data/r2-disabled-70pct.flag`). Same failure
mode as 2026-08-04: Litestream multi-level LTX on `usage-monitor-prod-v3`, not
dashboard traffic. Live DB ~0.87 GiB; R2 held **8.92 GiB / 157 objects**.

| Prefix | GiB | objects |
|--------|-----|---------|
| ltx/0001 | 2.88 | 74 |
| ltx/0002 | 2.83 | 19 |
| ltx/0003 | 2.81 | 13 |
| ltx/0009 | 0.40 | 1 |
| ltx/0000 | ~0 | 50 |

GraphQL account total ~9.86 GiB (includes laggy ghost ~0.67 GiB on empty
`usage-monitor-bucket`). Class A MTD ~9.5% (fine). Ops cost was **storage**.

## Immediate ops (executed)

Tip-prune: keep newest max-txid `.ltx` per level; delete the rest.

- **Before:** 157 objects, **8.922 GiB** (89.2%)
- **After:** 5 objects, **0.405 GiB** (4.0%)
- **Deleted:** 152 objects, **8.517 GiB**

Kill flag left for deploy of resume path; auto-resume + litestream restart land
in this change.

## Root cause

`snapshot.retention: 24h` + `sync-interval: 1h` keeps **all** multi-level LTX
younger than 24h. Compaction writes ~0.4 GiB intermediates at L1/L2/L3 every
few hours → free tier fills in under a day. Kill stops writes but does not
delete objects; without tip-prune, resume re-breaches quickly. Prior 24h
ListObjects cache while killed also blocked auto-resume after external prune.

## Code / config

| Change | Why |
|--------|-----|
| `litestream.yml` retention **24h → 6h**, sync **1h → 2h** | Shallow DR window; fewer LTX generations |
| `planLtxTipPrune` + soft prune at **50%** absolute | Delete non-tip LTX before 70% kill |
| Live list cache while killed **24h → 1h** | External prune visible for auto-resume |
| `start-with-litestream.sh` watcher **restarts** litestream when kill clears | Flag clear alone left replica dead until bounce |

## Verify

```bash
npx vitest run src/lib/__tests__/r2-usage.test.ts
# live R2 (sizes only): objects=5, ~0.4 GiB
```

## Host follow-up

1. Deploy this branch (auto-deploy on main).
2. Confirm kill flag cleared (auto-resume when live &lt; 65%) and litestream
   process running (`replica sync` logs; probe not `r2_free_tier_disabled`).
3. Optional: prune `/data/.deploy-backups` to policy (1 deploy backup max) —
   local disk, not R2.
