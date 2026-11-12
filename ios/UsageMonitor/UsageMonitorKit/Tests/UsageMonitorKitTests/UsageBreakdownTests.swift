import XCTest
@testable import Models
@testable import DesignSystem

final class UsageBreakdownTests: XCTestCase {

    func testAppResolution() {
        let st = ExternalBillingRecord(
            source: "backblaze-b2-bucket-storage",
            externalId: "b_1",
            kind: "service_plan",
            serviceName: "jays-socratic-trade-eu",
            usageQuantity: 150.0,
            usageUnit: "GB",
            syncedAt: "2026-08-24T00:00:00.000Z"
        )
        XCTAssertEqual(st.resolvedAppName, "Socratic.Trade")
        XCTAssertEqual(st.formattedUsage, "150.0 GB")

        let ct = ExternalBillingRecord(
            source: "backblaze-b2-bucket-storage",
            externalId: "b_2",
            kind: "service_plan",
            serviceName: "jays-congress-trade-eu",
            usageQuantity: 30.5,
            usageUnit: "GB",
            syncedAt: "2026-08-24T00:00:00.000Z"
        )
        XCTAssertEqual(ct.resolvedAppName, "Congress.Trade")
        XCTAssertEqual(ct.formattedUsage, "30.5 GB")

        let um = ExternalBillingRecord(
            source: "backblaze-b2-bucket-storage",
            externalId: "b_3",
            kind: "service_plan",
            serviceName: "jays-usage-monitor-eu",
            usageQuantity: 12.0,
            usageUnit: "GB",
            syncedAt: "2026-08-24T00:00:00.000Z"
        )
        XCTAssertEqual(um.resolvedAppName, "Usage Monitor")
        XCTAssertEqual(um.formattedUsage, "12.0 GB")

        let fleet = ExternalBillingRecord(
            source: "backblaze-b2-bucket-storage",
            externalId: "b_4",
            kind: "service_plan",
            serviceName: "jays-fleet-eu",
            usageQuantity: 3.6,
            usageUnit: "GB",
            syncedAt: "2026-08-24T00:00:00.000Z"
        )
        XCTAssertEqual(fleet.resolvedAppName, "Fleet Infra")
        XCTAssertEqual(fleet.formattedUsage, "3.60 GB")
    }

    func testDecodesExternalBillingInBudgetStatus() throws {
        let json = """
        {
          "id": "prov_backblaze",
          "name": "backblaze",
          "displayName": "Backblaze B2",
          "monthlyBudgetUsd": 4.00,
          "fixedMonthlyCostUsd": 0,
          "pushedMonthToDateUsd": 0,
          "receiptCashPaidUsd": 0,
          "observedVariableUsageUsd": 1.41,
          "estimatedApiEquivalentUsd": 0,
          "spendCoverage": "partial",
          "subscriptionMonthToDateUsd": 0,
          "fixedAccruedUsd": 0,
          "forecastedSubscriptionRenewalsUsd": 0,
          "spentUsd": 1.41,
          "projectedEomUsd": 3.87,
          "status": "ok",
          "alerts": [],
          "externalBilling": [
            {
              "source": "backblaze-b2-bucket-storage",
              "externalId": "b_st",
              "kind": "service_plan",
              "serviceName": "jays-socratic-trade-eu",
              "planName": "B2 bucket",
              "status": "active",
              "amountUsd": 0.90,
              "currency": "USD",
              "usageQuantity": 150.0,
              "usageUnit": "GB",
              "syncedAt": "2026-08-24T04:00:00.000Z"
            },
            {
              "source": "backblaze-b2-bucket-storage",
              "externalId": "b_ct",
              "kind": "service_plan",
              "serviceName": "jays-congress-trade-eu",
              "planName": "B2 bucket",
              "status": "active",
              "amountUsd": 0.18,
              "currency": "USD",
              "usageQuantity": 30.5,
              "usageUnit": "GB",
              "syncedAt": "2026-08-24T04:00:00.000Z"
            }
          ]
        }
        """.data(using: .utf8)!

        let provider = try JSONDecoder().decode(ProviderBudgetStatus.self, from: json)
        XCTAssertEqual(provider.title, "Backblaze B2")
        XCTAssertEqual(provider.externalBilling?.count, 2)
        XCTAssertEqual(provider.externalBilling?.first?.resolvedAppName, "Socratic.Trade")
        XCTAssertEqual(provider.externalBilling?.first?.usageQuantity, 150.0)
        XCTAssertEqual(provider.externalBilling?.first?.usageUnit, "GB")
    }

    func testUsageBreakdownCardItemConstruction() {
        let item = UsageBreakdownItem(
            id: "1",
            title: "Socratic.Trade",
            subtitle: "jays-socratic-trade-eu",
            value: 150.0,
            formattedValue: "150.0 GB",
            secondaryValue: "$0.90",
            percentage: 0.765,
            status: .ok,
            color: Theme.Colors.accent
        )

        XCTAssertEqual(item.title, "Socratic.Trade")
        XCTAssertEqual(item.value, 150.0)
        XCTAssertEqual(item.formattedValue, "150.0 GB")
        XCTAssertEqual(item.secondaryValue, "$0.90")
        XCTAssertEqual(item.percentage, 0.765)
    }
}
