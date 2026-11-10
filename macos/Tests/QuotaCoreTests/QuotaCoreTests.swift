import Foundation
import XCTest
@testable import QuotaCore

final class QuotaCoreTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    override func setUp() {
        super.setUp()
        StubURLProtocol.seenURLs = []
        StubURLProtocol.handler = nil
    }

    private func window(
        provider: String = "claude-code",
        providerKey: String? = nil,
        via: String? = nil,
        percentage: Double? = 50,
        occurred: String = "2023-11-14T22:00:00Z",
        reset: String? = nil
    ) -> QuotaWindow {
        QuotaWindow(
            id: UUID().uuidString,
            provider: provider,
            providerKey: providerKey,
            via: via,
            label: provider,
            remainingPercent: percentage,
            remainingUnknown: percentage == nil,
            resetAt: reset,
            occurredAt: occurred
        )
    }

    func testWireResponseDecodesOriginalAndAdditiveFields() throws {
        let data = #"{"generatedAt":"2023-11-14T22:10:00Z","windows":[{"id":"a","provider":"claude-code","sourceApp":null,"modelId":null,"modelType":null,"label":"Claude","remainingPercent":12.5,"remainingUnknown":false,"isExhausted":false,"resetAt":null,"window":"5h","status":"near_cap","skip":false,"skipReason":null,"occurredAt":"2023-11-14T22:00:00Z","source":"local","providerKey":"anthropic","providerLabel":"Claude","via":null}],"skipModelTypes":[]}"#.data(using: .utf8)!

        let response = try JSONDecoder().decode(QuotaResponse.self, from: data)
        XCTAssertEqual(response.windows.first?.providerKey, "anthropic")
        XCTAssertEqual(response.windows.first?.remainingPercent, 12.5)
        XCTAssertTrue(response.providerGroups.isEmpty)
        XCTAssertEqual(response.platformSections(now: now).first?.providerKey, "anthropic")
    }

    func testAliasesAndAntigravityIdentity() {
        let antigravity = window(provider: "anthropic", via: "antigravity")
        let claude = window(provider: "claude-code")
        XCTAssertEqual(antigravity.canonicalProviderKey, "google-antigravity")
        XCTAssertEqual(claude.canonicalProviderKey, "anthropic")

        let sections = QuotaResponse(generatedAt: "now", windows: [antigravity, claude]).platformSections(now: now)
        XCTAssertEqual(sections.first(where: { $0.providerKey == "google-antigravity" })?.windows.count, 4)
        XCTAssertEqual(sections.first(where: { $0.providerKey == "anthropic" })?.windows.count, 1)
    }

    func testUnknownAndNonFinitePercentagesStayUnknown() {
        let omitted = window(percentage: nil)
        let nan = window(percentage: .nan)
        let omittedSnapshot = QuotaWindowSnapshot(window: omitted, now: now)
        let nanSnapshot = QuotaWindowSnapshot(window: nan, now: now)
        XCTAssertNil(omittedSnapshot.remainingPercent)
        XCTAssertNil(nanSnapshot.remainingPercent)
        XCTAssertEqual(omittedSnapshot.status, .unknown)
        XCTAssertEqual(nanSnapshot.status, .unknown)
    }

    func testUnusedPlatformsStayHiddenEvenWhenServerReportsThem() {
        let hidden = ["kimi", "gemini-cli", "github-copilot", "windsurf"]
        let windows = hidden.map { key in
            QuotaWindow(id: key, provider: key, label: "Quota", remainingPercent: 30, occurredAt: "2023-11-14T22:13:20Z")
        }
        let response = QuotaResponse(generatedAt: "", windows: windows)
        XCTAssertTrue(Set(response.platformSections(now: now).map(\.providerKey)).isDisjoint(with: hidden))
    }

    func testVideoClassificationDoesNotDemoteCodingOrOtherProviders() {
        let video = QuotaWindow(id: "video", provider: "minimax", modelId: "video", label: "1d", occurredAt: "")
        let coding = QuotaWindow(id: "coding", provider: "minimax", modelId: "MiniMax-M2", label: "5h", occurredAt: "")
        let other = QuotaWindow(id: "other", provider: "xai", label: "Video", occurredAt: "")
        XCTAssertTrue(video.isSupplementaryVideoQuota)
        XCTAssertFalse(coding.isSupplementaryVideoQuota)
        XCTAssertFalse(other.isSupplementaryVideoQuota)
    }

    func testPercentagesAreClampedWithoutInventingCaps() {
        XCTAssertEqual(QuotaWindowSnapshot(window: window(percentage: 130), now: now).remainingPercent, 100)
        XCTAssertEqual(QuotaWindowSnapshot(window: window(percentage: -5), now: now).remainingPercent, 0)
        XCTAssertNil(QuotaWindowSnapshot(window: window(percentage: nil), now: now).remainingPercent)
    }

    func testMissingInvalidAndOldObservationAreStale() {
        let missing = window(occurred: "")
        let invalid = window(occurred: "yesterday-ish")
        let old = window(occurred: "2023-11-14T21:00:00Z")
        XCTAssertEqual(QuotaWindowSnapshot(window: missing, now: now).freshness, .stale)
        XCTAssertEqual(QuotaWindowSnapshot(window: invalid, now: now).freshness, .stale)
        XCTAssertEqual(QuotaWindowSnapshot(window: old, now: now).freshness, .stale)
    }

    func testPassedResetAwaitsRefresh() {
        let value = window(reset: "2023-11-14T22:10:00Z")
        let snapshot = QuotaWindowSnapshot(window: value, now: now)
        XCTAssertEqual(snapshot.freshness, .awaitingRefresh)
        XCTAssertTrue(snapshot.isAwaitingRefresh)
    }

    func testExpectedSectionsAndFutureProviders() {
        let future = window(provider: "new-provider", occurred: "2023-11-14T22:05:00Z")
        let response = QuotaResponse(generatedAt: "2023-11-14T22:10:00Z", windows: [future])
        let sections = response.platformSections(now: now)
        XCTAssertEqual(Array(sections.prefix(8)).map(\.providerKey), [
            "anthropic", "openai", "google-antigravity", "cursor", "xai", "grok-bot", "minimax",
            "deepseek"
        ])
        XCTAssertTrue(sections.prefix(8).allSatisfy(\.isMissing))
        XCTAssertEqual(sections.last?.providerKey, "new-provider")
    }

    func testFreshWindowsSortByLowRemainingAndUnknownLast() {
        let high = window(provider: "cursor", percentage: 80, occurred: "2023-11-14T22:05:00Z")
        let low = window(provider: "cursor", percentage: 5, occurred: "2023-11-14T22:05:00Z")
        let unknown = window(provider: "cursor", percentage: nil, occurred: "2023-11-14T22:05:00Z")
        let section = QuotaResponse(generatedAt: "now", windows: [high, unknown, low])
            .platformSections(now: now).first(where: { $0.providerKey == "cursor" })!
        XCTAssertEqual(section.windows.map(\.remainingPercent), [5, 80, nil])
    }

    func testEndpointRestrictions() {
        XCTAssertTrue(QuotaClient.isAllowedEndpoint(URL(string: "https://usage.example/api/quota-windows")!))
        XCTAssertTrue(QuotaClient.isAllowedEndpoint(URL(string: "http://localhost:3000/api/quota-windows")!))
        XCTAssertTrue(QuotaClient.isAllowedEndpoint(URL(string: "http://127.0.0.1/api/quota-windows")!))
        XCTAssertTrue(QuotaClient.isAllowedEndpoint(URL(string: "http://[::1]/api/quota-windows")!))
        XCTAssertFalse(QuotaClient.isAllowedEndpoint(URL(string: "http://usage.example/api")!))
        XCTAssertFalse(QuotaClient.isAllowedEndpoint(URL(string: "https://user:pass@usage.example/api")!))
        XCTAssertFalse(QuotaClient.isAllowedEndpoint(URL(string: "https://usage.example/api?token=secret")!))
        XCTAssertFalse(QuotaClient.isAllowedEndpoint(URL(string: "https://usage.example/api#fragment")!))
    }

    func testUnauthorizedAndRedirectAreRejectedWithoutFollowingRedirect() async throws {
        StubURLProtocol.handler = { request in
            if request.url?.path == "/unauthorized" {
                return StubURLProtocol.reply(status: 401, body: Data())
            }
            return StubURLProtocol.reply(status: 302, headers: ["Location": "https://evil.example/collect"], body: Data())
        }
        let unauthorized = try QuotaClient(endpoint: URL(string: "http://localhost/unauthorized")!, token: "secret", urlProtocolClasses: [StubURLProtocol.self])
        do {
            _ = try await unauthorized.fetch()
            XCTFail("expected 401")
        } catch let error as QuotaClientError {
            XCTAssertEqual(error, .unauthorized)
        }

        let redirect = try QuotaClient(endpoint: URL(string: "http://localhost/redirect")!, token: "secret", urlProtocolClasses: [StubURLProtocol.self])
        do {
            _ = try await redirect.fetch()
            XCTFail("expected redirect rejection")
        } catch let error as QuotaClientError {
            XCTAssertEqual(error, .httpStatus(302))
        }
        XCTAssertEqual(StubURLProtocol.seenURLs, ["/unauthorized", "/redirect"])
    }

    func testMalformedAndOversizedResponsesAreRejected() async throws {
        StubURLProtocol.handler = { _ in StubURLProtocol.reply(status: 200, body: Data(repeating: 0x78, count: 32)) }
        let malformed = try QuotaClient(endpoint: URL(string: "http://localhost/malformed")!, token: "secret", urlProtocolClasses: [StubURLProtocol.self])
        do {
            _ = try await malformed.fetch()
            XCTFail("expected malformed")
        } catch let error as QuotaClientError {
            XCTAssertEqual(error, .malformedResponse)
        }

        StubURLProtocol.handler = { _ in StubURLProtocol.reply(status: 200, body: Data(repeating: 0x78, count: 33)) }
        let oversized = try QuotaClient(endpoint: URL(string: "http://localhost/large")!, token: "secret", maxResponseBytes: 32, urlProtocolClasses: [StubURLProtocol.self])
        do {
            _ = try await oversized.fetch()
            XCTFail("expected oversized")
        } catch let error as QuotaClientError {
            XCTAssertEqual(error, .responseTooLarge)
        }
    }
}

private final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    struct Reply {
        let status: Int
        let headers: [String: String]
        let body: Data
    }

    static var handler: ((URLRequest) -> Reply)?
    static var seenURLs: [String] = []

    static func reply(status: Int, headers: [String: String] = [:], body: Data) -> Reply {
        Reply(status: status, headers: headers, body: body)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url else { return }
        Self.seenURLs.append(url.path)
        let reply = Self.handler?(request) ?? Self.reply(status: 500, body: Data())
        let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
