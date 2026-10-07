import XCTest
@testable import OfflineCache
@testable import AppCore
@testable import Networking
import Models
@testable import WidgetShared

/// OfflineCache lane tests: disk round-trip (with timestamp + legacy fallback),
/// the "stale as of <time>" indicator logic, and the widget snapshot derivation.
///
/// NOTE: requires the `UsageMonitorKitTests` target to depend on `OfflineCache`
/// and `WidgetShared` (see integration notes) — the foundation manifest wires
/// only Models/Networking/AppCore/DesignSystem by default.
final class OfflineCacheTests: XCTestCase {

    private func tempDirectory() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("offlinecache-tests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func remove(_ directory: URL) {
        try? FileManager.default.removeItem(at: directory)
    }

    /// Asserts a cache file carries `completeUntilFirstUserAuthentication`
    /// Data Protection.
    ///
    /// The Simulator does not implement Data Protection: `setAttributes`
    /// accepts `.protectionKey` (the `.posixPermissions` written in the *same*
    /// call, and the backup exclusion written right after it, both land), but
    /// `attributesOfItem` always reads the protection back as `nil`. So the
    /// real assertion can only run on a device — it is kept intact there, and
    /// the Simulator branch pins the known no-op so this fails loudly if the
    /// platform ever starts reporting protection instead of silently passing.
    private func assertProtectedUntilFirstUnlock(
        _ attributes: [FileAttributeKey: Any],
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        #if os(iOS)
        let protection = attributes[.protectionKey] as? FileProtectionType
        #if targetEnvironment(simulator)
        XCTAssertNil(
            protection,
            """
            The Simulator now reports Data Protection — delete this branch so \
            the device assertion runs everywhere.
            """,
            file: file,
            line: line
        )
        #else
        XCTAssertEqual(
            protection,
            .completeUntilFirstUserAuthentication,
            file: file,
            line: line
        )
        #endif
        #endif
    }

    // MARK: - Disk cache round-trip

    func testSaveThenLoadRoundTripsResponse() {
        let dir = tempDirectory()
        defer { remove(dir) }
        let cache = BudgetDiskCache(directory: dir, scopeIdentifier: "account-a")

        XCTAssertNil(cache.load(), "empty directory should have no cache")

        cache.save(.sample)

        let loaded = cache.load()
        XCTAssertEqual(loaded?.month, BudgetStatusResponse.sample.month)
        XCTAssertEqual(loaded?.providers.count, BudgetStatusResponse.sample.providers.count)
    }

    func testSaveStampsCachedAtCloseToNow() throws {
        let dir = tempDirectory()
        defer { remove(dir) }
        let cache = BudgetDiskCache(directory: dir, scopeIdentifier: "account-a")
        let before = Date()

        cache.save(.sample)

        let cachedAt = try XCTUnwrap(cache.loadEntry()?.cachedAt)
        XCTAssertGreaterThanOrEqual(cachedAt.timeIntervalSince1970, before.timeIntervalSince1970 - 1)
        XCTAssertLessThanOrEqual(cachedAt.timeIntervalSince1970, Date().timeIntervalSince1970 + 1)
    }

    func testSaveEntryPreservesExplicitCachedAt() {
        let dir = tempDirectory()
        defer { remove(dir) }
        let cache = BudgetDiskCache(directory: dir, scopeIdentifier: "account-a")
        let stamp = Date(timeIntervalSince1970: 1_700_000_000)

        cache.saveEntry(CachedBudget(response: .sample, cachedAt: stamp))

        XCTAssertEqual(cache.loadEntry()?.cachedAt, stamp)
    }

    func testClearRemovesCache() {
        let dir = tempDirectory()
        defer { remove(dir) }
        let cache = BudgetDiskCache(directory: dir, scopeIdentifier: "account-a")
        cache.save(.sample)
        XCTAssertNotNil(cache.load())

        cache.clear()
        XCTAssertNil(cache.load())
    }

