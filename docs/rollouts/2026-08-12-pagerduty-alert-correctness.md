# 2026-08-12 — PagerDuty alert correctness: false Twilio discrepancies + two ways an incident could never resolve [CLAUDE]

## Context & Objective

PagerDuty incidents **#64 ($0.71)** and **#70 ($0.77)** were open on two distinct
Twilio provider rows, both `alert_code = usage_reconciliation_discrepancy`.  They
were not a Twilio problem and not a threshold problem: the reconciler was
comparing Twilio's real billed amount against pushed telemetry of **zero**,
because nothing pushes Twilio usage events at all.  Separately, two code paths
could leave a PagerDuty incident open **forever** even after its condition
cleared.  This lands all three fixes.

## Changes Made

### 1. Zero telemetry is "unverifiable", not a discrepancy

`src/lib/provider-usage-reconciliation.ts` — when `reportedEventCount === 0`, the
row is recorded with the module's existing `unverifiable` status instead of
computing a delta.  `verifiedCostUsd`, `deltaUsd`, and `deltaRatio` all stay
null, which is what keeps it silent: `provider-alerts.ts` raises
`usage_reconciliation_discrepancy` only when
`usageReconciliations[0].status === "discrepancy"` (see `budget-status.ts:1542`
and `alert-delivery.ts:2508`), so an unverifiable row cannot alert.

Threshold tuning was the wrong lever and is worth stating plainly: the
discrepancy is `verified - 0`, so the delta is always **100%** of the bill.  No
ratio tolerance below 1.0 absorbs it, and a tolerance of 1.0 disables the check
for every provider in the fleet.

Recovery is automatic.  The event count is recomputed from live data on every
pass and the row is upserted in place on
`(providerId, periodStart, periodEnd, keyRef)`, so the first pass after a
telemetry source comes online falls straight through to normal reconciliation —
no backfill, no manual reset.  There is a test for exactly that transition.

### 2a. `stale_snapshot` CLEAR now stamps the same watermark as ACTIVE

`src/lib/alert-delivery.ts`, `alertEvidenceTimes` — the active transition
persisted `at = providerSnapshotStaleAt(fetchedAt, refreshIntervalMin)` while the
clear reported `at = fetchedAt`, which is **strictly earlier**.  With the same
snapshot (equal `sourceAt`), `compareEvidence` therefore ranked the persisted
active watermark ahead of the clear candidate and rejected the resolution as
stale evidence.  The observable symptom is an error entry reading *"Alert
evidence is older than the durable incident watermark; stale transition
suppressed"*, no resolve event, and an incident that cannot close.

Both states now stamp the deadline, so `EVIDENCE_STATE_RANK` (`clear` > `active`)
breaks the tie in the resolution's favour — which is the ordering that rank
exists to express.  `state` became unused inside `alertEvidenceTimes` and was
dropped from its signature; `alertEvidence` still carries `state` onto the
evidence record.

This is not hypothetical for legacy rows: `stale_snapshot` is deliberately no
longer emitted (`provider-alerts.ts:243`), so any incident still open from before
that product decision has **resolve as its only correct next transition** — and
that was precisely the transition being suppressed.

### 2b. A hard-deleted provider can no longer orphan its incident

`ProviderAlertNotification.providerId` is `onDelete: Cascade`, so hard-deleting a
Provider destroys the open incident rows — dedup keys, incident generations, and
all.  The maintenance pass only looks at providers that still exist
(`alert-delivery.ts:2296`), so nothing could ever resolve what PagerDuty was
still holding.

New `resolveProviderAlertsBeforeDeletion()` in `src/lib/alert-delivery.ts` closes
the PagerDuty side first, using each incident's **own persisted dedup key** so
the resolve lands on the exact incident the trigger opened.  `DELETE
/api/providers/:id` calls it before `prisma.provider.delete`, and returns **409**
rather than knowingly stranding an incident.  `?force=true` is the operator
override; the success body then reports `strandedPagerDutyIncidents` instead of
hiding it.

Touched files:

- `src/lib/provider-usage-reconciliation.ts`
- `src/lib/alert-delivery.ts`
- `src/app/api/providers/[id]/route.ts`
- `src/app/settings/page.tsx`
- `src/lib/__tests__/provider-reconciliation-maintenance.test.ts`
- `src/lib/__tests__/alert-delivery.test.ts`
- `src/app/api/providers/[id]/__tests__/route.test.ts`

## Decisions & Trade-offs

**Status vocabulary reused, not extended.**  `unverifiable` already exists in this
module and is a first-class state in `provider-compliance.ts` and the provider
compliance UI, whose whole design rule is that an unverifiable provider is
labelled explicitly rather than reading as silently fine.  Zero telemetry fits
that meaning exactly.  No migration, no new enum value.

**Ordered after the `pending` branch, not before.**  A provider with no snapshot
yet stays `pending`; only a provider that *has* an authoritative bill and *no*
telemetry becomes `unverifiable`.  This keeps `pending`'s narrower meaning —
waiting on the poll — and preserves the existing assertion in
`provider-reconciliation-maintenance.test.ts`.  The alerting outcome is identical
either way, since neither status alerts.

