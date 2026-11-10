import Foundation

/// Mirrors `AlertSeverity` in `src/lib/provider-alerts.ts`.
public enum AlertSeverity: String, Codable, Hashable, Sendable {
    case critical
    case warning
    case info

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AlertSeverity(rawValue: raw) ?? .info
    }

    /// Sort weight so criticals surface first.
    public var order: Int {
        switch self {
        case .critical: return 0
        case .warning: return 1
        case .info: return 2
        }
    }
}

/// Mirrors `ProviderAlert` in `src/lib/provider-alerts.ts`. The `code` is kept
/// as a raw string (decoded into a known enum where possible) so a
/// newly-added backend alert code never breaks decoding.
public struct ProviderAlert: Codable, Hashable, Sendable, Identifiable {
    public var code: String
    public var severity: AlertSeverity
    public var message: String

    public init(code: String, severity: AlertSeverity, message: String) {
        self.code = code
        self.severity = severity
        self.message = message
    }

    /// Stable identity for SwiftUI lists — an alert is unique per (code,
    /// message) within a provider.
    public var id: String { "\(code)|\(message)" }

    /// Known alert codes with a human title + SF Symbol. Unknown codes fall
    /// back to a generic presentation.
    public var title: String {
        switch code {
        case "budget_exceeded": return "Budget exceeded"
        case "budget_warning": return "Approaching budget"
        case "fixed_cost_conflict": return "Fixed cost conflict"
        case "billing_sync_incomplete": return "Billing sync incomplete"
        case "balance_low": return "Low balance"
        case "credits_low": return "Low credits"
        case "request_limit": return "Request limit reached"
        case "request_limit_warning": return "Approaching request limit"
        case "renewal_overdue": return "Renewal overdue"
        case "renewal_due": return "Renewal due soon"
        case "missing_balance_visibility": return "Balance not visible"
        case "stale_snapshot": return "Sync lag" // legacy code; no longer emitted
        case "missing_snapshot": return "No recent data"
        case "unconfigured_budget": return "Budget not configured"
        case "usage_reconciliation_discrepancy": return "Usage discrepancy"
        case "spend_anomaly": return "Spend anomaly"
        case "request_anomaly": return "Request anomaly"
        case "budget_control_paused": return "Auto-paused on budget breach"
        case "key_disable_recommended": return "Key disable recommended"
        default: return code.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    public var symbolName: String {
        switch code {
        case "budget_exceeded": return "exclamationmark.octagon.fill"
        case "budget_warning": return "gauge.with.dots.needle.67percent"
        case "balance_low", "credits_low": return "creditcard.trianglebadge.exclamationmark"
        case "request_limit", "request_limit_warning": return "chart.bar.xaxis"
        case "renewal_overdue", "renewal_due": return "calendar.badge.exclamationmark"
        case "stale_snapshot", "missing_snapshot": return "clock.badge.exclamationmark"
        case "billing_sync_incomplete": return "arrow.triangle.2.circlepath"
        case "fixed_cost_conflict": return "arrow.triangle.merge"
        case "usage_reconciliation_discrepancy": return "scalemass"
        case "spend_anomaly": return "chart.line.uptrend.xyaxis"
        case "request_anomaly": return "chart.bar.fill"
        case "budget_control_paused": return "pause.circle.fill"
        case "key_disable_recommended": return "key.fill"
        default: return "bell.badge"
        }
    }
}
