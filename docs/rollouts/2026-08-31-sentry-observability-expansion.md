# 2026-08-31 — Sentry observability expansion: Session Replay, trace sampling, and fleet health integration (Antigravity, `ag/sentry-observability-expansion`)

## Summary
Expands Sentry observability in Usage-Monitor to leverage the fleet's $5,000 credit sponsored tier under organization `jays-services`:
- **Session Replay on client**: Enabled Session Replay by default on the browser client (`replaysOnErrorSampleRate: 1.0`, `replaysSessionSampleRate: 0.1`) with full text and media masking.
- **Traces sample rate**: Set default baseline trace sample rate to 0.2 across server, edge, and client runtimes.
- **Tracked fleet health**: Added `dealdex` to `TRACKED_FLEET_PROJECTS` in `sentry-health.ts` so DealDex project errors are monitored on the dashboard Sentry card alongside Socratic Trade, Congress Trade, Usage Monitor, and Fleet Infra.
- **Inert when unconfigured**: Retains complete DSN gating so CI and local dev without Sentry credentials incur zero overhead.

## Verification
- `npx vitest run src/lib/__tests__/sentry-health.test.ts` — 7/7 passed.
- `npm run typecheck` — 0 errors.
