import Foundation
import XCTest
@testable import AppCore
@testable import Models
@testable import Networking
@testable import ProjectBudgets
@testable import Providers

@MainActor
final class ProjectManagementStoreTests: XCTestCase {
    override func tearDown() {
        ManagementStoreURLProtocol.handler = nil
        super.tearDown()
    }

    // MARK: - Capability probe

    func testProbeCapabilitiesActivatesManagementWithSession() async throws {
        let harness = makeHarness()
        harness.installSessionCookie()
        ManagementStoreURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/usage-events")
            return .json(Self.sessionProbeJSON)
        }

        let store = ProjectManagementStore()
        await store.probeCapabilities(using: harness.client)

        XCTAssertTrue(store.canManage)
    }

    func testProbeCapabilitiesWithoutSessionKeepsManagementOff() async {
        let harness = makeHarness()
        // No cookie: the probe short-circuits to signed-out without a request.
        ManagementStoreURLProtocol.handler = { _ in
            XCTFail("No session cookie means no probe request at all.")
            return .json(Self.sessionProbeJSON)
        }

        let store = ProjectManagementStore()
        await store.probeCapabilities(using: harness.client)

        XCTAssertFalse(store.canManage)
    }

    // MARK: - Mutations

    func testCreateProjectPostsThenRefreshesBudgetStore() async throws {
        let harness = makeHarness()
        harness.installSessionCookie()
        var requestedPaths: [String] = []
        ManagementStoreURLProtocol.handler = { request in
            requestedPaths.append(request.url?.path ?? "")
            switch request.url?.path {
            case "/api/projects":
                XCTAssertEqual(request.httpMethod, "POST")
                let body = Self.jsonObject(request)
                XCTAssertEqual(body["name"] as? String, "New Project")
                XCTAssertEqual(body["monthlyBudgetUsd"] as? Double, 250)
                return .json(Self.projectMutationJSON)
            case "/api/budget-status":
                return .json(Self.budgetJSON)
            default:
                return .json(["error": "unexpected"], status: 404)
            }
        }

        let store = ProjectManagementStore()
        let receipt = await store.create(
            ProjectBudgetDraft(name: "New Project", details: "desc", monthlyBudgetInput: "250"),
            using: harness.client,
            refreshing: harness.budgetStore
        )

        XCTAssertEqual(receipt?.id, "project-1")
        XCTAssertEqual(
            requestedPaths,
            ["/api/projects", "/api/budget-status"],
            "A successful mutation must refresh the shared budget store."
        )
        XCTAssertNotNil(harness.budgetStore.state.value)
        XCTAssertNil(store.actionError)
    }

    func testUpdateProjectRefreshesBudgetStore() async {
        let harness = makeHarness()
        harness.installSessionCookie()
        var requestedPaths: [String] = []
        ManagementStoreURLProtocol.handler = { request in
            requestedPaths.append(request.url?.path ?? "")
            if request.url?.path == "/api/projects/project-1" {
                XCTAssertEqual(request.httpMethod, "PUT")
                return .json(Self.projectMutationJSON)
            }
            return .json(Self.budgetJSON)
        }

        let store = ProjectManagementStore()
        let succeeded = await store.update(
            ProjectBudgetDraft(name: "Renamed", monthlyBudgetInput: "300"),
            projectID: "project-1",
            using: harness.client,
            refreshing: harness.budgetStore
        )

        XCTAssertTrue(succeeded)
        XCTAssertEqual(requestedPaths, ["/api/projects/project-1", "/api/budget-status"])
    }

    func testDeleteProjectRefreshesBudgetStore() async {
        let harness = makeHarness()
        harness.installSessionCookie()
        var requestedPaths: [String] = []
        ManagementStoreURLProtocol.handler = { request in
            requestedPaths.append(request.url?.path ?? "")
            if request.url?.path == "/api/projects/project-1" {
                XCTAssertEqual(request.httpMethod, "DELETE")
                return .json(["success": true])
            }
            return .json(Self.budgetJSON)
        }

        let store = ProjectManagementStore()
        let succeeded = await store.delete(
            projectID: "project-1",
            using: harness.client,
            refreshing: harness.budgetStore
        )

        XCTAssertTrue(succeeded)
        XCTAssertEqual(requestedPaths, ["/api/projects/project-1", "/api/budget-status"])
    }

    func testUnauthorizedMutationSurfacesErrorAndDropsCapability() async {
        let harness = makeHarness()
        harness.installSessionCookie()
        ManagementStoreURLProtocol.handler = { _ in
            .json(["error": "Unauthorized"], status: 401)
        }

        let store = ProjectManagementStore()
        let receipt = await store.create(
            ProjectBudgetDraft(name: "New Project", monthlyBudgetInput: "100"),
            using: harness.client,
            refreshing: harness.budgetStore
        )

        XCTAssertNil(receipt)
        XCTAssertEqual(store.actionError, .unauthorized)
        XCTAssertFalse(store.canManage, "An expired session must hide the mutation affordances.")
    }

    func testInvalidDraftNeverTouchesNetwork() async {
        let harness = makeHarness()
        harness.installSessionCookie()
        ManagementStoreURLProtocol.handler = { _ in
            XCTFail("An invalid draft must fail validation before any request.")
            return .json(Self.projectMutationJSON)
        }

        let store = ProjectManagementStore()
        let receipt = await store.create(
            ProjectBudgetDraft(name: "   ", monthlyBudgetInput: "100"),
            using: harness.client,
            refreshing: harness.budgetStore
        )

        XCTAssertNil(receipt)
        XCTAssertNil(store.actionError)
    }

    // MARK: - Harness

    private struct Harness {
        let client: APIClient
        let budgetStore: BudgetStore
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

    private func makeHarness() -> Harness {
        // Unique host per test: the cookie jar is process-shared, so reuse
        // would leak sessions between tests.
        let baseURL = URL(string: "https://projects-\(UUID().uuidString.lowercased()).example.test")!
        let cookieStorage = HTTPCookieStorage.shared
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ManagementStoreURLProtocol.self]
        configuration.httpShouldSetCookies = true
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpCookieStorage = cookieStorage
        let client = APIClient(
            configuration: APIConfiguration(baseURL: baseURL, timeout: 2),
            tokenStore: InMemoryTokenStore(token: "read-token"),
            session: URLSession(configuration: configuration)
        )
        return Harness(
            client: client,
            budgetStore: BudgetStore(apiClient: client),
            baseURL: baseURL,
            cookieStorage: cookieStorage
        )
    }

    /// The request body as seen by `URLProtocol`.
    ///
    /// `URLSession` moves an outgoing `httpBody` onto `httpBodyStream` before
    /// the protocol sees the request, so `httpBody` is always `nil` here and a
    /// naive read silently yields an empty object (making every body
    /// assertion vacuous). Drain the stream instead.
    private static func jsonObject(_ request: URLRequest) -> [String: Any] {
        guard let body = request.httpBody ?? bodyStreamData(request),
              let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else {
            return [:]
        }
        return object
    }

    private static func bodyStreamData(_ request: URLRequest) -> Data? {
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4_096
        var buffer = [UInt8](repeating: 0, count: bufferSize)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: bufferSize)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data.isEmpty ? nil : data
    }

    private static let sessionProbeJSON: [String: Any] = [
        "mode": "raw",
        "days": 1,
        "limit": 1,
        "events": [],
        "hasMore": false,
    ]

    private static let projectMutationJSON: [String: Any] = [
        "id": "project-1",
        "name": "New Project",
        "nameKey": "new project",
        "description": "desc",
        "monthlyBudgetUsd": 250,
    ]

    /// `summary` carries every key `BudgetSummary` decodes as required (the
    /// server declares them non-nullable in `src/lib/budget-status.ts`).
    /// Dropping one makes the whole refresh fail to decode, which is exactly
    /// the "did the store actually reload?" signal these tests assert on.
    private static let budgetJSON: [String: Any] = [
        "ok": true,
        "generatedAt": "2026-07-29T12:00:00.000Z",
        "month": "2026-07",
        "providers": [],
        "projects": [],
        "summary": [
            "totalBudgetUsd": 0,
            "budgetedSpentUsd": 0,
            "unbudgetedSpentUsd": 0,
            "totalSpentUsd": 0,
            "remainingUsd": 0,
            "overBudget": false,
            "warning": false,
            "estimatedApiEquivalentUsd": 0,
        ],
    ]
}

