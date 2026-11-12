import XCTest
import Foundation
@testable import Models

/// Models-lane tests for `SubscriptionSummary`: cadence pluralization (I8),
/// the external-billing management helpers (I5), and forward-compatible
/// decoding of the managed/charged fields.
final class SubscriptionModelTests: XCTestCase {

    // MARK: - cadenceLabel (I8)

    private func summary(interval: String, intervalCount: Int) -> SubscriptionSummary {
        SubscriptionSummary(
            id: "s1",
            name: "Plan",
            costUsd: 20,
            interval: interval,
            intervalCount: intervalCount,
            monthlyEquivalentUsd: 20,
            startDate: "2026-01-01T00:00:00.000Z",
            currentPeriodStart: "2026-07-01T00:00:00.000Z",
            nextRenewalAt: "2026-08-01T00:00:00.000Z",
            status: "active",
            effectiveStatus: "active",
            provider: .init(id: "p1", name: "openai", displayName: "OpenAI")
        )
    }

    func testSingleIntervalKeepsRawLabel() {
        XCTAssertEqual(summary(interval: "monthly", intervalCount: 1).cadenceLabel, "monthly")
        XCTAssertEqual(summary(interval: "annual", intervalCount: 1).cadenceLabel, "annual")
    }

    func testPluralizedCadenceUsesNouns() {
        XCTAssertEqual(summary(interval: "monthly", intervalCount: 3).cadenceLabel, "every 3 months")
        XCTAssertEqual(summary(interval: "weekly", intervalCount: 2).cadenceLabel, "every 2 weeks")
        XCTAssertEqual(summary(interval: "quarterly", intervalCount: 2).cadenceLabel, "every 2 quarters")
        XCTAssertEqual(summary(interval: "annual", intervalCount: 2).cadenceLabel, "every 2 years")
    }

    func testUnknownIntervalFallsBackToRawPlural() {
        XCTAssertEqual(summary(interval: "fortnightly", intervalCount: 3).cadenceLabel, "every 3 fortnightlys")
    }

    // MARK: - External billing helpers (I5)

    func testManagedFlagDefaultsToFalseWhenUnknown() {
        XCTAssertFalse(summary(interval: "monthly", intervalCount: 1).isExternalBillingManaged)
        XCTAssertFalse(summary(interval: "monthly", intervalCount: 1).isExternalBillingLinked)
    }

    func testManagedAndLinkedDecodeFromPayload() throws {
        let json: [String: Any] = [
            "id": "s1", "name": "Workers Paid", "costUsd": 5, "currency": "USD",
            "interval": "monthly", "intervalCount": 1, "monthlyEquivalentUsd": 5,
            "startDate": "2026-01-01T00:00:00.000Z",
            "currentPeriodStart": "2026-07-01T00:00:00.000Z",
            "nextRenewalAt": "2026-08-01T00:00:00.000Z",
            "autoRenew": false, "status": "active", "effectiveStatus": "active",
            "externalBillingSource": "cloudflare",
            "externalBillingId": "workers-paid",
            "externalBillingManaged": true,
            "lastChargedPeriodStart": "2026-07-01T00:00:00.000Z",
            "provider": ["id": "p1", "name": "cloudflare", "displayName": "Cloudflare"],
        ]
        let decoded = try JSONDecoder().decode(
            SubscriptionSummary.self,
            from: JSONSerialization.data(withJSONObject: json)
        )
        XCTAssertTrue(decoded.isExternalBillingManaged)
        XCTAssertTrue(decoded.isExternalBillingLinked)
    }

    func testResumeEligibility() {
        var paused = summary(interval: "monthly", intervalCount: 1)
        paused.status = "paused"
        paused.effectiveStatus = "paused"
        // Watermark unknown (nil) → resume is offered; the server validates.
        XCTAssertTrue(paused.canAttemptResume)

        paused.lastChargedPeriodStart = "2026-07-01T00:00:00.000Z"
        XCTAssertTrue(paused.canAttemptResume)

        paused.lastChargedPeriodStart = ""
        XCTAssertFalse(paused.canAttemptResume)

        var active = summary(interval: "monthly", intervalCount: 1)
        active.lastChargedPeriodStart = "2026-07-01T00:00:00.000Z"
        XCTAssertFalse(active.canAttemptResume, "Only paused/canceled rows can resume.")
    }
}
