import Foundation
import XCTest
@testable import QuotaCore

final class LocalQuotaReaderTests: XCTestCase {
    private let observedAt = Date(timeIntervalSince1970: 1_789_000_000)

    func testClaudeAndCodexReadKnownShapesWithoutLeakingCredentials() async throws {
        let root = try makeFixtureHome()
        defer { try? FileManager.default.removeItem(at: root) }
        try writeJSON(["claudeAiOauth": ["accessToken": "claude-secret", "subscriptionType": "max", "expiresAt": observedAt.addingTimeInterval(3600).timeIntervalSince1970]], to: root.appendingPathComponent(".claude/.credentials.json"))
        try writeJSON(["tokens": ["access_token": "codex-secret", "account_id": "account-secret"]], to: root.appendingPathComponent(".codex/auth.json"))

        let reader = LocalQuotaReader(
            homeDirectory: root,
            now: { self.observedAt },
            fetchJSON: { request in
                switch request.url?.host {
                case "api.anthropic.com":
                    return Self.httpResponse("""
                    {"five_hour":{"utilization":25,"resets_at":"2026-09-13T12:00:00Z"},"seven_day":{"utilization":60,"resets_at":"2026-09-19T12:00:00Z"}}
                    """)
                case "chatgpt.com":
                    return Self.httpResponse("""
                    {"plan_type":"plus","rate_limit":{"primary_window":{"used_percent":30,"limit_window_seconds":18000,"reset_after_seconds":1200},"secondary_window":{"used_percent":5,"limit_window_seconds":604800,"resets_at":"2026-09-19T12:00:00Z"}}}
                    """)
                default:
                    XCTFail("unexpected provider request")
                    return Self.httpResponse("{}", status: 500)
                }
            },
            runAntigravity: { Data("{}".utf8) }
        )

        let result = await reader.read()
        let claude = result.windows.filter { $0.providerKey == "anthropic" }
        let codex = result.windows.filter { $0.providerKey == "openai" }
        XCTAssertEqual(claude.count, 2)
        XCTAssertEqual(codex.count, 2)
        XCTAssertEqual(claude.first(where: { $0.window == "5h" })?.remainingPercent, 75)
        XCTAssertEqual(codex.first(where: { $0.window == "5h" })?.remainingPercent, 70)
        XCTAssertEqual(codex.first(where: { $0.window == "5h" })?.resetDate, observedAt.addingTimeInterval(1200))
        XCTAssertEqual(claude.first?.sourceApp, "local-mac")
        XCTAssertFalse(result.issues.keys.contains("claude-secret"))
        XCTAssertFalse(result.issues.values.joined(separator: " ").contains("account-secret"))
    }