@MainActor
final class ProviderDepthStoreTests: XCTestCase {
    override func tearDown() {
        ManagementStoreURLProtocol.handler = nil
        super.tearDown()
    }

    // MARK: - Series math

    func testSpendPointsChronologicalAndSkipsMissingCost() {
        let snapshots = [
            UsageSnapshotPoint(id: "b", providerId: "p", fetchedAt: "2026-07-02T00:00:00.000Z", totalCost: 12),
            UsageSnapshotPoint(id: "a", providerId: "p", fetchedAt: "2026-07-01T00:00:00.000Z", totalCost: 10),
            UsageSnapshotPoint(id: "c", providerId: "p", fetchedAt: "2026-07-03T00:00:00.000Z"),
            UsageSnapshotPoint(id: "d", providerId: "p", fetchedAt: "2026-07-04T00:00:00.000Z", totalCost: 15),
        ]

        XCTAssertEqual(ProviderHistorySeries.spendPoints(from: snapshots), [10, 12, 15])
        XCTAssertEqual(ProviderHistorySeries.latestSpend(from: snapshots), 15)
    }

    func testSpendPointsNilWithInsufficientData() {
        XCTAssertNil(ProviderHistorySeries.spendPoints(from: []))
        XCTAssertNil(ProviderHistorySeries.spendPoints(from: [
            UsageSnapshotPoint(id: "a", providerId: "p", fetchedAt: "2026-07-01T00:00:00.000Z", totalCost: 10),
        ]))
    }

