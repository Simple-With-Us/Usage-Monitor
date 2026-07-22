import Foundation
import AppCore
import Models
import OfflineCache
import WidgetShared
#if canImport(WidgetKit)
import WidgetKit
#endif

/// Bridges the `OfflineCache` + `WidgetShared` integrations to
/// `AppCore.BudgetSnapshotSink`. Lives in the app target because it is the one
/// place allowed to depend on both AppCore and the integration modules, keeping
/// those modules independent of each other.
///
/// On every successful budget response the shared `BudgetStore` calls
/// ``store(_:)``, which writes the disk cache (offline-first first paint) and a
/// compact `WidgetSnapshot` into the app group (so the widget shows fresh data
/// without launching the app). ``loadCached()`` feeds the offline first paint.
struct OfflineCacheSnapshotSink: BudgetSnapshotSink {
    /// Prefer the app-group container so the widget shares the same cache file;
    /// falls back to the app's Caches directory when unavailable.
    private var directory: URL? { AppGroup.containerURL }

    func store(_ response: BudgetStatusResponse) async {
        BudgetDiskCache(directory: directory).save(response)
        SharedStore.shared.write(WidgetSnapshotBuilder.snapshot(from: response))
        // Foreground pull-to-refresh must refresh the home-screen widget too;
        // do not wait for the next BGAppRefresh (~hours).
        #if canImport(WidgetKit) && os(iOS)
        WidgetCenter.shared.reloadAllTimelines()
        #endif
    }

    func loadCached() async -> BudgetStatusResponse? {
        BudgetDiskCache(directory: directory).load()
    }

    /// Synchronous identity boundary for host/token/session changes. Both
    /// stores perform bounded local deletes, so there is no termination window
    /// in which another identity's money remains visible.
    func invalidate() {
        BudgetDiskCache(directory: directory).clear()
        SharedStore.shared.clear()
        reloadWidgets()
    }

    /// Clear disk cache + widget snapshot (sign-out). Also called through the
    /// serialized async cache-operation queue as a defensive second pass.
    func clear() async {
        invalidate()
    }

    private func reloadWidgets() {
        #if canImport(WidgetKit) && os(iOS)
        WidgetCenter.shared.reloadAllTimelines()
        #endif
    }
}
