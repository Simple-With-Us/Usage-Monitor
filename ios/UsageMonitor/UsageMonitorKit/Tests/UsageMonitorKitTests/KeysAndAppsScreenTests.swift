import Foundation
import XCTest
@testable import Models
@testable import Networking
@testable import Providers

/// Covers the Keys & Apps read path end to end through the real `APIClient`:
/// the request it issues, the payload it decodes, and how `KeysAndAppsStore`
/// turns a missing dashboard session into an affordance instead of an error.
///
/// Every time assertion runs against a frozen instant. Nothing here may call
/// `Date()`, or the suite starts failing on a calendar boundary rather than on
/// a real regression.
@MainActor
final class KeysAndAppsScreenTests: XCTestCase {
    /// The one "now" every binding-window assertion is judged against.
    private static let now = ISO8601DateParser.date(from: "2026-06-15T12:00:00.000Z")!

    override func tearDown() {
        KeysAndAppsURLProtocol.handler = nil
        super.tearDown()
    }

    // MARK: - Request shape

    func testLoadReadsSessionRouteWithoutLeakingBearerToken() async throws {
        // A bearer token IS configured. /api/key-attribution is session-only,
        // so the client must NOT attach it: the read token must never reach a
        // route the server gates on the dashboard cookie.
        let harness = makeHarness(token: "read-token")
        harness.installSessionCookie()
        var seenPaths: [String] = []
        KeysAndAppsURLProtocol.handler = { request in
            seenPaths.append(request.url?.path ?? "")
            XCTAssertEqual(request.url?.path, "/api/key-attribution")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return .json(Self.attributionJSON)
        }

        let store = KeysAndAppsStore()
        await store.load(using: harness.client)

        XCTAssertEqual(seenPaths, ["/api/key-attribution"])
        XCTAssertFalse(store.requiresSession)
        XCTAssertNotNil(store.payload)
    }

    func testDecodesIdentitiesBindingsAndCoverage() async throws {
        let harness = makeHarness(token: "read-token")
        KeysAndAppsURLProtocol.handler = { _ in .json(Self.attributionJSON) }

        let store = KeysAndAppsStore()
        await store.load(using: harness.client)

        // Active identity sorts ahead of the retired one.
        let identities = store.identities
        XCTAssertEqual(identities.map(\.id), ["identity-active", "identity-retired"])

        let active = try XCTUnwrap(identities.first)
        XCTAssertEqual(active.title, "Production key")
        XCTAssertEqual(active.provider?.title, "OpenAI")
        // Redacted preview only — never a usable credential.
        XCTAssertEqual(active.providerKeyFingerprint, "sk-…a91f")
        XCTAssertFalse(active.isRetired)

        let bindings = active.orderedBindings(asOf: Self.now)
        XCTAssertEqual(bindings.count, 2)
        // In-force binding is listed first even though the closed one is newer.
        XCTAssertEqual(bindings[0].id, "binding-open")
        XCTAssertEqual(bindings[0].producerId, "congress-trade")
        XCTAssertEqual(bindings[0].producerKeyRef, "configured-openai-primary")
        XCTAssertEqual(bindings[0].resolvedProjectName, "Congress Trade")
        XCTAssertNil(bindings[0].effectiveToDate)

        let coverage = try XCTUnwrap(store.coverage)
        XCTAssertEqual(coverage.totalCostUsd, 42.5)
        XCTAssertEqual(coverage.identityMatchedCostUsd, 30)
        XCTAssertEqual(coverage.identityUnattributedCostUsd, 12.5)
        XCTAssertEqual(coverage.unclassifiedCostEventCount, 7)
        XCTAssertEqual(coverage.excludedNonKeyScopeEventCount, 3)
        XCTAssertTrue(coverage.hasProjectAuthorityConflict)

        let totals = try XCTUnwrap(coverage.totals(forIdentity: "identity-active"))
        XCTAssertEqual(totals.costUsd, 30)
        XCTAssertEqual(totals.eventCount, 12)
        // An identity with no proven-additive record has NO totals row — the UI
        // must say "none recorded" rather than invent a $0 figure.
        XCTAssertNil(coverage.totals(forIdentity: "identity-retired"))
    }

