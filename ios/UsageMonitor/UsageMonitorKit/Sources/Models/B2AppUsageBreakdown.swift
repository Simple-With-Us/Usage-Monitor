import Foundation

/// Rounds a JSON number to an `Int` without ever trapping: NaN, infinite and
/// out-of-range values (e.g. a garbled `1e19` CSV cell) become zero instead
/// of hitting Swift's fatal Double-to-Int conversion error.
public func b2SafeRoundedInt(_ value: Double) -> Int {
    guard value.isFinite, let exact = Int(exactly: value.rounded()) else {
        return 0
    }
    return exact
}

/// Decodes an integer the server may have sent as a JSON number with a
/// fractional part, defaulting to zero when the key is absent or the value
/// is not representable.
private func decodeTolerantInt<Key: CodingKey>(
    from container: KeyedDecodingContainer<Key>,
    forKey key: Key
) -> Int {
    if let exact = try? container.decode(Int.self, forKey: key) {
        return exact
    }
    if let fractional = try? container.decode(Double.self, forKey: key) {
        return b2SafeRoundedInt(fractional)
    }
    return 0
}

/// `GET /api/b2-app-usage` — fleet Backblaze B2 breakdown (storage + daily usage).
public struct B2AppUsageBreakdown: Codable, Hashable, Sendable {
    /// Latest Backblaze report day for one app.  Decoded tolerantly for the
    /// same reason as `DailyAppUsage`: a fractional transaction count from the
    /// CSV parser must not fail the whole payload.
    public struct LatestDay: Codable, Hashable, Sendable {
        public var date: String
        public var storedGb: Double
        public var downloadedGb: Double
        public var classCTransactions: Int
        public var classBTransactions: Int

        public init(
            date: String,
            storedGb: Double,
            downloadedGb: Double,
            classCTransactions: Int,
            classBTransactions: Int
        ) {
            self.date = date
            self.storedGb = storedGb
            self.downloadedGb = downloadedGb
            self.classCTransactions = classCTransactions
            self.classBTransactions = classBTransactions
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            date = (try? container.decodeIfPresent(String.self, forKey: .date)) ?? ""
            storedGb = (try? container.decodeIfPresent(Double.self, forKey: .storedGb)) ?? 0
            downloadedGb =
                (try? container.decodeIfPresent(Double.self, forKey: .downloadedGb)) ?? 0
            classCTransactions = decodeTolerantInt(from: container, forKey: .classCTransactions)
            classBTransactions = decodeTolerantInt(from: container, forKey: .classBTransactions)
        }

        private enum CodingKeys: String, CodingKey {
            case date
            case storedGb
            case downloadedGb
            case classCTransactions
            case classBTransactions
        }
    }

    public struct AppSlice: Codable, Hashable, Sendable, Identifiable {
        public var id: String
        public var label: String
        public var bucketNames: [String]
        public var storageGb: Double
        public var latestDay: LatestDay?

        public init(
            id: String,
            label: String,
            bucketNames: [String],
            storageGb: Double,
            latestDay: LatestDay?
        ) {
            self.id = id
            self.label = label
            self.bucketNames = bucketNames
            self.storageGb = storageGb
            self.latestDay = latestDay
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            label = (try? container.decodeIfPresent(String.self, forKey: .label)) ?? ""
            bucketNames =
                (try? container.decodeIfPresent([String].self, forKey: .bucketNames)) ?? []
            storageGb = (try? container.decodeIfPresent(Double.self, forKey: .storageGb)) ?? 0
            // A malformed latest day degrades to "no latest day" for this app
            // instead of failing the slice (and with it the whole payload).
            latestDay = try? container.decodeIfPresent(LatestDay.self, forKey: .latestDay)
        }

        private enum CodingKeys: String, CodingKey {
            case id
            case label
            case bucketNames
            case storageGb
            case latestDay
        }
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

    /// Human labels for every server `B2AppId`, mirroring `B2_APP_LABELS`
    /// on web.  Used when the daily series names an app the `apps` list
    /// omits (an app with buckets only on an older day).
    public static let appLabels: [String: String] = [
        "usage-monitor": "Usage Monitor",
        "socratic-trade": "Socratic.Trade",
        "congress-trade": "Congress.Trade",
        "fleet-infra": "Fleet Infra",
        "other": "Other",
    ]

    /// Friendly label for an app id: the known label, else the id humanized
    /// ("new-app" → "New App"), else "Other app".  Never the raw id.
    public static func displayLabel(forAppId appId: String) -> String {
        if let known = appLabels[appId] { return known }
        let words = appId
            .split(whereSeparator: { $0 == "-" || $0 == "_" || $0 == " " })
            .map { String($0.prefix(1)).uppercased() + String($0.dropFirst()) }
        return words.isEmpty ? "Other app" : words.joined(separator: " ")
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
        // Decode app slices one by one so a single malformed slice is dropped
        // rather than failing the whole payload.
        if var appsContainer = try? container.nestedUnkeyedContainer(forKey: .apps) {
            var decoded: [AppSlice] = []
            while !appsContainer.isAtEnd {
                if let slice = try? appsContainer.decode(AppSlice.self) {
                    decoded.append(slice)
                } else if (try? appsContainer.decode(B2SkippedElement.self)) == nil {
                    // Could not even skip the element; stop rather than spin.
                    break
                }
            }
            apps = decoded
        } else {
            apps = []
        }
        // Tolerate payloads without a daily series (or with a malformed one):
        // the daily view simply renders nothing instead of failing the card.
        dailySeries = (try? container.decode([DailyPoint].self, forKey: .dailySeries)) ?? []
    }
}

/// Consumes one element of an unkeyed container regardless of its shape.
private struct B2SkippedElement: Decodable {
    init(from decoder: Decoder) throws {}
}
