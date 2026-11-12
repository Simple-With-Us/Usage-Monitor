import Foundation

public struct ClaudeCostModelRow: Codable, Hashable, Sendable, Identifiable {
    public var model: String
    public var reportedCostUsd: Double?
    public var derivedCostUsd: Double?
    public var driftRatio: Double?
    public var unpriced: Bool?
    public var id: String { model }
}

public struct ClaudeCostCheckResponse: Codable, Hashable, Sendable {
    public var ok: Bool
    public var days: Int?
    public var models: [ClaudeCostModelRow]?
    public var totalReportedCostUsd: Double?
    public var totalDerivedCostUsd: Double?

    public var hasData: Bool {
        !(models ?? []).isEmpty || (totalReportedCostUsd ?? 0) > 0 || (totalDerivedCostUsd ?? 0) > 0
    }
}
