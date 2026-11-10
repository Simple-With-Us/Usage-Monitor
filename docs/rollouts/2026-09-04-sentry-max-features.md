# 2026-09-04 — Sentry Max Features (UM)

Board `af1ab6e9`.  Branch `grok/sentry-max-features`.  Worktree
`~/apps/usage-grok-sentry-max`.

## Changes

- User Feedback widget on the admin web client (kill switch
  `NEXT_PUBLIC_SENTRY_FEEDBACK_ENABLED=false`).
- Server `profileSessionSampleRate` + optional `@sentry/profiling-node`
  (fail-soft if the native binary is missing).
- `nodeRuntimeMetricsIntegration` on the Node init.

Replay stays 10% session / 100% error, masked.

## Verification

- `npx tsc --noEmit` (or `npm run typecheck`)
