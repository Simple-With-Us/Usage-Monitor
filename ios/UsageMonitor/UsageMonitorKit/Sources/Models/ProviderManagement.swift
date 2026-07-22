import Foundation

/// The bounded subset of `GET /api/providers?view=dashboard` needed by native
/// management. Secret config and raw provider responses are intentionally not
/// modeled, so they cannot leak into native view state.
public struct ProviderManagementItem: Codable, Hashable, Sendable, Identifiable {
    public struct Plan: Codable, Hashable, Sendable {
        public var billingMode: String
        public var fixedMonthlyCostUsd: Double?
        public var monthlyBudgetUsd: Double?
        public var monthlyRequestLimit: Int?
        public var lowBalanceUsd: Double?
        public var lowCredits: Double?
        public var renewalDate: String?
        public var billingInterval: String?
        public var mustKeepFunded: Bool
        public var notes: String?

        public init(
            billingMode: String = "manual",
            fixedMonthlyCostUsd: Double? = nil,
            monthlyBudgetUsd: Double? = nil,
            monthlyRequestLimit: Int? = nil,
            lowBalanceUsd: Double? = nil,
            lowCredits: Double? = nil,
            renewalDate: String? = nil,
            billingInterval: String? = nil,
            mustKeepFunded: Bool = false,
            notes: String? = nil
        ) {
            self.billingMode = billingMode
            self.fixedMonthlyCostUsd = fixedMonthlyCostUsd
            self.monthlyBudgetUsd = monthlyBudgetUsd
            self.monthlyRequestLimit = monthlyRequestLimit
            self.lowBalanceUsd = lowBalanceUsd
            self.lowCredits = lowCredits
            self.renewalDate = renewalDate
            self.billingInterval = billingInterval
            self.mustKeepFunded = mustKeepFunded
            self.notes = notes
        }
    }

    public struct LatestSnapshot: Codable, Hashable, Sendable {
        public var balance: Double?
        public var totalCost: Double?
        public var totalRequests: Double?
        public var credits: Double?
        public var fetchedAt: String

        public init(
            balance: Double? = nil,
            totalCost: Double? = nil,
            totalRequests: Double? = nil,
            credits: Double? = nil,
            fetchedAt: String
        ) {
            self.balance = balance
            self.totalCost = totalCost
            self.totalRequests = totalRequests
            self.credits = credits
            self.fetchedAt = fetchedAt
        }
    }

    public struct CredentialManagement: Codable, Hashable, Sendable {
        public var source: String
        public var scope: String
        public var label: String
        public var status: String
        public var alias: Bool
        public var readOnlyFields: [String]

        public init(
            source: String,
            scope: String,
            label: String,
            status: String,
            alias: Bool,
            readOnlyFields: [String]
        ) {
            self.source = source
            self.scope = scope
            self.label = label
            self.status = status
            self.alias = alias
            self.readOnlyFields = readOnlyFields
        }
    }

    public var id: String
    public var name: String
    public var displayName: String
    public var type: String
    public var isActive: Bool
    public var refreshIntervalMin: Int
    public var groupId: String?
    public var label: String?
    public var keyPreview: String?
    public var plan: Plan?
    public var credentialManagement: CredentialManagement?
    public var latestSnapshot: LatestSnapshot?
    public var spentUsd: Double?
    public var projectedEomUsd: Double?
    public var spendCoverage: CostCoverage?
    public var createdAt: String

    public init(
        id: String,
        name: String,
        displayName: String,
        type: String,
        isActive: Bool,
        refreshIntervalMin: Int,
        groupId: String? = nil,
        label: String? = nil,
        keyPreview: String? = nil,
        plan: Plan? = nil,
        credentialManagement: CredentialManagement? = nil,
        latestSnapshot: LatestSnapshot? = nil,
        spentUsd: Double? = nil,
        projectedEomUsd: Double? = nil,
        spendCoverage: CostCoverage? = nil,
        createdAt: String
    ) {
        self.id = id
        self.name = name
        self.displayName = displayName
        self.type = type
        self.isActive = isActive
        self.refreshIntervalMin = refreshIntervalMin
        self.groupId = groupId
        self.label = label
        self.keyPreview = keyPreview
        self.plan = plan
        self.credentialManagement = credentialManagement
        self.latestSnapshot = latestSnapshot
        self.spentUsd = spentUsd
        self.projectedEomUsd = projectedEomUsd
        self.spendCoverage = spendCoverage
        self.createdAt = createdAt
    }

    public var title: String {
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? name : trimmed
    }

    public var canToggleActive: Bool {
        !(credentialManagement?.readOnlyFields.contains("isActive") ?? false)
    }

    public var latestSnapshotDate: Date? {
        latestSnapshot.flatMap { ISO8601DateParser.date(from: $0.fetchedAt) }
    }
}

/// Minimal response from `PUT /api/providers/:id`.
public struct ProviderMutationReceipt: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var displayName: String
    public var isActive: Bool
    public var plan: ProviderManagementItem.Plan?

    public init(
        id: String,
        name: String,
        displayName: String,
        isActive: Bool,
        plan: ProviderManagementItem.Plan? = nil
    ) {
        self.id = id
        self.name = name
        self.displayName = displayName
        self.isActive = isActive
        self.plan = plan
    }
}

/// Minimal response from `PUT /api/subscriptions/:id`.
public struct SubscriptionMutationReceipt: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var status: String
    public var nextRenewalAt: String

    public init(id: String, name: String, status: String, nextRenewalAt: String) {
        self.id = id
        self.name = name
        self.status = status
        self.nextRenewalAt = nextRenewalAt
    }
}
