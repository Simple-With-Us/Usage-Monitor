import Foundation
import XCTest
import DesignSystem
@testable import Models
@testable import Networking
@testable import Providers

/// Money-lane tests.
///
/// Two halves, both of which have burned this app before:
///   1. **Wire contract** — the screen must read the *bearer-reachable*
///      `/api/subscriptions` and actually send the `Authorization` header. If
///      this silently drifted to a session-only route, the whole screen would
///      401 for every user who only pasted a read token.
///   2. **Money honesty** — a plan with no recorded price must read "Not
///      budgeted", never "$0"; and only active USD plans may be summed into the
///      headline figure.
///
/// Every date assertion runs against an injected clock and a fixed UTC calendar
/// (`Self.now` / `Self.utc`) so no test rots when the wall clock moves.
final class MoneyScreenTests: XCTestCase {
    override func tearDown() {
        MoneyURLProtocol.handler = nil
        super.tearDown()
    }

    // MARK: - Wire contract

    /// The screen reads two sources with two DIFFERENT auth modes, and that
    /// split is the load-bearing part: `/api/subscriptions` is bearer-reachable
    /// so recurring costs render with only a read token, while `/api/providers`
    /// is session-only and may legitimately 401.  Recording every request
    /// rather than just the last one is deliberate — a single-slot capture
    /// silently asserted whichever call happened to finish last.
    @MainActor
    func testStoreReadsBothSourcesWithTheCorrectAuthorizationPerRoute() async {
        let client = Self.makeClient(token: "  read-token  ")
        let observed = RequestLog()
        MoneyURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            observed.record(path: path, authorization: request.value(forHTTPHeaderField: "Authorization"))
            if path == "/api/providers" { return .json([Any]()) }
            return .json([Self.subscriptionJSON(id: "sub-1", name: "Claude Max", monthlyEquivalentUsd: 200, costUsd: 200)])
        }

        let store = MoneyStore()
        await store.load(using: client)

