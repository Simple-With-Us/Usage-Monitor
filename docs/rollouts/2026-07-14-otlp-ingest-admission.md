# OTLP retry-storm isolation and ingest admission

## Summary

Added two receiver-side controls for the production SQLite contention incident:

- `OTLP_METRICS_INGEST_ENABLED` defaults to enabled. Explicit `false` makes the
  authenticated OTLP metrics requests admitted by the IP limiter return HTTP
  503 with `Retry-After: 300` before reading the request body or starting
  database work. Excess requests receive 429 with the same long backoff.
- A process-global, non-queuing admission token now permits only one
  database-writing request across `/api/ingest/usage` and
  `/api/otlp/v1/metrics`. Concurrent writers receive HTTP 503 with
  `Retry-After: 5`; every admitted path releases the token in `finally`.

The accept-and-drop OTLP logs route remains available because it does not write
to SQLite. Both switches are default-compatible until an operator explicitly
disables OTLP metrics.

## Why

On exact production revision `6ae30eb`, Prisma P1008 continued after both the
provider scheduler and readiness SQLite probe were disabled. Render metrics then
showed a correlated inbound retry storm: up to 2,036 HTTP 502 responses in one
minute, 485 HTTP 429 responses in another, and sustained client cancellations.
The machine-wide Claude configuration exports OTLP metrics to this receiver from
many concurrent processes. The OpenTelemetry OTLP specification treats HTTP 429
and 503 as retryable and permits `Retry-After`; the receiver therefore needs to
fail quickly with an explicit backoff while ensuring an older query cannot be
overlapped by a retried request.

Reference: https://opentelemetry.io/docs/specs/otlp/

## Files

- `src/lib/ingest-admission.ts`
- `src/lib/__tests__/ingest-admission.test.ts`
- `src/app/api/ingest/usage/route.ts`
- `src/app/api/ingest/usage/__tests__/route.test.ts`
- `src/app/api/otlp/v1/metrics/route.ts`
- `src/app/api/otlp/v1/__tests__/metrics-route.test.ts`
- `.env.example`
- `AGENTS.md`
- `DEPLOY.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-14-otlp-ingest-admission.md`
- `/Users/jay/apps/API-USAGE-MONITOR-EFFORT-LOG.md` (branch-neutral live board)

## Verification

Focused checks completed under Node `24.18.0`:

```bash
env PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx vitest run src/lib/__tests__/ingest-admission.test.ts src/app/api/ingest/usage/__tests__/route.test.ts src/app/api/otlp/v1/__tests__/metrics-route.test.ts
# 3 files / 27 tests passed

env PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npx eslint src/lib/ingest-admission.ts src/lib/__tests__/ingest-admission.test.ts src/app/api/ingest/usage/route.ts src/app/api/ingest/usage/__tests__/route.test.ts src/app/api/otlp/v1/metrics/route.ts src/app/api/otlp/v1/__tests__/metrics-route.test.ts
# passed

env PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run typecheck
# passed

git diff --check
# passed
```

The first dependency-install attempt inherited shell Node `26.5.0`, emitted the
expected engine mismatch, and was interrupted. `npm ci` was immediately rerun
successfully with the required Node 24 PATH.

The complete gate then passed:

```bash
env PATH=/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin npm run verify
# eslint passed
# TypeScript passed
# Vitest: 76 files / 460 tests passed
# migrate-safe: additive, Litestream external-state, no-op, and destructive-refusal scenarios passed
# SQLite pre-migration backup checks passed
# startup configuration checks passed
# Next.js production build passed
```

An independent hostile review inspected the full tracked and untracked diff,
reran Node 24 TypeScript, scoped ESLint, 27 focused tests, and
`git diff --check`, then returned LAND with no P0-P2. The reviewer confirmed the
process-local token is correct for the current single-instance Render service;
horizontal or multi-process scaling requires replacing it with shared admission.

## Activation and follow-ups

1. Open a ready PR; require hosted verify, CodeQL, and secret-scan checks.
2. After the exact merge revision is live, set
   `OTLP_METRICS_INGEST_ENABLED=false` once and wait for that config deploy.
3. Verify `/api/health`, strict `/api/ready` diagnostics, absence of new P1008,
   and bounded OTLP 503/429 responses over a sustained interval.
4. Only after the database is quiet, send one authenticated zero-cost generic
   ingest and one identical replay. Expect `accepted: 1`, then `accepted: 0`.
5. Keep the scheduler and OTLP metrics disabled until the database remains
   healthy through a full provider tick and a controlled OTLP re-enable.

No production ingest smoke was sent during implementation.
