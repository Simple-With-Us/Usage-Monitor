import Foundation

/// Mirrors the backend `CostCoverage` union
/// (`src/lib/external-usage-events.ts`): how confident the monitor is that a
/// provider's reported spend is complete. Decodes unknown/future values to
/// `.unknown` instead of throwing.
public enum CostCoverage: String, Codable, Hashable, Sendable, CaseIterable {
    case complete
    case partial
    case unknown
    case legacyUnknown = "legacy_unknown"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CostCoverage(rawValue: raw) ?? .unknown
    }

    /// Whether spend is provably complete (used to decide when to caveat a
    /// number in the UI).
    public var isComplete: Bool { self == .complete }

    public var label: String {
        switch self {
        case .complete: return "Complete"
        case .partial: return "Partial"
        case .unknown: return "Unknown"
        case .legacyUnknown: return "Legacy"
        }
    }
}

/// Mirrors `BudgetStatusLevel` in `src/lib/budget-status.ts`.
public enum BudgetLevel: String, Codable, Hashable, Sendable, CaseIterable {
    case ok
    case warning
    case exceeded
    case unconfigured

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = BudgetLevel(rawValue: raw) ?? .unconfigured
    }
}
