import XCTest
@testable import Dashboard
@testable import Models

/// Wire-contract and presentation-math tests for the Overview "Subscription
/// Quotas" card (`GET /api/quota-windows`).
///
/// The main fixture below mirrors the real route's shape from
/// `src/lib/quota-windows.ts` / `src/app/api/quota-windows/route.ts`: one
/// Antigravity model-family bucket, one Claude window, one exhausted Codex
/// window, and Grok/MiniMax deliberately absent so the empty-row rule has
/// something to prove. It also carries fields the route does not emit today
/// (`skip`, `skipReason`, `providerLabel`, `via`) to prove unknown/additive
/// keys never break the decode — a parallel server change is landing
/// `providerLabel` and `via` as ADDITIVE fields alongside new collectors.
final class QuotaWindowsDecodingTests: XCTestCase {

    func testPlanMetadataDecodesAndMalformedOptionalFieldsDoNotDropWindow() throws {
        let json = #"{"windows":[{"id":"plan","provider":"claude","remainingUnknown":true,"planName":"Max 20x","planMetadata":{"detectedPlanName":"Max 20x","userPlanName":"Team","userCostUsd":"200","userRenewalDateText":"Tomorrow","userSubtitle":"Work","showCostAndRenewal":false,"hasMismatch":true}},{"id":"legacy","provider":"codex"},{"id":"partial","provider":"claude","planMetadata":{"userSubtitle":42}}]}"#
        let response = try JSONDecoder().decode(QuotaWindowsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.windows.count, 3)
        let row = response.windows[0]
        XCTAssertEqual(row.planName, "Max 20x")
        XCTAssertEqual(row.planMetadata?.detectedPlanName, "Max 20x")
        XCTAssertEqual(row.planMetadata?.userPlanName, "Team")
        XCTAssertEqual(row.planMetadata?.userCostUsd, "200")
        XCTAssertEqual(row.planMetadata?.userRenewalDateText, "Tomorrow")
        XCTAssertEqual(row.planMetadata?.userSubtitle, "Work")
        XCTAssertEqual(row.planMetadata?.showCostAndRenewal, false)
        XCTAssertEqual(row.planMetadata?.hasMismatch, true)
        XCTAssertNil(row.remainingPercent)
        XCTAssertNil(response.windows[1].planMetadata)
        XCTAssertNil(response.windows[2].planMetadata?.userSubtitle)
        XCTAssertEqual(response.windows[2].planMetadata?.hasMismatch, false)
    }

    private let quotaWindowsJSON = """
        {
          "ok": true,
          "generatedAt": "2026-09-12T18:00:00.000Z",
          "windows": [
            {
              "id": "google-antigravity:claude-opus-4-6-thinking",
              "provider": "google-antigravity",
              "sourceApp": "antigravity",
              "modelId": "claude-opus-4-6-thinking",
              "modelType": "claude-opus-4-6-thinking",
              "label": "Claude Opus 4.6 (Thinking)",
              "remainingPercent": 62,
              "remainingUnknown": false,
              "isExhausted": false,
              "resetAt": "2026-09-13T04:00:00.000Z",
              "window": "24h",
              "status": "available",
              "skip": false,
              "skipReason": null,
              "occurredAt": "2026-09-12T17:55:00.000Z",
              "source": "antigravity-usage-collector",
              "providerLabel": "Google Antigravity",
              "via": "antigravity"
            },
            {
              "id": "claude:5h",
              "provider": "claude",
              "label": "5h window",
              "remainingPercent": 18,
              "remainingUnknown": false,
              "isExhausted": false,
              "resetAt": "2026-09-12T21:30:00.000Z",
              "window": "5h",
              "status": "near_cap",
              "occurredAt": "2026-09-12T17:50:00.000Z"
            },
            {
              "id": "codex:7d",
              "provider": "codex",
              "label": "7d window",
              "remainingPercent": 0,
              "remainingUnknown": false,
              "isExhausted": true,
              "resetAt": "2026-09-15T00:00:00.000Z",
              "window": "7d",
              "status": "exhausted",
              "skip": true,
              "skipReason": "7d window remaining 0%",
              "occurredAt": "2026-09-12T17:40:00.000Z"
            }
          ],
          "skipModelTypes": [
            { "instanceId": "antigravity", "model": "claude-opus-4-6-thinking" }
          ]
        }
        """

    private func decodedResponse() throws -> QuotaWindowsResponse {
        try JSONDecoder().decode(QuotaWindowsResponse.self, from: Data(quotaWindowsJSON.utf8))
    }

    // MARK: - Decoding

    func testDecodesRealQuotaWindowsPayload() throws {
        let response = try decodedResponse()

        XCTAssertTrue(response.ok)
        XCTAssertEqual(response.windows.count, 3)
    }

    /// The additive `providerLabel` / `via` fields the parallel server change
    /// introduces must decode even though today's real route never sends
    /// them — and the unmodeled `skip` / `skipReason` / `skipModelTypes`
    /// keys must be silently ignored rather than failing the whole decode.
    func testAdditiveAndUnmodeledFieldsDoNotBreakDecoding() throws {
        let response = try decodedResponse()

        let antigravityWindow = try XCTUnwrap(
            response.windows.first { $0.modelId == "claude-opus-4-6-thinking" })
        XCTAssertEqual(antigravityWindow.via, "antigravity")
        XCTAssertEqual(antigravityWindow.providerLabel, "Google Antigravity")
        XCTAssertEqual(antigravityWindow.provider, "google-antigravity")
    }

