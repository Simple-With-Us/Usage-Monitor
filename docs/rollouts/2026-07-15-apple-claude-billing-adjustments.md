# Apple-billed Claude subscription adjustments (manual)

## Why (owner directive)

Two prior-tier Claude subscriptions were billed through Apple's in-app
purchase channel before the account moved to its current subscription tier.
Neither prior-tier charge, nor the pro-rated refund Apple issued when each
upgrade happened mid-cycle, ever reached this monitor: Apple billing has no
push/poll integration here, and the ordinary subscription materializer only
tracks the *current* tier (see `src/lib/subscription-materializer.ts`). The
owner directed these four historical events be recorded manually so June's
Anthropic spend/subscription figures reflect what was actually charged and
refunded, instead of silently omitting them.

## The four planned records

All four are `anthropic`, `metricType: "subscription"`, `sourceApp:
"manual-billing-adjustment"` (never the materializer's reserved
`"subscription"` sourceApp — see "Reserved source" below).

| Occurred (UTC) | Amount USD | Confidence | Label |
| --- | --- | --- | --- |
| 2026-06-13 | +21.45 | actual | Claude Pro Monthly (prior tier, Apple) |
| 2026-06-16 | +124.99 | actual | Claude Max 5x Monthly (prior tier, Apple) |
| 2026-06-16 | -19.15 | estimated | Pro-rated upgrade refund |
| 2026-06-21 | -104.16 | estimated | Pro-rated upgrade refund |

Net: `21.45 + 124.99 - 19.15 - 104.16 = +23.13` added to Anthropic's June
subscription spend on top of whatever the current-term subscription already
charges.

## Where the amounts came from

- The two **positive** charges (`+21.45`, `+124.99`) are copied directly from
  the Apple receipts for the Claude Pro Monthly and Claude Max 5x Monthly
  purchases — hence `confidence: "actual"`. These are historical facts, not
  estimates.
- The two **negative** refunds are day-count proration *estimates*, not
  amounts read off a refund receipt — hence `confidence: "estimated"`
  (validated and stored as such; nothing here is silently upgraded to
  `"actual"`):
  - `-19.15 = 21.45 × 25 / 28` — the Claude Pro Monthly charge, prorated for
    the 25 of 28 remaining days in that billing cycle at the moment of
    upgrade.
  - `-104.16 = 124.99 × 25 / 30` — the Claude Max 5x Monthly charge, prorated
    for the 25 of 30 remaining days in that billing cycle at the moment of
    upgrade.

  Apple's actual refund line-item amount was not available to reconcile
  against; the proration formula is the best evidence-based estimate and is
  labeled accordingly end to end (ingest `confidence`, script `metadata.estimate:
  true`, and this document).

## What surfaces show them

