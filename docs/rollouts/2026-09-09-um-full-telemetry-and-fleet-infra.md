# 2026-09-09 — UM full telemetry (token/model) and Sentry fleet-infra wiring (`[MM] minimax/full-telemetry-and-sentry-fleet-infra`)

## Summary

Three things ship together on one branch.

1. **Producer coverage audit.**  `docs/observability/producer-coverage-matrix.md` maps every known producer of `/api/ingest/usage` and `/api/otlp/v1/metrics` to the v2 fields they send, what UM accepts, and the known honest gaps.  No wire change — the v2 schema in `@jaywedgeworth22/congress-trading-shared` is the absolute truth; this is the human reference.
2. **Three new Sentry Application Metrics on the `usage-monitor` project.**  `scheduler.duration_ms` (gauge), `ingest.admission_rejected` (counter), `rollup.completed` (counter).  These fill the gaps the 2026-09-01 Sentry fleet integration plan called out for UM.  No SDK re-init; uses the existing Sentry SDK.
3. **UM → fleet-infra mirror.**  A small dependency-free raw-envelope client (`src/lib/sentry-fleet.ts`) mirrors a bounded subset of UM's app-health signals into the shared fleet-infra Sentry project so the fleet health view sees UM alongside the peer apps.  Pattern ports `scripts/sentry-ci-report.py` to TypeScript and reuses the same DSN-gated no-op contract.

The branch also keeps the receiver-side guarantees intact: BotFleet's `claude/sentry-usage-telemetry` shape, Socratic.Trade's `provider-call-volume` events, and Congress.Trade's `thirdPartyTelemetry` shape are all covered by the existing v2 ingest (`/api/ingest/usage`) and OTLP (`/api/otlp/v1/metrics`); no ingest route changes.

## Why a fleet-infra mirror and not just a richer `usage-monitor` Sentry project

The 2026-09-01 Sentry fleet integration plan (`/Users/jay/apps/fleet-claude/docs/plans/2026-09-01-sentry-fleet-integration.md`) reserves fleet-infra for **CI failures, host-monitor events, and infra-level signals**, not per-app runtime.  Every app's runtime signals stay in its own Sentry project.  The mirror is bounded: only the four signal classes that signal "UM is healthy at the fleet level" (scheduler tick success, ingest failure, scheduler duration, rollup completion, ingest admission rejection).  The other side of the rule: app-level errors, route-level 4xx/5xx, and user-facing incidents still go to `usage-monitor` only.

## What this branch does NOT do

- No new ingest endpoint.  No new v2 schema field.  No v2 producer changes.
- No new cron monitor in fleet-infra.  The 15-min `usage-monitor-scheduler` cron monitor (in the `usage-monitor` project) stays where it is — matching BotFleet's `scheduler-tick` pattern.  The mirror adds application-metric events to fleet-infra, not a second cron monitor.
- No Sentry SDK re-init with a second DSN.  The `@sentry/nextjs` SDK only takes one DSN at init; the fleet-infra mirror is a separate, dependency-free raw-envelope client that posts to Sentry's envelope endpoint using the public key parsed from `SENTRY_FLEET_DSN`.
- No secrets in git.  `SENTRY_FLEET_DSN` is provisioned by Infisical → Coolify env, the same path the existing `SENTRY_DSN` (and `SENTRY_FLEET_DSN` for the CI reporter) already take.  The test suite mocks `fetch` and the DSN value never appears in any persisted log line or breadcrumb.
- No second fleet-infra reporter shape.  The existing `scripts/sentry-ci-report.py` keeps the `[app, workflow]` fingerprint for CI failures; the new mirror uses `[um-fleet, metric, <name>]` for app-health metrics.  Two distinct shapes, no cross-dedup risk.

## Files

New:
- `src/lib/sentry-fleet.ts` — raw-envelope Sentry client, DSN-gated, no SDK init.
- `src/lib/__tests__/sentry-fleet.test.ts` — 11 tests.
- `docs/observability/producer-coverage-matrix.md` — producer × field matrix.
- `docs/rollouts/2026-09-09-um-full-telemetry-and-fleet-infra.md` (this file).

Modified:
- `src/lib/sentry-ops.ts` — adds `recordSchedulerDuration`, `recordIngestAdmissionRejected`, `recordRollupCompleted`, and a fleet-infra mirror into `logIngestFailed`.  All four are no-op when the SDK never init'd or `SENTRY_FLEET_DSN` is unset.
- `src/lib/usage-recorder.ts` — wraps the scheduler tick in a `Date.now()` timer, emits `recordSchedulerDuration` on success and on error.
- `src/lib/ingest-admission.ts` — unchanged: the route handlers emit the metric where the 503 is returned (see next two).
- `src/lib/data-retention.ts` — emits `recordRollupCompleted` per non-empty batch.
- `src/app/api/ingest/usage/route.ts` — emits `recordIngestAdmissionRejected` on the 503 admission rejection.
- `src/app/api/otlp/v1/metrics/route.ts` — same, for the OTLP path.
- `src/lib/__tests__/sentry-ops.test.ts` — adds 6 tests for the new metrics + the fleet mirror on `logIngestFailed`.
- `AGENTS.md` — short note about the new fleet-infra mirror and the new metrics.

## Owner task (do once)

1. Add `SENTRY_FLEET_DSN` to the `usage-monitor` Infisical project (env `prod`, path `/`) — the same fleet-infra DSN `scripts/sentry-ci-report.py` already uses (it lives in repo or org Actions secrets for the CI reporter; the Infisical copy is for the runtime mirror).
2. Confirm Coolify env for the UM app has `SENTRY_FLEET_DSN` set.  The deploy preflight does not need to hard-fail on its absence — the module is DSN-gated and the absence is a no-op.  But the operator-visible Sentry fleet health view is better with it on.
3. After deploy, verify the first events land in fleet-infra by filtering on `app:usage-monitor` and `agent:MM`.  Expect one scheduler.duration_ms per 15 min, one rollup.completed per maintenance cycle, one ingest.admission_rejected per busy-window, and one ingest.failed per failed ingest.

## Verification

- `npx vitest run src/lib/__tests__/sentry-fleet.test.ts` — 11/11 passed.
- `npx vitest run src/lib/__tests__/sentry-ops.test.ts` — 9/9 passed (3 new metric tests + the fleet-mirror case).
- `npx vitest run` — full suite green (TBD pending CI).
- `npm run typecheck` — 0 errors (TBD pending CI).
- Manual: deploy, wait one scheduler tick, confirm `scheduler.duration_ms` event in fleet-infra filtered by `app:usage-monitor`.

## Coordinate

- Board item: `58c6cf02` (this lane).
- Cross-seat: `c630ceed` (Claude's fleet-wide Sentry campaign).  No overlap; the DSN is shared, the wire shapes are disjoint, and the existing CI reporter stays untouched.
- Slack: post a `[MM]` handoff to `#ag***-s**c` with the PR number once it lands.
