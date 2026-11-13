import Foundation
import XCTest
@testable import QuotaCore

final class CursorQuotaReaderTests: XCTestCase {
    private let observedAt = Date(timeIntervalSince1970: 1_789_000_000)

    func testReadsIncludedPlanAndTranslatesCursorAppTokenToSessionCookie() async {
        let token = Self.jwt(subject: "auth0|cursor-user-1", expiration: observedAt.addingTimeInterval(3600))
        let reader = CursorQuotaReader(
            now: { self.observedAt },
            accessToken: { token },
            fetch: { request in
                XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "WorkosCursorSessionToken=cursor-user-1%3A%3A\(token)")
                XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
                return Self.response("""
                {"billingCycleEnd":"2026-10-01T00:00:00Z","membershipType":"pro","individualUsage":{"plan":{"used":2500,"limit":10000,"remaining":7500,"totalPercentUsed":25},"onDemand":{"used":999,"limit":1000,"remaining":1}}}
                """)
            }
        )

        let result = await reader.read()
        XCTAssertNil(result.issues["cursor"])
        XCTAssertEqual(result.windows.count, 1)
        XCTAssertEqual(result.windows.first?.providerKey, "cursor")
        XCTAssertEqual(result.windows.first?.remainingPercent, 75)
        XCTAssertEqual(result.windows.first?.absoluteRemaining, 75)
        XCTAssertEqual(result.windows.first?.absoluteLimit, 100)
        XCTAssertEqual(result.windows.first?.quotaUnit, "USD")
        XCTAssertEqual(result.windows.first?.resetAt, "2026-10-01T00:00:00Z")
        XCTAssertEqual(result.windows.first?.planName, "pro")
    }

    func testMissingLocalSessionIsActionableAndDoesNotMakeNetworkRequest() async {
        let reader = CursorQuotaReader(
            accessToken: { nil },
            fetch: { _ in
                XCTFail("missing local session must not make a request")
                return Self.response("{}", status: 500)
            }
        )
        let result = await reader.read()
        XCTAssertEqual(result.issues["cursor"], "Cursor is not signed in locally.")
        XCTAssertTrue(result.windows.isEmpty)
    }

    func testRejectedSessionAndMalformedClaimsAreSanitized() async {
        let secret = "cursor-secret-value"
        let token = Self.jwt(subject: "auth0|cursor-user-2", expiration: observedAt.addingTimeInterval(3600))
        let rejected = CursorQuotaReader(
            now: { self.observedAt },
            accessToken: { token },
            fetch: { _ in Self.response("{\"account\":\"\(secret)\"}", status: 401) }
        )
        let rejectedResult = await rejected.read()
        XCTAssertEqual(rejectedResult.issues["cursor"], "Cursor session was rejected; sign in again in Cursor.")
        XCTAssertFalse(rejectedResult.issues.values.joined().contains(secret))

        let malformed = CursorQuotaReader(accessToken: { "not-a-jwt" }, fetch: { _ in XCTFail("invalid token must not request"); return Self.response("{}") })
        let malformedResult = await malformed.read()
        XCTAssertEqual(malformedResult.issues["cursor"], "Cursor local session is not usable; sign in again in Cursor.")
    }

    func testPlanWithoutCapRemainsUnavailableAndOnDemandIsIgnored() async {
        let token = Self.jwt(subject: "cursor-user-3", expiration: observedAt.addingTimeInterval(3600))
        let reader = CursorQuotaReader(
            now: { self.observedAt },
            accessToken: { token },
            fetch: { _ in Self.response(#"{"billingCycleEnd":"2026-10-01T00:00:00Z","individualUsage":{"plan":{"used":100},"onDemand":{"used":1,"limit":10,"remaining":9}}}"#) }
        )
        let result = await reader.read()
        XCTAssertEqual(result.windows.count, 1)
        XCTAssertNil(result.windows.first?.remainingPercent)
        XCTAssertNil(result.windows.first?.absoluteLimit)
        XCTAssertEqual(result.issues["cursor"], "Cursor returned no readable included quota.")
    }

    func testInjectedClockControlsExpiryAndCountFallback() async {
        let soon = Self.jwt(subject: "cursor-user-4", expiration: observedAt.addingTimeInterval(30))
        let expired = CursorQuotaReader(now: { self.observedAt }, accessToken: { soon }, fetch: { _ in
            XCTFail("expired session must not request")
            return Self.response("{}")
        })
        let expiredResult = await expired.read()
        XCTAssertEqual(expiredResult.issues["cursor"], "Cursor local session is not usable; sign in again in Cursor.")

        let valid = Self.jwt(subject: "cursor-user-5", expiration: observedAt.addingTimeInterval(3600))
        let reader = CursorQuotaReader(now: { self.observedAt }, accessToken: { valid }, fetch: { _ in
            Self.response(#"{"individualUsage":{"plan":{"used":7000,"limit":10000}}}"#)
        })
        let result = await reader.read()
        XCTAssertEqual(result.windows.first?.remainingPercent, 30)
    }

    func testOversizedTokenFailsClosedBeforeRequest() async {
        let oversized = String(repeating: "a", count: 65_537)
        let reader = CursorQuotaReader(accessToken: { oversized }, fetch: { _ in
            XCTFail("oversized session must not request")
            return Self.response("{}")
        })
        let result = await reader.read()
        XCTAssertEqual(result.issues["cursor"], "Cursor local session is not usable; sign in again in Cursor.")
    }

    private static func jwt(subject: String, expiration: Date) -> String {
        let header = Data("{\"alg\":\"none\"}".utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let body = try! JSONSerialization.data(withJSONObject: ["sub": subject, "exp": expiration.timeIntervalSince1970])
        let payload = body.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return "\(header).\(payload).signature"
    }

    private static func response(_ text: String, status: Int = 200) -> (Data, HTTPURLResponse) {
        let response = HTTPURLResponse(url: URL(string: "https://fixture.invalid/usage-summary")!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        return (Data(text.utf8), response)
    }
}
