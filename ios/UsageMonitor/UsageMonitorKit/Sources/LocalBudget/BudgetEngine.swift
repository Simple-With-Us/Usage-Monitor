import Foundation
import LocalStore

/// BudgetEngine v1 — design §2.3 (locked golden vectors).
public enum BudgetEngine {
    public struct ProviderSpend: Equatable, Sendable {
        public var providerId: String
        public var displayName: String
        public var pollVariableUsd: Double
        public var subscriptionChargesUsd: Double
        public var planFixedUsd: Double
        public var spentUsd: Double
        public var monthlyBudgetUsd: Double?
        public var projectedEomUsd: Double?
        /// EOM composition (web parity: paced variable + fixed accrued + known renewals).
        public var pacedVariableUsd: Double
        public var fixedAccruedUsd: Double
        public var remainingScheduledUsd: Double
        public var level: SpendLevel
        public var isActive: Bool
        public var lastFetchAt: Date?
        public var lastFetchError: String?
        public var adapterKind: String
        public var statusNote: String?

        public var hasBudget: Bool { (monthlyBudgetUsd ?? 0) > 0 }

        public var percentUsed: Double? {
            guard let b = monthlyBudgetUsd, b > 0 else { return nil }
            return spentUsd / b
        }
    }

    public enum SpendLevel: String, Sendable, Equatable {
        case unconfigured
        case ok
        case warning
        case exceeded
    }

    public struct Summary: Equatable, Sendable {
        public var monthStart: Date
        public var providers: [ProviderSpend]
        public var totalSpentUsd: Double
        public var totalBudgetUsd: Double?
        public var overBudget: Bool
        /// Combined EOM projection parts (web / remote dashboard parity).
        public var totalProjectedEomUsd: Double
        public var totalPacedVariableUsd: Double
        public var totalFixedAccruedUsd: Double
        public var totalRemainingScheduledUsd: Double
        public var exceededCount: Int
        public var warningCount: Int
        public var configuredBudgetCount: Int

        public var hasBudget: Bool { (totalBudgetUsd ?? 0) > 0 }

        public var remainingUsd: Double? {
            guard let b = totalBudgetUsd, b > 0 else { return nil }
            return b - totalSpentUsd
        }

        public var hasSubscriptionProjectionComponent: Bool {
            totalFixedAccruedUsd > 0.005 || totalRemainingScheduledUsd > 0.005
        }
    }

