import Foundation
import Models
import WidgetShared

#if canImport(WidgetKit)
import WidgetKit
#endif

/// Merge-writes compact widget sections into the shared app-group snapshot.
/// Budget, LLM, server, and Mac refreshes each update only their own fields
/// so a successful budget poll cannot wipe a later LLM, host, or Mac cache.
public enum WidgetSnapshotStore {

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

    public static func updateQuotas(_ response: QuotaWindowsResponse, now: Date = Date()) {
        let section = WidgetSnapshotBuilder.quotaSection(from: response, now: now)
        SharedStore.shared.update { current in
            current = current.replacingQuotas(section)
        }
        reloadWidgetsIfNeeded()
    }

    public static func reloadWidgetsIfNeeded(force: Bool = false, now: Date = Date()) {
        // Single throttle + WidgetCenter call now live in one shared reloader
        // so the Client and the Local app cannot drift apart again.
        WidgetTimelineReloader.reload(force: force, now: now)
    }
}