**One existing test asserted the bug and was corrected.**  *"records a discrepancy
when provider-reported cost exceeds pushed telemetry"* seeded a snapshot with no
telemetry at all and asserted `reportedCostUsd === 0, deltaUsd === 100`.  It now
seeds real pushed usage ($10 reported vs $100 billed → $90 delta), which is what
the assertion's own name describes.  No tolerance was loosened and no assertion
was deleted.

**Deletion refuses rather than silently stranding.**  A 409 on a failed resolve is
a guardrail, so it ships with the override the fleet convention requires
(`?force=true`), not as an immovable block.  `src/app/settings/page.tsx` now
surfaces the server's `error` text instead of a generic "Failed to delete", so
all three delete refusals (attribution history, Infisical ownership, unresolvable
incident) are actionable in the UI.

**`resolveProviderAlertsBeforeDeletion` deliberately does not take the durable
operation claim.**  It reuses the maintenance path's exact "is this destination
owed a resolve" predicate and dedup-key derivation, but instead of competing for
the claim it **refuses** to act on an incident with a live operation/trigger/
resolve claim and reports it as unresolved.  Leases are short, so the honest
answer is "retry in a moment" rather than reimplementing ~200 lines of the claim
protocol at a call site where the rows are about to be deleted anyway.

## Residual gaps (stated, not hidden)

1. **Narrow re-trigger race on delete.**  Between the resolve and the
   `provider.delete`, a concurrent maintenance pass could re-open the incident at
   a new generation, and *that* incident would be stranded.  Sub-second window,
   single-instance production, and it degrades to an orphaned incident rather
   than anything unsafe.  Closing it fully needs the delete and the resolve under
   one durable claim.
2. **Non-PagerDuty channels get no deletion notice.**  Matches existing behaviour:
   `sendToChannelOnce` returns early for every non-PagerDuty channel on a resolve,
   because only PagerDuty holds durable incident state.
3. **`?force=true` really does strand.**  It is reported in the response body, but
   the operator owns closing that incident by hand.
4. **Legacy `pagerDutyAuditState = "legacy_unknown"` rows** still require a
   configured routing key; without one, deletion is refused (or forced) rather
   than guessing a dedup key.

## Verification State

Run with `PATH=/opt/homebrew/opt/node@24/bin:$PATH` (the Mac's default `node` is
v26; `better-sqlite3` is built for the Node 24 ABI this repo pins).

```
npm run lint                    # clean
npm run typecheck               # clean
npm test                        # 180 passed | 1 skipped (181 files), 2144 passed | 1 skipped
npm run test:receipt-inbox-worker   # pass
npm run test:migrate-safe           # pass
npm run test:sqlite-backup          # pass
npm run test:startup-config         # pass
npm run test:oracle-deploy          # pass
npm run test:apple-projects         # pass
npm run test:antigravity-collector  # pass
npm run build                       # pass
```

`npm run verify` additionally chains `npm run test:r2-archive`, which **exits 1 on
a dev Mac** — it needs `R2_ARCHIVE_ENDPOINT` / `R2_ARCHIVE_ACCESS_KEY_ID` /
`R2_ARCHIVE_SECRET_ACCESS_KEY` and writes to `/data/`.  Confirmed pre-existing:
stashing this branch's changes and running `node
scripts/test-r2-weekly-archive.mjs` on the clean `origin/main` base exits 1
identically.  `.github/workflows/ci.yml` does not run that script, so it does not
gate the merge.

Negative check on 2a (guarding against a vacuous test): reintroducing the
`state === "active"` condition makes the new test fail with exactly the
production symptom — `resolved: 0` plus *"Alert evidence is older than the durable
incident watermark; stale transition suppressed"*.

New coverage:

- zero telemetry → `unverifiable`, null delta, no alert
- non-zero telemetry → discrepancy and `ok` both still computed normally
- telemetry arriving later → same upserted row flips back to `ok` unaided
- cleared `stale_snapshot` → resolve event sent with the incident's exact dedup key
- provider deletion → resolve sent, then the cascade deletes nothing stranded
- deletion with a rejected resolve → reported unresolved, incident stays open, 409
- `?force=true` → deletes and reports `strandedPagerDutyIncidents`

## Next Steps & Blockers

- **PD #64 / #70 close on the next reconciliation pass after deploy.**  Both rows
  flip `discrepancy → unverifiable`, the alert disappears from the evaluated set,
  and the existing resolve path sends the resolve.  No manual PagerDuty action
  needed; if they are still open an hour after deploy, check the maintenance
  cron ran rather than re-tuning tolerances.
- Twilio remains genuinely unverified until something pushes Twilio usage events.
  That is now stated honestly on the provider's compliance summary instead of
  being laundered into a false discrepancy.  Wiring a Twilio telemetry producer is
  separate work and is the only thing that makes it verifiable.
- Residual gap 1 above is the only known correctness hole left in this area.
