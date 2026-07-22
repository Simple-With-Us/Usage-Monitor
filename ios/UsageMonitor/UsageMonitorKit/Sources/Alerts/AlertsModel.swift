import Foundation
import Observation
import Models
import AppCore

/// The severity a user can narrow the *active* list to. `.all` is the default.
public enum AlertSeverityFilter: String, CaseIterable, Identifiable, Hashable, Sendable {
    case all
    case critical
    case warning
    case info

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .all: return "All"
        case .critical: return "Critical"
        case .warning: return "Warning"
        case .info: return "Info"
        }
    }

    /// The domain severity this filter selects, or `nil` for `.all`.
    public var severity: AlertSeverity? {
        switch self {
        case .all: return nil
        case .critical: return .critical
        case .warning: return .warning
        case .info: return .info
        }
    }

    public func matches(_ severity: AlertSeverity) -> Bool {
        self.severity == nil || self.severity == severity
    }
}

/// View-local state for the Alerts screen: the active severity filter plus the
/// resolved-alert tracker. Budget data itself is *not* stored here — it comes
/// from the shared `BudgetStore` the contract mandates as the sole owner of the
/// `budget-status` fetch. This model only owns what is genuinely Alerts-local.
@MainActor
@Observable
public final class AlertsModel {
    public var filter: AlertSeverityFilter = .all
    public let tracker: ResolvedAlertTracker

    public init(tracker: ResolvedAlertTracker? = nil) {
        // Build the default inside the MainActor-isolated init body — a default
        // argument expression is nonisolated and can't call this @MainActor init.
        self.tracker = tracker ?? ResolvedAlertTracker()
    }

    public var resolved: [ResolvedAlert] { tracker.resolved }

    public func useAccountScope(_ scopeID: String?) {
        tracker.useAccountScope(scopeID)
    }

    /// Apply the active severity filter.
    public func filtered(_ items: [ProviderAlertItem]) -> [ProviderAlertItem] {
        items.filter { filter.matches($0.alert.severity) }
    }

    /// Fold a freshly-loaded active set into the resolved tracker.
    public func reconcile(active items: [ProviderAlertItem]) {
        tracker.reconcile(activeItems: items)
    }

    /// Count of active alerts at each severity (for the summary chips / subtitle).
    public func counts(_ items: [ProviderAlertItem]) -> [AlertSeverity: Int] {
        Dictionary(grouping: items, by: { $0.alert.severity }).mapValues(\.count)
    }
}
