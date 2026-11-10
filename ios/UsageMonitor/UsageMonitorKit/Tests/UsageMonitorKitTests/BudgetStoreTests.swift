import Foundation
import XCTest
@testable import AppCore
@testable import Models
@testable import Networking

@MainActor
final class BudgetStoreTests: XCTestCase {
    override func tearDown() {
        BudgetStoreURLProtocol.handler = nil
        BudgetStoreURLProtocol.fetchCount = 0
        super.tearDown()
    }

    func testConcurrentLoadIfNeededCoalescesToSingleFetch() async {
        let client = makeClient()
        let store = BudgetStore(apiClient: client)
        BudgetStoreURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/budget-status")
            try await Task.sleep(nanoseconds: 50_000_000)
            return .json(Self.budgetJSON)
        }

        async let first: Void = store.loadIfNeeded()
        async let second: Void = store.loadIfNeeded()
        _ = await (first, second)

        XCTAssertEqual(BudgetStoreURLProtocol.fetchCount, 1)
        XCTAssertNil(store.state.error, "decode/transport failure hides itself as a nil value below")
        XCTAssertNotNil(store.state.value)
        XCTAssertNotNil(store.lastCachedAt)
    }

    func testConcurrentRefreshCoalescesToSingleFetch() async throws {
        let client = makeClient()
        let store = BudgetStore(apiClient: client)
        BudgetStoreURLProtocol.handler = { _ in
            try await Task.sleep(nanoseconds: 50_000_000)
            return .json(Self.budgetJSON)
        }

        await store.load()
        BudgetStoreURLProtocol.fetchCount = 0

        async let first: Void = store.refresh()
        async let second: Void = store.refresh()
        _ = await (first, second)

        XCTAssertEqual(BudgetStoreURLProtocol.fetchCount, 1)
    }

    func testOfflineFirstPaintPreservesCachedAt() async {
        let cachedAt = Date(timeIntervalSince1970: 1_700_000_000)
        let sink = StubBudgetSnapshotSink(
            cached: CachedBudgetSnapshot(response: .sample, cachedAt: cachedAt)
        )
        let store = BudgetStore(apiClient: makeClient(), sink: sink)
        BudgetStoreURLProtocol.handler = { _ in
            throw URLError(.notConnectedToInternet)
        }

        await store.load()

        XCTAssertEqual(store.state.value, .sample)
        XCTAssertEqual(store.lastCachedAt, cachedAt)
    }

    func testSuccessfulFetchSetsLastCachedAt() async throws {
        let store = BudgetStore(apiClient: makeClient())
        let before = Date()
        BudgetStoreURLProtocol.handler = { _ in .json(Self.budgetJSON) }

        await store.load()

        XCTAssertNil(store.state.error, "decode/transport failure hides itself as a nil lastCachedAt below")
        let lastCachedAt = try XCTUnwrap(store.lastCachedAt)
        XCTAssertGreaterThanOrEqual(lastCachedAt.timeIntervalSince1970, before.timeIntervalSince1970 - 1)
    }

    private func makeClient() -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [BudgetStoreURLProtocol.self]
        let session = URLSession(configuration: configuration)
        return APIClient(
            configuration: .production,
            tokenStore: InMemoryTokenStore(token: "test-token"),
            session: session
        )
    }

    /// Mirrors the wire shape of `GET /api/budget-status`
    /// (`src/lib/budget-status.ts` → `computeProjectBudgetStatus`). Every
    /// non-optional field of `BudgetSummary` must be present: a missing key
    /// fails the whole decode, which the store reports as `state.failed`.
    private static let budgetJSON: [String: Any] = [
        "ok": true,
        "generatedAt": "2026-07-20T12:00:00.000Z",
        "month": "2026-07",
        "providers": [],
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

private struct StubBudgetSnapshotSink: BudgetSnapshotSink {
    let cached: CachedBudgetSnapshot?

    func store(_ response: BudgetStatusResponse) async {}
    func loadCached() async -> CachedBudgetSnapshot? { cached }
    func clear() async {}
}

private final class BudgetStoreURLProtocol: URLProtocol {
    nonisolated(unsafe) static var fetchCount = 0
    nonisolated(unsafe) static var handler: ((URLRequest) async throws -> BudgetStoreStubResponse)?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Task {
            do {
                guard let handler = Self.handler else {
                    throw URLError(.badServerResponse)
                }
                Self.fetchCount += 1
                let stub = try await handler(request)
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
    }

    override func stopLoading() {}
}

private struct BudgetStoreStubResponse {
    let status: Int
    let headers: [String: String]
    let body: Data

    static func json(
        _ object: Any,
        status: Int = 200,
        headers: [String: String] = [:]
    ) -> BudgetStoreStubResponse {
        var responseHeaders = headers
        responseHeaders["Content-Type"] = "application/json"
        return BudgetStoreStubResponse(
            status: status,
            headers: responseHeaders,
            body: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        )
    }
}
