import Foundation

/// Snapshot history window options for `GET /api/snapshots?days=`, matching
/// the website provider-detail range control (7 / 30 / 90 / 365 days).
public enum SnapshotHistoryRange: Int, CaseIterable, Identifiable, Sendable, Hashable {
    case sevenDays = 7
    case thirtyDays = 30
    case ninetyDays = 90
    case oneYear = 365

    public var id: Int { rawValue }

    /// Query parameter value for `/api/snapshots?days=`.
    public var days: Int { rawValue }

    /// Compact segmented-control label (e.g. "7d", "1y").
    public var shortLabel: String {
        switch self {
        case .sevenDays: return "7d"
        case .thirtyDays: return "30d"
        case .ninetyDays: return "90d"
        case .oneYear: return "1y"
        }
    }

    /// Full label for captions and accessibility (e.g. "7 days", "1 year").
    public var displayLabel: String {
        switch self {
        case .sevenDays: return "Past 7 days"
        case .thirtyDays: return "Past 30 days"
        case .ninetyDays: return "Past 90 days"
        case .oneYear: return "Past year"
        }
    }

    public static let `default`: SnapshotHistoryRange = .thirtyDays
}

/// One point from `GET /api/snapshots` — either a raw `UsageSnapshot` row or a
/// daily rollup synthesized server-side (older history past the raw-retention
/// cutoff arrives as `rollup: true` rows carrying the day's latest values).
/// Only the subset the native history chart consumes is modeled.
public struct UsageSnapshotPoint: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var providerId: String
    public var fetchedAt: String
    public var balance: Double?
    public var totalCost: Double?
    public var totalRequests: Double?
    public var credits: Double?
    /// Present (and `true`) only on server-synthesized daily rollup rows.
    public var rollup: Bool?
    public var sampleCount: Int?

    public init(
        id: String,
        providerId: String,
        fetchedAt: String,
        balance: Double? = nil,
        totalCost: Double? = nil,
        totalRequests: Double? = nil,
        credits: Double? = nil,
        rollup: Bool? = nil,
        sampleCount: Int? = nil
    ) {
        self.id = id
        self.providerId = providerId
        self.fetchedAt = fetchedAt
        self.balance = balance
        self.totalCost = totalCost
        self.totalRequests = totalRequests
        self.credits = credits
        self.rollup = rollup
        self.sampleCount = sampleCount
    }

    public var fetchedDate: Date? {
        ISO8601DateParser.date(from: fetchedAt)
    }

    public var isRollup: Bool { rollup ?? false }
}

/// One provider-reported billing record from the `externalBilling` array of
/// `GET /api/providers/:id`. Read-only evidence synced from the provider's own
/// billing API; it never creates or duplicates local Subscription charges.
/// Only the compact subset the native billing card renders is modeled.
public struct ExternalBillingRecord: Codable, Hashable, Sendable, Identifiable {
    public var source: String
    public var externalId: String?
    public var kind: String
    public var serviceName: String?
    public var planName: String?
    public var status: String?
    public var amountUsd: Double?
    public var currency: String?
    public var billingInterval: String?
    public var currentPeriodStart: String?
    public var currentPeriodEnd: String?
    public var nextRenewalAt: String?
    public var usageQuantity: Double?
    public var usageUnit: String?
    public var syncedAt: String

    public init(
        source: String,
        externalId: String? = nil,
        kind: String,
        serviceName: String? = nil,
        planName: String? = nil,
        status: String? = nil,
        amountUsd: Double? = nil,
        currency: String? = nil,
        billingInterval: String? = nil,
        currentPeriodStart: String? = nil,
        currentPeriodEnd: String? = nil,
        nextRenewalAt: String? = nil,
        usageQuantity: Double? = nil,
        usageUnit: String? = nil,
        syncedAt: String
    ) {
        self.source = source
        self.externalId = externalId
        self.kind = kind
        self.serviceName = serviceName
        self.planName = planName
        self.status = status
        self.amountUsd = amountUsd
        self.currency = currency
        self.billingInterval = billingInterval
        self.currentPeriodStart = currentPeriodStart
        self.currentPeriodEnd = currentPeriodEnd
        self.nextRenewalAt = nextRenewalAt
        self.usageQuantity = usageQuantity
        self.usageUnit = usageUnit
        self.syncedAt = syncedAt
    }

