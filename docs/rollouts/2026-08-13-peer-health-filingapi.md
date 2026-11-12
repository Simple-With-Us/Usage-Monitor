# 2026-08-13 — Peer App Health ignores last-resort FilingAPI 401

## Summary

ST's env `FILINGAPI` key 401s against filingapi.dev (35/35 health rows, all
HTTP 401).  FilingAPI is a last-resort scarce enrichment source, not required
for trading or liveness.  Counting it as a hard failed dependency kept Peer App
Health Degraded on an otherwise healthy ST process.

Same class as the overnight VIX filter shipped earlier.

## Files changed

- `src/lib/operations-health.ts` — drop `filingapi` from `dependencyFailures`.
- `src/lib/__tests__/operations-health.test.ts`.

## Verification

- Focused vitest `operations-health`.
- After deploy: UM `/api/operations` `socraticInfrastructure.failedDependencies`
  should not list `filingapi`.  Card is healthy when the only remaining false
  dep was FilingAPI (and market is closed).

## Follow-ups

- Replace or retire the dead FilingAPI env key only with owner sign-off.
