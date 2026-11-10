import Foundation

/// Top-level response of `GET /api/budget-status`.
///
/// Note: the route handler calls `computeProjectBudgetStatus()`, so the
/// bearer-token-gated budget-status endpoint returns the *full* project
/// budget response — `providers[]`, `projects[]`, and `summary` — not just a
/// provider list. This single endpoint powers the Dashboard, Providers,
/// provider budget detail, Alerts, and Project budgets screens.
///
/// Only the fields the app consumes are declared; Swift's `Codable` ignores
/// the many additional reconciliation fields the backend also emits.
public struct BudgetStatusResponse: Codable, Hashable, Sendable {
    public var ok: Bool
    public var generatedAt: String
    public var month: String
    public var providers: [ProviderBudgetStatus]
    public var projects: [ProjectBudgetStatus]?
    public var summary: BudgetSummary

    public init(
        ok: Bool,
        generatedAt: String,
        month: String,
        providers: [ProviderBudgetStatus],
        projects: [ProjectBudgetStatus]? = nil,
        summary: BudgetSummary
    ) {
        self.ok = ok
        self.generatedAt = generatedAt
        self.month = month
        self.providers = providers
        self.projects = projects
        self.summary = summary
    }

    public var generatedAtDate: Date? { ISO8601DateParser.date(from: generatedAt) }
}

public struct BudgetSummary: Codable, Hashable, Sendable {
    public var totalBudgetUsd: Double
    public var budgetedSpentUsd: Double
    public var unbudgetedSpentUsd: Double
    public var unassignedSpentUsd: Double?
    public var totalSpentUsd: Double
    public var estimatedApiEquivalentUsd: Double
    public var remainingUsd: Double
    public var percentUsed: Double?
    public var overBudget: Bool
    public var warning: Bool

    public init(
        totalBudgetUsd: Double,
        budgetedSpentUsd: Double,
        unbudgetedSpentUsd: Double,
        unassignedSpentUsd: Double? = nil,
        totalSpentUsd: Double,
        estimatedApiEquivalentUsd: Double,
        remainingUsd: Double,
        percentUsed: Double? = nil,
        overBudget: Bool,
        warning: Bool
    ) {
        self.totalBudgetUsd = totalBudgetUsd
        self.budgetedSpentUsd = budgetedSpentUsd
        self.unbudgetedSpentUsd = unbudgetedSpentUsd
        self.unassignedSpentUsd = unassignedSpentUsd
        self.totalSpentUsd = totalSpentUsd
        self.estimatedApiEquivalentUsd = estimatedApiEquivalentUsd
        self.remainingUsd = remainingUsd
        self.percentUsed = percentUsed
        self.overBudget = overBudget
        self.warning = warning
    }
}