- **`GET /api/budget-status` (the dashboard's data source) is month-scoped.**
  `computeBudgetStatus` sums `metricType: "subscription"` events from the
  *current* UTC month start forward (`src/lib/budget-status.ts`,
  `sumMonthToDateExternalCostByProvider`). All four events occurred in June
  2026, so they are visible in a June computation and **invisible** once the
  wall clock rolls into July — same as every other historical event in this
  app. There is no dashboard toggle to view a past month; this is expected,
  pre-existing behavior, not a gap introduced by this feature.
- **`GET /api/usage-events?days=<n>` is a rolling long-horizon summary** (up to
  365 days, `src/app/api/usage-events/route.ts`). Querying with a large enough
  `days` value from any point after June 2026 will surface all four events
  (grouped under `sourceApp: "manual-billing-adjustment"`, `provider:
  "anthropic"`).
- **Any ad hoc June-window computation** — a direct `ExternalUsageEvent` query
  bounded to June, or re-running `computeBudgetStatus` with `now` frozen inside
  June — sees them, exactly like the money-math test does (see below).

## Double-count analysis

- **No existing `Subscription` row represents either prior tier.** The
  `Subscription` table only ever held the *current* tier; Claude Pro Monthly
  and the mid-cycle Claude Max 5x Monthly purchase were never entered as
  `Subscription` rows, so there is no materializer-owned
  (`sourceApp: "subscription"`) `ExternalUsageEvent` for either of them to
  collide with. The four manual events are the *only* record of those two
  historical charges anywhere in the system.
- **The current-term `Subscription` row and its materialized charges are
  untouched.** This feature does not modify `subscription-materializer.ts`,
  does not delete or edit any `Subscription` row, and the manual events use a
  distinct `sourceApp` (`manual-billing-adjustment`, never the reserved
  `subscription`) with their own idempotency keys, so they cannot collide with
  — or get deduped against — the current subscription's ongoing monthly
  charge.
- **Composition is additive, not clamped.** `fixedAccruedUsd` in
  `budget-status.ts` is `fixedMonthlyCostUsd + pushed.subscriptionPushed +
  snapshotFixedCostIncludedUsd - linkedFixedDedupeUsd` — a plain sum, not a
  `Math.max(...)`. `pushed.subscriptionPushed` itself is an additive sum over
  every `metricType: "subscription"` event for the provider regardless of
  `sourceApp` (`sumMonthToDateExternalCostByProvider` in
  `src/lib/external-usage-events.ts`). The two refund events therefore
  genuinely *reduce* Anthropic's June spend rather than being floored at zero
  or dropped — verified by
  `src/lib/__tests__/manual-subscription-adjustments.test.ts`, which persists
  all four events through the real ingest validation path
  (`usage-telemetry.ts` parsing + `persistExternalUsageEvents`) alongside a
  materialized current-term charge, and asserts the net `+23.13` lands in both
  `subscriptionMonthToDateUsd` and `spentUsd` — with an explicit assertion
  that the total is *not* what it would be if the negatives were swallowed by
  a clamp.

## Reserved source / validation notes

- `sourceApp: "subscription"` (`SUBSCRIPTION_SOURCE_APP`,
  `src/lib/subscription-charge-identity.ts`) is reserved for the internal
  materializer, which writes directly via `persistExternalUsageEvents` and
  never goes through `POST /api/ingest/usage`. The ingest route rejects any
  event that claims that `sourceApp`, so a manual import can never forge a
  materializer-owned charge that `budget-status.ts` cross-references via
  `metadata.subscriptionId`. See `src/app/api/ingest/usage/route.ts` and its
  tests.
- Negative `costUsd` is accepted by the ingest route **only** when
  `metricType === "subscription"` (`src/lib/usage-telemetry.ts`'s
  `readNumber`). Every other metric type, and every other numeric field
  (`quantity`, `credits`, `limit`, `requests`), remains non-negative. This is
  why the refund events must be `metricType: "subscription"` — the same
  metric type recurring subscription charges already use.
- A negative subscription `costUsd` is additionally bounded in magnitude —
  see "Negative-magnitude bound" below.
- A negative-`costUsd` event cannot be receipt-cash-shaped: the script always
  sets `sourceApp: "manual-billing-adjustment"` and never sets `service:
  "api-prepaid-funding"` or `label: "receipt_cash_paid"` (`src/lib/receipt-cash.ts`'s
  trigger fields), so `looksLikeReceiptCashEvent` never matches these events.
  Even if it did, `verifyReceiptCashEvent` requires `metricType === "cost"`
  and `costUsd > 0`, so a forged receipt-shaped negative-subscription event
  is rejected regardless — see the route test
  `"rejects a negative-cost subscription event that is shaped like a
  receipt-cash event"`.

## Review remediation (P3 findings, 2026-07-16)

Two P3 findings from PR review were fixed on top of the original design
above. Both guards are general (they protect every provider, not just
Anthropic's June events), but are documented here because this feature is
what motivated them.

### Fixed-cost dedupe isolation (`src/lib/budget-status.ts`,
`src/lib/external-usage-events.ts`)

The original design note above states `pushed.subscriptionPushed` is an
additive sum "over every `metricType: 'subscription'` event for the provider
regardless of `sourceApp`" and that composition into `fixedAccruedUsd` is a
plain sum, not `Math.max(...)`. Both statements are still true, but they
missed a second reconciliation `budget-status.ts` performs for providers that
*also* have a fixed-cost-included poll snapshot (`UsageCostSnapshot.
fixedCostIncludedUsd`) linked to a materialized subscription charge (e.g.
Cloudflare-style `ProviderExternalBilling`-adopted subscriptions): `
linkedFixedDedupeUsd = Math.min(pushed.subscriptionPushed,
linkedMaterializedFixedUsd)` cancels out the double-representation of that
one linked charge between the snapshot and the push channel.

That `Math.min()` was computed against the *total* `pushed.subscriptionPushed`
pool — which a manual adjustment on the same provider/month also feeds. A
refund therefore shrank the pool the dedupe was min'd against, and the dedupe
shrank right along with it, silently cancelling the refund out of
`fixedAccruedUsd` instead of ever subtracting it. Concretely: snapshot
`fixedCostIncludedUsd = 124.99`, one linked materialized `$124.99` charge, a
manual `-50.00` refund → `fixedAccruedUsd` computed to `124.99` (the refund
vanished) instead of the correct `74.99`. A refund larger than the linked
charge made it worse: it drove the dedupe itself negative, which *added*
spend back instead of ever subtracting any.

Fix: `ProviderPushedCost` (`external-usage-events.ts`) now also tracks
`subscriptionPushedManualUsd` — the slice of `subscriptionPushed` contributed
by `sourceApp != SUBSCRIPTION_SOURCE_APP` (manual adjustments), accumulated
alongside the existing additive total in `sumMonthToDateExternalCostByProvider`'s
`add()`. `budget-status.ts` isolates the materializer-linked-only portion —
`Math.max(0, pushed.subscriptionPushed - pushed.subscriptionPushedManualUsd)`
— and dedupes *that* against `linkedMaterializedFixedUsd`, instead of the raw
manual-inclusive total. The `Math.max(0, ...)` clamp guarantees the dedupe
itself can never go negative, so it can never add spend back regardless of
how large a refund is. `subscriptionMonthToDateUsd` (the raw additive total)
is unchanged. Regression coverage:
`src/lib/__tests__/external-billing-subscription-adoption.test.ts` —
`"keeps a manual refund additive instead of letting the fixed-cost dedupe
cancel it out"` (the `124.99`/`-50.00`/`74.99` scenario above) and `"never
lets the fixed-cost dedupe add spend back when a manual refund drives the
subscription pool net-negative"` (a `-200.00` refund against the same
`124.99` charge, asserting `fixedAccruedUsd` lands at the correct `-75.01`
net credit and the dedupe stays non-negative); plus a
`sumMonthToDateExternalCostByProvider`-level unit test in
`src/lib/__tests__/external-usage-summary.test.ts` asserting the manual/
materializer split itself.

Anthropic has no `UsageCostSnapshot.fixedCostIncludedUsd` or linked
materialized billing in this rollout, so `linkedFixedDedupeUsd` is `0` for
every event here and this bug never affected the four events above — it only
manifests for providers that combine a fixed-cost snapshot *and* manual
subscription adjustments in the same month, which does not include Anthropic
today. The fix is general so it can't affect a future provider either.

### Negative-magnitude bound (`src/lib/usage-telemetry.ts`)

The original design permits any `USAGE_INGEST_TOKEN` holder to post a
negative-`costUsd` `metricType: "subscription"` event with no magnitude
limit. This app is single-owner with no per-caller scoping on that token, so
an unbounded negative amount is unbounded spend-erasure / budget-alert
suppression from anyone who has (or leaks) the token — proportionate for a
personal app, but worth bounding per event.

Fix: `MAX_NEGATIVE_SUBSCRIPTION_COST_USD = 1000` (`usage-telemetry.ts`).
Boundary semantics: this is the maximum magnitude a single negative
subscription `costUsd` may carry, **inclusive** — exactly `-1000` is
accepted, anything more negative (e.g. `-1000.01`) is rejected with a
dedicated error before the event reaches persistence. Positive amounts, and
every other metric type's already-unconditional non-negative check, are
unaffected. `$1000` comfortably covers the largest realistic single Apple/App
Store subscription-tier proration this channel is meant for (the events
above top out at `-104.16`) while bounding a single ingest call's blast
radius. Tests: `src/lib/__tests__/usage-telemetry.test.ts` (`-999.99`
accepted, `-1000` accepted at the inclusive boundary, `-1000.01` rejected,
and a large negative still rejected outright for every non-subscription
metric type regardless of magnitude) and an end-to-end pair in
`src/app/api/ingest/usage/__tests__/route.test.ts` exercising the same
boundary through `POST /api/ingest/usage`.

## Operator script usage

```bash
# records.json — chmod 600, kept outside the repo
npm run import:subscription-adjustments -- \
  --input /path/outside/repo/records.json \
  --provider-name anthropic
```

Dry-run is the default and makes no network calls; it prints a summary
(records, amounts, confidences, computed idempotency keys, net total). Apply:

```bash
USAGE_INGEST_TOKEN="$(cat /path/to/token)" \
npm run import:subscription-adjustments -- \
  --input /path/outside/repo/records.json \
  --provider-name anthropic \
  --apply --base-url https://usage.jays.services
```

`USAGE_INGEST_TOKEN` is read from the environment only — never accepted as a
flag, never printed. `--base-url` must be exactly
`https://usage.jays.services`, or a localhost URL passed with
`--allow-localhost` for local testing. `--provider-id` is optional and, unlike
`scripts/import-private-billing-receipts.mjs`'s receipt channel, is **not**
cross-checked by the server for plain events — the ingest route only verifies
a provider UUID/name pair for the dedicated receipt-cash channel. When
supplied here it is embedded in event `metadata.providerId` purely as an
operator provenance note.

Each record's `idempotencyKey` is derived deterministically from
(`--provider-name`, the record's own `externalId`), so re-running the script
against the same input is a no-op at the ingest route rather than a
duplicate charge.

## No new required environment variables

`--apply` reads the existing `USAGE_INGEST_TOKEN` (already required for any
plain-event ingest); nothing new is required to run this feature.
