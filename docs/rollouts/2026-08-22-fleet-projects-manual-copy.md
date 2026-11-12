# Fleet projects, Manually only labels, stale refetch, local copy

**Date:** 2026-08-22
**Branch:** `grok/fleet-projects-manual`
**Board:** `1a5de7b6`

## Why

Owner: create UM Projects for every fleet app; copy workspace to local for testing; never present a non-poll provider as fetchable/needs-setup; if a usage snapshot is old, take a new one instead of a confusing stale alert; research Grok/Antigravity/Codex subscription telemetry vs API PAYG.

## What landed

- `ensureFleetProjectsSeeded` on GET `/api/projects` and the poll tick (fail-closed if Project is unavailable). Alias-safe: existing `SocraticTrade.com` is not duplicated as `Socratic.Trade`.
- Coverage / last-sync / iOS inventory labels: **Manually only**. Integration drawer banner says adding a key will not unlock polling. Anthropic individual stays skip-fetch.
- Pollable old snapshots / old external billing: force due in `fetchAllDueProviders`; dashboard POSTs `/api/providers/refresh-stale` once. Coverage "stale" only when the usage snapshot itself is old; copy says this is not an alert.
- Settings card **Copy Workspace For Local Testing**: `GET /api/workspace/export` (session or `USAGE_READ_TOKEN`) and `POST /api/workspace/import` (session). Format `usage-monitor-local-export` v1 matches Local Usage Monitor Import. No API keys. Imported providers stay inactive until credentials are re-entered.
- Research note for SuperGrok / Codex / Antigravity vs PAYG.

## Verification

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx tsc --noEmit -p tsconfig.json
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run \
  src/lib/__tests__/ensure-fleet-projects.test.ts \
  src/lib/__tests__/workspace-copy.test.ts \
  src/lib/__tests__/billing-inventory.test.ts \
  src/lib/__tests__/provider-sync-mode.test.ts \
  src/lib/__tests__/provider-integration-catalog.test.ts \
  src/lib/__tests__/usage-recorder-failure-backoff.test.ts \
  src/lib/__tests__/usage-recorder-budget-pause.test.ts \
  src/lib/__tests__/provider-timeout-budget.test.ts \
  src/components/__tests__/ProviderTable.test.ts \
  src/components/__tests__/ProviderIntegrationDrawer.test.ts \
  src/components/__tests__/PaidServicesPanel.test.ts \
  src/__tests__/middleware.test.ts
```

tsc clean.  Focused 87 + 35 usage-recorder tests passed.

## Follow-ups

- After deploy, open Projects on usage.jays.services so the seed runs (or wait for the next poll tick).
- Download the workspace JSON and import on Local Usage Monitor or `npm run dev` then Import On This Instance.
- Optional later: Codex session-JSONL collector and Grok Build credits collector on the Mac (LaunchAgent must be listed on MAC-LOCAL-PROCESSES.md).  Not in this PR.  SuperGrok/Codex/Antigravity remain MANUALLY ONLY.
