import Foundation
import XCTest
@testable import QuotaCore

final class GrokBotQuotaReaderTests: XCTestCase {
    private let observedAt = Date(timeIntervalSince1970: 1_789_000_000)

    func testReadsSeparateWeeklyGrokBotAllowanceThroughDashboardRPC() async {
        let reader = GrokBotQuotaReader(
            now: { self.observedAt },
            accessToken: { "cursor-access-token" },
            fetch: { request in
                XCTAssertEqual(request.url?.absoluteString, "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus")
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer cursor-access-token")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Connect-Protocol-Version"), "1")
                XCTAssertEqual(request.value(forHTTPHeaderField: "x-cursor-client-type"), "sand")
                XCTAssertEqual(request.value(forHTTPHeaderField: "x-cursor-client-version"), "0.47.0")
                XCTAssertEqual(request.value(forHTTPHeaderField: "x-sand-box-namespace"), "prod")
                XCTAssertEqual(request.value(forHTTPHeaderField: "x-ghost-mode"), "true")
                XCTAssertEqual(String(data: request.httpBody ?? Data(), encoding: .utf8), "{}")
                return Self.response("""
                {"usagePercent":25,"currentPeriodStart":"2026-09-09T08:00:00Z","nextResetTimestampUtc":"2026-09-16T08:00:00Z","hasNonZeroIncludedLimit":true,"usesPooledEnterpriseAllowance":false,"grokPlanLabel":"Pro+"}
                """)
            }
        )

        let result = await reader.read()
        XCTAssertTrue(result.issues.isEmpty)
        XCTAssertEqual(result.windows.count, 1)
        let window = result.windows[0]
        XCTAssertEqual(window.provider, "Grok Bot")
        XCTAssertEqual(window.providerKey, "grok-bot")
        XCTAssertEqual(window.via, "cursor")
        XCTAssertEqual(window.remainingPercent, 75)
        XCTAssertEqual(window.planName, "Pro+")
        XCTAssertEqual(window.window, "weekly")
        XCTAssertEqual(window.resetAt, "2026-09-16T08:00:00.000Z")
        XCTAssertEqual(window.status, .available)
        XCTAssertFalse(window.isExhausted)
    }

    func testMissingTokenDoesNotMakeNetworkRequest() async {
        let reader = GrokBotQuotaReader(
            accessToken: { nil },
            fetch: { _ in
                XCTFail("missing Cursor session must not make a request")
                return Self.response("{}", status: 500)
            }
        )

        let result = await reader.read()
        XCTAssertEqual(result.issues["grok-bot"], "Grok Bot requires a signed-in Cursor account.")
        XCTAssertTrue(result.windows.isEmpty)
    }

    func testRejectedSessionIsSanitized() async {
        let secret = "account-secret-must-not-leak"
        let reader = GrokBotQuotaReader(
            accessToken: { "cursor-access-token" },
            fetch: { _ in Self.response("{\"account\":\"\(secret)\"}", status: 401) }
        )

        let result = await reader.read()
        XCTAssertEqual(result.issues["grok-bot"], "Grok Bot session was rejected; sign in again in Cursor.")
        XCTAssertFalse(result.issues.values.joined().contains(secret))
    }

    func testPooledEnterpriseAllowanceIsNotFlattenedIntoPersonalWindow() async {
        let reader = GrokBotQuotaReader(
            accessToken: { "cursor-access-token" },
            fetch: { _ in Self.response("{\"usagePercent\":90,\"usesPooledEnterpriseAllowance\":true}") }
        )

        let result = await reader.read()
        XCTAssertEqual(result.windows.count, 1)
        XCTAssertTrue(result.windows[0].remainingUnknown)
        XCTAssertEqual(result.issues["grok-bot"], "Grok Bot returned no readable included weekly quota.")
    }

    func testExplicitlyZeroIncludedLimitStaysUnknown() async {
        let reader = GrokBotQuotaReader(
            accessToken: { "cursor-access-token" },
            fetch: { _ in Self.response("{\"usagePercent\":90,\"hasNonZeroIncludedLimit\":false,\"nextResetTimestampUtc\":\"2026-09-16T08:00:00Z\"}") }
        )

        let result = await reader.read()
        XCTAssertEqual(result.windows.count, 1)
        XCTAssertTrue(result.windows[0].remainingUnknown)
        XCTAssertNil(result.windows[0].remainingPercent)
        XCTAssertEqual(result.issues["grok-bot"], "Grok Bot returned no readable included weekly quota.")
    }

    func testMalformedOrMissingPercentageStaysUnknown() async {
        let reader = GrokBotQuotaReader(
            accessToken: { "cursor-access-token" },
            fetch: { _ in Self.response("{\"hasNonZeroIncludedLimit\":true,\"currentPeriodStart\":\"2026-09-09T08:00:00Z\",\"nextResetTimestampUtc\":\"2026-09-16T08:00:00Z\"}") }
        )

        let result = await reader.read()
        XCTAssertEqual(result.windows.count, 1)
        XCTAssertNil(result.windows[0].remainingPercent)
        XCTAssertEqual(result.issues["grok-bot"], "Grok Bot returned no readable included weekly quota.")
    }

    func testSnakeCaseAndTimestampObjectAreAccepted() async {
        let reader = GrokBotQuotaReader(
            accessToken: { "cursor-access-token" },
            fetch: { _ in Self.response("{\"usage_percent\":100,\"current_period_start\":{\"seconds\":1788931200},\"next_reset_timestamp_utc\":{\"seconds\":1789536000},\"grok_plan_label\":\"Trial\"}") }
        )

        let result = await reader.read()
        let window = result.windows[0]
        XCTAssertEqual(window.remainingPercent, 0)
        XCTAssertEqual(window.status, .exhausted)
        XCTAssertTrue(window.skip)
        XCTAssertEqual(window.planName, "Trial")
        XCTAssertEqual(window.resetAt, "2026-09-16T05:20:00.000Z")
    }

    func testUnsafeHeaderTokenFailsClosed() async {
        let reader = GrokBotQuotaReader(
            accessToken: { "bad\nheader" },
            fetch: { _ in
                XCTFail("unsafe token must not make a request")
                return Self.response("{}")
            }
        )

        let result = await reader.read()
        XCTAssertEqual(result.issues["grok-bot"], "Grok Bot requires a signed-in Cursor account.")
    }

    private static func response(_ text: String, status: Int = 200) -> (Data, HTTPURLResponse) {
        let response = HTTPURLResponse(
            url: URL(string: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus")!,
            statusCode: status,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        return (Data(text.utf8), response)
    }
}
