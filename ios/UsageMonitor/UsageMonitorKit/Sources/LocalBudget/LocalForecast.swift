import Foundation
import LocalStore

/// Realistic EOM projection: pace **variable** usage; keep known fixed/sub
/// charges discrete; add **remaining scheduled** subscription charges this UTC month.
///
/// Mirrors server `projectedEomUsd` composition:
/// `pacedVariable + fixedAccrued + forecastedSubscriptionRenewals`
/// (see `src/lib/budget-status.ts` + `src/lib/forecasting.ts`).
public enum LocalForecast {
    public struct Components: Equatable, Sendable {
        public var observedVariableUsd: Double
        public var pacedVariableUsd: Double
        public var fixedAccruedUsd: Double
        public var remainingScheduledUsd: Double
        public var projectedEomUsd: Double
    }

    /// Fractional UTC day-of-month (1-based with hour/minute fraction).
    public static func fractionalUtcDay(of now: Date) -> Double {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let day = cal.component(.day, from: now)
        let hour = cal.component(.hour, from: now)
        let minute = cal.component(.minute, from: now)
        return Double(day) + Double(hour) / 24 + Double(minute) / 1440
    }

    public static func daysInUtcMonth(of now: Date) -> Int {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let range = cal.range(of: .day, in: .month, for: now)
        return range?.count ?? 30
    }

    /// Linear pace of usage only (fixed passed separately as 0 here).
    public static func paceVariableToEom(observedVariableUsd: Double, now: Date) -> Double {
        let usage = max(0, observedVariableUsd)
        let currentDay = fractionalUtcDay(of: now)
        if currentDay < 0.1 { return usage }
        let dim = Double(daysInUtcMonth(of: now))
        return (usage / currentDay) * dim
    }

    /// Remaining discrete subscription charges still due this UTC month after `now`.
    /// Active USD subscriptions only; walks `nextRenewalAt` with auto-renew.
    public static func remainingScheduledSubscriptionUsd(
        subscriptions: [LocalSubscription],
        providerId: String,
        now: Date,
        monthEnd: Date
    ) -> Double {
        var total = 0.0
        for sub in subscriptions where sub.providerId == providerId {
            guard sub.status == "active",
                  sub.currency.uppercased() == "USD",
                  sub.costUsd > 0
            else { continue }

            let intervalCount = max(1, sub.intervalCount)
            var renewal = sub.nextRenewalAt
            if sub.autoRenew {
                var guardCount = 0
                while renewal < monthEnd && guardCount < 240 {
                    if renewal > now {
                        total += sub.costUsd
                    }
                    renewal = SubscriptionPeriodMath.advancePeriod(
                        periodStart: renewal,
                        interval: sub.interval,
                        intervalCount: intervalCount
                    )
                    guardCount += 1
                }
            } else if renewal > now && renewal < monthEnd {
                total += sub.costUsd
            }
        }
        return total
    }

    public static func project(
        pollVariableUsd: Double,
        subscriptionChargesUsd: Double,
        planFixedUsd: Double,
        subscriptions: [LocalSubscription],
        providerId: String,
        now: Date,
        monthEnd: Date
    ) -> Components {
        let fixedAccrued = max(0, subscriptionChargesUsd) + max(0, planFixedUsd)
        let observedVar = max(0, pollVariableUsd)
        let pacedVar = max(observedVar, paceVariableToEom(observedVariableUsd: observedVar, now: now))
        let remaining = remainingScheduledSubscriptionUsd(
            subscriptions: subscriptions,
            providerId: providerId,
            now: now,
            monthEnd: monthEnd
        )
        // Early month: still report paced+fixed+scheduled once past day 0.1 of variable.
        let projected = pacedVar + fixedAccrued + remaining
        return Components(
            observedVariableUsd: observedVar,
            pacedVariableUsd: pacedVar,
            fixedAccruedUsd: fixedAccrued,
            remainingScheduledUsd: remaining,
            projectedEomUsd: projected
        )
    }
}