        XCTAssertTrue(observed.paths.contains("/api/subscriptions"))
        XCTAssertEqual(
            observed.authorization(for: "/api/subscriptions"),
            "Bearer read-token",
            "the bearer read token must reach the subscriptions read"
        )
        if observed.paths.contains("/api/providers") {
            XCTAssertNil(
                observed.authorization(for: "/api/providers") ?? nil,
                "session-only routes must not carry the bearer token"
            )
        }
        XCTAssertEqual(store.state.value?.count, 1)
        XCTAssertEqual(store.viewData(now: Self.now)?.monthlyTotalLine, "$200.00")
    }

    /// Thread-safe request recorder — the two loads run concurrently.
    private final class RequestLog: @unchecked Sendable {
        private let lock = NSLock()
        private var entries: [(path: String, authorization: String?)] = []

        func record(path: String, authorization: String?) {
            lock.lock()
            defer { lock.unlock() }
            entries.append((path, authorization))
        }

        var paths: [String] {
            lock.lock()
            defer { lock.unlock() }
            return entries.map(\.path)
        }

        /// Nested optional on purpose: outer nil means "never requested",
        /// inner nil means "requested with no Authorization header".
        func authorization(for path: String) -> String?? {
            lock.lock()
            defer { lock.unlock() }
            return entries.first { $0.path == path }?.authorization
        }
    }

    @MainActor
    func testStoreSurfacesUnauthorizedSoTheScreenCanRouteToSettings() async {
        let client = Self.makeClient(token: "stale-token")
        MoneyURLProtocol.handler = { _ in .json(["error": "unauthorized"], status: 401) }

        let store = MoneyStore()
        await store.load(using: client)

        XCTAssertEqual(store.state.error, .unauthorized)
    }

    @MainActor
    func testFailedRefreshKeepsAlreadyLoadedCosts() async {
        let client = Self.makeClient(token: "read-token")
        MoneyURLProtocol.handler = { _ in
            .json([Self.subscriptionJSON(id: "sub-1", name: "Claude Max", monthlyEquivalentUsd: 200, costUsd: 200)])
        }
        let store = MoneyStore()
        await store.load(using: client)

        MoneyURLProtocol.handler = { _ in .json(["error": "down"], status: 500) }
        await store.refresh(using: client)

        XCTAssertNil(store.state.error, "A refresh failure must not blank good money data.")
        XCTAssertEqual(store.state.value?.count, 1)
    }

    // MARK: - Total

    func testTotalSumsOnlyActiveUsdPlans() {
        let data = Self.viewData([
            Self.subscription(id: "a", name: "Claude Max", monthlyEquivalentUsd: 200),
            Self.subscription(id: "b", name: "Euro Plan", monthlyEquivalentUsd: 50, currency: "EUR"),
            Self.subscription(id: "c", name: "Maybe Later", monthlyEquivalentUsd: 500, effectiveStatus: "considering"),
            Self.subscription(id: "d", name: "Old Plan", monthlyEquivalentUsd: 90, effectiveStatus: "paused"),
        ])

        XCTAssertEqual(data.monthlyTotalUsd, 200, accuracy: 0.001)
        XCTAssertEqual(data.monthlyTotalLine, "$200.00")
        XCTAssertEqual(data.activeCount, 2)
        XCTAssertEqual(data.nonUsdActiveCount, 1)
        XCTAssertEqual(data.considering.map(\.name), ["Maybe Later"])
        XCTAssertEqual(data.inactive.map(\.name), ["Old Plan"])
    }

    func testNonUsdPlanKeepsItsOwnCurrencyAndSaysItIsExcluded() throws {
        let data = Self.viewData([
            Self.subscription(id: "b", name: "Euro Plan", costUsd: 50, monthlyEquivalentUsd: 50, currency: "EUR"),
        ])
        let row = try XCTUnwrap(data.billingGroups.first?.rows.first)

        XCTAssertEqual(row.monthlySecondary, "per month · not in the USD total")
        XCTAssertFalse(row.monthlyLine.contains("$"), "A EUR plan must not be relabelled as dollars.")
        XCTAssertEqual(data.monthlyTotalUsd, 0, accuracy: 0.001)
        XCTAssertEqual(data.monthlyTotalLine, "Not budgeted")
    }

    // MARK: - "Never $0"

    func testPlanWithNoRecordedCostReadsAsNotBudgeted() throws {
        let data = Self.viewData([
            Self.subscription(id: "a", name: "Claude Max", costUsd: 200, monthlyEquivalentUsd: 200),
            Self.subscription(id: "b", name: "Comped Seat", costUsd: 0, monthlyEquivalentUsd: 0),
        ])
        let comped = try XCTUnwrap(
            data.billingGroups.flatMap(\.rows).first { $0.name == "Comped Seat" }
        )

        XCTAssertFalse(comped.isBudgeted)
        XCTAssertEqual(comped.monthlyLine, "Not budgeted")
        XCTAssertEqual(comped.monthlySecondary, "no recurring cost recorded")
        XCTAssertFalse(comped.monthlyLine.contains("0"), "An unpriced plan must never render as a dollar figure.")
        XCTAssertFalse(comped.priceLine.contains("$"))
    }

    func testTotalNeverRendersZeroDollarsWhenNothingIsPriced() {
        let data = Self.viewData([
            Self.subscription(id: "a", name: "Comped Seat", costUsd: 0, monthlyEquivalentUsd: 0),
        ])

        XCTAssertFalse(data.hasBudgetedActive)
        XCTAssertEqual(data.monthlyTotalLine, "Not budgeted")
        XCTAssertEqual(data.billingGroups.first?.totalLine, "Not budgeted")
    }

    // MARK: - Provider grouping

    func testGroupsByProviderOrderedByMonthlySpend() throws {
        let data = Self.viewData([
            Self.subscription(id: "a", name: "Cheap Plan", monthlyEquivalentUsd: 10, providerID: "p-small", providerDisplayName: "Small Co"),
            Self.subscription(id: "b", name: "Big Plan", monthlyEquivalentUsd: 200, providerID: "p-big", providerDisplayName: "Anthropic"),
            Self.subscription(id: "c", name: "Second Big Plan", monthlyEquivalentUsd: 20, providerID: "p-big", providerDisplayName: "Anthropic"),
        ])

        XCTAssertEqual(data.billingGroups.map(\.providerTitle), ["Anthropic", "Small Co"])
        let big = try XCTUnwrap(data.billingGroups.first)
        XCTAssertEqual(big.monthlyTotalUsd, 220, accuracy: 0.001)
        XCTAssertEqual(big.totalLine, "$220.00")
        XCTAssertEqual(big.subtitle, "2 services")
        XCTAssertEqual(big.rows.map(\.name), ["Big Plan", "Second Big Plan"])
        XCTAssertEqual(data.providerCount, 2)
        // Provider attribution is repeated on every row so VoiceOver users who
        // land mid-list still hear who bills the service.
        XCTAssertTrue(big.rows[0].subtitleLine.hasPrefix("Anthropic · "))
    }

    func testProviderTitleFallsBackToNameWhenDisplayNameIsBlank() throws {
        let data = Self.viewData([
            Self.subscription(id: "a", name: "Plan", providerID: "p", providerName: "openrouter", providerDisplayName: "   "),
        ])

        XCTAssertEqual(try XCTUnwrap(data.billingGroups.first).providerTitle, "openrouter")
    }

    // MARK: - Renewal wording (frozen clock)

    func testRenewalWordingUsesInjectedClock() throws {
        let data = Self.viewData([
            Self.subscription(id: "a", name: "Claude Max", monthlyEquivalentUsd: 200, nextRenewalAt: "2026-03-15T00:00:00.000Z"),
        ])
        let row = try XCTUnwrap(data.billingGroups.first?.rows.first)

        XCTAssertTrue(row.renewalLine.hasPrefix("Renews "), row.renewalLine)
        XCTAssertTrue(row.renewalLine.hasSuffix("· in 14 days"), row.renewalLine)
        XCTAssertEqual(row.renewalDate, ISO8601DateParser.date(from: "2026-03-15T00:00:00.000Z"))
    }

    func testNonRenewingTermSaysItEnds() throws {
        let data = Self.viewData([
            Self.subscription(id: "a", name: "Claude Max", monthlyEquivalentUsd: 200, autoRenew: false, nextRenewalAt: "2026-03-02T00:00:00.000Z"),
        ])
        let row = try XCTUnwrap(data.billingGroups.first?.rows.first)

        XCTAssertTrue(row.renewalLine.hasPrefix("Term ends "), row.renewalLine)
        XCTAssertTrue(row.renewalLine.hasSuffix("· tomorrow"), row.renewalLine)
    }

    func testPausedPlanDescribesPaidThroughDateInThePast() throws {
        let data = Self.viewData([
            Self.subscription(id: "a", name: "Old Plan", monthlyEquivalentUsd: 90, effectiveStatus: "paused", nextRenewalAt: "2026-02-27T00:00:00.000Z"),
        ])
        let row = try XCTUnwrap(data.inactive.first)

        XCTAssertTrue(row.renewalLine.hasPrefix("Paid through "), row.renewalLine)
        XCTAssertTrue(row.renewalLine.hasSuffix("· 2 days ago"), row.renewalLine)
        XCTAssertEqual(row.statusLabel, "Paused")
        XCTAssertEqual(row.status, Theme.SemanticStatus.warning)
    }

    func testNextRenewalIgnoresPastAndInactivePlans() throws {
        let data = Self.viewData([
            Self.subscription(id: "a", name: "Later", monthlyEquivalentUsd: 20, nextRenewalAt: "2026-04-01T00:00:00.000Z"),
            Self.subscription(id: "b", name: "Sooner", monthlyEquivalentUsd: 10, nextRenewalAt: "2026-03-10T00:00:00.000Z"),
            Self.subscription(id: "c", name: "Paused Soonest", monthlyEquivalentUsd: 90, effectiveStatus: "paused", nextRenewalAt: "2026-03-02T00:00:00.000Z"),
        ])

        XCTAssertEqual(try XCTUnwrap(data.nextRenewal).name, "Sooner")
    }

    func testMissingRenewalDateIsReportedNotInvented() throws {
        let data = Self.viewData([
            Self.subscription(id: "a", name: "Claude Max", monthlyEquivalentUsd: 200, nextRenewalAt: "not-a-date"),
        ])
        let row = try XCTUnwrap(data.billingGroups.first?.rows.first)

        XCTAssertNil(row.renewalDate)
        XCTAssertEqual(row.renewalLine, "Renewal date not reported")
        XCTAssertNil(data.nextRenewal)
    }

    // MARK: - Summary copy

    func testSummaryLineNamesScopeAndNonUsdCaveat() {
        let single = Self.viewData([Self.subscription(id: "a", name: "Only", monthlyEquivalentUsd: 5)])
        XCTAssertEqual(single.summaryLine, "1 active service · 1 provider")

        let mixed = Self.viewData([
            Self.subscription(id: "a", name: "Only", monthlyEquivalentUsd: 5),
            Self.subscription(id: "b", name: "Euro", monthlyEquivalentUsd: 5, currency: "EUR", providerID: "p2", providerDisplayName: "Second"),
        ])
        XCTAssertEqual(mixed.summaryLine, "2 active services · 2 providers · 1 not in USD")
    }

    func testEmptyPayloadIsEmpty() {
        XCTAssertTrue(Self.viewData([]).isEmpty)
    }

    // MARK: - Fixtures

    private static let now = ISO8601DateParser.date(from: "2026-03-01T12:00:00.000Z")!

    private static var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private static func viewData(_ subscriptions: [SubscriptionSummary]) -> MoneyViewData {
        MoneyViewData(subscriptions: subscriptions, now: now, calendar: utc)
    }

    private static func subscription(
        id: String,
        name: String,
        costUsd: Double = 20,
        monthlyEquivalentUsd: Double = 20,
        currency: String = "USD",
        interval: String = "monthly",
        intervalCount: Int = 1,
        autoRenew: Bool = true,
        effectiveStatus: String = "active",
        nextRenewalAt: String = "2026-03-20T00:00:00.000Z",
        providerID: String = "provider-1",
        providerName: String = "anthropic",
        providerDisplayName: String = "Anthropic"
    ) -> SubscriptionSummary {
        SubscriptionSummary(
            id: id,
            name: name,
            costUsd: costUsd,
            currency: currency,
            interval: interval,
            intervalCount: intervalCount,
            monthlyEquivalentUsd: monthlyEquivalentUsd,
            startDate: "2026-01-01T00:00:00.000Z",
            currentPeriodStart: "2026-02-20T00:00:00.000Z",
            nextRenewalAt: nextRenewalAt,
            autoRenew: autoRenew,
            status: effectiveStatus,
            effectiveStatus: effectiveStatus,
            provider: SubscriptionSummary.ProviderRef(
                id: providerID,
                name: providerName,
                displayName: providerDisplayName
            )
        )
    }

    private static func subscriptionJSON(
        id: String,
        name: String,
        monthlyEquivalentUsd: Double,
        costUsd: Double
    ) -> [String: Any] {
        [
            "id": id,
            "name": name,
            "costUsd": costUsd,
            "currency": "USD",
            "interval": "monthly",
            "intervalCount": 1,
            "monthlyEquivalentUsd": monthlyEquivalentUsd,
            "startDate": "2026-01-01T00:00:00.000Z",
            "currentPeriodStart": "2026-02-20T00:00:00.000Z",
            "nextRenewalAt": "2026-03-20T00:00:00.000Z",
            "autoRenew": true,
            "status": "active",
            "effectiveStatus": "active",
            "provider": [
                "id": "provider-1",
                "name": "anthropic",
                "displayName": "Anthropic",
            ],
        ]
    }

    private static func makeClient(token: String?) -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MoneyURLProtocol.self]
        let session = URLSession(configuration: configuration)
        return APIClient(
            configuration: APIConfiguration(
                baseURL: URL(string: "https://money-\(UUID().uuidString.lowercased()).example.test")!,
                timeout: 2
            ),
            tokenStore: InMemoryTokenStore(token: token),
            session: session
        )
    }
}

private final class MoneyURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> MoneyStubResponse)?

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
                headerFields: ["Content-Type": "application/json"]
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

private struct MoneyStubResponse {
    let status: Int
    let body: Data

    static func json(_ object: Any, status: Int = 200) -> MoneyStubResponse {
        MoneyStubResponse(
            status: status,
            body: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        )
    }
}
