import Foundation
import LocalStore

/// Ports pure period advance + charge planning (design K17 / §6).
public enum SubscriptionPeriodMath {
    public static func advancePeriod(
        periodStart: Date,
        interval: String,
        intervalCount: Int
    ) -> Date {
        let count = max(1, intervalCount)
        if interval == "weekly" {
            return periodStart.addingTimeInterval(Double(count) * 7 * 24 * 3600)
        }
        let months: Int
        switch interval {
        case "monthly": months = 1 * count
        case "quarterly": months = 3 * count
        case "annual": months = 12 * count
        default: months = 1 * count
        }
        return addUtcMonths(periodStart, months)
    }

    public static func addUtcMonths(_ date: Date, _ months: Int) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let day = cal.component(.day, from: date)
        guard var comps = Optional(cal.dateComponents([.year, .month, .hour, .minute, .second], from: date)) else {
            return date
        }
        comps.month = (comps.month ?? 1) + months
        comps.day = 1
        guard let base = cal.date(from: comps) else { return date }
        let last = cal.range(of: .day, in: .month, for: base)?.count ?? 28
        comps.day = min(day, last)
        return cal.date(from: comps) ?? base
    }
}

public enum SubscriptionMaterializer {
    /// Materialize due active subscription charges into the store.
    /// - Returns number of new charge rows inserted.
    @discardableResult
    public static func materialize(
        store: SQLiteLocalStore,
        now: Date = Date()
    ) async throws -> Int {
        try await store.open()
        let subs = try await store.listSubscriptions().filter { $0.status == "active" }
        var inserted = 0
        for var sub in subs {
            var cursor = sub.lastChargedPeriodStart ?? sub.currentPeriodStart
            // If never charged, charge current period if period start is in the past
            if sub.lastChargedPeriodStart == nil, sub.currentPeriodStart <= now {
                let end = SubscriptionPeriodMath.advancePeriod(
                    periodStart: sub.currentPeriodStart,
                    interval: sub.interval,
                    intervalCount: sub.intervalCount
                )
                let charge = LocalSubscriptionCharge(
                    subscriptionId: sub.id,
                    providerId: sub.providerId,
                    projectId: sub.projectId,
                    periodStart: sub.currentPeriodStart,
                    periodEnd: end,
                    costUsd: sub.costUsd,
                    currency: sub.currency,
                    materializedAt: now
                )
                try await store.insertCharge(charge)
                sub.lastChargedPeriodStart = sub.currentPeriodStart
                cursor = sub.currentPeriodStart
                inserted += 1
            }

            // Advance through any fully elapsed periods after last charge
            var periodStart = cursor
            while true {
                let periodEnd = SubscriptionPeriodMath.advancePeriod(
                    periodStart: periodStart,
                    interval: sub.interval,
                    intervalCount: sub.intervalCount
                )
                // Next period is due once current period has ended
                if periodEnd > now { break }
                // Charge the period that starts at periodEnd? Server materializer charges elapsed periods.
                // Charge period starting at periodEnd only when periodEnd <= now (period fully started)
                let nextStart = periodEnd
                if nextStart > now { break }
                let nextEnd = SubscriptionPeriodMath.advancePeriod(
                    periodStart: nextStart,
                    interval: sub.interval,
                    intervalCount: sub.intervalCount
                )
                if let last = sub.lastChargedPeriodStart, nextStart <= last {
                    periodStart = nextStart
                    continue
                }
                let charge = LocalSubscriptionCharge(
                    subscriptionId: sub.id,
                    providerId: sub.providerId,
                    projectId: sub.projectId,
                    periodStart: nextStart,
                    periodEnd: nextEnd,
                    costUsd: sub.costUsd,
                    currency: sub.currency,
                    materializedAt: now
                )
                try await store.insertCharge(charge)
                sub.lastChargedPeriodStart = nextStart
                sub.currentPeriodStart = nextStart
                sub.nextRenewalAt = nextEnd
                inserted += 1
                periodStart = nextStart
                // safety bound
                if inserted > 120 { break }
            }

            sub.updatedAt = now
            try await store.upsertSubscription(sub)
        }
        return inserted
    }
}
