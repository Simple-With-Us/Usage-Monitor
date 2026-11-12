import XCTest

@testable import Models

/// Wire-contract tests for the Platforms tab.
///
/// The `ServerMetrics` fixture below is a trimmed copy of a REAL
/// `GET /api/server-metrics` response captured from production on
/// 2026-08-11 — same field names, same values, same edge cases.  That matters
/// because every model in this lane decodes leniently (`try?` everywhere), so
/// a field-name drift on the server does not throw, it silently renders an
/// empty row.  These tests are the thing that catches that.
///
/// The three edge cases preserved from the live payload are deliberate:
///   1. `congress-trade` reports `"running:unknown"` — Coolify says the
///      container runs but cannot health-check it.  Neither up nor down.
///   2. Socratic.Trade's `b2-litestream` is `ok: false` with `reason:
///      "ltx_stale"` while the app overall is still `ok: true`.
///   3. Congress.Trade's `b2-litestream` is `present: false` /
///      `"not_configured"` — absent, not broken.
final class PlatformsDecodingTests: XCTestCase {

    // MARK: - ServerMetrics (real production payload)

    private let serverMetricsJSON = """
        {
          "degraded": false,
          "stale": false,
          "cacheAgeSeconds": 0,
          "configuration": { "hetzner": "configured", "coolify": "configured" },
          "host": {
            "name": "ubuntu-16gb-nbg1-cx43",
            "status": "running",
            "serverType": "cx43",
            "cpus": 8,
            "memoryTotalBytes": 17179869184,
            "location": "nbg1",
            "ip": "192.0.2.1",
            "backupWindow": "14-18"
          },
          "hostUsage": {
            "cpuPct": 43.3505005,
            "networkRxBytesPerSec": 1828418.133333,
            "networkTxBytesPerSec": 989306.5,
            "diskReadBytesPerSec": 67430946.133333,
            "diskWriteBytesPerSec": 1708032
          },
          "resources": [
            {
              "uuid": "mock-um-app-uuid",
              "name": "usage-monitor",
              "type": "application",
              "status": "running:healthy",
              "self": true,
              "fleetAppId": "usage-monitor",
              "fleetLabel": "Usage Monitor"
            },
            {
              "uuid": "mock-ct-app-uuid",
              "name": "congress-trade",
              "type": "application",
              "status": "running:unknown",
              "self": false,
              "fleetAppId": "congress-trade",
              "fleetLabel": "Congress.Trade"
            },
            {
              "uuid": "mock-st-app-uuid",
              "name": "socratic-app",
              "type": "application",
              "status": "running:healthy",
              "self": false,
              "fleetAppId": "socratic-trade",
              "fleetLabel": "Socratic.Trade"
            }
          ],
          "selfResources": [],
          "appDisk": {
            "freeBytes": 62649335808,
            "totalBytes": 160897654784,
            "usedPct": 61,
            "ok": true
          },
          "fleetBackups": {
            "configured": true,
            "ok": true,
            "asOf": "2026-08-11T19:42:01.579Z",
            "apps": [
              {
                "id": "socratic-trade",
                "label": "Socratic.Trade",
                "self": false,
                "ok": true,
                "locations": [
                  {
                    "id": "b2-full-dump",
                    "label": "B2 Full Dump",
                    "ok": true,
                    "present": true,
                    "latestAgeSeconds": 2931.705,
                    "bytes": 35306964530,
                    "fileCount": 26,
                    "reason": null
                  },
                  {
                    "id": "b2-litestream",
                    "label": "B2 Litestream",
                    "ok": false,
                    "present": true,
                    "latestAgeSeconds": 97937.107,
                    "bytes": 307638394,
                    "fileCount": 4000,
                    "reason": "ltx_stale"
                  }
                ]
              },
              {
                "id": "congress-trade",
                "label": "Congress.Trade",
                "self": false,
                "ok": true,
                "locations": [
                  {
                    "id": "b2-litestream",
                    "label": "B2 Litestream",
                    "ok": null,
                    "present": false,
                    "latestAgeSeconds": null,
                    "bytes": null,
                    "fileCount": null,
                    "reason": "not_configured"
                  }
                ]
              }
            ],
            "warnings": []
          },
          "prevention": {
            "overall": "critical",
            "summary": {
              "cpuPeakPct": 98.7881555,
              "cpuAvgPct": 52.91519174264706,
              "cpuLatestPct": 43.3505005,
              "diskUsedPct": 61,
              "appsHealthy": 2,
              "appsDown": 0,
              "appsDegraded": 0,
              "appsUnknown": 1,
              "appsTotal": 3,
              "backupAppsOk": 3,
              "backupAppsTotal": 3,
              "backupConfigured": true
            },
            "indicators": [
              {
                "id": "cpu_high",
                "severity": "critical",
                "label": "CPU High",
                "detail": "Host CPU peaked at 99% in the last hour."
              }
            ],
            "history": [],
            "historyNote": "Process-local history of recent polls."
          },
          "asOf": "2026-08-11T19:42:01.579Z",
          "warnings": []
        }
        """