    func testOtherKnownShapesAndAntigravityUseConservativeParsing() async throws {
        let root = try makeFixtureHome()
        defer { try? FileManager.default.removeItem(at: root) }
        try writeJSON(["token": "grok-secret"], to: root.appendingPathComponent(".grok/auth.json"))
        try writeJSON(["api_key": "minimax-secret"], to: root.appendingPathComponent(".mmx/config.json"))
        let reader = LocalQuotaReader(
            homeDirectory: root,
            now: { self.observedAt },
            fetchJSON: { request in
                switch request.url?.host {
                case "cli-chat-proxy.grok.com": return Self.httpResponse(#"{"credits":{"used":25,"limit":100},"period":"weekly","reset_at":"2026-09-19T12:00:00Z"}"#)
                case "api.minimax.io": return Self.httpResponse(#"{"base_resp":{"status_code":0},"model_remains":[{"model_name":"MiniMax-M2","current_interval_usage_count":25,"current_interval_total_count":100,"end_time":"2026-09-20T00:00:00Z"}]}"#)
                default: return Self.httpResponse("{}", status: 500)
                }
            },
            runAntigravity: { Data(#"{"models":[{"model":"gemini-pro","remainingPercentage":0.25,"resetTime":"2026-09-14T00:00:00Z"}]}"#.utf8) }
        )

        let result = await reader.read()
        XCTAssertEqual(result.windows.first(where: { $0.providerKey == "xai" })?.remainingPercent, 75)
        XCTAssertEqual(result.windows.first(where: { $0.providerKey == "minimax" })?.remainingPercent, 25)
        XCTAssertEqual(result.windows.first(where: { $0.providerKey == "google-antigravity" })?.remainingPercent, 25)
        XCTAssertEqual(result.windows.first(where: { $0.providerKey == "google-antigravity" })?.via, "antigravity")
        XCTAssertNil(result.issues["xai"])
        XCTAssertNil(result.issues["minimax"])
        XCTAssertNil(result.issues["google-antigravity"])
    }

    func testUnauthorizedAndMissingSourcesAreSanitized() async throws {
        let root = try makeFixtureHome()
        defer { try? FileManager.default.removeItem(at: root) }
        try writeJSON(["claudeAiOauth": ["accessToken": "super-secret"]], to: root.appendingPathComponent(".claude/.credentials.json"))
        let reader = LocalQuotaReader(
            homeDirectory: root,
            now: { self.observedAt },
            fetchJSON: { _ in Self.httpResponse("{\"account_id\":\"account-secret\"}", status: 401) },
            runAntigravity: { throw NSError(domain: "private", code: 1) }
        )

        let result = await reader.read()
        XCTAssertEqual(result.issues["anthropic"], "Claude quota access was rejected.  Reconnect Claude in Settings to reread your existing login.")
        XCTAssertEqual(result.issues["openai"], "Codex is not signed in locally.")
        XCTAssertEqual(result.issues["xai"], "Grok is not signed in locally.")
        XCTAssertFalse(result.issues.values.joined(separator: " ").contains("super-secret"))
        XCTAssertFalse(result.issues.values.joined(separator: " ").contains("account-secret"))
        XCTAssertFalse(result.issues.values.joined(separator: " ").contains("private"))
    }

    private func makeFixtureHome() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("quota-reader-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url.appendingPathComponent(".claude"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: url.appendingPathComponent(".codex"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: url.appendingPathComponent(".grok"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: url.appendingPathComponent(".mmx"), withIntermediateDirectories: true)
        return url
    }

    func testClaudeSessionCredentialAndGrokProfileEnvelope() async throws {
        let home = try makeFixtureHome()
        defer { try? FileManager.default.removeItem(at: home) }
        try writeJSON(["mcpOAuth": [:]], to: home.appendingPathComponent(".claude/.credentials.json"))
        try writeJSON(["https://api.x.ai": ["key": "fixture-grok"]], to: home.appendingPathComponent(".grok/auth.json"))
        let reader = LocalQuotaReader(homeDirectory: home, fetchJSON: { request in
            if request.url?.host == "api.anthropic.com" {
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-claude")
                return Self.httpResponse(#"{"five_hour":{"utilization":30}}"#)
            }
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-grok")
            return Self.httpResponse(#"{"remaining_percent":40}"#)
        }, runAntigravity: { Data("{}".utf8) }, claudeCredential:
            Data(#"{"claudeAiOauth":{"accessToken":"fixture-claude","expiresAt":4102444800000}}"#.utf8)
        )
        let result = await reader.read()
        XCTAssertEqual(result.windows.first { $0.providerKey == "anthropic" }?.remainingPercent, 70)
        XCTAssertEqual(result.windows.first { $0.providerKey == "xai" }?.remainingPercent, 40)
    }

    func testRepeatedRefreshWithoutClaudeCredentialRequiresExplicitConnection() async throws {
        let home = try makeFixtureHome()
        defer { try? FileManager.default.removeItem(at: home) }
        try writeJSON(["mcpOAuth": [:]], to: home.appendingPathComponent(".claude/.credentials.json"))
        let reader = LocalQuotaReader(homeDirectory: home, fetchJSON: { _ in
            XCTFail("Missing Claude quota access must not contact a provider.")
            return Self.httpResponse("{}")
        }, runAntigravity: { Data("{}".utf8) })
        for _ in 0..<3 {
            let result = await reader.read()
            XCTAssertTrue(result.windows.filter { $0.providerKey == "anthropic" }.isEmpty)
            XCTAssertEqual(result.issues["anthropic"], "Claude quota access is unavailable.  Use Connect Claude in Settings to read your existing login.")
        }
    }

    func testRejectedClaudeCredentialRequestsReconnectWithoutAssumingSignedOut() async throws {
        let home = try makeFixtureHome()
        defer { try? FileManager.default.removeItem(at: home) }
        let reader = LocalQuotaReader(homeDirectory: home, fetchJSON: { _ in
            Self.httpResponse("{}", status: 401)
        }, runAntigravity: { Data("{}".utf8) }, claudeCredential:
            Data(#"{"claudeAiOauth":{"accessToken":"rejected-fixture"}}"#.utf8)
        )
        let result = await reader.read()
        XCTAssertEqual(result.issues["anthropic"], "Claude quota access was rejected.  Reconnect Claude in Settings to reread your existing login.")
        XCTAssertTrue(result.windows.filter { $0.providerKey == "anthropic" }.isEmpty)
    }

    func testInvalidClaudeSessionCredentialNeverReachesNetwork() async throws {
        let home = try makeFixtureHome()
        defer { try? FileManager.default.removeItem(at: home) }
        for data in [Data("not-json".utf8), Data(#"{"mcpOAuth":{}}"#.utf8), Data(#"{"claudeAiOauth":{"accessToken":"expired-fixture","expiresAt":1}}"#.utf8)] {
            let reader = LocalQuotaReader(homeDirectory: home, fetchJSON: { _ in
                XCTFail("An invalid session credential must not make a quota request.")
                return Self.httpResponse("{}")
            }, runAntigravity: { Data("{}".utf8) }, claudeCredential: data)
            let result = await reader.read()
            XCTAssertNotNil(result.issues["anthropic"])
        }
    }

    func testExplicitClaudeSnapshotPrecedesRevokedFileCredential() async throws {
        let home = try makeFixtureHome()
        defer { try? FileManager.default.removeItem(at: home) }
        // The on-disk file holds a valid-looking but revoked token; the explicit
        // Connect Claude snapshot is the credential that must be used.
        try writeJSON(
            ["claudeAiOauth": ["accessToken": "revoked-file", "expiresAt": 4102444800000]],
            to: home.appendingPathComponent(".claude/.credentials.json")
        )
        let reader = LocalQuotaReader(homeDirectory: home, fetchJSON: { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer current-snapshot")
            return Self.httpResponse(#"{"five_hour":{"utilization":25}}"#)
        }, runAntigravity: { Data("{}".utf8) }, claudeCredential:
            Data(#"{"claudeAiOauth":{"accessToken":"current-snapshot","expiresAt":4102444800000}}"#.utf8)
        )
        let result = await reader.read()
        XCTAssertEqual(result.windows.first { $0.providerKey == "anthropic" }?.remainingPercent, 75)
        XCTAssertNil(result.issues["anthropic"])
    }

    func testRejectedSnapshotFallsBackToFileCredential() async throws {
        let home = try makeFixtureHome()
        defer { try? FileManager.default.removeItem(at: home) }
        try writeJSON(
            ["claudeAiOauth": ["accessToken": "file-fallback", "expiresAt": 4102444800000]],
            to: home.appendingPathComponent(".claude/.credentials.json")
        )
        let reader = LocalQuotaReader(homeDirectory: home, fetchJSON: { request in
            if request.value(forHTTPHeaderField: "Authorization") == "Bearer stale-snapshot" {
                return Self.httpResponse("{}", status: 401)
            }
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer file-fallback")
            return Self.httpResponse(#"{"five_hour":{"utilization":20}}"#)
        }, runAntigravity: { Data("{}".utf8) }, claudeCredential:
            Data(#"{"claudeAiOauth":{"accessToken":"stale-snapshot","expiresAt":4102444800000}}"#.utf8)
        )
        let result = await reader.read()
        XCTAssertEqual(result.windows.first { $0.providerKey == "anthropic" }?.remainingPercent, 80)
        XCTAssertNil(result.issues["anthropic"])
    }

    func testClaudeKeychainAcceptsPayloadsLargerThan64KB() async throws {
        let home = try makeFixtureHome()
        defer { try? FileManager.default.removeItem(at: home) }
        try writeJSON(["mcpOAuth": [:]], to: home.appendingPathComponent(".claude/.credentials.json"))
        // Create a payload > 64KB (e.g. 120KB) containing claudeAiOauth
        var padding = [String: String]()
        for i in 0..<1500 {
            padding["key_\(i)"] = "padding_value_for_large_keychain_payload_\(i)"
        }
        let payloadDict: [String: Any] = [
            "claudeAiOauth": [
                "accessToken": "fixture-large-claude",
                "expiresAt": 4102444800000
            ],
            "metadata": padding
        ]
        let payloadData = try JSONSerialization.data(withJSONObject: payloadDict)
        XCTAssertGreaterThan(payloadData.count, 65_536)
        XCTAssertLessThan(payloadData.count, 1_048_576)

        let reader = LocalQuotaReader(homeDirectory: home, fetchJSON: { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fixture-large-claude")
            return Self.httpResponse(#"{"five_hour":{"utilization":20}}"#)
        }, runAntigravity: { Data("{}".utf8) }, claudeCredential: payloadData)
        let result = await reader.read()
        XCTAssertEqual(result.windows.first { $0.providerKey == "anthropic" }?.remainingPercent, 80)
        XCTAssertNil(result.issues["anthropic"])
    }

    func testGrokSubscriptionConfigExcludesOnDemandAndPrepaidCaps() async throws {
        let home = try makeFixtureHome()
        defer { try? FileManager.default.removeItem(at: home) }
        try writeJSON(["token": "fixture"], to: home.appendingPathComponent(".grok/auth.json"))
        let reader = LocalQuotaReader(homeDirectory: home, fetchJSON: { _ in
            Self.httpResponse(#"{"config":{"creditUsagePercent":51,"currentPeriod":{"start":"2026-09-10T00:00:00Z","end":"2026-09-17T00:00:00Z"},"onDemandCap":{"val":500},"prepaidBalance":{"val":300},"productUsage":[{"usagePercent":50},{"usagePercent":1}]}}"#)
        }, runAntigravity: { Data("{}".utf8) })
        let result = await reader.read()
        let grok = try XCTUnwrap(result.windows.first { $0.providerKey == "xai" })
        XCTAssertEqual(grok.remainingPercent, 49)
        XCTAssertEqual(grok.window, "1w")
        XCTAssertEqual(grok.resetAt, "2026-09-17T00:00:00Z")
        XCTAssertNil(grok.absoluteLimit)
        XCTAssertNil(grok.absoluteRemaining)
    }

    private func writeJSON(_ object: Any, to url: URL) throws {
        let data = try JSONSerialization.data(withJSONObject: object)
        try data.write(to: url, options: .atomic)
    }

    private static func httpResponse(_ text: String, status: Int = 200) -> (Data, HTTPURLResponse) {
        let url = URL(string: "https://fixture.invalid/quota")!
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        return (Data(text.utf8), response)
    }
}