/// Mirrors the consumed subset of `ProviderBudgetStatus` in
/// `src/lib/budget-status.ts`.
public struct ProviderBudgetStatus: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var displayName: String
    public var monthlyBudgetUsd: Double?
    public var fixedMonthlyCostUsd: Double
    public var snapshotCostUsd: Double?
    public var snapshotCostFetchedAt: String?
    public var pushedMonthToDateUsd: Double
    public var receiptCashPaidUsd: Double
    public var observedVariableUsageUsd: Double
    public var estimatedApiEquivalentUsd: Double
    public var spendCoverage: CostCoverage
    public var subscriptionMonthToDateUsd: Double
    public var fixedAccruedUsd: Double
    public var forecastedSubscriptionRenewalsUsd: Double
    /// Variable usage extrapolated to EOM (excludes fixed + known renewals).
    /// Optional so older cached snapshots still decode; callers use
    /// ``resolvedProjectedVariableUsageUsd`` when absent.
    public var projectedVariableUsageUsd: Double?
    public var spentUsd: Double
    public var projectedEomUsd: Double
    public var remainingUsd: Double?
    public var percentUsed: Double?
    public var status: BudgetLevel
    /// Server-computed runway status from `projectedEomUsd` vs budget
    /// (`src/lib/budget-status.ts` `projectedStatus`). Optional so older
    /// payloads (and cached snapshots written before this shipped) still
    /// decode; callers fall back to local projection math when it is absent.
    public var projectedStatus: BudgetLevel?
    public var alerts: [ProviderAlert]
    public var externalBilling: [ExternalBillingRecord]?

    public init(
        id: String,
        name: String,
        displayName: String,
        monthlyBudgetUsd: Double? = nil,
        fixedMonthlyCostUsd: Double = 0,
        snapshotCostUsd: Double? = nil,
        snapshotCostFetchedAt: String? = nil,
        pushedMonthToDateUsd: Double = 0,
        receiptCashPaidUsd: Double = 0,
        observedVariableUsageUsd: Double = 0,
        estimatedApiEquivalentUsd: Double = 0,
        spendCoverage: CostCoverage = .unknown,
        subscriptionMonthToDateUsd: Double = 0,
        fixedAccruedUsd: Double = 0,
        forecastedSubscriptionRenewalsUsd: Double = 0,
        projectedVariableUsageUsd: Double? = nil,
        spentUsd: Double = 0,
        projectedEomUsd: Double = 0,
        remainingUsd: Double? = nil,
        percentUsed: Double? = nil,
        status: BudgetLevel = .unconfigured,
        projectedStatus: BudgetLevel? = nil,
        alerts: [ProviderAlert] = [],
        externalBilling: [ExternalBillingRecord]? = nil
    ) {
        self.id = id
        self.name = name
        self.displayName = displayName
        self.monthlyBudgetUsd = monthlyBudgetUsd
        self.fixedMonthlyCostUsd = fixedMonthlyCostUsd
        self.snapshotCostUsd = snapshotCostUsd
        self.snapshotCostFetchedAt = snapshotCostFetchedAt
        self.pushedMonthToDateUsd = pushedMonthToDateUsd
        self.receiptCashPaidUsd = receiptCashPaidUsd
        self.observedVariableUsageUsd = observedVariableUsageUsd
        self.estimatedApiEquivalentUsd = estimatedApiEquivalentUsd
        self.spendCoverage = spendCoverage
        self.subscriptionMonthToDateUsd = subscriptionMonthToDateUsd
        self.fixedAccruedUsd = fixedAccruedUsd
        self.forecastedSubscriptionRenewalsUsd = forecastedSubscriptionRenewalsUsd
        self.projectedVariableUsageUsd = projectedVariableUsageUsd
        self.spentUsd = spentUsd
        self.projectedEomUsd = projectedEomUsd
        self.remainingUsd = remainingUsd
        self.percentUsed = percentUsed
        self.status = status
        self.projectedStatus = projectedStatus
        self.alerts = alerts
        self.externalBilling = externalBilling
    }

    public var snapshotFetchedDate: Date? {
        snapshotCostFetchedAt.flatMap(ISO8601DateParser.date(from:))
    }

    /// A display name that never renders empty.
    public var title: String {
        let trimmed = displayName.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? name : trimmed
    }

    /// Whether a real monthly budget is configured (drives meter vs. plain
    /// spend presentation).
    public var hasBudget: Bool { (monthlyBudgetUsd ?? 0) > 0 }

    public var mostSevereAlert: ProviderAlert? {
        alerts.min { $0.severity.order < $1.severity.order }
    }

    /// Variable usage portion of EOM projection.
    /// Prefer the server field; otherwise derive from the two-part composition:
    /// `projectedEom = variable + fixedAccrued + forecastedRenewals`.
    public var resolvedProjectedVariableUsageUsd: Double {
        if let projectedVariableUsageUsd, projectedVariableUsageUsd.isFinite {
            return max(0, projectedVariableUsageUsd)
        }
        let derived = projectedEomUsd - fixedAccruedUsd - forecastedSubscriptionRenewalsUsd
        return max(0, derived)
    }

    /// Known remaining subscription charges this UTC month (not yet spent).
    public var resolvedForecastedSubscriptionRenewalsUsd: Double {
        max(0, forecastedSubscriptionRenewalsUsd)
    }

    /// Fixed / subscription charges already accrued MTD.
    public var resolvedFixedAccruedUsd: Double {
        max(0, fixedAccruedUsd)
    }
}

/// Mirrors the consumed subset of `ProjectBudgetStatus` in
/// `src/lib/budget-status.ts`.
public struct ProjectBudgetStatus: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var description: String?
    public var monthlyBudgetUsd: Double?
    public var spentUsd: Double
    public var projectedEomUsd: Double
    public var spendCoverage: CostCoverage
    public var directUsd: Double?
    public var allocatedUsd: Double?
    public var incompleteAllocatedProviderCount: Int?
    public var remainingUsd: Double?
    public var percentUsed: Double?
    public var status: BudgetLevel

    public init(
        id: String,
        name: String,
        description: String? = nil,
        monthlyBudgetUsd: Double? = nil,
        spentUsd: Double = 0,
        projectedEomUsd: Double = 0,
        spendCoverage: CostCoverage = .unknown,
        directUsd: Double? = nil,
        allocatedUsd: Double? = nil,
        incompleteAllocatedProviderCount: Int? = nil,
        remainingUsd: Double? = nil,
        percentUsed: Double? = nil,
        status: BudgetLevel = .unconfigured
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.monthlyBudgetUsd = monthlyBudgetUsd
        self.spentUsd = spentUsd
        self.projectedEomUsd = projectedEomUsd
        self.spendCoverage = spendCoverage
        self.directUsd = directUsd
        self.allocatedUsd = allocatedUsd
        self.incompleteAllocatedProviderCount = incompleteAllocatedProviderCount
        self.remainingUsd = remainingUsd
        self.percentUsed = percentUsed
        self.status = status
    }

    public var hasBudget: Bool { (monthlyBudgetUsd ?? 0) > 0 }
}