    func testDecodesRealServerMetricsPayload() throws {
        let metrics = try JSONDecoder().decode(
            ServerMetrics.self, from: Data(serverMetricsJSON.utf8))

        XCTAssertFalse(metrics.degraded)
        XCTAssertEqual(metrics.host?.name, "ubuntu-16gb-nbg1-cx43")
        XCTAssertEqual(metrics.host?.cpus, 8)
        XCTAssertEqual(metrics.appDisk?.usedPct, 61)
        XCTAssertEqual(metrics.hostUsage?.cpuPct ?? 0, 43.3505005, accuracy: 0.0001)
    }

    /// All three fleet apps must survive the decode — the whole point of the
    /// tab is that it covers the fleet, not just this app.
    func testDecodesEveryFleetAppOnTheHost() throws {
        let metrics = try JSONDecoder().decode(
            ServerMetrics.self, from: Data(serverMetricsJSON.utf8))

        XCTAssertEqual(metrics.resources.count, 3)
        let fleetIDs = Set(metrics.resources.compactMap(\.fleetAppId))
        XCTAssertEqual(fleetIDs, ["usage-monitor", "congress-trade", "socratic-trade"])

        let selfApp = metrics.resources.first { $0.selfApp }
        XCTAssertEqual(selfApp?.name, "usage-monitor", "the `self` key must map to selfApp")
    }

    /// `running:unknown` is a distinct third state.  If this ever decodes as
    /// healthy, an app whose health check has stopped reporting would look
    /// fine on the dashboard — exactly the failure the tab exists to catch.
    func testUnknownHealthIsNeitherHealthyNorDown() throws {
        let metrics = try JSONDecoder().decode(
            ServerMetrics.self, from: Data(serverMetricsJSON.utf8))

        let congress = try XCTUnwrap(metrics.resources.first { $0.name == "congress-trade" })
        XCTAssertEqual(congress.status, "running:unknown")
        XCTAssertTrue(congress.status.contains("unknown"))
        XCTAssertFalse(congress.status.contains("healthy"))

        XCTAssertEqual(metrics.prevention?.summary?.appsUnknown, 1)
        XCTAssertEqual(metrics.prevention?.summary?.appsHealthy, 2)
    }

    /// A lagging off-site replica must decode as `ok: false` with its reason,
    /// even while the owning app's rollup stays `ok: true`.
    func testStaleBackupLocationKeepsItsFailureReason() throws {
        let metrics = try JSONDecoder().decode(
            ServerMetrics.self, from: Data(serverMetricsJSON.utf8))

        let socratic = try XCTUnwrap(
            metrics.fleetBackups?.apps.first { $0.id == "socratic-trade" })
        XCTAssertEqual(socratic.ok, true, "app rollup stays ok while one location lags")

        let litestream = try XCTUnwrap(
            socratic.locations.first { $0.id == "b2-litestream" })
        XCTAssertEqual(litestream.ok, false)
        XCTAssertEqual(litestream.reason, "ltx_stale")
        XCTAssertEqual(litestream.present, true)
    }