    func testSpendPointsDownsamplesDenseWindows() {
        let snapshots = (0..<500).map { index in
            UsageSnapshotPoint(
                id: "s\(index)",
                providerId: "p",
                fetchedAt: String(format: "2026-07-01T00:%02d:%02d.000Z", index / 60, index % 60),
                totalCost: Double(index)
            )
        }

        let points = ProviderHistorySeries.spendPoints(from: snapshots)
        XCTAssertEqual(points?.count, ProviderHistorySeries.maxRenderedPoints)
        XCTAssertEqual(points?.first, 0)
        XCTAssertEqual(points?.last, 499)
    }

    // MARK: - Store behavior

    func testDepthLoadPopulatesHistoryAndBilling() async throws {
        let harness = makeHarness()
        harness.installSessionCookie()
        ManagementStoreURLProtocol.handler = { request in
            switch request.url?.path {
            case "/api/snapshots":
                return .json(Self.snapshotsJSON)
            case "/api/providers/provider-1":
                return .json(Self.providerDetailJSON)
            default:
                return .json(["error": "unexpected"], status: 404)
            }
        }

        let store = ProviderDepthStore()
        await store.loadIfNeeded(providerID: "provider-1", using: harness.client)

        XCTAssertEqual(store.snapshotPointCount, 2)
        XCTAssertEqual(store.spendHistoryPoints, [40.25, 120.5])
        XCTAssertEqual(store.latestRecordedSpend, 120.5)
        XCTAssertEqual(store.billingRecords.count, 1)
        XCTAssertEqual(store.billingRecords.first?.displayName, "Workers Paid")
        XCTAssertFalse(store.requiresSession)
    }

    func testDepthLoadWithoutSessionSetsRequiresSession() async {
        let harness = makeHarness()
        // No cookie: the session-gated routes 401.
        ManagementStoreURLProtocol.handler = { _ in
            .json(["error": "Unauthorized"], status: 401)
        }

        let store = ProviderDepthStore()
        await store.loadIfNeeded(providerID: "provider-1", using: harness.client)

        XCTAssertTrue(store.requiresSession)
        XCTAssertNil(store.spendHistoryPoints)
        XCTAssertTrue(store.billingRecords.isEmpty)
    }

