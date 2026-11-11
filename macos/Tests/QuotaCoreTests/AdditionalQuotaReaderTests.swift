import Foundation
import XCTest
@testable import QuotaCore

final class AdditionalQuotaReaderTests: XCTestCase {
    func testReadsGeminiAndKimiWithoutExposingCredentials() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".gemini"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".kimi-code/credentials"), withIntermediateDirectories: true)
        try Data(#"{"access_token":"gemini-secret","expiry_date":4102444800000}"#.utf8).write(to: home.appendingPathComponent(".gemini/oauth_creds.json"))
        try Data(#"{"access_token":"kimi-secret"}"#.utf8).write(to: home.appendingPathComponent(".kimi-code/credentials/kimi-code.json"))
        defer { try? FileManager.default.removeItem(at: home) }
        let reader = AdditionalQuotaReader(homeDirectory: home, fetchJSON: { request in
            if request.url?.host == "cloudcode-pa.googleapis.com" {
                XCTAssertEqual(request.url?.path, "/v1internal:retrieveUserQuota")
                return Self.response(#"{"buckets":[{"modelId":"gemini-pro","remainingFraction":0.42,"resetTime":"2026-09-14T00:00:00Z"}]}"#)
            }
            XCTAssertEqual(request.url?.host, "api.kimi.com")
            return Self.response(#"{"usage":{"limit":"2048","used":"214","remaining":"1834","resetTime":"2026-09-15T00:00:00Z"},"limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},"detail":{"limit":"200","used":"139","remaining":"61","resetTime":"2026-09-13T12:00:00Z"}}]}"#)
        })
        let result = await reader.read()
        XCTAssertEqual(result.windows.first(where: { $0.providerKey == "gemini-cli" })?.remainingPercent, 42)
        XCTAssertEqual(result.windows.first(where: { $0.providerKey == "kimi" && $0.window == "300m" })?.absoluteRemaining, 61)
        XCTAssertFalse(result.issues.values.joined(separator: " ").contains("secret"))
    }

    func testUnauthorizedAndOversizedResponsesAreSanitized() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".gemini"), withIntermediateDirectories: true)
        try Data(#"{"access_token":"hidden"}"#.utf8).write(to: home.appendingPathComponent(".gemini/oauth_creds.json"))
        defer { try? FileManager.default.removeItem(at: home) }
        let reader = AdditionalQuotaReader(homeDirectory: home, fetchJSON: { _ in Self.response(#"{"account":"hidden"}"#, status: 401) })
        let result = await reader.read()
        XCTAssertEqual(result.issues["gemini-cli"], "Gemini CLI needs you to sign in again.")
        XCTAssertEqual(result.issues["kimi"], "Kimi Code is not signed in locally.")
        XCTAssertFalse(result.issues.values.joined(separator: " ").contains("hidden"))
    }

    func testExpiryAndInvalidNumericWindowsStayUnknown() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".gemini"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".kimi-code/credentials"), withIntermediateDirectories: true)
        try Data(#"{"access_token":"expired","expiry_date":1}"#.utf8).write(to: home.appendingPathComponent(".gemini/oauth_creds.json"))
        try Data(#"{"access_token":"kimi"}"#.utf8).write(to: home.appendingPathComponent(".kimi-code/credentials/kimi-code.json"))
        defer { try? FileManager.default.removeItem(at: home) }
        let reader = AdditionalQuotaReader(homeDirectory: home, now: { Date(timeIntervalSince1970: 100) }, fetchJSON: { _ in
            Self.response(#"{"usage":{"limit":"100","used":"25","resetTime":"2026-09-15T00:00:00Z"},"limits":[{"window":{"duration":0,"timeUnit":"TIME_UNIT_MINUTE"},"detail":{"limit":true,"used":"nan","resetTime":"2026-09-13T12:00:00Z"}}]}"#)
        })
        let result = await reader.read()
        XCTAssertEqual(result.issues["gemini-cli"], "Gemini CLI needs you to sign in again.")
        let plan = result.windows.first(where: { $0.providerKey == "kimi" && $0.label == "Plan quota" })
        XCTAssertEqual(plan?.remainingPercent, 75)
        XCTAssertEqual(plan?.absoluteRemaining, 75)
        XCTAssertFalse(result.windows.contains { $0.window == "0m" })
    }

    private static func response(_ body: String, status: Int = 200) -> (Data, HTTPURLResponse) {
        (Data(body.utf8), HTTPURLResponse(url: URL(string: "https://fixture.invalid")!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}