    /// "Absent" and "broken" must stay distinguishable: a not-configured
    /// location has `ok == nil`, not `ok == false`.
    func testNotConfiguredBackupLocationIsAbsentNotBroken() throws {
        let metrics = try JSONDecoder().decode(
            ServerMetrics.self, from: Data(serverMetricsJSON.utf8))

        let congress = try XCTUnwrap(
            metrics.fleetBackups?.apps.first { $0.id == "congress-trade" })
        let litestream = try XCTUnwrap(congress.locations.first { $0.id == "b2-litestream" })

        XCTAssertNil(litestream.ok)
        XCTAssertEqual(litestream.present, false)
        XCTAssertEqual(litestream.reason, "not_configured")
    }

    func testDecodesPreventionIndicators() throws {
        let metrics = try JSONDecoder().decode(
            ServerMetrics.self, from: Data(serverMetricsJSON.utf8))

        XCTAssertEqual(metrics.prevention?.overall, "critical")
        let indicator = try XCTUnwrap(metrics.prevention?.indicators.first)
        XCTAssertEqual(indicator.id, "cpu_high")
        XCTAssertEqual(indicator.severity, "critical")
        XCTAssertEqual(indicator.label, "CPU High")
    }

    // MARK: - PlatformStatusPayload

    private let platformStatusJSON = """
        {
          "platforms": [
            {
              "id": "hetzner",
              "name": "Hetzner Cloud",
              "category": "hosting",
              "configured": true,
              "state": "healthy",
              "headline": "ubuntu-16gb-nbg1-cx43 is running.  Automatic backups are on.",
              "metrics": [
                { "label": "Server Type", "value": "cx43" },
                { "label": "Location", "value": "nbg1", "hint": "Nuremberg" }
              ],
              "requiredEnv": ["HCLOUD_TOKEN", "HETZNER_SERVER_ID"],
              "consoleUrl": "https://console.hetzner.cloud/",
              "fetchedAt": "2026-08-11T20:00:00.000Z"
            },
            {
              "id": "coolify",
              "name": "Coolify",
              "category": "hosting",
              "configured": true,
              "state": "degraded",
              "headline": "2 of 3 applications are healthy.  congress-trade reports unknown health.",
              "metrics": [{ "label": "Applications", "value": "3" }],
              "requiredEnv": ["COOLIFY_SERVER_STATS"],
              "consoleUrl": "https://host.jays.services",
              "fetchedAt": "2026-08-11T20:00:00.000Z",
              "error": null
            },
            {
              "id": "netlify",
              "name": "Netlify",
              "category": "hosting",
              "configured": false,
              "state": "unconfigured",
              "headline": null,
              "metrics": [],
              "requiredEnv": ["NETLIFY_API_TOKEN"],
              "consoleUrl": "https://app.netlify.com/",
              "fetchedAt": "2026-08-11T20:00:00.000Z"
            },
            {
              "id": "sentry",
              "name": "Sentry",
              "category": "observability",
              "configured": true,
              "state": "unreachable",
              "headline": "Sentry did not respond.",
              "metrics": [],
              "requiredEnv": ["SENTRY_READ_TOKEN"],
              "consoleUrl": "https://sentry.io/",
              "fetchedAt": "2026-08-11T20:00:00.000Z",
              "error": "timeout"
            },
            {
              "id": "future-platform",
              "name": "Something New",
              "category": "quantum-mesh",
              "configured": true,
              "state": "brand-new-state",
              "headline": "Added by a newer server.",
              "metrics": [],
              "requiredEnv": ["NEW_TOKEN"],
              "consoleUrl": null,
              "fetchedAt": "2026-08-11T20:00:00.000Z"
            }
          ],
          "summary": {
            "total": 5, "configured": 4, "healthy": 1, "degraded": 3, "unconfigured": 1
          },
          "degraded": true,
          "stale": false,
          "cacheAgeSeconds": 12,
          "fetchedAt": "2026-08-11T20:00:00.000Z"
        }
        """

