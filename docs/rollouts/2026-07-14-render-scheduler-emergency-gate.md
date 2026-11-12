# Render emergency boot-scheduler gate

## Summary

Added a default-on environment gate around the in-process provider polling
scheduler. Operators can set `USAGE_SCHEDULER_ENABLED=false` to isolate the
receiver from boot polling while diagnosing SQLite/Litestream contention;
pushed usage and OTLP ingest remain registered.

## Why

Production remained database-unavailable after the readiness Prisma probe was
disabled. On exact `main` revision `27cf61a`, `/api/ready` safely reported
`probeSkipped=true`, but the boot scheduler stayed in progress for more than
five minutes, Prisma emitted P1008 about every five seconds, and one new
authenticated zero-cost ingest smoke returned HTTP 500. A reversible scheduler
gate separates provider polling from receiver availability while the distinct
Litestream metadata-preservation repair is reviewed.

## Files

- `.env.example`
- `DEPLOY.md`
- `src/instrumentation.ts`
- `src/__tests__/instrumentation.test.ts`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-14-render-scheduler-emergency-gate.md`
- `/Users/jay/apps/API-USAGE-MONITOR-EFFORT-LOG.md` (branch-neutral live board)

## Verification

- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm ls --depth=0` - clean
  dependency graph under Node `v24.18.0`.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm test -- src/__tests__/instrumentation.test.ts`
  - 1 file / 4 tests passed.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npx eslint src/instrumentation.ts src/__tests__/instrumentation.test.ts`
  - passed with no output.
- `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm run verify` - passed:
  lint, TypeScript, 74 files / 452 tests, safe-migration reproduction,
  SQLite pre-migration backup checks, startup configuration checks, and the
  production Next.js build.
- `git diff --check` - passed.
- The build retained the pre-existing Next.js warning that the `middleware`
  convention is deprecated in favor of `proxy`; it did not fail the build.

## Follow-ups

- Land only after focused tests, full `npm run verify`, independent review, and
  hosted checks pass.
- After the exact revision is live, set `USAGE_SCHEDULER_ENABLED=false`, verify
  monotonic `/api/health`, no new P1008, then prove authenticated ingest plus an
  identical idempotent replay.
- Re-enable provider polling only after the Litestream/Prisma repair is live and
  one complete scheduler tick succeeds without database contention.