    // MARK: - Session gate

    func testUnauthorizedAsksForDashboardSessionInsteadOfFailing() async {
        let harness = makeHarness(token: "read-token")
        KeysAndAppsURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/key-attribution")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return .json(["error": "Unauthorized"], status: 401)
        }

        let store = KeysAndAppsStore()
        await store.load(using: harness.client)

        XCTAssertTrue(store.requiresSession, "401 must offer Settings, not an error screen.")
        XCTAssertNil(store.state.error, "The session gate is a capability gap, not a failure.")
        XCTAssertNil(store.payload)
        XCTAssertNil(store.lastError)
    }

    func testNonAuthErrorSurfacesAsFailureWhenNothingLoaded() async {
        let harness = makeHarness(token: "read-token")
        KeysAndAppsURLProtocol.handler = { _ in .json(["error": "down"], status: 500) }

        let store = KeysAndAppsStore()
        await store.load(using: harness.client)

        XCTAssertFalse(store.requiresSession)
        XCTAssertEqual(store.state.error, .httpStatus(500))
    }

    func testRefreshFailureKeepsTheLastGoodAttribution() async {
        let harness = makeHarness(token: "read-token")
        KeysAndAppsURLProtocol.handler = { _ in .json(Self.attributionJSON) }

        let store = KeysAndAppsStore()
        await store.load(using: harness.client)
        XCTAssertEqual(store.identities.count, 2)

        KeysAndAppsURLProtocol.handler = { _ in .json(["error": "down"], status: 500) }
        await store.refresh(using: harness.client)

        XCTAssertEqual(store.identities.count, 2, "A refresh failure must not blank good data.")
        XCTAssertEqual(store.lastError, .httpStatus(500))
    }

    // MARK: - Binding windows

    func testBindingActivityAgainstFrozenClock() throws {
        let payload = try Self.decodedPayload()
        let identity = try XCTUnwrap(payload.identities?.first { $0.id == "identity-active" })
        let bindings = Dictionary(
            uniqueKeysWithValues: (identity.bindings ?? []).map { ($0.id, $0) }
        )

        // Open-ended and already started.
        XCTAssertEqual(bindings["binding-open"]?.activity(asOf: Self.now), .active)
        // Closed before "now".
        XCTAssertEqual(bindings["binding-closed"]?.activity(asOf: Self.now), .closed)
        // The open binding had not started yet at the start of the month.
        let monthStart = try XCTUnwrap(ISO8601DateParser.date(from: "2026-06-01T00:00:00.000Z"))
        XCTAssertEqual(bindings["binding-open"]?.activity(asOf: monthStart), .scheduled)

        // A retired identity's binding is closed, and a binding with no parsable
        // start is reported as unknown rather than silently treated as active.
        let retired = try XCTUnwrap(payload.identities?.first { $0.id == "identity-retired" })
        let retiredBindings = retired.bindings ?? []
        XCTAssertEqual(retiredBindings.first?.activity(asOf: Self.now), .closed)
        XCTAssertEqual(
            KeyAttributionBinding(id: "no-dates").activity(asOf: Self.now),
            .unknown
        )
    }

    // MARK: - Unattributed discovery

    func testUnattributedBucketsSortByCostAndHumanizeReason() async throws {
        let harness = makeHarness(token: "read-token")
        KeysAndAppsURLProtocol.handler = { _ in .json(Self.attributionJSON) }

        let store = KeysAndAppsStore()
        await store.load(using: harness.client)

        let buckets = store.unattributedBuckets
        XCTAssertEqual(buckets.map(\.producerKeyRef), ["socratic-openai", "unmapped-anthropic"])
        XCTAssertEqual(
            KeysAndAppsStore.humanizedReason(buckets.first?.reason),
            "Unknown provider key"
        )
        XCTAssertEqual(KeysAndAppsStore.humanizedReason(nil), "Unattributed")
        XCTAssertFalse(store.isEmpty)
    }

    func testEmptyPayloadIsReportedAsEmptyNotAsFailure() async {
        let harness = makeHarness(token: "read-token")
        let empty: [String: Any] = [
            "identities": [],
            "providers": [],
            "projects": [],
            "coverage": ["totalCostUsd": 0, "totalEventCount": 0],
        ]
        KeysAndAppsURLProtocol.handler = { _ in .json(empty) }

        let store = KeysAndAppsStore()
        await store.load(using: harness.client)

        XCTAssertTrue(store.isEmpty)
        XCTAssertNil(store.state.error)
        XCTAssertFalse(store.requiresSession)
    }

    // MARK: - Identity revision

    func testAdoptIdentityRevisionOnlyDiscardsOnAnActualChange() async {
        let harness = makeHarness(token: "read-token")
        KeysAndAppsURLProtocol.handler = { _ in .json(Self.attributionJSON) }

        let store = KeysAndAppsStore()
        // First appearance adopts the current revision without discarding.
        store.adopt(identityRevision: 0)
        await store.load(using: harness.client)
        store.adopt(identityRevision: 0)
        XCTAssertEqual(store.identities.count, 2)

        // A host switch bumps the revision: the previous host's data must go.
        store.adopt(identityRevision: 1)
        XCTAssertTrue(store.identities.isEmpty)
        XCTAssertNil(store.payload)
    }

    // MARK: - Harness

    private struct Harness {
        let client: APIClient
        let baseURL: URL
        let cookieStorage: HTTPCookieStorage

        func installSessionCookie() {
            let cookie = HTTPCookie(properties: [
                .domain: baseURL.host!,
                .path: "/",
                .name: "dashboard_session",
                .value: "session-value",
                .secure: "TRUE",
                .expires: Date().addingTimeInterval(3_600),
            ])!
            cookieStorage.setCookie(cookie)
        }
    }

    private func makeHarness(token: String? = nil) -> Harness {
        // Unique host per test: the cookie jar is process-shared, so reuse
        // would leak sessions between tests.
        let baseURL = URL(string: "https://keys-\(UUID().uuidString.lowercased()).example.test")!
        let cookieStorage = HTTPCookieStorage.shared
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [KeysAndAppsURLProtocol.self]
        configuration.httpShouldSetCookies = true
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpCookieStorage = cookieStorage
        return Harness(
            client: APIClient(
                configuration: APIConfiguration(baseURL: baseURL, timeout: 2),
                tokenStore: InMemoryTokenStore(token: token),
                session: URLSession(configuration: configuration)
            ),
            baseURL: baseURL,
            cookieStorage: cookieStorage
        )
    }

    private static func decodedPayload() throws -> KeyAttributionResponse {
        let data = try JSONSerialization.data(withJSONObject: attributionJSON)
        return try JSONDecoder().decode(KeyAttributionResponse.self, from: data)
    }

    /// Shaped exactly like `GET /api/key-attribution`
    /// (`src/app/api/key-attribution/route.ts`).
    private static let attributionJSON: [String: Any] = [
        "identities": [
            [
                "id": "identity-retired",
                "providerId": "provider-anthropic",
                "provider": ["name": "anthropic", "displayName": "Anthropic"],
                "alias": "Old console key",
                "description": NSNull(),
                "providerKeyFingerprint": NSNull(),
                "status": "retired",
                "retiredAt": "2026-05-30T00:00:00.000Z",
                "createdAt": "2026-01-04T00:00:00.000Z",
                "bindings": [
                    [
                        "id": "binding-retired",
                        "projectId": NSNull(),
                        "projectName": NSNull(),
                        "producerId": "socratic-trade",
                        "producerKeyRef": "legacy-anthropic",
                        "providerConnectionRef": NSNull(),
                        "billingAccountRef": NSNull(),
                        "effectiveFrom": "2026-01-04T00:00:00.000Z",
                        "effectiveTo": "2026-05-30T00:00:00.000Z",
                        "project": NSNull(),
                    ],
                ],
            ],
            [
                "id": "identity-active",
                "providerId": "provider-openai",
                "provider": ["name": "openai", "displayName": "OpenAI"],
                "alias": "Production key",
                "description": "Billing account used by the fleet",
                "providerKeyFingerprint": "sk-…a91f",
                "status": "active",
                "retiredAt": NSNull(),
                "createdAt": "2026-02-01T00:00:00.000Z",
                "bindings": [
                    [
                        "id": "binding-closed",
                        "projectId": "project-socratic",
                        "projectName": "Socratic Trade",
                        "producerId": "socratic-trade",
                        "producerKeyRef": "configured-openai-primary",
                        "providerConnectionRef": "conn-1",
                        "billingAccountRef": "acct-1",
                        "effectiveFrom": "2026-06-02T00:00:00.000Z",
                        "effectiveTo": "2026-06-10T00:00:00.000Z",
                        "project": ["id": "project-socratic", "name": "Socratic Trade"],
                    ],
                    [
                        "id": "binding-open",
                        "projectId": "project-congress",
                        "projectName": "Congress Trade",
                        "producerId": "congress-trade",
                        "producerKeyRef": "configured-openai-primary",
                        "providerConnectionRef": NSNull(),
                        "billingAccountRef": NSNull(),
                        "effectiveFrom": "2026-06-05T00:00:00.000Z",
                        "effectiveTo": NSNull(),
                        "project": ["id": "project-congress", "name": "Congress Trade"],
                    ],
                ],
            ],
        ],
        "providers": [["id": "provider-openai", "name": "openai", "displayName": "OpenAI"]],
        "projects": [["id": "project-congress", "name": "Congress Trade"]],
        "coverage": [
            "scope": "pushed_v2_cost_events",
            "aggregation": "proven_disjoint_point_or_window_event_sum",
            "note": "Cost sums include only v2 api_key-scope point records.",
            "totalCostUsd": 42.5,
            "identityMatchedCostUsd": 30,
            "identityUnattributedCostUsd": 12.5,
            "projectAttributedCostUsd": 18,
            "projectUnattributedCostUsd": 24.5,
            "projectAuthorityConflictCostUsd": 4,
            "projectAuthorityConflictEventCount": 2,
            "totalEventCount": 20,
            "identityMatchedEventCount": 12,
            "identityUnattributedEventCount": 8,
            "unclassifiedCostEventCount": 7,
            "excludedNonKeyScopeEventCount": 3,
            "reasons": ["unknown_provider_key": ["costUsd": 12.5, "eventCount": 8]],
            "byIdentity": ["identity-active": ["costUsd": 30, "eventCount": 12]],
            "unattributedBuckets": [
                [
                    "providerName": "anthropic",
                    "producerId": "usage-monitor",
                    "producerKeyRef": "unmapped-anthropic",
                    "providerConnectionRef": NSNull(),
                    "billingAccountRef": NSNull(),
                    "reason": "no_binding",
                    "costUsd": 2.5,
                    "eventCount": 3,
                    "unclassifiedCostEventCount": 1,
                ],
                [
                    "providerName": "openai",
                    "producerId": "socratic-trade",
                    "producerKeyRef": "socratic-openai",
                    "providerConnectionRef": "conn-9",
                    "billingAccountRef": NSNull(),
                    "reason": "unknown_provider_key",
                    "costUsd": 10,
                    "eventCount": 5,
                    "unclassifiedCostEventCount": 0,
                ],
            ],
        ],
    ]
}

private final class KeysAndAppsURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> KeysAndAppsStubResponse)?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let stub = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: stub.status,
                httpVersion: "HTTP/1.1",
                headerFields: stub.headers
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: stub.body)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private struct KeysAndAppsStubResponse {
    let status: Int
    let headers: [String: String]
    let body: Data

    static func json(_ object: Any, status: Int = 200) -> KeysAndAppsStubResponse {
        KeysAndAppsStubResponse(
            status: status,
            headers: ["Content-Type": "application/json"],
            body: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        )
    }
}