    func testDecodesPlatformStatusPayload() throws {
        let payload = try JSONDecoder().decode(
            PlatformStatusPayload.self, from: Data(platformStatusJSON.utf8))

        XCTAssertEqual(payload.platforms.count, 5)
        XCTAssertTrue(payload.degraded)
        XCTAssertEqual(payload.summary?.configured, 4)
        XCTAssertEqual(payload.cacheAgeSeconds, 12)

        let hetzner = try XCTUnwrap(payload.platforms.first { $0.id == "hetzner" })
        XCTAssertEqual(hetzner.category, .hosting)
        XCTAssertEqual(hetzner.state, .healthy)
        XCTAssertEqual(hetzner.metrics.count, 2)
        XCTAssertEqual(hetzner.metrics.last?.hint, "Nuremberg")
        XCTAssertNil(hetzner.metrics.last?.usagePct)
    }

    /// An unconfigured platform is not an outage: no headline, no metrics, and
    /// it must still name the env var that would switch it on.
    func testUnconfiguredPlatformCarriesItsEnvVarAndNoAlarm() throws {
        let payload = try JSONDecoder().decode(
            PlatformStatusPayload.self, from: Data(platformStatusJSON.utf8))

        let netlify = try XCTUnwrap(payload.platforms.first { $0.id == "netlify" })
        XCTAssertFalse(netlify.configured)
        XCTAssertEqual(netlify.state, .unconfigured)
        XCTAssertNil(netlify.headline)
        XCTAssertTrue(netlify.metrics.isEmpty)
        XCTAssertEqual(netlify.requiredEnv, ["NETLIFY_API_TOKEN"])
        XCTAssertFalse(netlify.state.needsAttention, "missing config is not an incident")
    }

