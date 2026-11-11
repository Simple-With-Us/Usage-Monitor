import Foundation

/// Bounded per-day export from `GET /api/export/daily-rollups` (session-gated).
/// The route returns many more per-row breakdown fields (see
/// `src/app/api/export/daily-rollups/route.ts`) than the Overview chart-range
/// card needs — only `day` and `totalCostUsd` are decoded here; unknown keys
/// are ignored by `Codable` automatically.
public struct DailyRollupsResponse: Codable, Hashable, Sendable {
    public var from: String
    public var to: String
    public var rowCount: Int?
    public var truncated: Bool?
    public var rows: [DailyRollupRow]

    public init(
        from: String,
        to: String,
        rowCount: Int? = nil,
        truncated: Bool? = nil,
        rows: [DailyRollupRow] = []
    ) {
        self.from = from
        self.to = to
        self.rowCount = rowCount
        self.truncated = truncated
        self.rows = rows
    }
}

/// One `ExternalUsageEventDailyRollup` row. Multiple rows can share the same
/// `day` (one per `groupKey`) — callers building a daily total must sum
/// across rows for a given day, not assume one row per day.
public struct DailyRollupRow: Codable, Hashable, Sendable {
    public var day: String
    public var totalCostUsd: Double

    public init(day: String, totalCostUsd: Double) {
        self.day = day
        self.totalCostUsd = totalCostUsd
    }
}
