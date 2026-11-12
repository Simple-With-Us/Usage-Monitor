import XCTest
@testable import Dashboard
@testable import Models

/// Dashboard-lane tests: the pure budget math, projection, roll-up, and
/// month-pace logic the overview renders. All fixture-driven and deterministic.
///
/// NOTE (integration): the `UsageMonitorKitTests` target must add `"Dashboard"`
/// to its `dependencies` in `Package.swift` for this file to compile. See the
/// Dashboard lane's integration notes.
final class DashboardViewDataTests: XCTestCase {

    // A calendar pinned to UTC so day-of-month derivations are deterministic
    // regardless of the host's time zone.
    private var utcCalendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal
    }

    // MARK: - Totals & fractions

    func testTotalsFromSample() {
        let data = DashboardViewData(.sample)
        XCTAssertEqual(data.totalSpent, 461.55, accuracy: 0.001)
        // Provider budgets only: 250+200+120 (voyage unconfigured).
        XCTAssertEqual(data.totalBudget, 570, accuracy: 0.001)
        XCTAssertEqual(data.remaining, 570 - 461.55, accuracy: 0.001)
        XCTAssertTrue(data.hasBudget)
        XCTAssertEqual(data.spentFraction, 461.55 / 570, accuracy: 0.0001)
        // Hero caption basis: "Across N provider budgets" uses this count.
        XCTAssertEqual(data.configuredProviderCount, 3)
    }

    func testPercentUsedIsProviderDerived() {
        let data = DashboardViewData(.sample)
        // Provider budgets 250+200+120=570; spend 461.55 → not project summary %.
        XCTAssertEqual(data.percentUsedDisplay, 461.55 / 570, accuracy: 0.0001)
    }

    func testProviderBudgetsOnlyWhenProjectsEmpty() {
        // Server project summary can report totalBudgetUsd=0 while providers have budgets.
        var summary = BudgetSummary.sample
        summary.totalBudgetUsd = 0
        summary.overBudget = false
        summary.warning = false
        summary.percentUsed = nil
        let response = BudgetStatusResponse(
            ok: true, generatedAt: "2026-07-19T09:15:00.000Z", month: "2026-07",
            providers: ProviderBudgetStatus.sampleList, projects: [], summary: summary
        )
        let data = DashboardViewData(response)
        XCTAssertTrue(data.hasBudget)
        XCTAssertEqual(data.totalBudget, 570, accuracy: 0.001)
        XCTAssertEqual(data.overallStatus, .exceeded) // sample list includes exceeded provider
    }

    func testNoBudgetYieldsZeroFractionNotDivideByZero() {
        var summary = BudgetSummary.sample
        summary.totalBudgetUsd = 0
        summary.percentUsed = nil
        let response = BudgetStatusResponse(
            ok: true, generatedAt: "2026-07-19T09:15:00.000Z", month: "2026-07",
            providers: [.sampleUnconfigured], projects: nil, summary: summary
        )
        let data = DashboardViewData(response)
        XCTAssertFalse(data.hasBudget)
        XCTAssertEqual(data.spentFraction, 0)
        XCTAssertEqual(data.projectedFraction, 0)
        XCTAssertNil(data.projectedOverageFraction)
    }

    // MARK: - Projection

    func testProjectedEomSumsProviderProjections() {
        let data = DashboardViewData(.sample)
        // 210.40 + 335.10 + 151.80 + 28.40
        XCTAssertEqual(data.projectedEom, 725.70, accuracy: 0.001)
        XCTAssertTrue(data.projectedOverBudget)
        XCTAssertEqual(data.projectedDeltaVsBudget, 155.70, accuracy: 0.001)
        XCTAssertEqual(data.projectedOverageFraction!, 155.70 / 570, accuracy: 0.0001)
    }

    /// Without any provider budgets, remaining is 0 − spent (negative). UI must
    /// not treat that as "Over Budget $X" — only `hasBudget` gates the dollar card.
    func testNoBudgetDoesNotImplyConfiguredRemaining() {
        let response = makeResponse(
            budget: 0,
            providers: [provider(spent: 42, projected: 80, budget: nil, status: .unconfigured)]
        )
        let data = DashboardViewData(response)
        XCTAssertFalse(data.hasBudget)
        XCTAssertEqual(data.totalBudget, 0, accuracy: 0.001)
        XCTAssertEqual(data.remaining, -42, accuracy: 0.001) // raw math
        // Presentation contract: only show currency remaining when hasBudget.
    }

    func testProjectedEomSplitsUsageAndSubscriptionParts() {
        // Explicit two-part composition: paced usage + fixed accrued + known renewals.
        let response = makeResponse(
            budget: 500,
            providers: [
                provider(
                    spent: 100,
                    projected: 250,
                    budget: 300,
                    status: .ok,
                    fixedAccrued: 40,
                    renewals: 60,
                    projectedVariable: 150
                ),
                provider(
                    spent: 50,
                    projected: 100,
                    budget: 200,
                    status: .ok,
                    fixedAccrued: 0,
                    renewals: 0,
                    projectedVariable: 100
                ),
            ]
        )
        let data = DashboardViewData(response)
        XCTAssertEqual(data.projectedEom, 350, accuracy: 0.001)
        XCTAssertEqual(data.projectedVariableUsage, 250, accuracy: 0.001)
        XCTAssertEqual(data.projectedFixedAccrued, 40, accuracy: 0.001)
        XCTAssertEqual(data.projectedKnownRenewals, 60, accuracy: 0.001)
        XCTAssertTrue(data.hasSubscriptionProjectionComponent)
    }

    // MARK: - Status

    func testOverallStatusFollowsProviderStatusesNotProjectSummary() {
        XCTAssertEqual(DashboardViewData(.sample).overallStatus, .exceeded)

        // Project summary claims ok while a provider is warning → hero must warn.
        var summary = BudgetSummary.sample
        summary.overBudget = false
        summary.warning = false
        let warn = BudgetStatusResponse(
            ok: true, generatedAt: "2026-07-19T09:15:00.000Z", month: "2026-07",
            providers: [.sampleWarning, .sampleOk], projects: nil, summary: summary
        )
        XCTAssertEqual(DashboardViewData(warn).overallStatus, .warning)

        let ok = BudgetStatusResponse(
            ok: true, generatedAt: "2026-07-19T09:15:00.000Z", month: "2026-07",
            providers: [.sampleOk], projects: nil, summary: summary
        )
        XCTAssertEqual(DashboardViewData(ok).overallStatus, .ok)
    }

    func testProjectionStatusFromProjectionVsBudget() {
        // Sample projects well over budget → exceeded.
        XCTAssertEqual(DashboardViewData(.sample).projectionStatus, .exceeded)

        // Projection at 92% of budget → warning.
        let response = makeResponse(
            budget: 100,
            providers: [provider(spent: 40, projected: 92, budget: 100, status: .ok)]
        )
        XCTAssertEqual(DashboardViewData(response).projectionStatus, .warning)

        // Comfortable projection → ok.
        let okResponse = makeResponse(
            budget: 100,
            providers: [provider(spent: 20, projected: 50, budget: 100, status: .ok)]
        )
        XCTAssertEqual(DashboardViewData(okResponse).projectionStatus, .ok)
    }

    func testProjectionStatusPrefersServerPerProviderValues() {
        // Aggregate projection is only 60% of the total budget (locally "ok"),
        // but the server flags one provider's runway as exceeded — the server's
        // per-provider statuses must win when every budgeted provider has one.
        let response = makeResponse(
            budget: 300,
            providers: [
                provider(id: "a", name: "A", spent: 90, projected: 150, budget: 100, status: .ok,
                         projectedStatus: .exceeded),
                provider(id: "b", name: "B", spent: 10, projected: 30, budget: 200, status: .ok,
                         projectedStatus: .ok),
            ]
        )
        XCTAssertEqual(DashboardViewData(response).projectionStatus, .exceeded)

        // Mixed payload (one provider missing the field) → local fallback.
        let mixed = makeResponse(
            budget: 300,
            providers: [
                provider(id: "a", name: "A", spent: 90, projected: 150, budget: 100, status: .ok,
                         projectedStatus: .exceeded),
                provider(id: "b", name: "B", spent: 10, projected: 30, budget: 200, status: .ok),
            ]
        )
        XCTAssertEqual(DashboardViewData(mixed).projectionStatus, .ok)

        // All-server warning rolls up to warning.
        let warning = makeResponse(
            budget: 300,
            providers: [
                provider(id: "a", name: "A", spent: 40, projected: 85, budget: 100, status: .ok,
                         projectedStatus: .warning),
                provider(id: "b", name: "B", spent: 10, projected: 30, budget: 200, status: .ok,
                         projectedStatus: .ok),
            ]
        )
        XCTAssertEqual(DashboardViewData(warning).projectionStatus, .warning)
    }

    // MARK: - Roll-ups

    func testTopProvidersSpendDescendingWithLimit() {
        let data = DashboardViewData(.sample)
        let top = data.topProviders(limit: 2)
        XCTAssertEqual(top.map(\.id), ["prov_anthropic", "prov_openrouter"]) // 212.40, 134.90
        XCTAssertEqual(data.topProviders(limit: 0).count, 0)
        XCTAssertEqual(data.topProviders(limit: 99).count, 4) // clamps to available
    }

    func testTopProvidersTieBreakByTitle() {
        let response = makeResponse(
            budget: 300,
            providers: [
                provider(id: "b", name: "Zeta", spent: 50, projected: 60, budget: 100, status: .ok),
                provider(id: "a", name: "Alpha", spent: 50, projected: 60, budget: 100, status: .ok),
            ]
        )
        // Equal spend → alphabetical by title.
        XCTAssertEqual(DashboardViewData(response).topProviders(limit: 2).map(\.title), ["Alpha", "Zeta"])
    }

    func testAttentionRollups() {
        let data = DashboardViewData(.sample)
        XCTAssertEqual(data.overBudgetProviders.map(\.id), ["prov_openrouter"])
        XCTAssertEqual(data.warningProviders.map(\.id), ["prov_anthropic"])
        XCTAssertEqual(data.configuredProviderCount, 3) // unconfigured has no budget
    }

    func testCoverageCaveat() {
        XCTAssertTrue(DashboardViewData(.sample).hasIncompleteCoverage) // partials present

        let allComplete = makeResponse(
            budget: 100,
            providers: [provider(spent: 10, projected: 20, budget: 100, status: .ok, coverage: .complete)]
        )
        XCTAssertFalse(DashboardViewData(allComplete).hasIncompleteCoverage)
    }

    func testApiEquivalentSavings() {
        let data = DashboardViewData(.sample)
        XCTAssertEqual(data.apiEquivalentSavings, 512.30 - 461.55, accuracy: 0.001)
        XCTAssertTrue(data.hasApiEquivalentSavings)

        // Never negative. Spend is provider-derived (see `totalSpent`), and the
        // server's `summary.estimatedApiEquivalentUsd` is the sum over the same
        // providers, so the clamp is exercised with provider spend well above
        // the API-equivalent value.
        var response = makeResponse(
            budget: 500,
            providers: [provider(spent: 400, projected: 400, budget: 500, status: .ok)]
        )
        response.summary.estimatedApiEquivalentUsd = 10
        XCTAssertEqual(DashboardViewData(response).totalSpent, 400)
        XCTAssertEqual(DashboardViewData(response).apiEquivalentSavings, 0)
        XCTAssertFalse(DashboardViewData(response).hasApiEquivalentSavings)
    }

    func testIsEmpty() {
        XCTAssertTrue(DashboardViewData(.sampleEmpty).isEmpty)
        XCTAssertFalse(DashboardViewData(.sample).isEmpty)
    }

    // MARK: - SpendPace

    func testSpendPaceBasics() {
        let pace = SpendPace.make(
            month: "2026-07",
            generatedAt: ISO8601DateParser.date(from: "2026-07-19T09:15:00.000Z"),
            spent: 461.55, projected: 725.70, budget: 570,
            calendar: utcCalendar
        )
        let unwrapped = try! XCTUnwrap(pace)
        XCTAssertEqual(unwrapped.daysInMonth, 31)
        XCTAssertEqual(unwrapped.currentDay, 19)
        XCTAssertEqual(unwrapped.toDate.last?.value, 461.55)
        XCTAssertEqual(unwrapped.toDate.first?.value, 0)
        XCTAssertEqual(unwrapped.projection.first?.day, 19)
        XCTAssertEqual(unwrapped.projection.last?.day, 31)
        XCTAssertEqual(unwrapped.projection.last?.value, 725.70)
        XCTAssertEqual(unwrapped.idealPace.last?.value, 570)
        XCTAssertGreaterThan(unwrapped.yUpperBound, 725.70)
    }

    func testSpendPaceNilWithoutBudget() {
        XCTAssertNil(SpendPace.make(
            month: "2026-07", generatedAt: nil, spent: 100, projected: 120, budget: 0,
            calendar: utcCalendar
        ))
    }

    func testSpendPaceNilForBadMonth() {
        XCTAssertNil(SpendPace.make(
            month: "not-a-month", generatedAt: nil, spent: 100, projected: 120, budget: 200,
            calendar: utcCalendar
        ))
        XCTAssertNil(SpendPace.make(
            month: "2026-13", generatedAt: nil, spent: 100, projected: 120, budget: 200,
            calendar: utcCalendar
        ))
    }

    func testSpendPaceClampsDayForOtherMonths() {
        // Snapshot generated before the month → day 1.
        let before = SpendPace.make(
            month: "2026-07",
            generatedAt: ISO8601DateParser.date(from: "2026-06-15T00:00:00.000Z"),
            spent: 10, projected: 20, budget: 100, calendar: utcCalendar
        )
        XCTAssertEqual(before?.currentDay, 1)

        // Snapshot from a later month → treat the month as complete.
        let after = SpendPace.make(
            month: "2026-07",
            generatedAt: ISO8601DateParser.date(from: "2026-09-15T00:00:00.000Z"),
            spent: 10, projected: 20, budget: 100, calendar: utcCalendar
        )
        XCTAssertEqual(after?.currentDay, 31)
    }

    func testSpendPaceProjectedNeverBelowSpent() {
        let pace = SpendPace.make(
            month: "2026-02", // 2026 is not a leap year → 28 days
            generatedAt: ISO8601DateParser.date(from: "2026-02-10T00:00:00.000Z"),
            spent: 300, projected: 250, budget: 400, calendar: utcCalendar
        )
        XCTAssertEqual(pace?.daysInMonth, 28)
        XCTAssertEqual(pace?.projected, 300) // clamped up to spent
    }

    // MARK: - TimeframeOption tests

    func testTimeframeOptionLabels() {
        XCTAssertEqual(TimeframeOption.rolling(days: 1).displayLabel, "Past 24 hours")
        XCTAssertEqual(TimeframeOption.rolling(days: 7).displayLabel, "Past 7 days")
        XCTAssertEqual(TimeframeOption.rolling(days: 30).displayLabel, "Past 30 days")
        XCTAssertEqual(TimeframeOption.rolling(days: 90).displayLabel, "Past 90 days")
        XCTAssertEqual(TimeframeOption.rolling(days: 180).displayLabel, "Past 180 days")
        XCTAssertEqual(TimeframeOption.rolling(days: 365).displayLabel, "Past 12 months")
        XCTAssertEqual(TimeframeOption.rolling(days: 3650).displayLabel, "All time")
        XCTAssertEqual(TimeframeOption.currentMonth.displayLabel, "This month")
        XCTAssertEqual(TimeframeOption.calendarYear(year: 2026).displayLabel, "2026")
    }

    func testTimeframeOptionQueryItems() {
        let rolling365 = TimeframeOption.rolling(days: 365)
        XCTAssertEqual(rolling365.usageEventsQueryItems, [URLQueryItem(name: "days", value: "365")])

        let month = TimeframeOption.calendarMonth(year: 2026, month: 8)
        XCTAssertEqual(month.usageEventsQueryItems, [
            URLQueryItem(name: "from", value: "2026-08-01"),
            URLQueryItem(name: "to", value: "2026-08-31"),
        ])
    }

    func testTimeframeRecentMonths() {
        let months = TimeframeOption.recentMonths(count: 13)
        XCTAssertEqual(months.count, 13)
        XCTAssertEqual(months.first, TimeframeOption.currentMonth)
    }

    // MARK: - Fixture helpers

    private func makeResponse(budget: Double, providers: [ProviderBudgetStatus]) -> BudgetStatusResponse {
        let summary = BudgetSummary(
            totalBudgetUsd: budget,
            budgetedSpentUsd: providers.reduce(0) { $0 + $1.spentUsd },
            unbudgetedSpentUsd: 0,
            totalSpentUsd: providers.reduce(0) { $0 + $1.spentUsd },
            estimatedApiEquivalentUsd: 0,
            remainingUsd: budget - providers.reduce(0) { $0 + $1.spentUsd },
            percentUsed: nil,
            overBudget: false,
            warning: false
        )
        return BudgetStatusResponse(
            ok: true, generatedAt: "2026-07-19T09:15:00.000Z", month: "2026-07",
            providers: providers, projects: nil, summary: summary
        )
    }

    private func provider(
        id: String = "p",
        name: String = "Provider",
        spent: Double,
        projected: Double,
        budget: Double?,
        status: BudgetLevel,
        coverage: CostCoverage = .complete,
        projectedStatus: BudgetLevel? = nil,
        fixedAccrued: Double = 0,
        renewals: Double = 0,
        projectedVariable: Double? = nil
    ) -> ProviderBudgetStatus {
        ProviderBudgetStatus(
            id: id, name: name, displayName: name,
            monthlyBudgetUsd: budget,
            spendCoverage: coverage,
            fixedAccruedUsd: fixedAccrued,
            forecastedSubscriptionRenewalsUsd: renewals,
            projectedVariableUsageUsd: projectedVariable,
            spentUsd: spent,
            projectedEomUsd: projected,
            remainingUsd: budget.map { $0 - spent },
            percentUsed: budget.map { $0 > 0 ? spent / $0 : 0 },
            status: status,
            projectedStatus: projectedStatus
        )
    }
}
