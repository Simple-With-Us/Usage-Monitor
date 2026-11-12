import DesignSystem
import Models

// ---------------------------------------------------------------------------
// The bridge between domain enums (Models) and the model-free DesignSystem.
//
// DesignSystem components take a `Theme.SemanticStatus`; the Models layer knows
// nothing about DesignSystem. AppCore depends on both, so the mapping lives
// here. Every feature maps its domain value at the call site, e.g.
//
//     BudgetMeter(fraction: p.percentUsed ?? 0, status: .init(p.status))
//     StatusBadge(alert.title, status: .init(alert.severity), systemImage: alert.symbolName)
// ---------------------------------------------------------------------------

public extension Theme.SemanticStatus {
    /// Map a provider/project `BudgetLevel` onto the design-system status.
    init(_ level: BudgetLevel) {
        switch level {
        case .ok: self = .ok
        case .warning: self = .warning
        case .exceeded: self = .danger
        case .unconfigured: self = .neutral
        }
    }

    /// Map an `AlertSeverity` onto the design-system status.
    init(_ severity: AlertSeverity) {
        switch severity {
        case .info: self = .neutral
        case .warning: self = .warning
        case .critical: self = .danger
        }
    }

    /// Map spend `CostCoverage` onto a status for caveat badges — complete
    /// reads neutral (no caveat needed), anything less reads as a warning.
    init(coverage: CostCoverage) {
        self = coverage.isComplete ? .neutral : .warning
    }
}
