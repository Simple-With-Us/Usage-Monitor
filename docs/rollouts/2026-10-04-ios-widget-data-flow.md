repo: usage-monitor
**Date:** 2026-10-04
**Seat:** MiniMax (`@MINIMAX`)
**Board:** `57d42d5809dd477d807625261b287582`
**Branch:** `minimax/ios-widget-data-flow`
**Worktree:** `~/apps/simplewithus-mm-ios-widget-data-flow` (Mac lane); Cursor Cloud
agents use `/workspace` on branch `minimax/ios-widget-data-flow`
**Pre-work claim:** posted in `#agent-sync` beginning with `repo: usage-monitor`
as required by the team's agent-sync protocol (see `AGENT-SYNC.md`); the
private local protocol file path is intentionally not in this public note.

## Context & Objective

The owner reported that the iOS app's widgets "don't work and they say click
here to load data and you click and then the app does work and has the data
but never gets it back to any of the widgets.  The widgets should have
options too for those that could serve multiple purposes logically or when
not then just have more widget options themselves I guess."

The specific shape of the report is the diagnostic clue: the app loads fine
and the widget still says the same thing afterwards.  That rules out
"the app cannot fetch" and points squarely at the app → widget handoff.

## Changes Made

### Implementation

- `ios/UsageMonitor/UsageMonitorKit/Sources/WidgetShared/WidgetSnapshotResolver.swift` (new)
- `ios/UsageMonitor/UsageMonitorKit/Sources/WidgetShared/WidgetTimelineReloader.swift` (new)
- `ios/UsageMonitor/UsageMonitorKit/Sources/OfflineCache/WidgetSnapshotStore.swift`
  (storage cap raised to `maxMeters: 8` so the render-time Rows option is
  the binding limit on the Budget topic)
- `ios/UsageMonitor/UsageMonitorKit/Sources/OfflineCache/BackgroundRefreshManager.swift`
  (forced widget reload now fires before the quota fetch returns, so a slow
  subscription-quota response cannot gate the Lock Screen alert or the
  final forced widget reload; Lock Screen alert path moved off the critical
  path the previous PR fix only partially unblocked)
- `ios/UsageMonitor/UsageMonitorKit/Sources/Dashboard/QuotaWindowsStore.swift`
  (race-safe mirror: chains the new detached write onto the previous one so
  a slower older response can no longer clobber a faster newer one)
- `ios/UsageMonitor/UsageMonitorKit/Sources/Models/QuotaWindows.swift`
  (decoded into the shared `WidgetShared.QuotaSection`)
- `ios/UsageMonitor/UsageMonitorWidget/WidgetTimeline.swift` (`BudgetEntry` +
  timeline provider split out of the bundle entry so unit tests can compile
  widget UI without `@main`)
- `ios/UsageMonitor/UsageMonitorWidget/WidgetScreenViews.swift` (root +
  budget/LLM/server chrome split out for the same reason)
- `ios/UsageMonitor/UsageMonitorWidget/WidgetPresentation.swift` (new
  `WidgetRowCount` / `WidgetSortOrder` options, new `WidgetTopic` cases for
  `quotas` and `projects`, new `topicContent` family including
  `quotaContent` / `projectsContent`, Rows picker threaded into
  `macContent` / `alertsContent` so the option actually renders a truncated
  list, `.utilisation` sort now ranks `isExhausted` first so a server-flagged
  exhausted window with no number cannot sort behind healthy 100%-remaining
  ones)
- `ios/UsageMonitor/UsageMonitorWidget/TopicWidgets.swift` (new Quotas
  topic and Projects topic)
- `ios/UsageMonitor/UsageMonitorWidget/GlanceWidgets.swift` (new dedicated
  Mac, Alerts, and Quotas tiles; previously Mac and Alerts were
  `StaticConfiguration` with no Edit Widget options)
- `ios/UsageMonitor/UsageMonitorWidget/BudgetWidgetIntent.swift` (new
  `SelectQuotasIntent`, `SelectMacAlertsIntent` and
  `WidgetRowCount`/`WidgetSortOrder` `AppEnum` conformances)
- `ios/UsageMonitor/UsageMonitorWidget/UsageMonitorWidgetBundle.swift`
  (registers the new tile kinds and topic providers)
