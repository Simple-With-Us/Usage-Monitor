# 2026-09-02 — Overview Timeframe Selection on Web and iOS (Antigravity, `feat/overview-timeframe-selection`)

## Context & Objective
Adds a prominent timeframe selection control to the top of the Overview screen on both Web and iOS apps, enabling users to switch between rolling periods (last 12, 6, 3, 1 month, 7 days, 24 hours, all time), the current calendar month, and named prior calendar months.

## Changes Made
- **Web Timeframe Options (`src/hooks/useDashboardData.ts`)**:
  - Added `"365d"` (12 months) to `TimeframeOption` union.
  - Updated `timeframeToDays`, `timeframeDisplayLabel`, `timeframeShortLabel`, and `isPrimaryHistoryChip` helpers.
  - Added unit test coverage in `src/hooks/__tests__/useDashboardData.test.ts`.
- **Web HistoryWindowControl & Overview Page (`src/components/HistoryWindowControl.tsx`, `src/app/page.tsx`)**:
  - Enhanced primary quick rail to include `"This month"`, `"30d"` (1m), `"90d"` (3m), `"180d"` (6m), and `"12m"` (365d).
  - Expanded More dropdown with rolling windows (24h, 7d, 30d, 90d, 180d, 365d, all time), 13 calendar months by name (current + 12 prior), and calendar years.
  - Placed `HistoryWindowControl` at the top of the Overview page above the spend hero card for immediate accessibility while maintaining full synchronization across the page.
- **iOS TimeframeOption & TimeframePicker (`TimeframeOption.swift`, `TimeframePicker.swift`, `PortfolioHistorySection.swift`)**:
  - Added `.rolling(days: 365)` / `"Past 12 months"` to `TimeframeOption` and `TimeframePicker`.
  - Updated `ChartRangeControl` to be public and support 12/6/3/1 month options alongside named prior calendar months.
- **iOS Overview Screen (`DashboardContentView.swift`, `DashboardRootView.swift`)**:
  - Added `timeframe` and `onSelectTimeframe` properties to `DashboardContentView`.
  - Added `OverviewTopTimeframeBar` card above `DashboardHeroCard` on Overview.
  - Wired `portfolioHistoryStore.timeframe` and `selectTimeframe` in `DashboardRootView`.
  - Added unit tests in `DashboardViewDataTests.swift`.

### Touched Files
- `src/hooks/useDashboardData.ts`
- `src/hooks/__tests__/useDashboardData.test.ts`
- `src/components/HistoryWindowControl.tsx`
- `src/app/page.tsx`
- `ios/UsageMonitor/UsageMonitorKit/Sources/Dashboard/TimeframeOption.swift`
- `ios/UsageMonitor/UsageMonitorKit/Sources/Dashboard/TimeframePicker.swift`
- `ios/UsageMonitor/UsageMonitorKit/Sources/Dashboard/PortfolioHistorySection.swift`
- `ios/UsageMonitor/UsageMonitorKit/Sources/Dashboard/DashboardContentView.swift`
- `ios/UsageMonitor/UsageMonitorKit/Sources/Dashboard/DashboardRootView.swift`
- `ios/UsageMonitor/UsageMonitorKit/Tests/UsageMonitorKitTests/DashboardViewDataTests.swift`
- `docs/EFFORT-LOG.md`
- `docs/rollouts/2026-09-02-overview-timeframe-selection.md`

## Decisions & Trade-offs
- Setting the timeframe on the Overview screen updates chart and usage telemetry data while keeping month-to-date budgets strictly anchored to the current calendar month as designed.
- Both top and in-content timeframe controls share identical state so changes propagate seamlessly across the entire view.

## Verification State
- `npm run lint` — passed with 0 errors.
- `npm run typecheck` — passed with 0 errors.
- `npm test` — 201 test suites, 2,347 tests passed (100% green).
- `npm run build` — Next.js production build succeeded in 37.4s.
- `swift build --build-tests --sdk ...` — compiled `UsageMonitorKit` and all tests cleanly.
