import XCTest
@testable import ServerStatus
@testable import AppCore
@testable import Networking
import DesignSystem
import Models

/// Server-status snapshot roll-ups, store lifecycle, and the shared
/// uptime/disk formatters. Moved from `SettingsFeatureTests` when the panel
/// became its own tab (ServerStatus lane).
@MainActor
final class ServerStatusFeatureTests: XCTestCase {

    // MARK: Formatting

    func testHealthDecodesRevisionAsCommitAndIgnoresNpmPlaceholderInUI() throws {
        let json = Data("""
        {
          "ok": true,
          "status": "live",
          "version": "0.1.0",
          "revision": "ef32f9afdeadbeef",
          "service": "usage-monitor"
        }
        """.utf8)
        let health = try JSONDecoder().decode(ServerHealth.self, from: json)
        XCTAssertEqual(health.version, "0.1.0")
        XCTAssertEqual(health.commit, "ef32f9afdeadbeef")
    }

    func testUptimeFormatting() {
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 273_600), "3d 4h")
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 3_660), "1h 1m")
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 90), "1m")
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 30), "30s")
        XCTAssertEqual(UptimeFormat.string(fromSeconds: 0), "just started")
    }

    func testDiskAndRateFormatting() {
        XCTAssertNotNil(DiskFormat.summary(free: 5_000_000_000, total: 20_000_000_000))
        XCTAssertNil(DiskFormat.summary(free: nil, total: 1))
        XCTAssertEqual(DiskFormat.cpuString(18.4), "18%")
        XCTAssertNotNil(DiskFormat.rateString(120_000))
    }

    // MARK: Server status

    func testSnapshotRollupsAndDependencyRows() {
        let degraded = ServerStatusSnapshot(
            health: .init(ok: true, status: "ok"),
            readiness: .init(
                ok: false,
                status: "degraded",
                checks: .init(
                    database: .init(ok: true),
                    scheduler: .init(ok: false),
                    backup: .init(ok: false)
                )
            ),
            fetchedAt: Date()
        )
        XCTAssertEqual(degraded.overallStatus, .warning)
        XCTAssertEqual(degraded.overallLabel, "Degraded")
        // Core service rows only; legacy single backup lands in backupLayerChecks.
        XCTAssertEqual(degraded.dependencyChecks.count, 2)
        XCTAssertEqual(
            degraded.dependencyChecks.map(\.name),
            ["Database", "Scheduler"]
        )
        let legacyBackup = degraded.backupLayerChecks.first { $0.name == "Backup (Off-Site)" }
        XCTAssertNotNil(legacyBackup)
        XCTAssertEqual(legacyBackup?.ok, false)
        XCTAssertEqual(legacyBackup?.gatesService, false)

        let layered = ServerStatusSnapshot(
            health: .init(ok: true, status: "ok"),
            readiness: .init(
                ok: true,
                status: "ready",
                checks: .init(
                    database: .init(ok: true),
                    scheduler: .init(ok: true),
                    startup: .init(ok: true),
                    disk: .init(ok: true, freeBytes: 10_000_000_000, totalBytes: 100_000_000_000),
                    backupLayers: .init(
                        local: .init(ok: true, present: true, count: 2, latestAgeSeconds: 7200),
                        primary: .init(
                            ok: true,
                            target: "b2",
                            label: "b2",
                            active: true,
                            replicaAgeSeconds: 90
                        ),
                        r2Historic: .init(
                            ok: true,
                            configured: true,
                            role: "historic",
                            weeklyArchive: .init(ok: true, ageSeconds: 3_600)
                        )
                    )
                )
            ),
            fetchedAt: Date()
        )
        XCTAssertEqual(
            layered.dependencyChecks.map(\.name),
            ["Database", "Scheduler", "Startup", "Disk"]
        )
        XCTAssertEqual(
            layered.backupLayerChecks.map(\.name),
            ["Local Backup", "B2 Backup", "R2 Weekly Archive"]
        )
        XCTAssertTrue(layered.backupLayerChecks.allSatisfy(\.ok))
        XCTAssertTrue(layered.backupLayerChecks.allSatisfy { !$0.gatesService })
        XCTAssertTrue(
            layered.backupLayerChecks.first { $0.name == "Local Backup" }?.detail?
                .contains("2 snapshots") == true
        )
        let r2Detail = layered.backupLayerChecks.first { $0.name == "R2 Weekly Archive" }?.detail
        XCTAssertTrue(r2Detail?.contains("latest") == true)
        XCTAssertFalse(r2Detail?.contains("weekly freeze") == true)
        XCTAssertFalse(r2Detail?.contains("Historic") == true)

        let serverDriven = ServerStatusSnapshot(
            health: .init(ok: true, status: "ok"),
            readiness: .init(
                ok: true,
                status: "ready",
                checks: .init(
                    backupLayers: .init(
                        r2Historic: .init(
                            ok: true,
                            configured: true,
                            role: "historic",
                            title: "R2 From Server",
                            detail: "server wrote this"
                        )
                    )
                )
            ),
            fetchedAt: Date()
        )
        XCTAssertEqual(
            serverDriven.backupLayerChecks.first?.name,
            "R2 From Server"
        )
        XCTAssertEqual(
            serverDriven.backupLayerChecks.first?.detail,
            "server wrote this"
        )

        let down = ServerStatusSnapshot(
            health: .init(ok: false, status: "fail"),
            readiness: nil,
            fetchedAt: Date()
        )
        XCTAssertEqual(down.overallStatus, .danger)
        XCTAssertEqual(down.overallLabel, "Offline")
        XCTAssertTrue(down.dependencyChecks.isEmpty)
        XCTAssertTrue(down.backupLayerChecks.isEmpty)
    }

    // The free-tier kill-switch flag is only meaningful while R2 is the live
    // litestream target (role "active"). A stale/engaged flag left over from
    // an unrelated incident must not make an already-frozen "historic" R2
    // row claim "writes paused".
    func testR2HistoricDetailIgnoresStaleKillSwitchFlag() {
        let snapshot = ServerStatusSnapshot(
            health: .init(ok: true, status: "ok"),
            readiness: .init(
                ok: true,
                status: "ready",
                checks: .init(
                    backupLayers: .init(
                        r2Historic: .init(
                            ok: false,
                            configured: true,
                            autoDisabled: true,
                            role: "historic",
                            reason: "archive_not_run"
                        )
                    )
                )
            ),
            fetchedAt: Date()
        )
        let row = snapshot.backupLayerChecks.first { $0.name == "R2 Weekly Archive" }
        XCTAssertEqual(row?.ok, false)
        XCTAssertTrue(row?.detail?.contains("not run this week") == true)
        XCTAssertFalse(row?.detail?.contains("writes paused") == true)
        XCTAssertFalse(row?.detail?.contains("weekly freeze") == true)
    }

    func testR2HistoricWithoutWeeklyArchiveIsNotOkEvenIfServerSaysOk() {
        let snapshot = ServerStatusSnapshot(
            health: .init(ok: true, status: "ok"),
            readiness: .init(
                ok: true,
                status: "ready",
                checks: .init(
                    backupLayers: .init(
                        r2Historic: .init(ok: true, configured: true, role: "historic")
                    )
                )
            ),
            fetchedAt: Date()
        )
        let row = snapshot.backupLayerChecks.first { $0.name == "R2 Weekly Archive" }
        XCTAssertEqual(row?.ok, false)
        XCTAssertEqual(row?.detail, "not run this week")
    }

    func testR2HistoricStaleArchiveShowsLaggingDetail() {
        let snapshot = ServerStatusSnapshot(
            health: .init(ok: true, status: "ok"),
            readiness: .init(
                ok: true,
                status: "ready",
                checks: .init(
                    backupLayers: .init(
                        r2Historic: .init(
                            ok: false,
                            configured: true,
                            role: "historic",
                            reason: "archive_stale",
                            weeklyArchive: .init(
                                ok: false,
                                ageSeconds: 900_000,
                                reason: "archive_stale"
                            )
                        )
                    )
                )
            ),
            fetchedAt: Date()
        )
        let row = snapshot.backupLayerChecks.first { $0.name == "R2 Weekly Archive" }
        XCTAssertEqual(row?.ok, false)
        XCTAssertTrue(row?.detail?.contains("archive stale") == true)
    }

    func testServerStatusStoreLoadsViaProbe() async {
        let snapshot = ServerStatusSnapshot(
            health: .init(ok: true, status: "ok", version: "1.0.0"),
            readiness: nil,
            fetchedAt: Date()
        )
        let store = ServerStatusStore(probe: { _ in snapshot })
        let client = APIClient(configuration: .production, tokenStore: InMemoryTokenStore())

        await store.load(using: client)

        XCTAssertEqual(store.state.value, snapshot)
    }

    func testServerStatusStoreSurfacesTypedError() async {
        let store = ServerStatusStore(probe: { _ in throw APIError.offline })
        let client = APIClient(configuration: .production, tokenStore: InMemoryTokenStore())

        await store.load(using: client)

        XCTAssertEqual(store.state.error, .offline)
    }
}