    /// An unscoped legacy file cannot be tied to the current account, so the v2
    /// cache intentionally drops it during the security migration.
    func testLegacyBareResponseIsRemovedWithoutLoading() throws {
        let dir = tempDirectory()
        defer { remove(dir) }
        let fileURL = dir.appendingPathComponent("budget-status-cache.json")
        let legacyData = try JSONEncoder().encode(BudgetStatusResponse.sample)
        try legacyData.write(to: fileURL)

        let cache = BudgetDiskCache(directory: dir, scopeIdentifier: "account-a")

        XCTAssertNil(cache.loadEntry())
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
    }

    func testDifferentIdentityCannotReadAndRemovesPriorScope() {
        let dir = tempDirectory()
        defer { remove(dir) }
        let first = BudgetDiskCache(directory: dir, scopeIdentifier: "account-a")
        first.save(.sample)
        let firstFile = first.cacheFileURL
        XCTAssertTrue(FileManager.default.fileExists(atPath: firstFile.path))

        let second = BudgetDiskCache(directory: dir, scopeIdentifier: "account-b")

        XCTAssertNil(second.load())
        XCTAssertFalse(FileManager.default.fileExists(atPath: firstFile.path))
    }

    func testLiveScopeSeparatesHostsAndAuthenticationModesWithoutExposingToken() {
        let production = URL(string: "https://usage.jays.services")!
        let staging = URL(string: "https://staging.example.com")!

        let sessionScope = BudgetDiskCache.scopeIdentifier(baseURL: production, bearerToken: nil)
        let bearerScope = BudgetDiskCache.scopeIdentifier(
            baseURL: production,
            bearerToken: "super-secret-token"
        )
        let stagingSessionScope = BudgetDiskCache.scopeIdentifier(baseURL: staging, bearerToken: nil)

        XCTAssertNotEqual(sessionScope, bearerScope)
        XCTAssertNotEqual(sessionScope, stagingSessionScope)
        XCTAssertFalse(bearerScope.contains("super-secret-token"))
    }

