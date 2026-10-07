import Foundation
import Models
import Networking
import WidgetShared

#if canImport(WidgetKit)
import WidgetKit
#endif

/// Merge-writes compact widget sections into the shared app-group snapshot.
/// Budget, LLM, server, and Mac refreshes each update only their own fields
/// so a successful budget poll cannot wipe a later LLM, host, or Mac cache.
public enum WidgetSnapshotStore {
    private static var lastWidgetReload = Date.distantPast
    private static let minimumWidgetReloadInterval: TimeInterval = 5
    private static var hasPendingReload = false
    private static var pendingReloadTask: Task<Void, Never>?
    private static let reloadLock = NSLock()

    public static func updateBudget(_ response: BudgetStatusResponse, maxMeters: Int = 3) {
        let budget = WidgetSnapshotBuilder.snapshot(from: response, maxMeters: maxMeters)
        SharedStore.shared.update { current in
            current = budget.mergingPreservedSections(from: current)
        }
        reloadWidgetsIfNeeded()
    }

    public static func updateLlm(_ response: LlmBurnResponse, now: Date = Date()) {
        guard let section = WidgetSnapshotBuilder.llmSection(from: response, now: now) else { return }
        SharedStore.shared.update { current in
            current = current.replacingLlm(section)
        }
        reloadWidgetsIfNeeded()
    }

    public static func updateServerService(
        health: ServerHealth,
        readiness: ServerReadiness?,
        now: Date = Date()
    ) {
        let service = WidgetSnapshotBuilder.serverService(health: health, readiness: readiness, now: now)
        SharedStore.shared.update { current in
            current = current.replacingServerService(service)
        }
        reloadWidgetsIfNeeded()
    }

    public static func updateServerHost(_ metrics: ServerMetrics, now: Date = Date()) {
        let projected = WidgetSnapshotBuilder.serverHost(from: metrics, now: now)
        SharedStore.shared.update { current in
            current = current.replacingServerHost(projected.host, apps: projected.apps)
        }
        reloadWidgetsIfNeeded()
    }

    public static func updateMac(_ response: MacHealthResponse, now: Date = Date()) {
        let section = WidgetSnapshotBuilder.macSection(from: response, now: now)
        SharedStore.shared.update { current in
            current = current.replacingMac(section)
        }
        reloadWidgetsIfNeeded()
    }

    private static var inFlightRefreshTask: Task<Void, Never>?
    private static let refreshLock = NSLock()

    /// Best-effort pre-fetch of LLM, Server, and Mac data so all home-screen widgets
    /// load real stats even if the user hasn't manually opened every tab.
    public static func refreshSecondarySections(using client: APIClient) async {
        refreshLock.lock()
        if let existing = inFlightRefreshTask {
            refreshLock.unlock()
            await existing.value
            return
        }

        let task = Task {
            async let llmTask: Void = {
                if let burn = try? await client.llmBurn() {
                    updateLlm(burn)
                }
            }()
            async let serverTask: Void = {
                if let health = try? await client.health() {
                    let readiness = try? await client.readiness()
                    updateServerService(health: health, readiness: readiness)
                }
                if let metrics = try? await client.serverMetrics() {
                    updateServerHost(metrics)
                }
            }()
            async let macTask: Void = {
                if let mac = try? await client.macHealth() {
                    updateMac(mac)
                }
            }()
            _ = await (llmTask, serverTask, macTask)
            reloadWidgetsIfNeeded(force: true)
        }
        inFlightRefreshTask = task
        refreshLock.unlock()

        await task.value

        refreshLock.lock()
        if inFlightRefreshTask == task {
            inFlightRefreshTask = nil
        }
        refreshLock.unlock()
    }

    public static func reloadWidgetsIfNeeded(force: Bool = false, now: Date = Date()) {
        reloadLock.lock()
        defer { reloadLock.unlock() }

        if force || now.timeIntervalSince(lastWidgetReload) >= minimumWidgetReloadInterval {
            lastWidgetReload = now
            hasPendingReload = false
            pendingReloadTask?.cancel()
            pendingReloadTask = nil
            #if canImport(WidgetKit) && os(iOS)
            WidgetCenter.shared.reloadAllTimelines()
            #endif
            return
        }

        // Schedule a trailing reload so that secondary updates (e.g. Mac stats,
        // Server status) fetched shortly after initial budget load are not dropped.
        guard !hasPendingReload else { return }
        hasPendingReload = true
        let delay = minimumWidgetReloadInterval - now.timeIntervalSince(lastWidgetReload)
        pendingReloadTask = Task {
            try? await Task.sleep(nanoseconds: UInt64(max(delay, 0.5) * 1_000_000_000))
            if !Task.isCancelled {
                reloadWidgetsIfNeeded(force: true)
            }
        }
    }
}
