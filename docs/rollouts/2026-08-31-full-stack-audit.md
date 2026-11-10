# 2026-08-31 — Usage Monitor full-stack audit (report only)

## Summary

Owner-directed team audit of Usage Monitor across web (all viewport sizes), iOS Client + Local + widgets, backend ingest/API, money path, security/privacy, and ops/CI.  Seven parallel read-only reviewers plus orchestrator spot-checks.  Product code is unchanged.  The report is `docs/audits/2026-08-31-full-stack-audit.md`.  `AGENTS.md` daily-rollups note is corrected (middleware exclusion already exists).

## Why

The owner asked for a top-to-bottom review of errors, issues, and improvements on every web size, both native apps, and backend functions.

## Files

- `docs/audits/2026-08-31-full-stack-audit.md` — ranked findings with file:line
- `docs/rollouts/2026-08-31-full-stack-audit.md` — this receipt
- `AGENTS.md` — daily-rollups bearer exclusion is present, not missing
- `STATUS.md` — current stanza
- `docs/EFFORT-LOG.md` — this lane

## Verification

- Spot-checked P0/P1 claims against current tree (`tailwind.config.ts`, `settings/route.ts`, `apns/device-tokens/route.ts`, `middleware.ts`, `auto-merge-shared-dependency.yml`, `r2-weekly-archive.mjs`, `usage-recorder.ts`, `backblaze.ts`, `budget-status.ts`).
- Did **not** run a live browser pass or iOS Simulator screenshots.
- `npm run verify` on the docs-only branch before merge.

## Follow-ups (do not start with copy)

1. Session-only `PUT /api/settings`; strip full APNs tokens from GET.
2. Same-repo guard on `auto-merge-shared-dependency.yml`.
3. Stop writing catalog estimates as cash; stop adding plan-fixed on snapshot-included fixed.
4. Weekly R2 workdir off `/tmp`; overlapping-tick stall-clock guard.
5. Agents Tailwind tokens + nested `<main>`; `overflow-x-clip` → scroll.
6. Coolify deploy gate (existing board `d0f5f1db`) and ios-ship ASC secret parity (`5828a5b7`).
