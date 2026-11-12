# Render SQLite readiness/restart-loop repair

## Summary

Diagnosed and repaired a production restart livelock on the paid Render Starter service. Scheduled retention no longer performs a full SQLite `VACUUM` unless an operator explicitly opts in, the declared Render configuration uses database-independent liveness, and concurrent readiness requests reuse one outstanding database probe instead of queueing uncancellable Prisma queries.

PR #178 merged as `d03b1b8`; PR #180 merged as `40afc02`; PR #181 merged as `938af7f`; and the no-probe bridge PR #188 merged as `27cf61a`. The live service reports `healthCheckPath=/api/health`. With `RENDER_READINESS_HTTP_COMPATIBILITY=true`, `/api/ready` no longer starts an uncancellable Prisma query, while HTTP transport, top-level `ok/status`, `X-Readiness-Status`, and scheduler/backup/startup diagnostics retain #181 semantics. Five-second P1008 failures still resumed after boot, proving readiness was a trigger but not the remaining database-lock cause.

## Why

Render reported the service as paid and `not_suspended`; the outage was not caused by account bandwidth, billing, or plan limits. Logs showed recurring Prisma `P1008` database timeouts followed by termination/restart of the sole instance. On every boot, the in-process scheduler immediately entered retention, pruned rows, checkpointed the WAL, and ran a full exclusive `VACUUM` against an approximately 129.7 MB SQLite database. The strict `/api/ready` health check timed out during that lock, so Render restarted the process before maintenance could finish; the next boot repeated the same cycle.

The repair separates liveness from readiness and keeps expensive whole-database compaction operator-controlled. `/api/ready` remains available for strict scheduler/backup/startup diagnostics; its database check is explicitly `probeSkipped` and not-ready only while the temporary compatibility flag is active. With the flag disabled, strict database probing resumes. The route is not an appropriate automatic process-restart signal for a single-instance SQLite service.

## Litestream state follow-up

Repeated production startup logs exposed a second defect: `prisma db push` saw
Litestream's nonempty `_litestream_seq` table as unmanaged drift, and
`migrate-safe.mjs` retried with `--accept-data-loss`, dropping that sequence row.
Litestream then uploaded a fresh 60,858,513-byte LTX before the P1008 loop resumed.

`prisma.config.ts` now marks `_litestream_seq` and `_litestream_lock` as external
tables, and the startup migration script no longer has any automatic
`--accept-data-loss` path. The migration regression uses arbitrary extra columns and
opaque BLOB values to prove Prisma preserves both external schemas and rows exactly,
while a destructive application-schema change still fails closed with the DB
unchanged.

## Files

- `.env.example`
- `DEPLOY.md`
- `prisma.config.ts`
- `render.yaml`
- `scripts/migrate-safe.mjs`
- `scripts/test-migrate-safe-repro.mjs`
- `scripts/test-startup-config.mjs`
- `src/app/api/ready/route.ts`
- `src/app/api/ready/__tests__/route.test.ts`
- `src/lib/data-retention.ts`
- `src/lib/usage-retention.ts`
- `src/lib/__tests__/usage-retention.test.ts`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-07-14-render-sqlite-readiness.md`
- `/Users/jay/apps/API-USAGE-MONITOR-EFFORT-LOG.md` (branch-neutral live board)

## Verification

All Node commands used Node `v24.18.0` from `/opt/homebrew/opt/node@24/bin`.

- `npm ci` — passed; Prisma client generated; 512 packages installed; 0 vulnerabilities.
- `npm test -- src/lib/__tests__/usage-retention.test.ts src/app/api/ready/__tests__/route.test.ts` — passed, 2 files / 12 tests.
- `npm run test:startup-config` — passed.
- `npm run lint -- src/lib/data-retention.ts src/lib/usage-retention.ts src/lib/__tests__/usage-retention.test.ts` — passed.
- `npm run typecheck` — passed after correcting the helper's testable environment type.
- `npm run verify` — passed: ESLint; TypeScript; 73 Vitest files / 440 tests; safe-migration reproduction; SQLite backup checks; startup configuration checks; production build.
- `git diff --check` — passed.
- Independent hostile review — ACCEPT; no blocking findings.

Follow-up compatibility verification for PR #180 used Node `v24.14.0`:

- Focused readiness suite — passed, 12/12 tests.
- `npm run verify` — passed: ESLint; TypeScript; 73 Vitest files / 445 tests; safe-migration reproduction; SQLite backup checks; startup configuration checks; production build.
- Independent adversarial review — no P0/P1/P2 findings; the flag cannot mask modeled non-database failures.

PR #181 failsafe verification used Node 24:

- Focused readiness suite — passed, 11/11 tests.
- Focused ESLint, `npm run typecheck`, and `git diff --check` — passed.
- Independent adversarial review — LAND; no P0/P1/P2 findings. The review confirmed always-200 transport, strict body/header diagnostics, 60-second failure caching, accurate timestamps, and hung-probe coalescing.

Current-main no-probe follow-up verification used Node `v24.14.0`:

- Focused readiness suite — passed, 15/15 tests.
- Complete `npm run verify` — passed: 73 test files / 448 tests, migration safety, SQLite backup, startup configuration, TypeScript, ESLint, and production build.
- `git diff --check` — passed.
- Tests explicitly cover no Prisma call, strict not-ready body/header semantics, cold start, backup, scheduler, and startup diagnostics while the flag is active.
- Independent exact-current-main review — LAND; no P0/P1/P2 findings.

Two accidental install attempts under the shell-default Node 26 were stopped at the engine guard before tests. The successful install and every verification command above used supported Node 24; this is additional evidence not to upgrade the repo to Node 26 now.

## Follow-ups

- Merge/deploy the no-probe follow-up, enable its compatibility flag, and verify the five-second P1008 pattern stops.
- Keep transport-level strict readiness and database probing deferred until production evidence proves the host no longer polls `/api/ready`; repository/service metadata alone has not been sufficient runtime proof.
- Verify sustained `/api/health` 200 responses, monotonic uptime, and recovery of DB-backed API routes before restoring retention windows.
- Verify an authenticated usage-ingest request returns 2xx before unblocking Socratic.Trade replay PR #1563.
- Schedule any future full `VACUUM` only in a deliberate maintenance window with `DATA_RETENTION_ENABLE_VACUUM=true`; the legacy disable flag remains an overriding kill switch.
