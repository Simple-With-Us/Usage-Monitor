# 2026-08-14 — Four Cloudflare accounts as UM providers

## Summary

Owner: add all 3–4 Cloudflare accounts to Usage Monitor.  Usage.Jays.Services
has its own token (not ST, CT, or Old).

Live `Provider` table had **zero** cloudflare rows.  Platforms/R2 already had
four account-id slots in env.  Nothing polled.

Boot now seeds four builtin rows:

| Name | Display | Account env | Token preference |
|---|---|---|---|
| `cloudflare-usage-jays` | Cloudflare (Usage.Jays.Services) | `R2_USAGE_ACCOUNT_ID` / `CLOUDFLARE_JAY_ACCOUNT_ID` | `CLOUDFLARE_JAY_API_TOKEN` first |
| `cloudflare-socratic` | Cloudflare (Socratic.Trade) | `CLOUDFLARE_ST_ACCOUNT_ID` | ST then fleet |
| `cloudflare-congress` | Cloudflare (Congress.Trade) | `CLOUDFLARE_CT_ACCOUNT_ID` | CT then fleet |
| `cloudflare-jay-old` | Cloudflare (Jay Old) | `CLOUDFLARE_OLD_ACCOUNT_ID` | Old then fleet (Old token absent; fleet works) |

`mustKeepFunded` is not touched.  Retired kimi/oracle rows are not touched.

Existing rows are never force-activated.  The first missing-row pass creates
them; later ticks refresh account id / display name only and leave `isActive`
alone so a dashboard off-switch survives restarts.

## Files

- `src/lib/ensure-cloudflare-fleet-providers.ts`
- `src/lib/usage-recorder.ts` (boot hook)
- `src/lib/adapters/index.ts` (`cloudflare-*` → adapter)
- `src/lib/r2-usage.ts` (UJS token before fleet)

## Verification

Targeted vitest + CI verify on #1187 (2m43s).  Live `d674904` at 2026-08-14T05:00Z:
four ON Provider rows, first seed `created=4 updated=0 skipped=0`, scheduler
`lastRun.total=26` (22+4) with `successes=4`.
