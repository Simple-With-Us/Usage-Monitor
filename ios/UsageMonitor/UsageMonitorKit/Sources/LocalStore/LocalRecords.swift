import Foundation

// MARK: - Domain rows (Local app money-truth)

public struct LocalProvider: Identifiable, Equatable, Sendable, Hashable {
    public var id: String
    public var name: String
    public var displayName: String
    public var type: String
    public var adapterKind: String
    public var category: String?
    public var isActive: Bool
    public var refreshIntervalMin: Int
    public var label: String?
    public var keychainAccountId: String?
    public var nonSecretConfigJSON: String?
    public var lastFetchAt: Date?
    public var lastFetchError: String?
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: String = UUID().uuidString,
        name: String,
        displayName: String,
        type: String = "builtin",
        adapterKind: String,
        category: String? = nil,
        isActive: Bool = true,
        refreshIntervalMin: Int = 60,
        label: String? = nil,
        keychainAccountId: String? = nil,
        nonSecretConfigJSON: String? = nil,
        lastFetchAt: Date? = nil,
        lastFetchError: String? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.name = name
        self.displayName = displayName
        self.type = type
        self.adapterKind = adapterKind
        self.category = category
        self.isActive = isActive
        self.refreshIntervalMin = refreshIntervalMin
        self.label = label
        self.keychainAccountId = keychainAccountId
        self.nonSecretConfigJSON = nonSecretConfigJSON
        self.lastFetchAt = lastFetchAt
        self.lastFetchError = lastFetchError
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// True only when a real phone poll adapter exists for this row.
    public var isPollable: Bool {
        Self.supportedPollAdapterKinds.contains(adapterKind)
    }

    /// Adapters registered in `LocalAdapterRegistry` (keep in sync).
    public static let supportedPollAdapterKinds: Set<String> = [
        "openrouter", "openai", "anthropic", "deepseek", "hetzner", "backblaze",
        "apify", "firecrawl", "twelvedata", "pushover", "resend",
        "stripe", "xai", "twilio",
    ]

    /// Fetch is useful only when pollable *and* a Keychain credential exists.
    public var canFetch: Bool {
        isPollable && keychainAccountId != nil
    }

    /// Pollable shell with no Keychain credential — the restore/catalog gap.
    public var needsKey: Bool {
        isPollable && keychainAccountId == nil
    }
}

public struct LocalProviderPlan: Equatable, Sendable {
    public var providerId: String
    public var billingMode: String
    public var fixedMonthlyCostUsd: Double?
    public var monthlyBudgetUsd: Double?
    public var monthlyRequestLimit: Int?
    public var renewalDate: Date?
    public var billingInterval: String?
    public var notes: String?
    public var updatedAt: Date

    public init(
        providerId: String,
        billingMode: String = "manual",
        fixedMonthlyCostUsd: Double? = nil,
        monthlyBudgetUsd: Double? = nil,
        monthlyRequestLimit: Int? = nil,
        renewalDate: Date? = nil,
        billingInterval: String? = "monthly",
        notes: String? = nil,
        updatedAt: Date = Date()
    ) {
        self.providerId = providerId
        self.billingMode = billingMode
        self.fixedMonthlyCostUsd = fixedMonthlyCostUsd
        self.monthlyBudgetUsd = monthlyBudgetUsd
        self.monthlyRequestLimit = monthlyRequestLimit
        self.renewalDate = renewalDate
        self.billingInterval = billingInterval
        self.notes = notes
        self.updatedAt = updatedAt
    }
}

public struct LocalUsageSnapshot: Identifiable, Equatable, Sendable {
    public var id: String
    public var providerId: String
    public var fetchedAt: Date
    public var balance: Double?
    public var totalCost: Double?
    public var fixedCostIncludedUsd: Double?
    public var costWindowStart: Date?
    public var costWindowEnd: Date?
    public var costScope: String?
    public var costIncludesUnknownFixed: Bool
    public var totalRequests: Int?
    public var credits: Double?
    public var costCoverageCaveatCode: String?
    public var costCoverageCaveatMessage: String?
    public var createdAt: Date

