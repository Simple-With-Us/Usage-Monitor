import XCTest
@testable import Models

final class AgentsOverviewDecodingTests: XCTestCase {
    func testDecodesTelemetryAccuracyAndNetSeatCost() throws {
        let json = """
        {
          "ok": true,
          "windowDays": 30,
          "windowLabel": "Last 30 Days",
          "generatedAt": "2026-09-03T12:00:00.000Z",
          "macHostname": "jays.services",
          "macChip": "Apple M5",
          "summary": {
            "activeAgentCount": 2,
            "totalAgentCount": 6,
            "totalTokens": 100000,
            "totalApiEquivalentCostUsd": 12.5,
            "totalSubscriptionCostUsd": 179,
            "totalNetSavingsUsd": 0,
            "savingsMultiplier": 0.1,
            "topModel": "claude-sonnet",
            "telemetryIncomplete": true,
            "telemetryIncompleteNote": "Token totals omit Antigravity because that seat is not reporting usage.",
            "unreliablePlatformIds": ["antigravity-cli"]
          },
          "burn5h": {
            "tokens5h": 0,
            "costEstimate5hUsd": 0,
            "burnRateTokensPerHour": 0,
            "burnRateUsdPerHour": 0
          },
          "platforms": [
            {
              "id": "antigravity-cli",
              "name": "Antigravity",
              "provider": "Google",
              "isRunningOnMac": true,
              "macStatus": "running",
              "dataCapability": "Quota windows from agy /usage only. Token telemetry is not available.",
              "fidelityTier": "unavailable",
              "notes": "Google Antigravity does not expose token telemetry.",
              "monthlySeatCostUsd": 70,
              "listMonthlySeatCostUsd": 100,
              "bundledOffsetUsd": 30,
              "bundledOffsetLabel": "Google One",
              "seatCostNote": "$100/mo plan.  $30 of that was already Google One, so $70 net for the AI.",
              "telemetryAccuracy": "unavailable",
              "telemetryAccuracyLabel": "not reported",
              "telemetryAccuracyNote": "Antigravity does not expose token telemetry.  This is not zero use.",
              "usageIsReliable": false,
              "totalTokens": 0,
              "inputTokens": 0,
              "outputTokens": 0,
              "cacheReadTokens": 0,
              "cacheCreationTokens": 0,
              "apiEquivalentCostUsd": 0,
              "reportedCostUsd": 0,
              "estimatedCostUsd": 0,
              "netSavingsUsd": 0,
              "modelsUsed": []
            }
          ],
          "modelDistribution": []
        }
        """

        let decoded = try JSONDecoder().decode(
            AgentsOverviewResponse.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(decoded.summary.telemetryIncomplete, true)
        XCTAssertEqual(decoded.platforms.count, 1)
        let platform = decoded.platforms[0]
        XCTAssertEqual(platform.monthlySeatCostUsd, 70)
        XCTAssertEqual(platform.listMonthlySeatCostUsd, 100)
        XCTAssertEqual(platform.bundledOffsetUsd, 30)
        XCTAssertEqual(platform.usageIsReliable, false)
        XCTAssertFalse(platform.reportsUsage)
        XCTAssertEqual(platform.seatCostDisplay, "$70/mo net")
        XCTAssertEqual(platform.telemetryAccuracyLabel, "not reported")
    }

    func testLegacyPayloadWithoutAccuracyFieldsStillDecodes() throws {
        let json = """
        {
          "ok": true,
          "windowDays": 7,
          "windowLabel": "Last 7 Days",
          "generatedAt": "2026-08-24T05:00:00.000Z",
          "macHostname": "jays.services",
          "macChip": "Apple M5",
          "summary": {
            "activeAgentCount": 1,
            "totalAgentCount": 6,
            "totalTokens": 1000,
            "totalApiEquivalentCostUsd": 1,
            "totalSubscriptionCostUsd": 20,
            "totalNetSavingsUsd": 0,
            "savingsMultiplier": 0.05,
            "topModel": null
          },
          "burn5h": {
            "tokens5h": 0,
            "costEstimate5hUsd": 0,
            "burnRateTokensPerHour": 0,
            "burnRateUsdPerHour": 0
          },
          "platforms": [
            {
              "id": "claude-code",
              "name": "Claude Code / Desktop",
              "provider": "Anthropic",
              "isRunningOnMac": false,
              "macStatus": "idle",
              "dataCapability": "OTLP",
              "fidelityTier": "realtime_otlp",
              "notes": "OTLP",
              "monthlySeatCostUsd": 20,
              "totalTokens": 1000,
              "inputTokens": 800,
              "outputTokens": 200,
              "cacheReadTokens": 0,
              "cacheCreationTokens": 0,
              "apiEquivalentCostUsd": 1,
              "reportedCostUsd": 1,
              "estimatedCostUsd": 1,
              "netSavingsUsd": 0,
              "modelsUsed": []
            }
          ],
          "modelDistribution": []
        }
        """

        let decoded = try JSONDecoder().decode(
            AgentsOverviewResponse.self,
            from: Data(json.utf8)
        )
        XCTAssertNil(decoded.summary.telemetryIncomplete)
        XCTAssertTrue(decoded.platforms[0].reportsUsage)
        XCTAssertEqual(decoded.platforms[0].seatCostDisplay, "$20/mo")
    }
}
