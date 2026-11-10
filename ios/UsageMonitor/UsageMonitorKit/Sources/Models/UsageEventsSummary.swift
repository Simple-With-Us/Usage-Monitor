import Foundation

/// Bounded summary from `GET /api/usage-events` (session-gated).
/// Only the fields Overview's chart-range card consumes.
public struct UsageEventsSummary: Codable, Hashable, Sendable {
    public var mode: String?
    public var days: Int?
    public var totalCostUsd: Double
    public var receiptCashPaidUsd: Double?
    public var groups: [UsageEventsGroup]?

    public init(
        mode: String? = "summary",
        days: Int? = nil,
        totalCostUsd: Double = 0,
        receiptCashPaidUsd: Double? = nil,
        groups: [UsageEventsGroup]? = nil
    ) {
        self.mode = mode
        self.days = days
        self.totalCostUsd = totalCostUsd
        self.receiptCashPaidUsd = receiptCashPaidUsd
        self.groups = groups
    }

    public var groupCount: Int { groups?.count ?? 0 }

    /// Top groups by cost for a compact list.
    public func topGroups(limit: Int = 5) -> [UsageEventsGroup] {
        guard limit > 0 else { return [] }
        return (groups ?? [])
            .sorted { $0.totalCostUsd > $1.totalCostUsd }
            .prefix(limit)
            .map { $0 }
    }
}

public struct UsageEventsGroup: Codable, Hashable, Sendable, Identifiable {
    public var sourceApp: String?
    public var provider: String?
    public var projectName: String?
    public var metricType: String?
    public var totalCostUsd: Double
    public var eventCount: Int?

    public var id: String {
        [
            sourceApp ?? "",
            provider ?? "",
            projectName ?? "",
            metricType ?? "",
            String(totalCostUsd),
        ].joined(separator: "|")
    }

    public init(
        sourceApp: String? = nil,
        provider: String? = nil,
        projectName: String? = nil,
        metricType: String? = nil,
        totalCostUsd: Double = 0,
        eventCount: Int? = nil
    ) {
        self.sourceApp = sourceApp
        self.provider = provider
        self.projectName = projectName
        self.metricType = metricType
        self.totalCostUsd = totalCostUsd
        self.eventCount = eventCount
    }

    public var title: String {
        let provider = (self.provider ?? "").trimmingCharacters(in: .whitespaces)
        if !provider.isEmpty { return provider }
        let app = (sourceApp ?? "").trimmingCharacters(in: .whitespaces)
        return app.isEmpty ? "Usage" : app
    }
}