- `ios/UsageMonitor/App/LocalWidgetSnapshotWriter.swift` (now calls
  `WidgetCenter.shared.reloadAllTimelines()` so a correct payload no
  longer waits out the widget's 30-minute `.after(...)` policy)
- `ios/UsageMonitor/App/OfflineCacheSnapshotSink.swift`
- `ios/UsageMonitor/project.yml` (declares the new widget sources; the
  `UsageMonitorWidgetTests` target already lists `UsageMonitorWidgetTests`
  and `UsageMonitorWidget/WidgetPresentation.swift` so both
  `WidgetPresentationTests.swift` and `WidgetSnapshotResolverTests.swift`
  compile in without any further change to `project.yml`)

### Tests

- `ios/UsageMonitor/UsageMonitorWidgetTests/WidgetPresentationTests.swift`
  (11 new widget-presentation tests pinning the new picker, sort, and
  unavailable-content behavior; the reinstall message uses two ASCII
  spaces after a sentence-ending period)
- `ios/UsageMonitor/UsageMonitorWidgetTests/WidgetSnapshotResolverTests.swift`
  (8 new resolver tests pinning the per-section merge, the two payload
  encodings, and the corrupt-Local fallback)
- `ios/UsageMonitor/UsageMonitorWidgetTests/WidgetVisualCaptureTests.swift`
  (simulator-hosted PNG capture for every topic × widget family; driven by
  `scripts/ios-widget-screenshots.sh`)
- `scripts/ios-widget-screenshots.sh`
- `.github/workflows/ios-widget-screenshots.yml`
- `.github/workflows/ios-build.yml` (XcodeGen regen + `UsageMonitorWidgetTests`
  on every iOS PR)

### Docs

- `docs/rollouts/2026-10-04-ios-widget-data-flow.md` (this note)
- `docs/EFFORT-LOG.md` (public copy scrubbed to brand-safe subscription
  quota-windows feature language; internal routing details stay in the
  private operations inventory)

## Decisions & Trade-offs

- **Two filenames, not one:** `local-widget-snapshot.json` (Local app writer)
  and `widget-snapshot-v2.json` (Client writer) coexist by design — the
  resolver merges them per-section so neither app can blank the other.
  Forcing one filename would have re-keyed a keymap every Local install
  had already migrated past.
- **Per-section merge, not newest-wins:** the Local payload's `generatedAt`
  is the device clock and is *always* newer than the server timestamp, so
  a whole-payload newest-wins pick wiped the Client's
  `llm` / `servers` / `mac` / `alerts` / `quotas` sections back to
  "Open the app to load …" on every Local reload.  Per-section merge with
  the budget core coming from the newer payload and the server-owned
  sections preferring the Client's non-nil value was the only fix that
  didn't reintroduce the original "app has data but widget shows stale
  data" loop.
- **Race-safe mirror in `QuotaWindowsStore`:** the previous fix moved the
  write off the main actor (SharedStore.update does a synchronous read +
  decode + encode + atomic write + hardenFile).  Two overlapping refreshes
  could still race because `NSLock` serialises bodies but imposes no
  ordering.  The fix chains the new detached write onto the previous one
  with `Task { [previous = mirrorTask] in await previous?.value; ... }` so
  fetch-completion order is preserved.
- **Quota fetch decoupled from forced reload:** `BGAppRefreshTask`
  consumes `performRefresh()`'s return via `setTaskCompleted(success:)`,
  so a slow subscription-quota response had the ability to delay the
  whole background budget cycle.  The forced `reloadAllTimelines()` now
  fires before `await quotaTask.value`; the quota mirror still lands on
  success.
- **Storage cap ≥ Rows picker max:** `WidgetSnapshotStore.updateBudget`
  defaults to `maxMeters: 8` (Full) so the render-time Rows option is the
  binding limit instead of silently truncating a Standard(4) / Full(8)
  pick to 3.

## Verification State

- `xcodebuild build -scheme UsageMonitor` — **BUILD SUCCEEDED** (hosted
  iOS job, recorded in the previous PR)
- `xcodebuild build -scheme LocalUsageMonitor` — **BUILD SUCCEEDED**
  (hosted iOS job, recorded in the previous PR)
- `xcodebuild test -only-testing:UsageMonitorWidgetTests` —
  **TEST SUCCEEDED**, 62 tests, 0 failures (11 new widget-presentation
  tests, 8 new resolver tests) (hosted iOS job, recorded in the previous
  PR)
- `bash scripts/ios-widget-screenshots.sh` (hosted `macos-latest`,
  `.github/workflows/ios-widget-screenshots.yml`) — writes
  `artifacts/ios-widget-screenshots/<topic>-<family>.png` via
  `WidgetVisualCaptureTests` and adds `simulator-booted.png` via
  `xcrun simctl io <udid> screenshot` — **pending first green CI run on this
  PR** (cannot execute on Linux).
- `swift build` against the iOS package is not runnable on this Linux host
  (the package's networking code is iOS-only and fails to compile for
  macOS), so Swift verification of this branch is hosted-ios-job only.
  No node tests are affected by this branch.

## Next Steps & Blockers

- **First green `ios-widget-screenshots` + extended `ios-build` test job:** both
  workflows now run `xcodegen generate` before `xcodebuild`.  Merge is blocked
  until the PR shows green on those jobs (this cloud seat cannot run them).
- **`xcodegen` regeneration:** `project.yml` is the sole source of truth; CI
  regenerates `UsageMonitor.xcodeproj` on every iOS workflow run.  Do not hand-
  edit `project.pbxproj`.
- **`UsageMonitorKitTests` SwiftPM target** is still not wired into any
  Xcode scheme and cannot be run with `swift test` (pre-existing iOS-only
  networking code).  Not addressed here; resolver tests were placed in
  `UsageMonitorWidgetTests` so they actually execute.

## Zero-Code Findings

- **Fleet-recall lesson (app `usage-monitor`):** searched the corpus
  before re-deriving; the reusable lesson is already stored
  (`contrib/MINIMAX/2026-10-04/126d3acf`): widget handoff regressions can
  survive successful builds when apps write different filenames or
  encodings into one app group, so tests should exercise every writer,
  decode each format, and verify centralized timeline reloads.  No
  duplicate contribution was added.
- **Public routing scrub:** the original rollout copy and
  `docs/EFFORT-LOG.md` exposed an internal subscription-quota routing
  path; both now use the brand-safe "subscription quota windows"
  feature language, and internal routing details stay only in the
  private operations inventory.
- **Two ASCII spaces after sentence-ending periods:** every user-facing
  string added or audited by this PR (notably the reinstall message in
  `WidgetUnavailableContent.init` and the matching assertion in
  `WidgetPresentationTests`) uses two ASCII spaces between sentences.
- **`#agent-sync` pre-work claim:** posted at the start of this lane as
  `repo: usage-monitor …`; the public rollout references the protocol
  (`AGENT-SYNC.md`) and the claim field without exposing the private
  local protocol file path.
