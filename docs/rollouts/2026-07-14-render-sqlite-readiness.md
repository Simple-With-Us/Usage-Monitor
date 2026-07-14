# Render SQLite readiness/restart-loop repair

## Summary

Diagnosed and repaired a production restart livelock on the paid Render Starter service. Scheduled retention no longer performs a full SQLite `VACUUM` unless an operator explicitly opts in, the declared Render configuration uses database-independent liveness, and concurrent readiness requests reuse one outstanding database probe instead of queueing uncancellable Prisma queries.

PR #178 merged as `d03b1b8` and deployed, but Render did not synchronize the declared health-check path: the live service still uses strict `/api/ready`. PR #180 (`40afc027`) added a temporary compatibility flag that softens the HTTP status of database-only readiness failures. Its first exact-revision live probe proved that the native Prisma/SQLite call itself can block the event loop beyond 10 seconds, before any status is returned. The active follow-up therefore skips that blocking probe only in compatibility mode. The body remains `{ ok:false, status:"not_ready" }`, and scheduler, backup, or startup failures remain HTTP 503.

## Why

Render reported the service as paid and `not_suspended`; the outage was not caused by account bandwidth, billing, or plan limits. Logs showed recurring Prisma `P1008` database timeouts followed by termination/restart of the sole instance. On every boot, the in-process scheduler immediately entered retention, pruned rows, checkpointed the WAL, and ran a full exclusive `VACUUM` against an approximately 129.7 MB SQLite database. The strict `/api/ready` health check timed out during that lock, so Render restarted the process before maintenance could finish; the next boot repeated the same cycle.

The repair separates liveness from readiness and keeps expensive whole-database compaction operator-controlled. `/api/ready` remains available for strict scheduler/database/backup diagnostics; it is not an appropriate automatic process-restart signal for a single-instance SQLite service.

## Files

- `.env.example`
- `DEPLOY.md`
- `render.yaml`
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

Follow-up compatibility verification used Node `v24.14.0`:

- Focused readiness suite — passed, 12/12 tests.
- `npm run verify` — passed: ESLint; TypeScript; 73 Vitest files / 445 tests; safe-migration reproduction; SQLite backup checks; startup configuration checks; production build.
- Independent adversarial review — no P0/P1/P2 findings; the flag cannot mask modeled non-database failures.
- PR #180 hosted CI, CodeQL, and gitleaks passed; merge `40afc027` deployed as `dep-d9b00ggddkuc73dp2d6g`.
- Exact-revision live probe: `/api/health` returned HTTP 200 with revision `40afc027`; the first `/api/ready` request exceeded 10 seconds, proving the event-loop-blocking gap. Recovery was not claimed from the later 2-second compatibility responses.
- Probe-skip follow-up focused readiness suite — passed, 13/13 tests; TypeScript and lint passed under Node `v24.14.0`.

Two accidental install attempts under the shell-default Node 26 were stopped at the engine guard before tests. The successful install and every verification command above used supported Node 24; this is additional evidence not to upgrade the repo to Node 26 now.

## Follow-ups

- Merge and deploy the probe-skip compatibility follow-up; keep `RENDER_READINESS_HTTP_COMPATIBILITY=true` only while Render continues to use `/api/ready` for process health.
- Correct the live Render service to `healthCheckPath: /api/health`, then disable the compatibility flag immediately; repository YAML alone is not runtime proof.
- Verify sustained `/api/health` 200 responses, strict `/api/ready` recovery, stable instance uptime, and absence of the Prisma timeout/restart pattern.
- Verify an authenticated usage-ingest request returns 2xx before unblocking Socratic.Trade replay PR #1563.
- Schedule any future full `VACUUM` only in a deliberate maintenance window with `DATA_RETENTION_ENABLE_VACUUM=true`; the legacy disable flag remains an overriding kill switch.