    public static func compute(
        providers: [LocalProvider],
        plans: [String: LocalProviderPlan],
        snapshots: [LocalUsageSnapshot],
        subscriptions: [LocalSubscription],
        charges: [LocalSubscriptionCharge],
        now: Date = Date()
    ) -> Summary {
        let monthStart = utcMonthStart(now)
        let nextMonth = nextUtcMonth(after: monthStart)

        let snapsByProvider = Dictionary(grouping: snapshots, by: \.providerId)
        let chargesByProvider = Dictionary(grouping: charges, by: \.providerId)
        let subsByProvider = Dictionary(grouping: subscriptions, by: \.providerId)

        var rows: [ProviderSpend] = []
        for p in providers {
            let eligible = latestEligibleSnapshot(
                snapsByProvider[p.id] ?? [],
                monthStart: monthStart
            )
            var pollVariable = 0.0
            if let s = eligible, let total = s.totalCost {
                pollVariable = max(0, total - (s.fixedCostIncludedUsd ?? 0))
            }

            let monthCharges = (chargesByProvider[p.id] ?? []).filter {
                $0.periodStart >= monthStart && $0.periodStart < nextMonth
            }
            let subCharges = monthCharges.reduce(0.0) { $0 + $1.costUsd }

            let subs = subsByProvider[p.id] ?? []
            let hasActiveOrConsidering = subs.contains {
                ($0.status == "active" || $0.status == "considering") && $0.costUsd > 0
            }
            let plan = plans[p.id]
            var planFixed = 0.0
            if let fixed = plan?.fixedMonthlyCostUsd, fixed > 0, !hasActiveOrConsidering {
                planFixed = fixed
            }

            let spent = pollVariable + subCharges + planFixed
            let budget = plan?.monthlyBudgetUsd
            let level = spendLevel(spent: spent, budget: budget)

            // Realistic EOM: pace *variable* poll usage; keep known fixed/sub
            // discrete; add remaining *scheduled* active subscription charges
            // still due this UTC month (not pure proportion of total spend).
            let forecast = LocalForecast.project(
                pollVariableUsd: pollVariable,
                subscriptionChargesUsd: subCharges,
                planFixedUsd: planFixed,
                subscriptions: subs,
                providerId: p.id,
                now: now,
                monthEnd: nextMonth
            )
            // Withhold early-month blow-up noise for pure variable-only rows
            // with almost no clock progress (aligned with server day < 0.1).
            let projected: Double? =
                LocalForecast.fractionalUtcDay(of: now) < 0.1 && forecast.observedVariableUsd <= 0
                ? (forecast.fixedAccruedUsd + forecast.remainingScheduledUsd > 0
                    ? forecast.fixedAccruedUsd + forecast.remainingScheduledUsd
                    : nil)
                : forecast.projectedEomUsd

            rows.append(
                ProviderSpend(
                    providerId: p.id,
                    displayName: p.displayName,
                    pollVariableUsd: pollVariable,
                    subscriptionChargesUsd: subCharges,
                    planFixedUsd: planFixed,
                    spentUsd: spent,
                    monthlyBudgetUsd: budget,
                    projectedEomUsd: projected,
                    pacedVariableUsd: forecast.pacedVariableUsd,
                    fixedAccruedUsd: forecast.fixedAccruedUsd,
                    remainingScheduledUsd: forecast.remainingScheduledUsd,
                    level: level,
                    isActive: p.isActive,
                    lastFetchAt: p.lastFetchAt,
                    lastFetchError: p.lastFetchError,
                    adapterKind: p.adapterKind,
                    statusNote: forecast.remainingScheduledUsd > 0.005
                        ? String(format: "Includes $%.2f scheduled later this month", forecast.remainingScheduledUsd)
                        : nil
                )
            )
        }

        rows.sort { $0.spentUsd > $1.spentUsd }
        let totalSpent = rows.reduce(0.0) { $0 + $1.spentUsd }
        let budgets = rows.compactMap(\.monthlyBudgetUsd).filter { $0 > 0 }
        let totalBudget: Double? = budgets.isEmpty ? nil : budgets.reduce(0, +)
        let over = rows.contains { $0.level == .exceeded }
        let totalProjected = rows.compactMap(\.projectedEomUsd).reduce(0.0, +)
        let totalPaced = rows.reduce(0.0) { $0 + $1.pacedVariableUsd }
        let totalFixed = rows.reduce(0.0) { $0 + $1.fixedAccruedUsd }
        let totalRenew = rows.reduce(0.0) { $0 + $1.remainingScheduledUsd }

        return Summary(
            monthStart: monthStart,
            providers: rows,
            totalSpentUsd: totalSpent,
            totalBudgetUsd: totalBudget,
            overBudget: over,
            totalProjectedEomUsd: totalProjected,
            totalPacedVariableUsd: totalPaced,
            totalFixedAccruedUsd: totalFixed,
            totalRemainingScheduledUsd: totalRenew,
            exceededCount: rows.filter { $0.level == .exceeded }.count,
            warningCount: rows.filter { $0.level == .warning }.count,
            configuredBudgetCount: budgets.count
        )
    }

    /// Design §2.3.2 eligibility (no grace).
    public static func latestEligibleSnapshot(
        _ snapshots: [LocalUsageSnapshot],
        monthStart: Date
    ) -> LocalUsageSnapshot? {
        let sorted = snapshots.sorted { $0.fetchedAt > $1.fetchedAt }

        if let cal = sorted.first(where: { s in
            guard s.totalCost != nil else { return false }
            guard s.costScope == "calendar_month_to_date" else { return false }
            if let w = s.costWindowStart, w < monthStart { return false }
            return true
        }) {
            return cal
        }

        if let unk = sorted.first(where: { s in
            guard s.totalCost != nil else { return false }
            guard s.costScope == "unknown" else { return false }
            return s.fetchedAt >= monthStart
        }) {
            return unk
        }

        return nil
    }

    public static func spendLevel(spent: Double, budget: Double?) -> SpendLevel {
        guard let budget, budget > 0 else { return .unconfigured }
        let pct = spent / budget
        if pct >= 1 { return .exceeded }
        if pct >= 0.8 { return .warning }
        return .ok
    }

    public static func utcMonthStart(_ date: Date = Date()) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let c = cal.dateComponents([.year, .month], from: date)
        return cal.date(from: DateComponents(year: c.year, month: c.month, day: 1))!
    }

    public static func nextUtcMonth(after start: Date) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        return cal.date(byAdding: .month, value: 1, to: start)!
    }
}
