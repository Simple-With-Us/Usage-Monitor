import XCTest

import DesignSystem
import Models

@testable import Platforms

/// Pure-function tests for the two badge mappings on the Platforms tab.
///
/// Both were "green means green" bugs: a badge that read healthy for something
/// that was, in fact, down.  Neither mapping reads the clock, so there is no
/// wall-clock fixture here to rot.
///
/// The status strings below are the literal shapes Coolify emits (see
/// `parseStatus` in `src/lib/adapters/coolify.ts`) and the literal account
/// shapes `fetchR2FleetSummary` emits (see `src/lib/r2-usage.ts`).
final class PlatformsStatusMappingTests: XCTestCase {

    // MARK: - FleetAppStatus (Coolify "<state>:<health>")

    /// The regression: "running:unhealthy" contains both "healthy" and
    /// "running", so substring matching rendered a down application green.
    func testRunningUnhealthyIsNotHealthy() {
        let status = FleetAppStatus.parse("running:unhealthy")
        XCTAssertEqual(status, .unhealthy)
        XCTAssertEqual(status.semantic, .danger)
        XCTAssertEqual(status.title, "Unhealthy")
    }

    /// Same substring trap with the container already gone.
    func testExitedUnhealthyReadsAsDown() {
        let status = FleetAppStatus.parse("exited:unhealthy")
        XCTAssertEqual(status, .down)
        XCTAssertEqual(status.semantic, .danger)
        XCTAssertEqual(status.title, "Down")
    }

    func testRunningHealthyIsTheOnlyGreenComposite() {
        let status = FleetAppStatus.parse("running:healthy")
        XCTAssertEqual(status, .healthy)
        XCTAssertEqual(status.semantic, .ok)
        XCTAssertEqual(status.title, "Healthy")
    }

    /// A compose app with no health check reports "running:unknown".  It is
    /// neither up nor down, and must never be counted as healthy.
    func testRunningUnknownIsWarningNotOk() {
        let status = FleetAppStatus.parse("running:unknown")
        XCTAssertEqual(status, .unknown)
        XCTAssertEqual(status.semantic, .warning)
        XCTAssertEqual(status.title, "Unknown")
    }

    /// A bare "running" has no health part at all — Coolify never configured
    /// one — so the container state is the best signal available.
    func testBareRunningIsHealthy() {
        XCTAssertEqual(FleetAppStatus.parse("running"), .healthy)
    }

    func testStoppedStatesAreDanger() {
        for raw in ["exited", "stopped", "dead", "exited:unknown", "stopped:healthy"] {
            let status = FleetAppStatus.parse(raw)
            XCTAssertEqual(status, .down, "expected \(raw) to be down")
            XCTAssertEqual(status.semantic, .danger, "expected \(raw) to be danger")
        }
    }

    /// "stopped:healthy" is the inverse trap: a stale health part must not
    /// resurrect a container that is not running.
    func testStoppedWithStaleHealthyHealthIsStillDown() {
        XCTAssertEqual(FleetAppStatus.parse("stopped:healthy"), .down)
    }

    func testTransitionalAndUnrecognisedStatesFallBackToUnknown() {
        for raw in ["restarting:starting", "paused", "created", "something-new"] {
            XCTAssertEqual(FleetAppStatus.parse(raw), .unknown, "expected \(raw) to be unknown")
        }
    }

    func testNeverDeployedApplicationIsNeutral() {
        for raw in ["", "   ", ":"] {
            let status = FleetAppStatus.parse(raw)
            XCTAssertEqual(status, .notDeployed, "expected \(raw.debugDescription) not deployed")
            XCTAssertEqual(status.semantic, .neutral)
            XCTAssertEqual(status.title, "Not Deployed")
        }
    }

    func testParsingIsCaseAndWhitespaceInsensitive() {
        XCTAssertEqual(FleetAppStatus.parse("  Running:Unhealthy "), .unhealthy)
        XCTAssertEqual(FleetAppStatus.parse("RUNNING : HEALTHY"), .healthy)
        XCTAssertEqual(FleetAppStatus.parse("Exited"), .down)
    }

    /// A single-token "unhealthy" still has to land on danger.
    func testBareUnhealthyIsDanger() {
        XCTAssertEqual(FleetAppStatus.parse("unhealthy"), .unhealthy)
    }

    // MARK: - R2AccountHealth

    private func account(
        id: String = "um",
        configured: Bool = true,
        status: String? = "ok",
        mtdPct: Double? = 12,
        onTrack: Bool = false,
        error: String? = nil,
        metricsSource: String? = nil
    ) -> OperationsHealth.R2Fleet.Account {
        OperationsHealth.R2Fleet.Account(
            id: id,
            label: id == "old" ? "Jay (Old)" : "Usage Monitor",
            configured: configured,
            status: status,
            storage: mtdPct.map { OperationsHealth.R2Fleet.MetricStatus(mtdPct: $0) },
            overallOnTrackToExceed70Pct: onTrack,
            error: error,
            metricsSource: metricsSource
        )
    }

    /// The regression: a failed read ships `status: "error"` with a zeroed
    /// storage metric and `overallOnTrackToExceed70Pct: false`, which rendered
    /// as a green "OK" beside a meaningless 0%.
    func testErroredAccountIsNotOkAndHidesItsZeroPercent() {
        let health = R2AccountHealth.evaluate(
            account(status: "error", mtdPct: 0, error: "Cloudflare GraphQL HTTP 403")
        )
        XCTAssertEqual(health, .unavailable)
        XCTAssertEqual(health.semantic, .warning)
        XCTAssertEqual(health.title, "Unavailable")
        XCTAssertFalse(health.showsUsage)
    }

