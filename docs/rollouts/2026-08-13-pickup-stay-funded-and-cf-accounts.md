# Pickup: hide LLM stay-funded + fourth Cloudflare account

## Context & Objective

Monet/Claude hit quota mid-pickup.  Owner leftover: (1) LLM-connected accounts should not present "Must stay funded"; (2) add all 3-4 Cloudflare accounts to Usage Monitor.  Usage.Jays.Services already had its own account id.  The missing dashboard account was the legacy **jay** account.

## Changes Made

- Hide the "Must stay funded" checkbox for built-in `LLM/AI` providers.  Saving those rows forces `mustKeepFunded=false` so a leftover check from a previous selection cannot stick.  `PUT`/`POST` still accept `mustKeepFunded=true` so the owner can turn it back on later without a schema change.
- Add a fourth R2/Platforms fleet slot `old` labeled **Jay (Old)**, keyed by `CLOUDFLARE_OLD_ACCOUNT_ID` (fleet token first).  Existing UM/ST/CT slots unchanged.  `CLOUDFLARE_JAY_*` remains the historical alias for **Usage.Jays.Services**, not the jay account.
- Wrote Infisical UM prod `CLOUDFLARE_OLD_ACCOUNT_ID` (len 32, `2543…8c73`).  Did not mint a Cloudflare token.  The existing `CLOUDFLARE_FLEET_API_TOKEN` already authenticates that account.

Touched:

- `src/lib/provider-funding-policy.ts`
- `src/components/AddProviderModal.tsx`
- `src/lib/r2-usage.ts`
- `src/lib/platform-status/probes/edge.ts`
- `src/lib/platform-status/probes/storage.ts`
- `src/lib/__tests__/provider-funding-policy.test.ts`
- `src/lib/__tests__/r2-usage.test.ts`
- `src/lib/__tests__/platform-status-edge.test.ts`
- `src/lib/__tests__/platform-status-storage.test.ts`
- `src/lib/__tests__/operations-health.test.ts`
- `src/components/__tests__/AddProviderModal.test.ts`
- `STATUS.md`
- `docs/EFFORT-LOG.md`

## Decisions & Trade-offs

- Do **not** API-block re-enabling stay-funded.  Owner: hide/disable the option for now.  Do not cage a later change of mind.
- Do **not** reuse `CLOUDFLARE_JAY_ACCOUNT_ID` for the jay account.  That name already points at Usage.Jays.Services in prod and feeds the UM kill-switch.
- Four-account Platforms cards can produce 7 raw metrics.  `MAX_PLATFORM_METRICS=6` still slices Token Expiry off.  Per-account status is more important than expiry on that card.
- The `cool-mouse-73d2` token in `~/.secrets/cloudflare.json` is a broad write token scoped to jay.  Not copied into Infisical.  Fleet read token is enough to verify the account.

## Verification State

```
npx vitest run src/lib/__tests__/provider-funding-policy.test.ts \
  src/lib/__tests__/r2-usage.test.ts \
  src/lib/__tests__/platform-status-edge.test.ts \
  src/lib/__tests__/platform-status-storage.test.ts \
  src/lib/__tests__/operations-health.test.ts \
  src/components/__tests__/AddProviderModal.test.ts
npx tsc --noEmit
```

81 targeted tests green (plus 14 storage).  `tsc --noEmit` clean.  Infisical `has CLOUDFLARE_OLD_ACCOUNT_ID` is yes.  Length 32.

## Next Steps & Blockers

- Coolify must rebuild after merge so Infisical injects `CLOUDFLARE_OLD_ACCOUNT_ID`.  Auto-deploy on main should do that.
- No token missing for the four dashboard accounts.  All four are visible on `GET /accounts` with the fleet token: Usage.Jays.Services, SocraticTrade.com, Congress.Trade, jay.

## Zero-Code Findings

Cloudflare dashboard accounts (fleet token `GET /accounts`):

| Label | Account | Already in UM slots? |
|---|---|---|
| Usage.Jays.Services | `3a93…d1b7` | yes (UM / JAY / R2_USAGE) |
| SocraticTrade.com | `94ec…2e79` | yes (ST) |
| Congress.Trade | `0e9f…1ae9` | yes (CT) |
| jay (Old) | `2543…8c73` | **no — added this pickup** |
