# 2026-08-20 — Cross-app coordination follow-ups (UM slice)

## Context & Objective

Socratic.Trade audit #2802 (`docs/audits/2026-08-17-cross-app-coordination.md`
in that repo) listed portfolio fixes.  This branch implements the
Usage-Monitor slice of §7 so the pin triangle and Peer App Health stop
rotting as "next agent" notes.

## Changes Made

- Added a vendor-era shared-package pin check.  LOCAL is this repo's
  `package.json` + lock.  Peers are Socratic.Trade (public npm git pin) and
  Congress.Trade (private vendor provenance).  The script fails if ST is
  unreadable, if CT is unreadable, if versions diverge, or if CT
  reintroduces an npm dependency.  A missing peer spec is not a skip-and-pass.
- Added a thin `shared-package-pin-check.yml` workflow.  It is intentionally
  not a required merge check.
- Operations health now probes `https://congress.trade/api/health` next to ST.
  CT `/api/health` is treated as liveness (`ok: true`).  Retired / last-resort
  pipeline checks (senate-relay, executive polling, Massive, Deno, FilingAPI)
  do not paint the card degraded.
- Web Ops card + iOS Platforms row for Congress.Trade liveness.

Touched:

- `scripts/check-shared-package-pin.mjs`
- `.github/workflows/shared-package-pin-check.yml`
- `src/lib/__tests__/shared-package-pin-check.test.ts`
- `src/lib/operations-health.ts`
- `src/lib/__tests__/operations-health.test.ts`
- `src/components/OperationsOverview.tsx`
- `src/components/__tests__/OperationsOverview.test.ts`
- `ios/UsageMonitor/UsageMonitorKit/Sources/Models/OperationsHealth.swift`
- `ios/UsageMonitor/UsageMonitorKit/Sources/Platforms/PlatformsSections.swift`
- `ios/UsageMonitor/UsageMonitorKit/Tests/UsageMonitorKitTests/PlatformsDecodingTests.swift`
- `STATUS.md`
- `PLAN.md`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-08-20-cross-app-coordination-followups.md` (this file)

## Decisions & Trade-offs

- Did not promote the pin-check to a required merge check (audit item 9).
- Did not mint API keys.  Did not add Coolify or USAGE_INGEST to peer apps.
- CT card state follows readiness `ok`, not `pipeline.status`.  Failed
  last-resort checks stay off the paint path even if they remain in the
  raw payload.
- iOS reuses `PeerInfrastructure` for the optional Congress row so older
  clients ignore the new field.

## Verification State

```bash
npx tsc --noEmit
npx vitest run src/lib/__tests__/shared-package-pin-check.test.ts \
  src/lib/__tests__/operations-health.test.ts \
  src/components/__tests__/OperationsOverview.test.ts
# tsc clean; 27 passed (3 files)
```

`npm run lint` / full `npm test` / `npm run build` were not required for this
slice; focused typecheck + the files touched above are green.  iOS Swift was
not compiled here (cloud Linux; no xcodebuild).

## Next Steps & Blockers

1. Land the matching ST pin-check PR (#2941) and the CT AGENTS.md / Massive
   last-resort peer PRs so the triangle is a matched pair.
2. Promote pin-check to required only after ST+UM+CT agree on the gate.
3. This cloud seat cannot write the Mac live effort board
   (`/Users/jay/apps/TRADING-EFFORT-LOG.md`).

## Zero-Code Findings

CT `GET /api/health` is readiness plus a pipeline rollup.  Treating that
rollup as Peer App Health would paint degraded on senate-relay and
last-resort Massive the same way FilingAPI painted ST.
