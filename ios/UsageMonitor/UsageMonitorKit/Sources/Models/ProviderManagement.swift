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

    /// Matches web Settings: Infisical-managed rows cannot be deleted (server 409).
    public var canDelete: Bool {
        credentialManagement == nil
    }

    /// Whether the server can poll this provider. Mirrors web `supportsManualFetch`
    /// — never surface a Fetch button that can only fail.
    public var canFetch: Bool {
        if credentialManagement?.alias == true { return false }
        let t = type.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if t == "manual_provider" || t == "generic" || t == "push" { return false }
        let key = Self.canonicalKey(name)
        if Self.manualSyncProviderKeys.contains(key) { return false }
        return true
    }

    public var inventoryStatusLabel: String {
        if !isActive { return "Inactive" }
        return canFetch ? "Active" : "Manually only"
    }

    public var latestSnapshotDate: Date? {
        latestSnapshot.flatMap { ISO8601DateParser.date(from: $0.fetchedAt) }
    }

    private static let manualSyncProviderKeys: Set<String> = [
        "voyage", "roic", "fmp", "finnhub", "alphavantage", "marketstack",
        "tiingo", "massive", "fred", "quiver-quant", "robinhood",
    ]

    private static func canonicalKey(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "_", with: "-")
            .replacingOccurrences(of: " ", with: "-")
    }
}

/// Response from `DELETE /api/providers/:id` (`{ "success": true }`).
public struct ProviderDeleteReceipt: Codable, Hashable, Sendable {
    public var success: Bool
    public init(success: Bool) { self.success = success }
}

/// Response from `DELETE /api/subscriptions/:id` (`{ "ok": true }`).
public struct SubscriptionDeleteReceipt: Codable, Hashable, Sendable {
    public var ok: Bool
    public init(ok: Bool) { self.ok = ok }
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

/// How a non-active subscription transitions back to `active`
/// (`activationMode` in `src/lib/subscription-input.ts`).
///
/// - `resume`: keep the existing schedule and roll forward to the current
///   period; the resumed term counts as already paid (only valid for a
///   previously charged paused/canceled row).
/// - `repurchase`: start a fresh billing cycle anchored at activation; the
///   next maintenance run charges the new current period.
public enum SubscriptionActivationMode: String, Codable, Hashable, Sendable {
    case resume
    case repurchase
}

/// Editable subset of a provider's plan, submitted by the native plan editor.
/// Every field uses clear-on-nil semantics: the form always submits its full
/// state, so `nil` encodes an explicit JSON null (the server clears the stored
/// value) rather than an omitted key (which would preserve it).
public struct ProviderPlanPatch: Hashable, Sendable {
    /// Server-supported `billingInterval` values (`SUBSCRIPTION_INTERVALS`).
    public static let billingIntervals = ["weekly", "monthly", "quarterly", "annual"]

    public var monthlyBudgetUsd: Double?
    public var fixedMonthlyCostUsd: Double?
    public var notes: String?
    /// ISO date string (`yyyy-MM-dd`), or `nil` to clear.
    public var renewalDate: String?
    /// One of `billingIntervals`, or `nil` to clear.
    public var billingInterval: String?

    public init(
        monthlyBudgetUsd: Double? = nil,
        fixedMonthlyCostUsd: Double? = nil,
        notes: String? = nil,
        renewalDate: String? = nil,
        billingInterval: String? = nil
    ) {
        self.monthlyBudgetUsd = monthlyBudgetUsd
        self.fixedMonthlyCostUsd = fixedMonthlyCostUsd
        self.notes = notes
        self.renewalDate = renewalDate
        self.billingInterval = billingInterval
    }
}

/// Minimal response from `PUT /api/subscriptions/:id`. The route returns the
/// full subscription row, so management-relevant fields beyond the original
/// four are decoded when present.
public struct SubscriptionMutationReceipt: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var status: String
    public var nextRenewalAt: String
    /// `true` while the row remains auto-managed by external-billing
    /// maintenance; the server clears it on any owner edit.
    public var externalBillingManaged: Bool?
    /// Watermark proving a previously charged term exists (resume-eligible).
    public var lastChargedPeriodStart: String?

    public init(
        id: String,
        name: String,
        status: String,
        nextRenewalAt: String,
        externalBillingManaged: Bool? = nil,
        lastChargedPeriodStart: String? = nil
    ) {
        self.id = id
        self.name = name
        self.status = status
        self.nextRenewalAt = nextRenewalAt
        self.externalBillingManaged = externalBillingManaged
        self.lastChargedPeriodStart = lastChargedPeriodStart
    }

    public var nextRenewalDate: Date? {
        ISO8601DateParser.date(from: nextRenewalAt)
    }
}

/// Response from `POST /api/providers/:id/fetch` (201): the fresh usage
/// snapshot recorded by the manual fetch.
public struct ProviderFetchReceipt: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var providerId: String
    public var fetchedAt: String
    public var balance: Double?
    public var totalCost: Double?
    public var totalRequests: Double?
    public var credits: Double?

    public init(
        id: String,
        providerId: String,
        fetchedAt: String,
        balance: Double? = nil,
        totalCost: Double? = nil,
        totalRequests: Double? = nil,
        credits: Double? = nil
    ) {
        self.id = id
        self.providerId = providerId
        self.fetchedAt = fetchedAt
        self.balance = balance
        self.totalCost = totalCost
        self.totalRequests = totalRequests
        self.credits = credits
    }

    public var fetchedDate: Date? {
        ISO8601DateParser.date(from: fetchedAt)
    }
}
