# 2026-10-06 — iOS Widget Data Flow: Container Fallback, Throttling & Pre-fetch

## Context

iOS widgets for Usage Client Monitor remained stuck displaying placeholder text (e.g. "Mac / Open the app to load Mac stats"), even after users launched the app and confirmed that the host app was fully populated with real stats.

Investigation isolated three distinct root causes:
1. **Container Read/Write & Sandbox Failure in `SharedStore.swift`**:
   - `writeUnlocked` previously skipped writing to the shared `UserDefaults` suite whenever `fileURL` existed.  If file container access failed in the widget process or was unentitled/sandboxed, the widget had no fallback.
   - `readUnlocked` read files using `Data(contentsOf: fileURL, options: .mappedIfSafe)`.  In WidgetKit extensions, memory-mapped reads frequently fail or cause process jetsam under strict widget memory limits.
   - When a file read threw an error, `readUnlocked` called `try? fileManager.removeItem(at: fileURL)` and `defaults.removeObject(forKey: Self.defaultsKey)`, actively destroying the persistent fallback cache instead of falling back to it.
2. **Aggressive Reload Throttling in `WidgetSnapshotStore.swift`**:
   - The reload throttle was set to 60 seconds with no trailing debouncing or retry task.  When the app launched, initial budget polling consumed the throttle window.  Subsequent updates from tabs opened 2–10 seconds later (such as Computers or Servers) were silently dropped.
3. **No Background Invalidation & Lazy Secondary Fetching**:
   - Foreground app launches only polled `GET /api/budget-status`.  Secondary endpoints (Mac health, Server status, LLM burn) were only fetched when the user manually navigated to those specific tabs.
   - Backgrounding the app never force-reloaded widget timelines.
   - `WidgetSnapshotBuilder.macSection` mapped raw `mac?.arch` rather than `mac?.chipName ?? mac?.arch`, showing raw architectures instead of human-friendly chip names (e.g. "Apple M5").

## Changes

- `ios/UsageMonitor/UsageMonitorKit/Sources/WidgetShared/SharedStore.swift`:
  - Dual-writes unconditionally to `defaults` (`UserDefaults(suiteName: "group.com.simplewithus.usage")`) as well as `fileURL`.
  - Removed `.mappedIfSafe` from `Data(contentsOf: fileURL)` to prevent extension mmap failures.
  - Safe fallback: file read errors no longer delete defaults, allowing seamless degradation to cached shared defaults.
- `ios/UsageMonitor/UsageMonitorKit/Sources/OfflineCache/WidgetSnapshotStore.swift`:
  - Reduced reload throttle interval from 60s to 5s.
  - Added trailing debounced reload task (`pendingReloadTask`) so updates arriving during the throttle window trigger a trailing reload instead of being silently lost.
  - Added `refreshSecondarySections(using:)` to pre-fetch LLM burn, Server health/readiness, and Mac stats concurrently in parallel.
- `ios/UsageMonitor/UsageMonitorKit/Sources/Computers/ComputersStore.swift`:
  - Calls `WidgetSnapshotStore.reloadWidgetsIfNeeded(force: true)` immediately after fetching Mac health.
- `ios/UsageMonitor/UsageMonitorKit/Sources/OfflineCache/WidgetSnapshotBuilder.swift`:
  - Prefers `mac?.chipName ?? mac?.arch` for `arch` field in `macSection`.
- `ios/UsageMonitor/UsageMonitorKit/Sources/OfflineCache/BackgroundRefreshManager.swift`:
  - Delegates secondary widget refresh to `WidgetSnapshotStore.refreshSecondarySections(using: client)`.
- `ios/UsageMonitor/App/UsageMonitorApp.swift`:
  - Calls `WidgetSnapshotStore.refreshSecondarySections(using: environment.apiClient)` on app launch (`.task`) and foreground reactivation (`phase == .active`).
  - Calls `WidgetSnapshotStore.reloadWidgetsIfNeeded(force: true)` on backgrounding (`phase == .background`).
- `ios/UsageMonitor/UsageMonitorKit/Tests/UsageMonitorKitTests/OfflineCacheTests.swift`:
  - Added regression assertion verifying `chipName` preference in `macSection`.
- `ios/UsageMonitor/UsageMonitorKit/Tests/UsageMonitorKitTests/RangeSpendSeriesTests.swift`:
  - Fixed test unwrap compiler error (`testBuildSumsMultipleRowsPerDay`).

## Verification

- `xcodebuild -scheme UsageMonitorKitTests -destination 'id=5EE1D9F3-7622-4CEA-B1A0-19AE9CA0AB21' test CODE_SIGNING_ALLOWED=NO -only-testing:UsageMonitorKitTests/OfflineCacheTests`: 36/36 passed.
- `xcodebuild -scheme UsageMonitor -destination 'id=5EE1D9F3-7622-4CEA-B1A0-19AE9CA0AB21' test CODE_SIGNING_ALLOWED=NO -only-testing:UsageMonitorWidgetTests`: 41/41 passed.
- `xcodebuild -scheme UsageMonitor -destination 'id=5EE1D9F3-7622-4CEA-B1A0-19AE9CA0AB21' test CODE_SIGNING_ALLOWED=NO -only-testing:UsageMonitorTests`: 2/2 passed.
- `bash scripts/verify-apple-projects.sh`: BUILD SUCCEEDED across all Apple project targets.

## Related

- Board `b7e41f2a`