    /// A status value the client has never seen must fall back to `.unknown`
    /// rather than throwing and blanking the whole card.
    func testUnknownStatusValueFallsBackInsteadOfThrowing() throws {
        let json = """
            { "id": "x", "provider": "grok", "label": "Monthly", "status": "brand-new-status" }
            """
        let window = try JSONDecoder().decode(QuotaWindow.self, from: Data(json.utf8))
        XCTAssertEqual(window.status, .unknown)
        XCTAssertEqual(window.label, "Monthly")
    }

    // MARK: - Provider classification

    func testClassifyMatchesExpectedProviderSlugsByKeyword() {
        XCTAssertEqual(SubscriptionQuotaProvider.classify("google-antigravity"), .antigravity)
        XCTAssertEqual(SubscriptionQuotaProvider.classify("codex"), .codex)
        XCTAssertEqual(SubscriptionQuotaProvider.classify("openai-codex"), .codex)
        XCTAssertEqual(SubscriptionQuotaProvider.classify("claude"), .claude)
        XCTAssertEqual(SubscriptionQuotaProvider.classify("anthropic-subscription"), .claude)
        XCTAssertEqual(SubscriptionQuotaProvider.classify("grok"), .grok)
        XCTAssertEqual(SubscriptionQuotaProvider.classify("xai-grok"), .grok)
        XCTAssertEqual(SubscriptionQuotaProvider.classify("minimax"), .minimax)
        XCTAssertEqual(SubscriptionQuotaProvider.classify("mmx-api"), .minimax)
        XCTAssertNil(SubscriptionQuotaProvider.classify("openrouter"), "not one of the five expected providers")
    }

    // MARK: - Ordering: lowest remaining first, then name

    /// Claude (18%) must sort ahead of Antigravity (62%); Codex (exhausted,
    /// 0%) is the most urgent and sorts first of all. Grok and MiniMax have
    /// no windows in the fixture and must still appear, sorted after every
    /// provider that has data.
    func testSectionsOrderByLowestRemainingPercentThenName() throws {
        let response = try decodedResponse()
        let sections = response.subscriptionSections

        XCTAssertEqual(sections.map(\.provider), [.codex, .claude, .antigravity, .grok, .minimax])
    }

    /// Every one of the five expected providers must produce a section, even
    /// when the server has nothing for it — the card renders an honest
    /// empty row instead of silently dropping a provider the owner expects.
    func testAllFiveExpectedProvidersAlwaysAppear() throws {
        let response = try decodedResponse()
        let providers = Set(response.subscriptionSections.map(\.provider))
        XCTAssertEqual(providers, Set(SubscriptionQuotaProvider.allCases))
    }

    func testMissingProviderSectionHasEmptyWindowsAndNilMinRemaining() throws {
        let response = try decodedResponse()
        let grok = try XCTUnwrap(response.subscriptionSections.first { $0.provider == .grok })
        XCTAssertTrue(grok.windows.isEmpty)
        XCTAssertNil(grok.minRemainingPercent)
    }

    func testProviderWithDataHasNonNilMinRemaining() throws {
        let response = try decodedResponse()
        let codex = try XCTUnwrap(response.subscriptionSections.first { $0.provider == .codex })
        XCTAssertEqual(codex.minRemainingPercent, 0)
    }

    // MARK: - Status tint mapping

    func testStatusMapsToExpectedSemanticTint() {
        XCTAssertEqual(QuotaWindowStatus.available.semanticStatus, .ok)
        XCTAssertEqual(QuotaWindowStatus.nearCap.semanticStatus, .warning)
        XCTAssertEqual(QuotaWindowStatus.exhausted.semanticStatus, .danger)
        XCTAssertEqual(QuotaWindowStatus.unknown.semanticStatus, .neutral)
    }

    // MARK: - Countdown formatting

    func testCountdownFormatsDaysHoursMinutes() {
        let now = Date(timeIntervalSince1970: 0)

        XCTAssertEqual(
            QuotaCountdownFormat.label(resetAt: now.addingTimeInterval(2 * 86_400 + 3 * 3_600), now: now),
            "Resets in 2d 3h"
        )
        XCTAssertEqual(
            QuotaCountdownFormat.label(resetAt: now.addingTimeInterval(3 * 3_600 + 24 * 60), now: now),
            "Resets in 3h 24m"
        )
        XCTAssertEqual(
            QuotaCountdownFormat.label(resetAt: now.addingTimeInterval(5 * 60), now: now),
            "Resets in 5m"
        )
        XCTAssertEqual(
            QuotaCountdownFormat.label(resetAt: now.addingTimeInterval(30), now: now),
            "Resets in <1m"
        )
    }

    func testCountdownHandlesPastAndMissingResetTimes() {
        let now = Date(timeIntervalSince1970: 1_000)

        XCTAssertEqual(QuotaCountdownFormat.label(resetAt: now.addingTimeInterval(-60), now: now), "Resetting now")
        XCTAssertEqual(QuotaCountdownFormat.label(resetAt: now, now: now), "Resetting now")
        XCTAssertEqual(QuotaCountdownFormat.label(resetAt: nil, now: now), "Reset time unknown")
    }
}
