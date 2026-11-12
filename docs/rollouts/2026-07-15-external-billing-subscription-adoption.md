# Automatic authoritative billing subscription adoption

Date: 2026-07-15

## Outcome

Fresh provider billing can create a linked, single-term local `Subscription` without an initial
manual Cloudflare row. Auto-adoption is provider-neutral, defaults off, and does not convert a
complete provider collection into charge authority.

## Authority and eligibility

`AdapterExternalBillingSync.authoritative` remains only the complete-list/pruning contract. The
adapter must separately set `paidRecurringAuthoritative=true` on the exact paid recurring record;
the persisted field defaults false. Cloudflare marks only paid, positive USD subscription records.
Apify additionally requires `isPaying === true`; false, null, or unavailable never authorizes a
charge.

The marked record must also be fresh, current, known-live, `plan|subscription`, explicitly
`canonical`, named, and use `renewal|period_end` date semantics. Its positive USD amount must be an
exact minor-unit value. Its explicit start/end must equal exactly one weekly, monthly, quarterly,
or annual cadence period; short/long periods are rejected, while normal UTC month-end clamping is
accepted.

Any positive `ProviderPlan.fixedMonthlyCostUsd` blocks adoption, regardless of amount, until the
owner performs an explicit migration/reconciliation. Existing manual or linked subscriptions and
any second eligible record with the same provider/cadence/amount guard also block adoption.

## Single-term lifecycle

Auto-created rows have `externalBillingManaged=true` and `autoRenew=false`. They authorize only the
observed term. Maintenance pauses or cancels managed rows when the record becomes stale, terminal,
ineligible, or is authoritatively removed. A fresh exact next period on the same external identity
updates the managed schedule and materializes once; the previous watermark prevents replay. A
`dateKind=period_end` row therefore never implies another term.

Owner-created and manually linked subscriptions remain unmanaged. Any dashboard edit to an
auto-managed row relinquishes management so later maintenance cannot overwrite the owner's choice.

## Races and failure behavior

Adoption executes as one SQLite transaction. It obtains the writer lock, re-reads providers,
external records, plans, and subscriptions, then reconciles/adopts. This closes preflight races with
manual creation and external cancellation/deletion. A nullable unique `externalAdoptionGuardKey`
claims eligible authoritative provider/cadence/amount shapes for auto-managed rows and for owner
rows explicitly linked to that exact external source + ID. Unlinked same-shape rows keep a null
guard and remain additive because amount/cadence/window cannot establish service identity. The
unique external-identity link plus the writer-locked recheck closes exact-link races without
silently suppressing legitimate same-price services.

Any unexpected candidate/stage error rolls back the whole adoption transaction. Maintenance
reports the adoption stage degraded and unhealthy, but still materializes existing subscriptions,
rolls renewals, applies retention, and delivers alerts.

## Accounting

Adoption immediately precedes materialization under one scheduler admission lease. Exact external
identity and exact period matching dedupe the materialized fixed term from a provider snapshot's
`fixedCostIncludedUsd`, so the current Cloudflare term contributes once.

When a fresh authoritative row corrects an already-materialized managed term, adoption verifies
the deterministic local charge's provider, identity, exact window, amount, and subscription
metadata before storing an `ExternalBillingChargeCorrection`. The proof is keyed to the immutable
original charged period plus the corrected charge shape, not the provider's mutable current term.
It therefore survives a process stop before collision settlement, later provider rollover/source
staleness, and managed-subscription edits or deletion. Collision settlement requires an
owner-managed row whose declared source + external ID exactly matches the proof; missing,
different, ambiguous, or auto-managed identity fails open and materializes. Budget reconciliation
still replaces only the exact proven event represented by the fixed snapshot, independently of an
owner link; unrelated subscription events remain additive. Stale, weak, or inexact evidence cannot
establish a new proof.

## Verification coverage

- Cloudflare auto-adoption, current-term materialization once, and fixed snapshot dedupe
- explicit per-record authority and Apify `isPaying` true/false/null behavior
- cancellation, authoritative deletion, staleness, `period_end`, and fresh next-term lifecycle
- every-positive-ProviderPlan suppression, including unequal values
- exact weekly/monthly/quarterly/annual periods, short-period rejection, and month-end clamping
- overlapping same-cadence prevention and same-guard/different-period ambiguity
- owner POST/PUT guard assignment only for exact external identity, with unlink clearing and exact relink restoring it
- charged same-period amount/name/cadence/end corrections preserve historical terms/guard and pause
- corrected fixed-cost snapshot dedupe (`$5` historical event + `$6` correction = `$6`, not `$11`)
- exact owner-linked collision settlement suppresses a duplicate without mutating owner terms
- missing identity, a different same-price/cadence/window service, and auto-managed replacement all remain additive
- rollover-safe suppression transactionally watermarks the manual planned period proven settled by durable exact-event correction proof
- crash before settlement followed by provider rollover still suppresses only the proven prior collision
- later provider amount/cadence changes cannot release that settled period as a delayed event
- initial settlement requires fresh/live/canonical/exact authority and matching full provider/managed/manual windows
- stale, terminal, and already-rolled same-price evidence cannot silently settle a manual period
- multi-period plans materialize non-overlapping inputs chronologically before the overlap watermark advances
- a true manual reanchor to the provider's next period remains independently billable
- downward fixed correction dedupe (`$5` historical event + `$4` correction = exactly `$4`)
- upward/downward correction dedupe remains stable after source staleness and managed-row deletion,
  without subtracting unrelated subscription spend
- exact USD cents, explicit `5.004`/`5.006` rejection, and manual near-cent ambiguity
- deterministic two-client manual-before-lock, manual-after-lock, cancel, and delete races
- whole-transaction rollback on candidate failure
- adoption-degraded continuation through existing materialization/renewal/retention/alerts
- same-price manual subscriptions remain allowed without external charge authority

The remediated local commit passed `npm run verify`: ESLint, TypeScript, 89 test files / 784 tests,
additive migration safety including Litestream preservation and destructive-change refusal, SQLite
backup/startup checks, and the production build. The hostile-review HOLD remains in force until
independent re-review. No production mutation, push, PR, merge, or deployment is allowed before
that verdict.