    /// Stable identity matching the web's key convention
    /// (`source-externalId|kind`), with service/plan disambiguation.
    public var id: String {
        "\(source)|\(externalId ?? kind)|\(serviceName ?? planName ?? "")"
    }

    /// Human label: the provider's service name, else plan name, else kind.
    public var displayName: String {
        for candidate in [serviceName, planName] {
            if let value = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
               !value.isEmpty {
                return value
            }
        }
        return kind
    }

    /// Readable application / project name mapped from bucket or service names.
    public var resolvedAppName: String {
        let raw = (serviceName ?? planName ?? externalId ?? kind).lowercased()
        if raw.contains("socratic") {
            return "Socratic.Trade"
        }
        if raw.contains("congress") {
            return "Congress.Trade"
        }
        if raw.contains("usage-monitor") || raw.contains("usagemonitor") {
            return "Usage Monitor"
        }
        if raw.contains("fleet") {
            return "Fleet Infra"
        }

        // Clean common bucket prefixes/suffixes: "jays-foo-eu" -> "Foo"
        var cleaned = serviceName ?? displayName
        if cleaned.lowercased().hasPrefix("jays-") {
            cleaned = String(cleaned.dropFirst(5))
        }
        if cleaned.lowercased().hasSuffix("-eu") {
            cleaned = String(cleaned.dropLast(3))
        } else if cleaned.lowercased().hasSuffix("-us") {
            cleaned = String(cleaned.dropLast(3))
        }

        let words = cleaned.replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
        let result = words.joined(separator: " ")
        return result.isEmpty ? displayName : result
    }

    /// Formatted usage quantity (e.g. "150.0 GB") or cost when quantity is missing.
    public var formattedUsage: String {
        if let qty = usageQuantity, qty > 0 {
            if let unit = usageUnit, !unit.isEmpty {
                if qty >= 10 {
                    return String(format: "%.1f %@", qty, unit)
                } else if qty >= 1 {
                    return String(format: "%.2f %@", qty, unit)
                } else {
                    return String(format: "%.3f %@", qty, unit)
                }
            }
            return String(format: "%.1f", qty)
        }
        if let amount = amountUsd, amount > 0 {
            return String(format: "$%.2f", amount)
        }
        return "--"
    }

    public var currentPeriodStartDate: Date? {
        currentPeriodStart.flatMap(ISO8601DateParser.date(from:))
    }

    public var currentPeriodEndDate: Date? {
        currentPeriodEnd.flatMap(ISO8601DateParser.date(from:))
    }

    public var nextRenewalDate: Date? {
        nextRenewalAt.flatMap(ISO8601DateParser.date(from:))
    }

    public var syncedDate: Date? {
        ISO8601DateParser.date(from: syncedAt)
    }
}

/// The bounded subset of `GET /api/providers/:id` the native provider-detail
/// screen consumes for read depth (external billing records). The route
/// returns the full provider row; everything else is intentionally ignored.
public struct ProviderDetailRecord: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var displayName: String
    public var type: String
    public var isActive: Bool
    public var externalBilling: [ExternalBillingRecord]?

    public init(
        id: String,
        name: String,
        displayName: String,
        type: String,
        isActive: Bool,
        externalBilling: [ExternalBillingRecord]? = nil
    ) {
        self.id = id
        self.name = name
        self.displayName = displayName
        self.type = type
        self.isActive = isActive
        self.externalBilling = externalBilling
    }
}
