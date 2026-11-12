# 2026-09-03 — Antigravity $70 net seat and honest missing telemetry

Owner 2026-09-03: Antigravity is a $100 Google AI Ultra plan of which $30 was
already Google One, so $70 net for the AI.  The Agents tab was showing little
or no token volume as if that were usage.  Antigravity does not expose token
telemetry.  When a number is not accurate, every platform must say so.

Two spaces between sentences in this file.

## What changed

- Antigravity seat cost is **$70/mo net** (`$100` list minus `$30` pre-existing
  Google One).  Savings math uses the net figure.
- Token feeds that are missing, character-count estimates, or process-only
  (Cursor) render **not reported**.  They never render as confirmed zero usage.
- A running session-jsonl seat with no events in the window is also
  **not reported** ("not confirmed as zero usage").
- Idle Claude OTLP with no events stays "no events in this window" because that
  stream is the one feed we can trust when it is quiet.
- Web `/agents` and iOS Agents tab show the accuracy note on every affected
  card.  Fleet totals omit those seats and say they are incomplete.

## Files

- `src/lib/agent-telemetry-accuracy.ts` — accuracy resolver and display helpers
- `src/lib/agents-overview.ts` — seat catalog + overview payload
- `src/components/AgentsDashboard.tsx` — web Agents tab
- `ios/UsageMonitor/UsageMonitorKit/Sources/Models/AgentsOverview.swift`
- `ios/UsageMonitor/UsageMonitorKit/Sources/Computers/AgentsRootView.swift`

## Verification

Ran locally from `~/apps/usage-grok-ag-telemetry`:

- `npx tsc --noEmit` PASS
- `npx vitest run src/lib/__tests__/agent-telemetry-accuracy.test.ts src/lib/__tests__/agents-overview.test.ts` PASS (11)
- `npm test` PASS (202 files, 1 skipped)
- `npm run test:sqlite-backup` / `test:r2-archive` / `test:startup-config` / `test:oracle-deploy` PASS
- `npm run test:antigravity-collector` / `test:session-token-collectors` / `test:cf-token-map` / `test:replica-status-probe` PASS
- `npm run build` PASS (`/agents` and `/api/agents-overview` in the route table)

Not run on this Mac (pre-existing local gaps, CI still runs them):

- `test:migrate-safe` — Prisma schema-engine `can-connect-to-database` fails on this Mac for temp SQLite files, including on `origin/main`
- `test:apple-projects` / simulator `xcodebuild` — iOS 26.5 Simulator SDK is not installed here.  GitHub-hosted `ios-build.yml` compiles the iOS change.

## Follow-ups

Quota windows from `agy -p "/usage"` still exist.  They are not token usage.
Do not re-enable character-count transcript estimates as a stand-in for
Antigravity burn.
