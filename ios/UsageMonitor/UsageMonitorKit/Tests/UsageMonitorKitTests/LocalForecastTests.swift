import XCTest
@testable import LocalBudget
@testable import LocalStore

final class LocalForecastTests: XCTestCase {
    func testPacesVariableButKeepsKnownFixedAndScheduled() {
        // Mid-month (~day 15 of 30) → variable ~doubles; fixed+remaining stay discrete.
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let now = cal.date(from: DateComponents(year: 2026, month: 8, day: 15, hour: 12))!
        let monthEnd = cal.date(from: DateComponents(year: 2026, month: 9, day: 1))!

        let providerId = "p1"
        // One more monthly charge due on day 20
        let sub = LocalSubscription(
            providerId: providerId,
            name: "Plan",
            costUsd: 30,
            currentPeriodStart: cal.date(from: DateComponents(year: 2026, month: 7, day: 20))!,
            nextRenewalAt: cal.date(from: DateComponents(year: 2026, month: 8, day: 20))!,
            autoRenew: true,
            status: "active"
        )

        let components = LocalForecast.project(
            pollVariableUsd: 100, // MTD variable
            subscriptionChargesUsd: 20, // already charged this month
            planFixedUsd: 0,
            subscriptions: [sub],
            providerId: providerId,
            now: now,
            monthEnd: monthEnd
        )

        // Paced variable should be well above 100 (~200 for mid-month).
        XCTAssertGreaterThan(components.pacedVariableUsd, 180)
        XCTAssertLessThan(components.pacedVariableUsd, 220)
        XCTAssertEqual(components.fixedAccruedUsd, 20, accuracy: 0.001)
        XCTAssertEqual(components.remainingScheduledUsd, 30, accuracy: 0.001)
        // EOM ≈ paced var + 20 + 30 — NOT pure proportion of (100+20)=120.
        XCTAssertEqual(
            components.projectedEomUsd,
            components.pacedVariableUsd + 50,
            accuracy: 0.01
        )
        // Pure proportion of total would understate scheduled renewals differently;
        // ensure remaining scheduled is fully included, not paced.
        XCTAssertEqual(components.remainingScheduledUsd, 30, accuracy: 0.001)
    }

    func testPausedSubscriptionDoesNotForecast() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let now = cal.date(from: DateComponents(year: 2026, month: 8, day: 10))!
        let monthEnd = cal.date(from: DateComponents(year: 2026, month: 9, day: 1))!
        let sub = LocalSubscription(
            providerId: "p1",
            name: "Paused",
            costUsd: 99,
            nextRenewalAt: cal.date(from: DateComponents(year: 2026, month: 8, day: 25))!,
            status: "paused"
        )
        let remaining = LocalForecast.remainingScheduledSubscriptionUsd(
            subscriptions: [sub],
            providerId: "p1",
            now: now,
            monthEnd: monthEnd
        )
        XCTAssertEqual(remaining, 0, accuracy: 0.001)
    }

    func testBudgetEngineSummaryExposesProjectionParts() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let now = cal.date(from: DateComponents(year: 2026, month: 8, day: 15, hour: 12))!
        let monthStart = BudgetEngine.utcMonthStart(now)

        let provider = LocalProvider(
            id: "p1",
            name: "openrouter",
            displayName: "OpenRouter",
            adapterKind: "openrouter",
            isActive: true
        )
        let plan = LocalProviderPlan(providerId: "p1", monthlyBudgetUsd: 200)
        let snap = LocalUsageSnapshot(
            providerId: "p1",
            fetchedAt: now,
            totalCost: 50,
            fixedCostIncludedUsd: 0,
            costWindowStart: monthStart,
            costScope: "calendar_month_to_date"
        )
        let sub = LocalSubscription(
            providerId: "p1",
            name: "Pro",
            costUsd: 20,
            currentPeriodStart: monthStart,
            nextRenewalAt: cal.date(from: DateComponents(year: 2026, month: 8, day: 20))!,
            autoRenew: true,
            status: "active"
        )
        let charge = LocalSubscriptionCharge(
            subscriptionId: sub.id,
            providerId: "p1",
            periodStart: monthStart,
            periodEnd: cal.date(from: DateComponents(year: 2026, month: 9, day: 1))!,
            costUsd: 20
        )

        let summary = BudgetEngine.compute(
            providers: [provider],
            plans: ["p1": plan],
            snapshots: [snap],
            subscriptions: [sub],
            charges: [charge],
            now: now
        )

        XCTAssertEqual(summary.providers.count, 1)
        let row = summary.providers[0]
        XCTAssertEqual(row.fixedAccruedUsd, 20, accuracy: 0.01)
        XCTAssertEqual(row.remainingScheduledUsd, 20, accuracy: 0.01)
        XCTAssertGreaterThan(row.pacedVariableUsd, 40)
        XCTAssertEqual(summary.totalFixedAccruedUsd, row.fixedAccruedUsd, accuracy: 0.001)
        XCTAssertEqual(summary.totalRemainingScheduledUsd, row.remainingScheduledUsd, accuracy: 0.001)
        XCTAssertEqual(summary.configuredBudgetCount, 1)
        XCTAssertTrue(summary.hasBudget)
        XCTAssertNotNil(summary.remainingUsd)
    }
}
