# 2026-09-01 — Sentry Structured Logs & Health Comments Update (Antigravity, `ag/sentry-logs-and-comment-fix`)

## Context & Objective
Enables Sentry Structured Logs across server, edge, and client runtimes in Usage-Monitor, modernizes comments around Sentry application metrics/health vs OTLP token usage, and normalizes falsy replay gate handling.

## Changes Made
- **Enabled Structured Logs**: Added `enableLogs: true` across `src/sentry.server.config.ts`, `src/sentry.edge.config.ts`, and `src/instrumentation-client.ts`.
- **Falsy Replay Gate Normalization**: Updated `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED` evaluation to recognize `false`, `0`, `off`, and `no`.
- **Updated Health Comments**: Corrected stale comments in `src/lib/sentry-health.ts` to reflect modern Sentry metrics/health split.

### Touched Files
- `src/sentry.server.config.ts`
- `src/sentry.edge.config.ts`
- `src/instrumentation-client.ts`
- `src/lib/sentry-health.ts`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-09-01-sentry-structured-logs-enablement.md`

## Decisions & Trade-offs
- Sparse log tracing provides critical operational context for Seer and Trace Explorer without ballooning log ingestion volume.

## Verification State
- `npm run typecheck` — passed with 0 errors.
- `npx vitest run src/lib/__tests__/sentry-health.test.ts` — 7/7 passed.

## Next Steps & Blockers
- None.
