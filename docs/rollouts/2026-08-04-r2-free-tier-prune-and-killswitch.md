# R2 free-tier breach: prune, kill-switch, Garage-gone docs (2026-08-04)

## Context & objective

Owner received a Socratic.Trade multi-account R2 alert for **Usage Monitor**
storage at 9.33 GiB (then ~10.5 GiB). Clarifications:

1. **Coolify-hosted Garage is gone** — production litestream is **Cloudflare R2**
   (`usage-monitor-bucket` on the Jay account), not Garage-on-Coolify.
2. Alerts about UM R2 must come **from Usage Monitor** via
   `PUSHOVER_USAGE_API_TOKEN`, not rely on Socratic noticing.
3. Kill-switch/pause like ST; explain the “sudden” spike with no UI use;
   **delete old LTX on the bucket**.

## Why storage spiked without “using” the app

Litestream uploads continuously from Oracle `/data/prod.db` whenever the app
writes (cron, peer telemetry ingest, maintenance). Level-`0009` full-DB LTX
objects are ~0.37 GiB each. On 2026-08-04 ~00:00–02:00Z the bucket climbed
~4 GiB → ~10.5 GiB in two hours because **dozens of full-size LTX files** were
written — not dashboard traffic. Snapshot retention was still **168h**.

## Why the in-app kill-switch did not fire first

`src/lib/r2-usage.ts` already existed, but Infisical `usage-monitor` prod had
**S3 write credentials only** — no `CLOUDFLARE_JAY_API_TOKEN` /
`R2_USAGE_API_TOKEN` for GraphQL analytics. Without metrics the check skips
auto-disable (`metricsSource: unavailable`). Socratic’s peer monitor had the
Jay analytics token and alerted instead.

## Changes made

### Ops (executed same day)

- Listed R2 `usage-monitor-bucket` via Infisical-sourced S3 keys (values never
  logged).
- **Pruned LTX:** kept newest tip object per level (`0000`…`0009`); deleted
  **1361** objects, **~9.78 GiB**. After: **5** objects, **~0.74 GiB**.

### Code / config

- `litestream.yml`: `snapshot.retention` **168h → 48h**.
- `src/lib/r2-usage.ts`: prefer `PUSHOVER_USAGE_API_TOKEN`; clearer kill-switch
  resume text; `clearR2AutoDisable()`; set `LITESTREAM_ACTIVE=false` on kill.
- `scripts/start-with-litestream.sh`: Garage-retired messaging; resume hints.
- Docs: `docs/litestream.md` rewrite (R2 prod, Garage gone), `DEPLOY.md`,
  `.env.example`.
- Tests: prefer USAGE pushover token.

### Infisical (operator)

Must set (if still missing) for auto-kill + UM-owned alerts:

- `CLOUDFLARE_JAY_API_TOKEN` (or `R2_USAGE_API_TOKEN`) — Account Analytics Read
- `PUSHOVER_USAGE_API_TOKEN` (optional if `PUSHOVER_API_TOKEN` already works)
- Optionally `LITESTREAM_EMERGENCY_DISABLE=true` until the next deploy is live
  and storage is confirmed under 70% after re-seed

## Verification

```bash
# local
npx vitest run src/lib/__tests__/r2-usage.test.ts
# R2 after prune (sizes only)
# objects≈5, ~0.74 GiB
```

## Next steps

1. Land this PR; Oracle auto-deploy.
2. Confirm Infisical analytics + USAGE pushover tokens.
3. After deploy, either engage kill flag until re-seed is controlled, or watch
   first litestream re-seed so free tier is not re-breached.
4. Optional: remove or demote Socratic multi-account UM alerts (UM is now SoT).