    func testEnvelopeCopiedAcrossIdentityScopeIsRejected() throws {
        let dir = tempDirectory()
        defer { remove(dir) }
        let first = BudgetDiskCache(directory: dir, scopeIdentifier: "account-a")
        first.save(.sample)
        let copiedData = try Data(contentsOf: first.cacheFileURL)

        let second = BudgetDiskCache(directory: dir, scopeIdentifier: "account-b")
        try FileManager.default.createDirectory(
            at: second.cacheFileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try copiedData.write(to: second.cacheFileURL)

        XCTAssertNil(second.load())
        XCTAssertFalse(FileManager.default.fileExists(atPath: second.cacheFileURL.path))
    }

    func testOversizedCacheIsRejectedAndRemoved() throws {
        let dir = tempDirectory()
        defer { remove(dir) }
        let cache = BudgetDiskCache(directory: dir, scopeIdentifier: "account-a")
        cache.save(.sample)
        try Data(count: 11 * 1_024 * 1_024).write(to: cache.cacheFileURL)

        XCTAssertNil(cache.load())
        XCTAssertFalse(FileManager.default.fileExists(atPath: cache.cacheFileURL.path))
    }

    func testCacheUsesPrivatePermissionsAndIsExcludedFromBackup() throws {
        let dir = tempDirectory()
        defer { remove(dir) }
        let cache = BudgetDiskCache(directory: dir, scopeIdentifier: "account-a")
        cache.save(.sample)

        let attributes = try FileManager.default.attributesOfItem(atPath: cache.cacheFileURL.path)
        let permissions = try XCTUnwrap(attributes[.posixPermissions] as? NSNumber)
        XCTAssertEqual(permissions.intValue & 0o777, 0o600)
        let values = try cache.cacheFileURL.resourceValues(
            forKeys: [URLResourceKey.isExcludedFromBackupKey]
        )
        XCTAssertEqual(values.isExcludedFromBackup, true)

        assertProtectedUntilFirstUnlock(attributes)
    }

    func testClearRemovesEveryScopeAndLegacyFile() throws {
        let dir = tempDirectory()
        defer { remove(dir) }
        let cache = BudgetDiskCache(directory: dir, scopeIdentifier: "account-a")
        cache.save(.sample)
        let legacyURL = dir.appendingPathComponent("budget-status-cache.json")
        try Data("legacy".utf8).write(to: legacyURL)
        let obsoleteScope = cache.cacheNamespaceURL.appendingPathComponent("obsolete", isDirectory: true)
        try FileManager.default.createDirectory(at: obsoleteScope, withIntermediateDirectories: true)

        cache.clear()

        XCTAssertFalse(FileManager.default.fileExists(atPath: cache.cacheNamespaceURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyURL.path))
    }

    func testPathTraversalFileNameFallsBackInsideCacheNamespace() {
        let dir = tempDirectory()
        defer { remove(dir) }
        let cache = BudgetDiskCache(
            directory: dir,
            fileName: "../outside.json",
            scopeIdentifier: "account-a"
        )
        cache.save(.sample)

        XCTAssertEqual(cache.cacheFileURL.lastPathComponent, "budget-status-cache.json")
        XCTAssertTrue(cache.cacheFileURL.path.hasPrefix(cache.cacheNamespaceURL.path + "/"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("outside.json").path))
    }

    // MARK: - Protected widget snapshot store

    func testWidgetStoreRoundTripsVersionedSnapshot() throws {
        let dir = tempDirectory()
        defer { remove(dir) }
        let defaults = isolatedDefaults("widget-roundtrip")
        let store = SharedStore(containerURL: dir, defaults: defaults)

        store.write(.placeholder)

        XCTAssertEqual(store.read(), .placeholder)
        let fileURL = try XCTUnwrap(store.snapshotFileURL)
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: fileURL)) as? [String: Any]
        )
        XCTAssertEqual(json["schemaVersion"] as? Int, 2)
    }

    func testWidgetStoreDropsUnscopedLegacySnapshot() throws {
        let dir = tempDirectory()
        defer { remove(dir) }
        let defaults = isolatedDefaults("widget-legacy")
        let store = SharedStore(containerURL: dir, defaults: defaults)
        let legacyURL = try XCTUnwrap(store.legacySnapshotFileURL)
        try JSONEncoder().encode(WidgetSnapshot.placeholder).write(to: legacyURL)
        defaults.set(Data("legacy".utf8), forKey: "widget-snapshot")

        XCTAssertNil(store.read())
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertNil(defaults.data(forKey: "widget-snapshot"))
    }

    func testWidgetStoreRejectsCorruptAndOversizedFiles() throws {
        let dir = tempDirectory()
        defer { remove(dir) }
        let defaults = isolatedDefaults("widget-invalid")
        let store = SharedStore(containerURL: dir, defaults: defaults)
        store.write(.placeholder)
        let fileURL = try XCTUnwrap(store.snapshotFileURL)

        // Corrupt file falls back to defaults and cleans up corrupt file
        try Data("not-json".utf8).write(to: fileURL)
        XCTAssertEqual(store.read(), .placeholder)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))

        // When defaults is also cleared, corrupt file read yields nil
        defaults.removeObject(forKey: "widget-snapshot-v2")
        try Data("not-json".utf8).write(to: fileURL)
        XCTAssertNil(store.read())
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))

        // Oversized file falls back to defaults and removes file
        store.write(.placeholder)
        try Data(count: 2 * 1_024 * 1_024).write(to: fileURL)
        XCTAssertEqual(store.read(), .placeholder)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
    }

    func testWidgetStoreRejectsObsoleteSchema() throws {
        let dir = tempDirectory()
        defer { remove(dir) }
        let defaults = isolatedDefaults("widget-schema")
        let store = SharedStore(
            containerURL: dir,
            defaults: defaults
        )
        store.write(.placeholder)
        let fileURL = try XCTUnwrap(store.snapshotFileURL)
        var json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: fileURL)) as? [String: Any]
        )
        json["schemaVersion"] = 1
        try JSONSerialization.data(withJSONObject: json).write(to: fileURL, options: .atomic)

        // Obsolete file schema falls back to defaults and deletes obsolete file
        XCTAssertEqual(store.read(), .placeholder)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))

        // When defaults is also cleared, returns nil
        defaults.removeObject(forKey: "widget-snapshot-v2")
        XCTAssertNil(store.read())
    }

    func testWidgetStoreUsesPrivatePermissionsAndNoBackup() throws {
        let dir = tempDirectory()
        defer { remove(dir) }
        let store = SharedStore(
            containerURL: dir,
            defaults: isolatedDefaults("widget-protection")
        )
        store.write(.placeholder)
        let fileURL = try XCTUnwrap(store.snapshotFileURL)
        let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let permissions = try XCTUnwrap(attributes[.posixPermissions] as? NSNumber)
        XCTAssertEqual(permissions.intValue & 0o777, 0o600)
        let values = try fileURL.resourceValues(
            forKeys: [URLResourceKey.isExcludedFromBackupKey]
        )
        XCTAssertEqual(values.isExcludedFromBackup, true)

        assertProtectedUntilFirstUnlock(attributes)
    }

    func testWidgetStoreFallbackRoundTripAndClear() {
        let defaults = isolatedDefaults("widget-fallback")
        let store = SharedStore(containerURL: nil, defaults: defaults)

        store.write(.placeholder)
        XCTAssertEqual(store.read(), .placeholder)

        store.clear()
        XCTAssertNil(store.read())
    }

    func testWidgetStoreClearRemovesProtectedAndLegacyData() throws {
        let dir = tempDirectory()
        defer { remove(dir) }
        let defaults = isolatedDefaults("widget-clear")
        let store = SharedStore(containerURL: dir, defaults: defaults)
        store.write(.placeholder)
        let fileURL = try XCTUnwrap(store.snapshotFileURL)
        let legacyURL = try XCTUnwrap(store.legacySnapshotFileURL)
        try Data("legacy".utf8).write(to: legacyURL)

        store.clear()

        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacyURL.path))
        XCTAssertNil(store.read())
    }

    private func isolatedDefaults(_ suffix: String) -> UserDefaults {
        let suite = "test.offline-cache.\(suffix).\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    // MARK: - Staleness indicator

    func testFreshEntryIsNotStale() {
        let staleness = BudgetStaleness(cachedAt: Date(), threshold: 15 * 60)
        XCTAssertFalse(staleness.isStale())
        XCTAssertTrue(staleness.shortLabel().hasPrefix("Updated"))
    }

    func testOldEntryIsStaleWithLabel() {
        let now = Date()
        let cachedAt = now.addingTimeInterval(-30 * 60) // 30 min old
        let staleness = BudgetStaleness(cachedAt: cachedAt, threshold: 15 * 60)

        XCTAssertTrue(staleness.isStale(asOf: now))
        XCTAssertEqual(staleness.age(asOf: now), 30 * 60, accuracy: 1)
        XCTAssertTrue(staleness.staleLabel(asOf: now).hasPrefix("Updated"))
        XCTAssertTrue(staleness.shortLabel(asOf: now).hasPrefix("Updated"))
        XCTAssertTrue(staleness.isStale(asOf: now))
    }

    func testThresholdBoundaryIsStale() {
        let now = Date()
        let staleness = BudgetStaleness(cachedAt: now.addingTimeInterval(-900), threshold: 900)
        XCTAssertTrue(staleness.isStale(asOf: now))
    }

    // MARK: - Widget snapshot derivation

    func testSnapshotKeepsHighestUtilisationBudgetedMeters() {
        let snapshot = WidgetSnapshotBuilder.snapshot(from: .sample, maxMeters: 2)

        XCTAssertLessThanOrEqual(snapshot.topMeters.count, 2)
        // Meters are sorted most-utilised first.
        let percents = snapshot.topMeters.map { $0.percentUsed ?? 0 }
        XCTAssertEqual(percents, percents.sorted(by: >))
        XCTAssertEqual(snapshot.month, BudgetStatusResponse.sample.month)
    }

    func testSnapshotIncludesProjectsForWidgetFocusPicker() {
        let snapshot = WidgetSnapshotBuilder.snapshot(from: .sample, maxMeters: 3)
        XCTAssertEqual(snapshot.projects.count, ProjectBudgetStatus.sampleList.count)
        XCTAssertTrue(snapshot.projects.contains { $0.id == ProjectBudgetStatus.sampleTrade.id })
        // Project rows carry projected EOM for the project-focused widget hero.
        XCTAssertNotNil(snapshot.projects.first?.projectedEomUsd)
    }

    func testSnapshotDecodeOmitsProjectsDefaultsEmpty() throws {
        // Older app-group payloads without `projects` must still load.
        let legacy = WidgetSnapshot(
            generatedAt: Date(timeIntervalSince1970: 1),
            month: "2026-08",
            totalSpentUsd: 10,
            totalBudgetUsd: 100,
            projectedEomUsd: 20,
            percentUsed: 0.1,
            overBudget: false,
            warning: false,
            topMeters: []
            // projects defaults to []
        )
        let data = try JSONEncoder().encode(legacy)
        let decoded = try JSONDecoder().decode(WidgetSnapshot.self, from: data)
        XCTAssertEqual(decoded.projects, [])
        XCTAssertNil(decoded.llm)
        XCTAssertNil(decoded.servers)
    }

    func testSnapshotDecodeBudgetOnlyJSONLeavesLlmAndServersMissing() throws {
        let json = """
        {
          "generatedAt": 1,
          "month": "2026-08",
          "totalSpentUsd": 10,
          "totalBudgetUsd": 100,
          "projectedEomUsd": 20,
          "overBudget": false,
          "warning": false,
          "topMeters": []
        }
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(WidgetSnapshot.self, from: json)
        XCTAssertEqual(decoded.projects, [])
        XCTAssertNil(decoded.llm)
        XCTAssertNil(decoded.servers)
        XCTAssertNil(decoded.mac)
        XCTAssertNil(decoded.alerts)
        XCTAssertEqual(decoded.spenders, [])
        XCTAssertEqual(decoded.totalSpentUsd, 10)
    }

    func testSnapshotRoundTripsLlmAndServerSections() throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let data = try encoder.encode(WidgetSnapshot.placeholder)
        let decoded = try decoder.decode(WidgetSnapshot.self, from: data)
        XCTAssertEqual(decoded.llm?.providers.count, 3)
        XCTAssertEqual(decoded.llm?.providers.first?.estimateUsd, 8.40)
        XCTAssertEqual(decoded.servers?.service?.name, "usage-monitor")
        XCTAssertEqual(decoded.servers?.apps.count, 3)
        XCTAssertEqual(decoded.mac?.hostname, "jays-macbook-pro")
        XCTAssertEqual(decoded.alerts?.openCount, 2)
        XCTAssertEqual(decoded.spenders.count, 3)
        XCTAssertEqual(decoded, .placeholder)
    }

    func testLlmSectionMapsKitFieldsAndKeepsMissingCostNil() {
        let section = WidgetSnapshotBuilder.llmSection(from: .sample)
        XCTAssertEqual(section?.windowHours, 5)
        XCTAssertEqual(section?.providers.count, 2)
        let anthropic = section?.providers.first { $0.id == "anthropic" }
        XCTAssertEqual(anthropic?.tokensTotal, 184_200)
        XCTAssertEqual(anthropic?.estimateUsd, 8.40)
        XCTAssertEqual(anthropic?.budgetStatus, "watch")
        XCTAssertEqual(anthropic?.quiet, false)
        let voyage = section?.providers.first { $0.id == "voyage" }
        XCTAssertEqual(voyage?.quiet, true)
        XCTAssertNil(voyage?.estimateUsd)
        XCTAssertNil(voyage?.derivedCostUsd)
        XCTAssertNil(voyage?.reportedCostUsd)
    }

    func testLlmSectionNilWhenResponseNotOk() {
        let failed = LlmBurnResponse(ok: false, providers: [])
        XCTAssertNil(WidgetSnapshotBuilder.llmSection(from: failed))
    }

    func testServerServiceMapsHealthAndReadinessChecks() {
        let service = WidgetSnapshotBuilder.serverService(
            health: .sample,
            readiness: .sample,
            now: Date(timeIntervalSince1970: 1_720_000_000)
        )
        XCTAssertEqual(service.name, "usage-monitor")
        XCTAssertTrue(service.ok)
        XCTAssertEqual(service.readyOk, true)
        XCTAssertEqual(service.uptimeSeconds, 84_213)
        XCTAssertTrue(service.checks.contains { $0.name == "Database" && $0.ok })
        XCTAssertTrue(service.checks.contains { $0.name == "Disk" && $0.freeBytes != nil })
    }

    func testServerHostOmitsMissingCpuAndKeepsServerCounts() {
        let projected = WidgetSnapshotBuilder.serverHost(from: .sample)
        XCTAssertEqual(projected.host.cpuPct, 18.5)
        XCTAssertEqual(projected.host.name, "ubuntu-16gb-nbg1-cx43")
        XCTAssertEqual(projected.apps.count, 3)
        XCTAssertTrue(projected.apps.contains { $0.selfApp && $0.id == "um" })

        var bare = ServerMetrics()
        bare.host = .init(name: "only-name")
        let missing = WidgetSnapshotBuilder.serverHost(from: bare)
        XCTAssertNil(missing.host.cpuPct)
        XCTAssertNil(missing.host.diskUsedPct)
        XCTAssertEqual(missing.host.name, "only-name")
        XCTAssertTrue(missing.apps.isEmpty)
    }

    func testBudgetSnapshotMergeKeepsLlmServerAndMacSections() {
        let budget = WidgetSnapshotBuilder.snapshot(from: .sample)
        XCTAssertNil(budget.llm)
        XCTAssertNil(budget.servers)
        XCTAssertNil(budget.mac)
        XCTAssertNotNil(budget.alerts)
        XCTAssertFalse(budget.spenders.isEmpty)
        let merged = budget.mergingPreservedSections(from: .placeholder)
        XCTAssertEqual(merged.totalSpentUsd, budget.totalSpentUsd)
        XCTAssertEqual(merged.llm, WidgetSnapshot.placeholder.llm)
        XCTAssertEqual(merged.servers, WidgetSnapshot.placeholder.servers)
        XCTAssertEqual(merged.mac, WidgetSnapshot.placeholder.mac)
        XCTAssertEqual(merged.alerts?.openCount, budget.alerts?.openCount)
    }

    func testSpendersAreHighestMonthToDateSpendIncludingUnbudgeted() {
        let spenders = WidgetSnapshotBuilder.spenders(from: .sample)
        XCTAssertEqual(spenders.map(\.name), ["Anthropic", "OpenRouter", "OpenAI", "Voyage AI"])
        XCTAssertEqual(try XCTUnwrap(spenders.first?.spentUsd), 212.40, accuracy: 0.001)
        XCTAssertEqual(spenders.last?.name, "Voyage AI")
        XCTAssertNil(spenders.last?.budgetUsd)
    }

    func testAlertsSectionUsesKitTitlesAndSeverityOrder() {
        let section = WidgetSnapshotBuilder.alertsSection(from: .sample)
        XCTAssertEqual(section.openCount, 3)
        XCTAssertEqual(section.needsAttentionCount, 2)
        XCTAssertEqual(section.latestTitle, "Budget exceeded")
        XCTAssertEqual(section.latestProvider, "OpenRouter")
        XCTAssertEqual(section.latestSeverity, "critical")
        XCTAssertEqual(section.items.map(\.title), [
            "Budget exceeded",
            "Approaching budget",
            "Billing sync incomplete",
        ])
    }

    func testAlertsSectionAllClearWhenNoAlerts() {
        let section = WidgetSnapshotBuilder.alertsSection(from: .sampleEmpty)
        XCTAssertEqual(section.openCount, 0)
        XCTAssertEqual(section.needsAttentionCount, 0)
        XCTAssertNil(section.latestTitle)
        XCTAssertTrue(section.items.isEmpty)
    }

    func testMacSectionMapsHeartbeatAndDoesNotInventPercents() {
        let online = MacHealthResponse(
            ok: true,
            status: "online",
            lastHeartbeatAt: "2026-08-16T12:00:00.000Z",
            secondsSinceHeartbeat: 12,
            mac: MacHostTelemetry(
                hostname: "jays-macbook-pro",
                osVersion: "macOS 26.0",
                arch: "arm64",
                cpuUsagePct: 24,
                memoryUsagePct: 61,
                diskUsagePct: 47,
                uptimeSeconds: 100,
                processes: ["com.jay.agy-acp": "running", "com.jay.z-last": "stopped"],
                lastHeartbeatAt: "2026-08-16T12:00:00.000Z"
            )
        )
        let section = WidgetSnapshotBuilder.macSection(from: online)
        XCTAssertTrue(section.reported)
        XCTAssertEqual(section.hostname, "jays-macbook-pro")
        XCTAssertEqual(section.cpuUsagePct, 24.0)
        XCTAssertTrue(section.flags.contains("z-last is stopped."))

        let offline = MacHealthResponse(ok: false, status: "offline")
        let missing = WidgetSnapshotBuilder.macSection(from: offline)
        XCTAssertFalse(missing.reported)
        XCTAssertNil(missing.cpuUsagePct)
        XCTAssertEqual(missing.status, "offline")
        XCTAssertTrue(missing.flags.contains("Heartbeat stale — Mac looks offline."))

        let sampleSection = WidgetSnapshotBuilder.macSection(from: .sample)
        XCTAssertEqual(sampleSection.arch, "Apple M5")
    }
}

@MainActor
final class BudgetCacheIdentityBoundaryTests: XCTestCase {
    func testBearerTokenChangeQueuesPersistedCacheClear() async throws {
        let defaults = UserDefaults(suiteName: "test.cache-token.\(UUID().uuidString)")!
        let sink = RecordingBudgetSink()
        let tokenStore = InMemoryTokenStore(token: "account-a")
        let environment = AppEnvironment(
            settings: AppSettings(defaults: defaults),
            tokenStore: tokenStore,
            snapshotSink: sink
        )

        let revision = environment.accessIdentityRevision
        try environment.setToken("account-b")
        await environment.budgetStore.drainCacheOperations()
        let clearCount = await sink.clearCount()

        XCTAssertEqual(clearCount, 1)
        XCTAssertEqual(environment.accessIdentityRevision, revision &+ 1)
    }

    func testEquivalentBearerTokenDoesNotClearCache() async throws {
        let defaults = UserDefaults(suiteName: "test.cache-token-same.\(UUID().uuidString)")!
        let sink = RecordingBudgetSink()
        let environment = AppEnvironment(
            settings: AppSettings(defaults: defaults),
            tokenStore: InMemoryTokenStore(token: "account-a"),
            snapshotSink: sink
        )

        let revision = environment.accessIdentityRevision
        try environment.setToken("  account-a  ")
        await environment.budgetStore.drainCacheOperations()
        let clearCount = await sink.clearCount()

        XCTAssertEqual(clearCount, 0)
        XCTAssertEqual(environment.accessIdentityRevision, revision)
    }

    func testHostChangeQueuesPersistedCacheClear() async {
        let defaults = UserDefaults(suiteName: "test.cache-host.\(UUID().uuidString)")!
        let sink = RecordingBudgetSink()
        let environment = AppEnvironment(
            settings: AppSettings(defaults: defaults),
            tokenStore: InMemoryTokenStore(token: "account-a"),
            snapshotSink: sink
        )

        let revision = environment.accessIdentityRevision
        environment.reconfigure(host: "staging.example.com")
        await environment.budgetStore.drainCacheOperations()
        let clearCount = await sink.clearCount()

        XCTAssertEqual(clearCount, 1)
        XCTAssertNil(environment.budgetStore.response)
        XCTAssertEqual(environment.accessIdentityRevision, revision &+ 1)
    }

    func testHostChangeClearsPriorHostDashboardSessionCookie() {
        let priorHost = "prior-\(UUID().uuidString.lowercased()).example.test"
        let nextHost = "next-\(UUID().uuidString.lowercased()).example.test"
        let priorURL = URL(string: "https://\(priorHost)")!
        let cookieStorage = HTTPCookieStorage.shared
        let cookie = HTTPCookie(properties: [
            .domain: priorHost,
            .path: "/",
            .name: "dashboard_session",
            .value: "prior-session",
            .secure: "TRUE",
            .expires: Date().addingTimeInterval(3_600),
        ])!
        cookieStorage.setCookie(cookie)
        defer {
            APIClient.clearDashboardSessionCookies(
                for: priorURL,
                cookieStorage: cookieStorage
            )
        }

        let defaults = UserDefaults(suiteName: "test.cache-host-session.\(UUID().uuidString)")!
        let settings = AppSettings(defaults: defaults)
        settings.baseHost = priorHost
        let environment = AppEnvironment(
            settings: settings,
            tokenStore: InMemoryTokenStore()
        )
        XCTAssertNotNil(
            cookieStorage.cookies(for: priorURL)?.first { $0.name == "dashboard_session" }
        )

        environment.reconfigure(host: nextHost)

        XCTAssertNil(
            cookieStorage.cookies(for: priorURL)?.first { $0.name == "dashboard_session" }
        )
    }

    func testTokenChangeSynchronouslyInvalidatesBeforeSetterReturns() throws {
        let defaults = UserDefaults(suiteName: "test.cache-sync.\(UUID().uuidString)")!
        let sink = ImmediateInvalidationSink()
        let environment = AppEnvironment(
            settings: AppSettings(defaults: defaults),
            tokenStore: InMemoryTokenStore(token: "account-a"),
            snapshotSink: sink
        )

        try environment.setToken("account-b")

        XCTAssertEqual(sink.invalidationCount, 1)
    }
}

private actor RecordingBudgetSink: BudgetSnapshotSink {
    private var clears = 0

    func store(_ response: BudgetStatusResponse) async {}
    func loadCached() async -> CachedBudgetSnapshot? { nil }
    func clear() async { clears += 1 }
    func clearCount() -> Int { clears }
}

private final class ImmediateInvalidationSink: BudgetSnapshotSink, @unchecked Sendable {
    private let lock = NSLock()
    private var invalidations = 0

    var invalidationCount: Int {
        lock.lock(); defer { lock.unlock() }
        return invalidations
    }

    func invalidate() {
        lock.lock(); defer { lock.unlock() }
        invalidations += 1
    }

    func store(_ response: BudgetStatusResponse) async {}
    func loadCached() async -> CachedBudgetSnapshot? { nil }
    func clear() async {}
}
