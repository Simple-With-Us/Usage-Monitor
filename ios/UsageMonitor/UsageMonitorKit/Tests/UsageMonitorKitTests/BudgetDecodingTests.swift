import XCTest
@testable import Models
@testable import AppCore
import DesignSystem

/// Foundation-owned tests: they lock down the API⇄Model decoding contract and
/// the domain→DesignSystem status mapping every feature relies on. Feature
/// lanes add their own test files alongside this one.
final class BudgetDecodingTests: XCTestCase {

    /// A trimmed but faithful `GET /api/budget-status` payload — extra backend
    /// fields present to prove `Codable` ignores what the app doesn't model.
    private let json = """
    {
      "ok": true,
      "generatedAt": "2026-07-19T09:15:00.000Z",
      "month": "2026-07",
      "providers": [
        {
          "id": "prov_anthropic",
          "name": "anthropic",
          "displayName": "Anthropic",
          "monthlyBudgetUsd": 250,
          "fixedMonthlyCostUsd": 0,
          "snapshotCostUsd": 212.40,
          "snapshotCostFetchedAt": "2026-07-19T09:15:00.000Z",
          "pushedMonthToDateUsd": 212.40,
          "receiptCashPaidUsd": 0,
          "observedVariableUsageUsd": 212.40,
          "estimatedApiEquivalentUsd": 0,
          "spendCoverage": "partial",
          "subscriptionMonthToDateUsd": 0,
          "fixedAccruedUsd": 0,
          "forecastedSubscriptionRenewalsUsd": 0,
          "spentUsd": 212.40,
          "projectedEomUsd": 335.10,
          "remainingUsd": 37.60,
          "percentUsed": 0.8496,
          "status": "warning",
          "someFutureFieldTheAppIgnores": {"nested": true},
          "alerts": [
            {"code": "budget_warning", "severity": "warning", "message": "At 85% of budget."}
          ]
        }
      ],
      "projects": [
        {
          "id": "proj_x", "name": "Trade", "monthlyBudgetUsd": 400,
          "spentUsd": 246.8, "projectedEomUsd": 388, "spendCoverage": "brand_new_value",
          "remainingUsd": 153.2, "percentUsed": 0.617, "status": "warning"
        }
      ],
      "summary": {
        "totalBudgetUsd": 650, "budgetedSpentUsd": 459.2, "unbudgetedSpentUsd": 0,
        "totalSpentUsd": 459.2, "estimatedApiEquivalentUsd": 512.3, "remainingUsd": 190.8,
        "percentUsed": 0.706, "overBudget": false, "warning": true
      }
    }
    """.data(using: .utf8)!

    func testDecodesFullBudgetResponse() throws {
        let response = try JSONDecoder().decode(BudgetStatusResponse.self, from: json)
        XCTAssertTrue(response.ok)
        XCTAssertEqual(response.month, "2026-07")
        XCTAssertEqual(response.providers.count, 1)

        let provider = try XCTUnwrap(response.providers.first)
        XCTAssertEqual(provider.title, "Anthropic")
        XCTAssertEqual(provider.status, .warning)
        XCTAssertEqual(provider.spendCoverage, .partial)
        XCTAssertTrue(provider.hasBudget)
        XCTAssertEqual(provider.alerts.first?.severity, .warning)
        XCTAssertNotNil(response.generatedAtDate)
    }

    /// Unknown enum values must degrade, not throw — the backend can add codes.
    func testUnknownEnumsDegradeGracefully() throws {
        let response = try JSONDecoder().decode(BudgetStatusResponse.self, from: json)
        let project = try XCTUnwrap(response.projects?.first)
        XCTAssertEqual(project.spendCoverage, .unknown) // "brand_new_value" → .unknown
    }

    func testSemanticStatusMapping() {
        XCTAssertEqual(Theme.SemanticStatus(BudgetLevel.exceeded), .danger)
        XCTAssertEqual(Theme.SemanticStatus(BudgetLevel.ok), .ok)
        XCTAssertEqual(Theme.SemanticStatus(AlertSeverity.critical), .danger)
        XCTAssertEqual(Theme.SemanticStatus(coverage: .partial), .warning)
    }

    func testLoadStatePhases() {
        let loading = LoadState<Int>.loading
        XCTAssertTrue(loading.isInitialLoading)
        XCTAssertNil(loading.value)

        let loaded = LoadState<Int>.loaded(7)
        XCTAssertEqual(loaded.value, 7)
        XCTAssertFalse(loaded.isInitialLoading)
    }
}
