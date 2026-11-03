# Alert-persistence corrective and config-generation fencing

## Summary

PR #204 (`56d532ec`) isolated an exact Prisma model/code timeout, but post-merge review showed that boundary still covered unsafe notification operations and that alert/channel state lacked durable fencing across external calls. A later reproduction found a separate ordering defect: disabling a provider resolved snapshot-based alerts with newer wall-clock evidence, so re-enabling against the same snapshot—or no snapshot—could not reopen them.

This isolated follow-up imports the corrective alert persistence implementation onto current main and adds a monotonic provider alert-config revision. Alert evidence is now the tuple `(config generation, source observation time, transition time, state)`, ordered lexicographically with `clear` winning an exact tie. Deliberate configuration transitions therefore supersede unchanged snapshot evidence without weakening stale-worker suppression. For `stale_snapshot`, source snapshot time is distinct from the deterministic stale deadline, so a newer snapshot always wins and the unchanged fresh snapshot can later recur as stale.

## Design

- `AlertNotificationSummaryPersistenceTimeout` is emitted only for exact `P1008` at the final CAS-protected notification summary write. Earlier notification/channel failures remain fatal or explicitly degraded according to the precise operation.
- Notification incidents, parent operations, channel triggers, and PagerDuty resolves use durable tokens, generations, incident IDs, and bounded leases. Activation evidence/payload mutation is atomic with parent acquisition. Child claims/outcomes, final summary, and close writes prove the exact config, source/transition evidence, severity/message, live parent, and open incident. Newer evidence may preempt a parent before a child claim, but a live exact child serializes the external boundary.
- Ambiguous non-idempotent sends remain unknown and are not blindly retried; PagerDuty uses a persisted per-incident dedup key and conservative legacy audit state.
- `Provider.alertConfigGeneration` and `ProviderAlertNotification.evidenceConfigGeneration` default to 0 for additive migration. `operationClaimConfigGeneration` binds each parent lease to the provider revision it evaluated.
- Provider active-state, refresh-interval, plan, API-key, public/secret config, and secret-clear writes increment the revision inside the same provider update. Renewal roll-forward uses one Prisma transaction for the conditional plan write plus revision increment. Ag***-s**c auto-disable and the Anthropic funding repair also increment atomically.
- Rebase onto #209 retains `providerPollSnapshotExpected`, including the rule that Anthropic snapshot alerts require stored Admin API capability. Capability transitions therefore share the same revision fence as every other alert-affecting edit.
- Activation checks the provider revision before and after first creation; every later notification CAS includes the provider relation revision. Trigger/resolve claims and outcomes, summary, and close writes carry the same fence.
- Raw alert activity remains independent from minimum-severity delivery policy, preventing policy changes from falsely resolving an incident.
- A later pass can CAS-repair `lastSentAt` and `sendCount` from complete durable channel success after a final-summary P1008, without repeating the external send.
- Reopened `firstDetectedAt`/`lastDetectedAt` are floored against cycle time, actual claim clock, source/transition evidence, prior detection, and prior resolution.
- The startup-index test closes its fixture Prisma connection before spawning startup DDL and reports bounded sanitized child diagnostics on strict nonzero-status failures, preventing test-only SQLite contention without changing application behavior.

## Files changed

- `prisma/schema.prisma`
- `src/lib/alert-delivery.ts`
- `src/lib/usage-maintenance.ts`
- `src/lib/usage-recorder.ts`
- `src/app/api/providers/[id]/route.ts`
- `src/lib/provider-renewals.ts`
- `src/lib/ensure-ag***-s**c-provider.ts`
- `scripts/repair-anthropic-funding.mjs`
- alert, maintenance, migration, provider-route, renewal, ag***-s**c, and adapter tests/fixtures
- `PLAN.md`, `STATUS.md`, `docs/EFFORT-LOG.md`, and rollout notes

## Verification

Using Node `v24.18.0` explicitly:

- `npm ci` — completed; 0 vulnerabilities; Prisma Client 6.19.3 generated.
- Focused Vitest after rebase and capability integration — 9 files / 75 tests passed.
- Core alert/provider integration subset — 4 files / 46 tests passed.
- Scoped ESLint — passed.
- `npx tsc --noEmit` — passed.
- `DATABASE_URL='file:/tmp/api-usage-monitor-alert-config-validate.db' npx prisma validate` — passed.
- `git diff --check` — passed.
- Fresh alert review plus final SQLite startup-test re-review — LAND; no P0-P3.
- Focused startup-index verification — one verbose run plus five repeated runs passed; scoped ESLint, TypeScript, and diff checks passed.
- Canonical `npm run verify` — passed ESLint, TypeScript, 81 files / 534 tests, all four safe-migration scenarios, SQLite backup, startup configuration, and Next.js 16.2.10 production build.

## Production impact and follow-ups

None from this local branch yet. Scheduler and OTLP remain disabled. No push, PR, merge, deploy, Render/config/provider/database mutation, provider call, production write, or secret read occurred before publication.

The branch is rebased onto `origin/main` `0420eb0` (#209), retains its Anthropic snapshot-capability semantics, and atomically generations capability-affecting credential/config edits. A true -> false -> true Admin-capability regression proves the unchanged no-snapshot epoch reopens. Reviews and the serialized full gate are clear; hosted checks, merge, and exact Render production proof remain.