    func testSelectHistoryRangeReloadsSnapshotsWithSelectedDays() async throws {
        let harness = makeHarness()
        harness.installSessionCookie()
        var requestedDays: [String] = []
        ManagementStoreURLProtocol.handler = { request in
            switch request.url?.path {
            case "/api/snapshots":
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
                let days = query?.first(where: { $0.name == "days" })?.value ?? ""
                requestedDays.append(days)
                return .json(Self.snapshotsJSON)
            case "/api/providers/provider-1":
                return .json(Self.providerDetailJSON)
            default:
                return .json(["error": "unexpected"], status: 404)
            }
        }

        let store = ProviderDepthStore()
        await store.loadIfNeeded(providerID: "provider-1", using: harness.client)
        XCTAssertEqual(store.historyRange, .thirtyDays)
        XCTAssertEqual(requestedDays, ["30"])
        // Caption reads the range's `displayLabel`, which gained its explicit
        // "Past …" framing in the timeframe redesign (#1020).
        XCTAssertEqual(store.historyCaption, "2 readings · Past 30 days")

        await store.selectHistoryRange(.ninetyDays, providerID: "provider-1", using: harness.client)
        XCTAssertEqual(store.historyRange, .ninetyDays)
        XCTAssertEqual(requestedDays, ["30", "90"])
        XCTAssertEqual(store.historyCaption, "2 readings · Past 90 days")
        XCTAssertFalse(store.isReloadingHistory)

        // Same range is a no-op (no extra network call).
        await store.selectHistoryRange(.ninetyDays, providerID: "provider-1", using: harness.client)
        XCTAssertEqual(requestedDays, ["30", "90"])
    }

    func testSelectHistoryRangeWithoutClientUpdatesSelectionOnly() async {
        let store = ProviderDepthStore()
        await store.selectHistoryRange(.oneYear, providerID: "provider-1", using: nil)
        XCTAssertEqual(store.historyRange, .oneYear)
        XCTAssertNil(store.historyState.value)
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

    private func makeHarness() -> Harness {
        let baseURL = URL(string: "https://depth-\(UUID().uuidString.lowercased()).example.test")!
        let cookieStorage = HTTPCookieStorage.shared
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ManagementStoreURLProtocol.self]
        configuration.httpShouldSetCookies = true
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpCookieStorage = cookieStorage
        return Harness(
            client: APIClient(
                configuration: APIConfiguration(baseURL: baseURL, timeout: 2),
                tokenStore: InMemoryTokenStore(),
                session: URLSession(configuration: configuration)
            ),
            baseURL: baseURL,
            cookieStorage: cookieStorage
        )
    }

    private static let snapshotsJSON: [[String: Any]] = [
        [
            "id": "rollup:rollup-1",
            "providerId": "provider-1",
            "fetchedAt": "2026-07-01T23:59:00.000Z",
            "totalCost": 40.25,
            "rollup": true,
            "sampleCount": 4,
        ],
        [
            "id": "snapshot-1",
            "providerId": "provider-1",
            "fetchedAt": "2026-07-28T12:00:00.000Z",
            "totalCost": 120.5,
        ],
    ]

    private static let providerDetailJSON: [String: Any] = [
        "id": "provider-1",
        "name": "cloudflare",
        "displayName": "Cloudflare",
        "type": "builtin",
        "isActive": true,
        "externalBilling": [[
            "source": "stripe",
            "externalId": "sub_123",
            "kind": "subscription",
            "serviceName": "Workers Paid",
            "status": "active",
            "amountUsd": 5,
            "billingInterval": "monthly",
            "currentPeriodStart": "2026-07-17T00:00:00.000Z",
            "currentPeriodEnd": "2026-08-17T00:00:00.000Z",
            "syncedAt": "2026-07-29T08:00:00.000Z",
        ]],
    ]
}

private final class ManagementStoreURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> ManagementStoreStubResponse)?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else {
                throw URLError(.badServerResponse)
            }
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

private struct ManagementStoreStubResponse {
    let status: Int
    let headers: [String: String]
    let body: Data

    static func json(
        _ object: Any,
        status: Int = 200,
        headers: [String: String] = [:]
    ) -> ManagementStoreStubResponse {
        var responseHeaders = headers
        responseHeaders["Content-Type"] = "application/json"
        return ManagementStoreStubResponse(
            status: status,
            headers: responseHeaders,
            body: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        )
    }
}
