import Models
import Networking
import XCTest

@testable import Platforms

/// The Platforms header's attention count must never disagree with the Fleet
/// Apps list underneath it.  The regression this guards: the count filtered
/// host resources on `status.contains("unknown")`, so a Coolify app reporting
/// "stopped", "exited" or "running:unhealthy" was invisible to the header — it
/// announced "All Systems Normal" over a list containing a down application.
///
/// No dates anywhere in these fixtures: the count is pure status parsing, so
/// there is no clock to freeze and nothing to rot at a month boundary.
@MainActor
final class PlatformsStoreAttentionTests: XCTestCase {

    // MARK: - Status classification

    func testCleanlyRunningStatusesDoNotNeedAttention() {
        XCTAssertFalse(PlatformsStore.resourceNeedsAttention("running:healthy"))
        XCTAssertFalse(PlatformsStore.resourceNeedsAttention("RUNNING:HEALTHY"))
        // Coolify databases have no container healthcheck and report bare state.
        XCTAssertFalse(PlatformsStore.resourceNeedsAttention("running"))
        XCTAssertFalse(PlatformsStore.resourceNeedsAttention(" running : healthy "))
    }

    func testDownAndDegradedStatusesNeedAttention() {
        // The bug: every one of these was previously counted as fine.
        XCTAssertTrue(PlatformsStore.resourceNeedsAttention("stopped"))
        XCTAssertTrue(PlatformsStore.resourceNeedsAttention("exited"))
        XCTAssertTrue(PlatformsStore.resourceNeedsAttention("exited:unhealthy"))
        XCTAssertTrue(PlatformsStore.resourceNeedsAttention("restarting:starting"))
        XCTAssertTrue(PlatformsStore.resourceNeedsAttention("dead"))
        XCTAssertTrue(PlatformsStore.resourceNeedsAttention("degraded"))
    }

    /// "running:unhealthy" contains "healthy" — a substring check scores the
    /// worst real-world case as the best one.  This is the trap the fix exists
    /// to avoid, so it gets its own test.
    func testUnhealthySubstringTrapIsNotScoredAsHealthy() {
        XCTAssertTrue(PlatformsStore.resourceNeedsAttention("running:unhealthy"))
        XCTAssertTrue(PlatformsStore.resourceNeedsAttention("RUNNING:UNHEALTHY"))
    }

    func testUnknownAndUnrecognisedStatusesStillNeedAttention() {
        XCTAssertTrue(PlatformsStore.resourceNeedsAttention("running:unknown"))
        XCTAssertTrue(PlatformsStore.resourceNeedsAttention("unknown"))
        XCTAssertTrue(PlatformsStore.resourceNeedsAttention(""))
        XCTAssertTrue(PlatformsStore.resourceNeedsAttention("something-new-from-coolify"))
    }

    // MARK: - Count wiring

    func testAttentionCountCountsDownAndDegradedResources() async {
        let metrics = ServerMetrics(
            resources: [
                resource(name: "usage-monitor", status: "running:healthy"),
                resource(name: "congress-trade", status: "running:unknown"),
                resource(name: "socratic-trade", status: "running:unhealthy"),
                resource(name: "worker", status: "stopped"),
                resource(name: "postgres", status: "running"),
            ]
        )

        let store = await loadedStore(metrics: metrics)

        // unknown + unhealthy + stopped; the two cleanly running apps are quiet.
        XCTAssertEqual(store.attentionCount, 3)
    }

    func testAttentionCountIsZeroWhenEveryResourceIsCleanlyRunning() async {
        let metrics = ServerMetrics(
            resources: [
                resource(name: "usage-monitor", status: "running:healthy"),
                resource(name: "postgres", status: "running"),
            ]
        )

        let store = await loadedStore(metrics: metrics)

        XCTAssertEqual(store.attentionCount, 0)
    }

    func testCriticalPreventionAddsToTheResourceCount() async {
        let metrics = ServerMetrics(
            resources: [
                resource(name: "usage-monitor", status: "running:healthy"),
                resource(name: "worker", status: "exited"),
            ],
            prevention: ServerMetrics.Prevention(overall: "critical")
        )

        let store = await loadedStore(metrics: metrics)

        XCTAssertEqual(store.attentionCount, 2)
    }

    // MARK: - Helpers

    private func resource(name: String, status: String) -> ServerMetrics.Resource {
        ServerMetrics.Resource(
            uuid: "uuid-\(name)",
            name: name,
            type: "application",
            status: status,
            selfApp: false
        )
    }

    /// Loads a store whose host probe returns `metrics`; the platform and
    /// operations probes stay empty so the assertion isolates the host count.
    private func loadedStore(metrics: ServerMetrics) async -> PlatformsStore {
        let store = PlatformsStore(
            platformProbe: { _ in PlatformStatusPayload() },
            hostProbe: { _ in metrics },
            operationsProbe: { _ in throw APIError.offline }
        )
        await store.load(
            using: APIClient(configuration: .production, tokenStore: InMemoryTokenStore())
        )
        return store
    }
}
