import Foundation

/// `GET /api/b2-app-usage` — fleet Backblaze B2 breakdown (storage + daily usage).
public struct B2AppUsageBreakdown: Codable, Hashable, Sendable {
    public struct LatestDay: Codable, Hashable, Sendable {
        public var date: String
        public var storedGb: Double
        public var downloadedGb: Double
        public var classCTransactions: Int
        public var classBTransactions: Int
    }

    public struct AppSlice: Codable, Hashable, Sendable, Identifiable {
        public var id: String
        public var label: String
        public var bucketNames: [String]
        public var storageGb: Double
        public var latestDay: LatestDay?
    }

    public struct Alerts: Codable, Hashable, Sendable {
        public var classCNearCap: Bool
        public var downloadNearCap: Bool
        public var classCSpike: Bool
    }

    public struct Caps: Codable, Hashable, Sendable {
        public var classCDailyFree: Int
        public var downloadGbDailyFree: Double
    }

    public var configured: Bool
    public var asOf: String
    public var cacheAgeSeconds: Int
    public var reportDate: String?
    public var storageSource: String
    public var reportSource: String
    public var warnings: [String]
    public var caps: Caps
    public var alerts: Alerts
    public var apps: [AppSlice]
}
