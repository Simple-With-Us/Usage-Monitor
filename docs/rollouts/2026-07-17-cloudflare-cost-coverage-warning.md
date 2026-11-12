# Cloudflare cost coverage gap warning

Date: 2026-07-17

## The gap

The owner found a Cloudflare bill over $1,000 (D1 Rows Written alone: $1,153) that the usage-monitor
dashboard never surfaced. It only ever showed the ~$5-10/mo Workers Paid flat subscription fee.

Cloudflare exposes three billing surfaces, and only two of them were ever wired into
`src/lib/adapters/cloudflare.ts`:

1. Fixed subscriptions (`/subscriptions`) - reliable, this is the $5-10/mo the owner saw.
2. PayGo metered usage (`/paygo-usage`) - this is where D1/R2/Queues/Workers-CPU overage actually
   lives. Cloudflare's own docs call it "a billing-grade alpha endpoint... restricted to select
   self-serve accounts."
3. Optional D1/R2/KV/Queue config fields, which are explicitly metadata-only presence probes
   (`src/lib/provider-integration-catalog.ts:378-384` and the AddProviderModal help text) and were
   never wired to compute cost.

When PayGo 403/404s or returns Cloudflare error code 10000, the adapter correctly falls back to
subscription-only `totalCost` rather than failing the whole provider - that part is reasonable. The
bug was that the miss was recorded only in `rawData.paygoBillingCapability.available = false` and
`rawData.billing.capabilities.usageOverageCost = false`, and nothing in `src/components/*.tsx` ever
read `rawData` or those capability fields. There was no visible signal anywhere in the dashboard
that Cloudflare's usage-based cost was unknown vs. fully known. The owner's real Cloudflare account
(Congress.Trade's D1 database `congress-feed-db`) has this exact gap live in production right now.

## The fix

This is a visibility-only fix - it does not touch `totalCost`/`fixedCostIncludedUsd` math.

**Generic concept, Cloudflare-only wiring.** `UsageResult` (`src/lib/adapters/helpers.ts`) gains an
optional `costCoverageCaveat?: { code: string; message: string } | null` field. The name and shape
are adapter-agnostic on purpose - any adapter can set it later when it can name a specific missing
cost surface. Only `src/lib/adapters/cloudflare.ts` populates it in this change: when the PayGo call
did not succeed (403/404, error 10000, or a transport failure) AND a fixed subscription cost was
found (`totalCost != null`), it sets
`{ code: "cloudflare_paygo_usage_unavailable", message: "Usage-based costs (D1, R2, Workers, Queues
overage) are not visible for this account — only the fixed subscription fee is shown. Cost may be
understated." }`. It is deliberately NOT set when PayGo succeeded (even with legitimate $0 usage) or
when there is no subscription data either (`totalCost` stays null, which is the separate
already-handled "unconfigured" state).

**No schema migration.** `rawData` is already a JSON blob column, and `usage-recorder.ts` already
has a precedent for stashing app-owned metadata inside it: `snapshot-sync-status.ts`'s
`__apiUsageMonitor` bag, previously used only for `partialFailure`. This change adds
`withCostCoverageCaveat`/`snapshotCostCoverageCaveat` to that same file, writing/reading a
`costCoverageCaveat` key inside the same bag. `usage-recorder.ts` composes it with the existing
`withSnapshotSyncFailure` call so both metadata kinds land in one object instead of one clobbering
the other. A first-class `UsageSnapshot` column was considered and rejected: the value is
adapter-optional, small, and already has a proven additive-JSON precedent in this codebase, so a
migration would add risk for no benefit.

**Derived server-side in the API route.** `src/app/api/providers/route.ts` and
`src/app/api/providers/[id]/route.ts` already select `rawData` from the latest snapshot (previously
only used for Gemini-specific status derivation) but never sent it to the client. Both routes now
call `snapshotCostCoverageCaveat(latestSnapshotWithRawData?.rawData ?? null)` and expose the result
as a new top-level `costCoverageCaveat` field on the provider object, parallel to the existing
`spendCoverage`/`pushedCostCoverage` fields rather than nested inside the already-widely-typed
`latestSnapshot` shape. No raw `rawData` blob is ever sent to the client - only this one derived,
sanitized field.

**Own, clearly-labeled UI treatment.** `costCoverageCaveat` is intentionally a distinct signal from
`spendCoverage`/`pushedCostCoverage` (pushed-telemetry pricing completeness, existing amber/emerald
"Complete/Partial/Unknown" badge) and must not be conflated with or overwrite it - a provider can
show "Complete" spend coverage and still carry a cost coverage caveat, since the *known* fixed cost
really is fully known; it's a *different, unmeasured* cost surface that's missing. It gets its own
orange banner/badge with an `AlertTriangle` icon and the literal caveat message, always rendered
inline (never behind a collapsed/expand click):

- `ProviderCard.tsx`: an orange banner ("Cost coverage gap: ...") below the existing blue
  provider-billing banner. Note: as of this change, `ProviderCard` is not mounted anywhere in the
  live app - `src/app/page.tsx`, `src/app/settings/page.tsx`, and
  `src/app/providers/[id]/page.tsx` only import its exported types, never its component (`grep -rn
  "<ProviderCard" src/` returns nothing on `main` or this branch). It is exercised solely by its
  own unit test. The banner is still added here to keep the component's props/rendering complete
  and ready if/when it is wired up, but it is not one of the currently-live UI surfaces.
- `ProviderTable.tsx`: an orange line inside the always-visible "Spend / Budget" cell (individual
  provider rows in this table are not collapsed by default; only the type-level group header is,
  same as before this change).
- `DashboardProviderWorkspace.tsx`: since PR #296 collapses each provider family's detail row by
  default, the badge lives in the family summary row itself (both `CompactFamilyCells` and
  `ComfortableFamilyCells`), aggregated as `ProviderFamily.costCoverageCaveatCount` /
  `costCoverageCaveatMessage`, so it is visible without expanding anything. A matching per-account
  note is also added to the expanded detail card for when a family has more than one account.

## Verification

- `npm run lint` - clean.
- `npx tsc --noEmit` - clean.
- `npx vitest run` - 99 files / 1019 tests passed, including:
  - `src/lib/adapters/__tests__/cloudflare.test.ts`: three new cases - caveat set when PayGo is
    unavailable and a subscription cost is known; not set when PayGo succeeds (even at $0); not set
    when there is no subscription cost either.
  - `src/components/__tests__/ProviderCard.test.ts`, `ProviderTable.test.ts`,
    `DashboardProviderWorkspace.test.ts`: renders-present / renders-absent pairs, plus a
    workspace-level assertion that the family-row `Spend` cell (not the hidden detail row) contains
    the "Cost coverage gap" text with the family collapsed by default.
- `npm run test:migrate-safe`, `test:sqlite-backup`, `test:startup-config` - all pass (no schema
  change, as expected).
- `npm run build` - production build succeeds.

No existing test was weakened.