    func testPlatformMetricDecodesUsagePctForTheFillBar() throws {
        let json = """
            {
              "label": "Socratic Trade",
              "value": "4.1 GB / 10 GB Free Tier",
              "usagePct": 41
            }
            """
        let metric = try JSONDecoder().decode(
            PlatformStatusPayload.Metric.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(metric.value, "4.1 GB / 10 GB Free Tier")
        XCTAssertEqual(metric.usagePct ?? 0, 41, accuracy: 0.001)
        XCTAssertNil(metric.hint)
    }

    /// Unknown category / state values from a newer server must fall back
    /// rather than throwing and blanking the whole screen.
    func testUnknownCategoryAndStateFallBackInsteadOfThrowing() throws {
        let payload = try JSONDecoder().decode(
            PlatformStatusPayload.self, from: Data(platformStatusJSON.utf8))

        let future = try XCTUnwrap(payload.platforms.first { $0.id == "future-platform" })
        XCTAssertEqual(future.category, .other)
        XCTAssertEqual(future.state, .unconfigured)
    }

    func testAttentionPlatformsExcludeUnconfiguredOnes() throws {
        let payload = try JSONDecoder().decode(
            PlatformStatusPayload.self, from: Data(platformStatusJSON.utf8))

        let attention = payload.attentionPlatforms.map(\.id)
        XCTAssertTrue(attention.contains("coolify"))
        XCTAssertTrue(attention.contains("sentry"))
        XCTAssertFalse(attention.contains("netlify"), "unconfigured is never attention")
        XCTAssertFalse(attention.contains("hetzner"))
    }

    /// Grouping preserves the server's ordering so web and iOS agree.
    func testGroupingPreservesServerOrder() throws {
        let payload = try JSONDecoder().decode(
            PlatformStatusPayload.self, from: Data(platformStatusJSON.utf8))

        let categories = payload.groupedByCategory.map(\.category)
        XCTAssertEqual(categories, [.hosting, .observability, .other])
        XCTAssertEqual(payload.groupedByCategory.first?.platforms.count, 3)
    }

    // MARK: - OperationsHealth

    func testDecodesOperationsHealthAndR2FleetShape() throws {
        let json = """
            {
              "receiptInbox": {
                "configured": true, "state": "receiving", "needsReviewCount": 2,
                "countIsLowerBound": false, "latestReceivedAt": "2026-08-11T18:00:00.000Z"
              },
              "socraticInfrastructure": {
                "state": "healthy", "releaseSha": "9506fe49aa11", "processUptimeSeconds": 3840,
                "recentRestart": false, "database": "ok", "schedulerStale": false,
                "storageDegraded": false, "litestreamState": "ok", "litestreamAgeSeconds": 25
              },
              "congressInfrastructure": {
                "state": "healthy", "releaseSha": "abcdef123456", "recentRestart": false,
                "database": "ok"
              },
              "coolifyFleet": {
                "configured": true, "state": "healthy",
                "applications": [
                  { "name": "congress-trade", "type": "application", "status": "running:unknown",
                    "health": "unknown", "up": true, "degraded": false,
                    "fqdn": "https://congress.trade" }
                ],
                "appsUp": 3, "appsDown": 0, "appsDegraded": 0, "appsUnknown": 1
              },
              "r2Fleet": {
                "configured": true,
                "anyOnTrackToExceed": false,
                "accounts": [
                  { "id": "um", "label": "Usage Monitor", "configured": true, "status": "ok",
                    "storage": { "actual": 429496729, "limit": 10737418240, "mtdPct": 4.0,
                                 "projected": 500000000, "projectedPct": 4.7,
                                 "onTrackToExceed": false },
                    "overallOnTrackToExceed70Pct": false,
                    "metricsSource": "cloudflare_graphql" },
                  { "id": "old", "label": "Jay (Old)", "configured": true, "status": "ok",
                    "storage": null, "overallOnTrackToExceed70Pct": false,
                    "metricsSource": "r2_not_enabled" }
                ],
                "fetchedAt": "2026-08-11T20:00:00.000Z"
              },
              "fetchedAt": "2026-08-11T20:00:00.000Z"
            }
            """

        let health = try JSONDecoder().decode(OperationsHealth.self, from: Data(json.utf8))

        XCTAssertEqual(health.receiptInbox?.state, .receiving)
        XCTAssertEqual(health.receiptInbox?.needsReviewCount, 2)
        XCTAssertEqual(health.socraticInfrastructure?.state, .healthy)
        XCTAssertEqual(health.congressInfrastructure?.state, .healthy)
        XCTAssertEqual(health.congressInfrastructure?.releaseSha, "abcdef123456")
        XCTAssertEqual(health.coolifyFleet?.appsUnknown, 1)

        // The R2 account shape must match r2-usage.ts exactly or the section
        // silently renders nothing.
        let account = try XCTUnwrap(health.r2Fleet?.accounts.first)
        XCTAssertEqual(account.id, "um")
        XCTAssertEqual(account.label, "Usage Monitor")
        XCTAssertEqual(account.storage?.mtdPct ?? 0, 4.0, accuracy: 0.001)
        XCTAssertFalse(account.overallOnTrackToExceed70Pct)
        XCTAssertEqual(account.metricsSource, "cloudflare_graphql")
        let old = try XCTUnwrap(health.r2Fleet?.accounts.first { $0.id == "old" })
        XCTAssertEqual(old.metricsSource, "r2_not_enabled")
        XCTAssertNil(old.storage)
    }

    /// The Coolify resource helper must recognise the live "running but health
    /// unknown" condition.
    func testCoolifyResourceFlagsUnknownHealth() throws {
        let json = """
            { "name": "congress-trade", "status": "running:unknown", "health": "unknown",
              "up": true, "degraded": false }
            """
        let resource = try JSONDecoder().decode(
            OperationsHealth.CoolifyFleet.Resource.self, from: Data(json.utf8))

        XCTAssertTrue(resource.healthUnknown)
    }
}