    func testErroredAccountSurfacesTheServerReason() {
        let failing = account(status: "error", mtdPct: 0, error: "Cloudflare GraphQL HTTP 403")
        XCTAssertEqual(
            R2AccountHealth.evaluate(failing).detail(for: failing),
            "Cloudflare GraphQL HTTP 403"
        )
    }

    func testErroredAccountWithoutAReasonStillExplainsItself() {
        let failing = account(status: "error", mtdPct: 0, error: nil)
        XCTAssertEqual(
            R2AccountHealth.evaluate(failing).detail(for: failing),
            "Metrics unavailable"
        )
    }

    /// An error string alone is enough, even if `status` still says "ok".
    func testErrorStringOverridesAnOkStatus() {
        XCTAssertEqual(
            R2AccountHealth.evaluate(account(status: "ok", error: "token expired")),
            .unavailable
        )
    }

    func testUnconfiguredAccountIsNeutralAndShowsNoUsage() {
        let health = R2AccountHealth.evaluate(
            account(configured: false, status: "unconfigured", mtdPct: nil)
        )
        XCTAssertEqual(health, .unconfigured)
        XCTAssertEqual(health.semantic, .neutral)
        XCTAssertEqual(health.title, "Not Configured")
        XCTAssertFalse(health.showsUsage)
        XCTAssertNil(health.detail(for: account(configured: false, mtdPct: nil)))
    }

    /// `configured: false` wins even when the server contradicts itself with a
    /// leftover "ok" status.
    func testUnconfiguredFlagWinsOverAnOkStatus() {
        XCTAssertEqual(
            R2AccountHealth.evaluate(account(configured: false, status: "ok")),
            .unconfigured
        )
    }

    func testHealthyAccountIsOkAndShowsUsage() {
        let health = R2AccountHealth.evaluate(account(mtdPct: 12, onTrack: false))
        XCTAssertEqual(health, .ok)
        XCTAssertEqual(health.semantic, .ok)
        XCTAssertEqual(health.title, "OK")
        XCTAssertTrue(health.showsUsage)
        XCTAssertNil(health.detail(for: account()))
    }

    func testAccountOnTrackToExceedIsWatch() {
        let health = R2AccountHealth.evaluate(account(mtdPct: 74, onTrack: true))
        XCTAssertEqual(health, .watch)
        XCTAssertEqual(health.semantic, .warning)
        XCTAssertEqual(health.title, "Watch")
        XCTAssertTrue(health.showsUsage)
    }

    /// A genuine 0% from a successful read is still a real figure.
    func testZeroPercentFromASuccessfulReadStaysVisible() {
        let health = R2AccountHealth.evaluate(account(status: "ok", mtdPct: 0))
        XCTAssertEqual(health, .ok)
        XCTAssertTrue(health.showsUsage)
    }

    /// No usage figure at all is not a green light — there is nothing to show.
    func testMissingStorageMetricIsUnavailable() {
        XCTAssertEqual(R2AccountHealth.evaluate(account(mtdPct: nil)), .unavailable)
    }

    /// Jay Old ships `r2_not_enabled` so leftover GraphQL storage is ignored.
    func testR2NotEnabledIsNeutralAndHidesUsage() {
        let health = R2AccountHealth.evaluate(
            account(id: "old", mtdPct: nil, metricsSource: "r2_not_enabled")
        )
        XCTAssertEqual(health, .notEnabled)
        XCTAssertEqual(health.semantic, .neutral)
        XCTAssertEqual(health.title, "R2 Not Enabled")
        XCTAssertFalse(health.showsUsage)
        XCTAssertEqual(
            health.detail(for: account(id: "old", mtdPct: nil, metricsSource: "r2_not_enabled")),
            "R2 is not enabled on this account.  GraphQL leftovers are ignored."
        )
    }

    /// Older payloads omit `metricsSource` — Jay Old with no storage is still
    /// a leftover account, not a failed live read.
    func testJayOldWithoutMetricsSourceIsNotUnavailable() {
        XCTAssertEqual(
            R2AccountHealth.evaluate(account(id: "old", mtdPct: nil)),
            .notEnabled
        )
    }

    /// A status this build has never seen fails closed rather than assuming
    /// it means "fine".
    func testUnrecognisedStatusFailsClosed() {
        XCTAssertEqual(R2AccountHealth.evaluate(account(status: "throttled")), .unavailable)
    }

    /// An absent `status` with real numbers and no error is still usable —
    /// the field is optional on the wire.
    func testAbsentStatusWithUsableNumbersIsNotPenalised() {
        XCTAssertEqual(R2AccountHealth.evaluate(account(status: nil, mtdPct: 41)), .ok)
    }

    func testUsageBarStatusMatchesFreeTierGuard() {
        XCTAssertEqual(PlatformFormat.usageBarStatus(20), .ok)
        XCTAssertEqual(PlatformFormat.usageBarStatus(50), .warning)
        XCTAssertEqual(PlatformFormat.usageBarStatus(70), .danger)
        XCTAssertEqual(PlatformFormat.bytesCompact(10 * 1024 * 1024 * 1024), "10 GB")
    }

    func testStatusMatchingIsCaseAndWhitespaceInsensitive() {
        XCTAssertEqual(R2AccountHealth.evaluate(account(status: " OK ")), .ok)
        XCTAssertEqual(R2AccountHealth.evaluate(account(status: " Error ", mtdPct: 0)), .unavailable)
    }
}
