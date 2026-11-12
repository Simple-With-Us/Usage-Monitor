import XCTest
@testable import LocalDataPlane
@testable import LocalBudget
@testable import LocalStore

final class LocalAlertBuilderTests: XCTestCase {
    func testExceededAndFetchErrorSurface() {
        let providerId = UUID().uuidString
        let provider = LocalProvider(
            id: providerId,
            name: "openai",
            displayName: "OpenAI",
            adapterKind: "openai",
            isActive: true,
            keychainAccountId: "k1",
            lastFetchError: "HTTP 401"
        )
        let plan = LocalProviderPlan(providerId: providerId, monthlyBudgetUsd: 10)
        let snap = LocalUsageSnapshot(
            providerId: providerId,
            fetchedAt: Date(),
            totalCost: 50,
            costWindowStart: BudgetEngine.utcMonthStart(),
            costWindowEnd: Date(),
            costScope: "calendar_month_to_date"
        )
        let summary = BudgetEngine.compute(
            providers: [provider],
            plans: [providerId: plan],
            snapshots: [snap],
            subscriptions: [],
            charges: []
        )
        // Attach fetch error onto the computed row via a synthetic rebuild path:
        // LocalAlertBuilder reads lastFetchError from ProviderSpend, which comes from LocalProvider.
        var providersWithError = [provider]
        // BudgetEngine copies lastFetchError from provider — recompute after setting.
        providersWithError[0].lastFetchError = "HTTP 401"
        let summary2 = BudgetEngine.compute(
            providers: providersWithError,
            plans: [providerId: plan],
            snapshots: [snap],
            subscriptions: [],
            charges: []
        )
        let alerts = LocalAlertBuilder.build(
            summary: summary2,
            providers: providersWithError,
            projects: []
        )
        XCTAssertTrue(alerts.contains { $0.id.contains("budget-exceeded") }, alerts.map(\.id).joined())
        XCTAssertTrue(alerts.contains { $0.id.contains("fetch-error") }, alerts.map(\.id).joined())
        _ = summary
    }
}