    public init(
        id: String = UUID().uuidString,
        providerId: String,
        fetchedAt: Date = Date(),
        balance: Double? = nil,
        totalCost: Double? = nil,
        fixedCostIncludedUsd: Double? = nil,
        costWindowStart: Date? = nil,
        costWindowEnd: Date? = nil,
        costScope: String? = nil,
        costIncludesUnknownFixed: Bool = false,
        totalRequests: Int? = nil,
        credits: Double? = nil,
        costCoverageCaveatCode: String? = nil,
        costCoverageCaveatMessage: String? = nil,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.providerId = providerId
        self.fetchedAt = fetchedAt
        self.balance = balance
        self.totalCost = totalCost
        self.fixedCostIncludedUsd = fixedCostIncludedUsd
        self.costWindowStart = costWindowStart
        self.costWindowEnd = costWindowEnd
        self.costScope = costScope
        self.costIncludesUnknownFixed = costIncludesUnknownFixed
        self.totalRequests = totalRequests
        self.credits = credits
        self.costCoverageCaveatCode = costCoverageCaveatCode
        self.costCoverageCaveatMessage = costCoverageCaveatMessage
        self.createdAt = createdAt
    }
}

public struct LocalSubscription: Identifiable, Equatable, Sendable {
    public var id: String
    public var providerId: String
    public var projectId: String?
    public var name: String
    public var description: String?
    public var costUsd: Double
    public var currency: String
    public var interval: String
    public var intervalCount: Int
    public var anchorDay: Int?
    public var startDate: Date
    public var currentPeriodStart: Date
    public var nextRenewalAt: Date
    public var lastChargedPeriodStart: Date?
    public var autoRenew: Bool
    public var status: String
    public var canceledAt: Date?
    public var notes: String?
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: String = UUID().uuidString,
        providerId: String,
        projectId: String? = nil,
        name: String,
        description: String? = nil,
        costUsd: Double,
        currency: String = "USD",
        interval: String = "monthly",
        intervalCount: Int = 1,
        anchorDay: Int? = nil,
        startDate: Date = Date(),
        currentPeriodStart: Date = Date(),
        nextRenewalAt: Date = Date(),
        lastChargedPeriodStart: Date? = nil,
        autoRenew: Bool = true,
        status: String = "active",
        canceledAt: Date? = nil,
        notes: String? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.providerId = providerId
        self.projectId = projectId
        self.name = name
        self.description = description
        self.costUsd = costUsd
        self.currency = currency
        self.interval = interval
        self.intervalCount = intervalCount
        self.anchorDay = anchorDay
        self.startDate = startDate
        self.currentPeriodStart = currentPeriodStart
        self.nextRenewalAt = nextRenewalAt
        self.lastChargedPeriodStart = lastChargedPeriodStart
        self.autoRenew = autoRenew
        self.status = status
        self.canceledAt = canceledAt
        self.notes = notes
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct LocalSubscriptionCharge: Identifiable, Equatable, Sendable {
    public var id: String
    public var subscriptionId: String
    public var providerId: String
    public var projectId: String?
    public var periodStart: Date
    public var periodEnd: Date
    public var costUsd: Double
    public var currency: String
    public var materializedAt: Date

    public init(
        id: String = UUID().uuidString,
        subscriptionId: String,
        providerId: String,
        projectId: String? = nil,
        periodStart: Date,
        periodEnd: Date,
        costUsd: Double,
        currency: String = "USD",
        materializedAt: Date = Date()
    ) {
        self.id = id
        self.subscriptionId = subscriptionId
        self.providerId = providerId
        self.projectId = projectId
        self.periodStart = periodStart
        self.periodEnd = periodEnd
        self.costUsd = costUsd
        self.currency = currency
        self.materializedAt = materializedAt
    }
}

public struct LocalProject: Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var nameKey: String
    public var description: String?
    public var monthlyBudgetUsd: Double?
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: String = UUID().uuidString,
        name: String,
        description: String? = nil,
        monthlyBudgetUsd: Double? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.name = name
        self.nameKey = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        self.description = description
        self.monthlyBudgetUsd = monthlyBudgetUsd
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public enum LocalWriteError: Error, Equatable, Sendable {
    case notOpen
    case conflict(String)
    case validation(String)
    case notFound(String)
    case sqlite(String)
}
