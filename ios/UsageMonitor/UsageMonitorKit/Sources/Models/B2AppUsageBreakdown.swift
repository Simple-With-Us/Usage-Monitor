import Foundation

/// Decodes an integer the server may have sent as a JSON number with a
/// fractional part, defaulting to zero when the key is absent.
private func decodeTolerantInt<Key: CodingKey>(
    from container: KeyedDecodingContainer<Key>,
    forKey key: Key
) -> Int {
    if let exact = try? container.decode(Int.self, forKey: key) {
        return exact
    }
    if let fractional = try? container.decode(Double.self, forKey: key) {
        return Int(fractional.rounded())
    }
    return 0
}

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

    /// One app's usage inside a single day of the daily series.
    ///
    /// Decoding is deliberately tolerant: the server's CSV parser can emit a
    /// fractional transaction count, and a missing field must not take the
    /// whole payload down.
    public struct DailyAppUsage: Codable, Hashable, Sendable {
        public var downloadedGb: Double
        public var classCTransactions: Int

        public init(downloadedGb: Double, classCTransactions: Int) {
            self.downloadedGb = downloadedGb
            self.classCTransactions = classCTransactions
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            downloadedGb = try container.decodeIfPresent(Double.self, forKey: .downloadedGb) ?? 0
            classCTransactions = decodeTolerantInt(
                from: container,
                forKey: .classCTransactions
            )
        }

        private enum CodingKeys: String, CodingKey {
            case downloadedGb
            case classCTransactions
        }
    }

    /// One calendar day of the fleet's B2 usage, split by app.
    public struct DailyPoint: Codable, Hashable, Sendable, Identifiable {
        public var date: String
        public var accountDownloadedGb: Double
        public var accountClassCTotal: Int
        public var byApp: [String: DailyAppUsage]

        public var id: String { date }

        public init(
            date: String,
            accountDownloadedGb: Double = 0,
            accountClassCTotal: Int = 0,
            byApp: [String: DailyAppUsage] = [:]
        ) {
            self.date = date
            self.accountDownloadedGb = accountDownloadedGb
            self.accountClassCTotal = accountClassCTotal
            self.byApp = byApp
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            date = try container.decodeIfPresent(String.self, forKey: .date) ?? ""
            accountDownloadedGb =
                try container.decodeIfPresent(Double.self, forKey: .accountDownloadedGb) ?? 0
            accountClassCTotal = decodeTolerantInt(
                from: container,
                forKey: .accountClassCTotal
            )
            byApp = (try? container.decode([String: DailyAppUsage].self, forKey: .byApp)) ?? [:]
        }

        private enum CodingKeys: String, CodingKey {
            case date
            case accountDownloadedGb
            case accountClassCTotal
            case byApp
        }
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
    /// Per-day usage split by app.  Missing on older payloads — decodes empty.
    public var dailySeries: [DailyPoint]

    public init(
        configured: Bool,
        asOf: String,
        cacheAgeSeconds: Int,
        reportDate: String?,
        storageSource: String,
        reportSource: String,
        warnings: [String],
        caps: Caps,
        alerts: Alerts,
        apps: [AppSlice],
        dailySeries: [DailyPoint] = []
    ) {
        self.configured = configured
        self.asOf = asOf
        self.cacheAgeSeconds = cacheAgeSeconds
        self.reportDate = reportDate
        self.storageSource = storageSource
        self.reportSource = reportSource
        self.warnings = warnings
        self.caps = caps
        self.alerts = alerts
        self.apps = apps
        self.dailySeries = dailySeries
    }

    private enum CodingKeys: String, CodingKey {
        case configured
        case asOf
        case cacheAgeSeconds
        case reportDate
        case storageSource
        case reportSource
        case warnings
        case caps
        case alerts
        case apps
        case dailySeries
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        configured = try container.decode(Bool.self, forKey: .configured)
        asOf = try container.decode(String.self, forKey: .asOf)
        cacheAgeSeconds = try container.decode(Int.self, forKey: .cacheAgeSeconds)
        reportDate = try container.decodeIfPresent(String.self, forKey: .reportDate)
        storageSource = try container.decode(String.self, forKey: .storageSource)
        reportSource = try container.decode(String.self, forKey: .reportSource)
        warnings = try container.decodeIfPresent([String].self, forKey: .warnings) ?? []
        caps = try container.decode(Caps.self, forKey: .caps)
        alerts = try container.decode(Alerts.self, forKey: .alerts)
        apps = try container.decodeIfPresent([AppSlice].self, forKey: .apps) ?? []
        // Tolerate payloads without a daily series (or with a malformed one):
        // the daily view simply renders nothing instead of failing the card.
        dailySeries = (try? container.decode([DailyPoint].self, forKey: .dailySeries)) ?? []
    }
}
