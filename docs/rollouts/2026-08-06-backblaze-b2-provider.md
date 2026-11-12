# Rollout: Backblaze B2 provider (web + iOS Local)

## Context & Objective

After fleet B2 buckets and scoped keys were created for offsite backup (Hetzner cutover), Usage Monitor needed a first-class connector so storage footprint and estimated storage spend are visible next to Hetzner/Coolify/Cloudflare — on both the web app and the Local iOS poll path.

## Changes Made

- Builtin provider `backblaze` (Infrastructure):
  - Adapter inventories buckets (`b2_list_buckets`) and file versions (`b2_list_file_versions`, including hidden versions that still bill).
  - `totalRequests` = whole megabytes of storage (soft cap via existing request-limit budgets).
  - `totalCost` = public catalog storage price × billable GB (after free allowance) × UTC month fraction, with `costCoverageCaveat` (not an invoice).
  - Download / Class A-B transaction spend is explicitly out of scope; console Caps & Alerts remain the hard protection layer.
- Credentials: Application Key ID + Application Key, or combined `keyId:applicationKey`. Prefer the dedicated read-only key `fleet-usage-monitor-readonly` (not write backup keys).
- Infisical auto-sync mapping for `BACKBLAZE_*` / `B2_MONITOR_*` shared secrets.
- iOS Local: `BackblazeAdapter`, catalog entry, `canFetch` / registry wiring; `LocalHTTP.postJSON` for Native API POSTs.

### Touched files

- `src/lib/adapters/backblaze.ts` (new)
- `src/lib/adapters/__tests__/backblaze.test.ts` (new)
- `src/lib/adapters/index.ts`
- `src/lib/provider-definitions.ts`
- `src/lib/provider-integration-catalog.ts`
- `src/lib/provider-identity.ts`
- `src/lib/infisical-provider-sync.ts`
- `src/lib/__tests__/provider-definitions.test.ts`
- `.env.example`
- `ios/.../SimplePollAdapters.swift`
- `ios/.../LocalProviderCatalog.swift`
- `ios/.../LocalRecords.swift`
- `ios/.../LocalAppModel.swift`
- `docs/EFFORT-LOG.md`, `docs/rollouts/…`

## Decisions & Trade-offs

- **Estimate, not invoice** — same honesty model as Hetzner catalog MTD. B2 has no public invoice API.
- **list_file_versions** (not names) so hidden lifecycle versions still count toward storage.
- **Read-only monitor key** created at account scope (`listBuckets` + `listFiles` + retention/encryption read). Secrets live in `~/.secrets/backblaze-monitor.env` (chmod 600); do not put write keys into UM.
- **Soft caps in-app** via `storageCapGb` config + ProviderPlan request limit (MB) + monthlyBudgetUsd; **hard caps** stay in Backblaze Caps & Alerts UI (no public API).
- Default poll interval 360 minutes — inventory is Class C (free) but large buckets are multi-page.

## Verification State

```bash
npx vitest run src/lib/adapters/__tests__/backblaze.test.ts \
  src/lib/__tests__/provider-definitions.test.ts \
  src/lib/__tests__/provider-integration-catalog.test.ts \
  src/lib/adapters/__tests__/provider-routing.test.ts \
  src/lib/__tests__/provider-identity.test.ts
npx tsc --noEmit
```

## Next Steps & Blockers

1. Seed Infisical UM shared project with `BACKBLAZE_APPLICATION_KEY_ID` + `BACKBLAZE_APPLICATION_KEY` from `~/.secrets/backblaze-monitor.env` so prod auto-creates the provider row.
2. Owner: set Caps & Alerts in Backblaze console (storage / download / Class A-B) if not already.
3. Optional: wire ST/CT/UM litestream to B2 endpoints (separate effort; this PR is monitor-only).
4. UptimeRobot indicators + ST integration (still pending from earlier ops list).

## Zero-Code Findings

- Live smoke with the new monitor key listed 4 empty EU buckets (`jays-*-eu`) successfully.
