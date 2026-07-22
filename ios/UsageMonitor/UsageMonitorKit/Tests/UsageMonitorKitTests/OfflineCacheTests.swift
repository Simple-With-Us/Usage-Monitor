import XCTest
@testable import OfflineCache
@testable import AppCore
@testable import Networking
import Models
import WidgetShared

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
        let values = try cache.cacheFileURL.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)

        #if os(iOS)
        XCTAssertEqual(
            attributes[.protectionKey] as? FileProtectionType,
            .completeUntilFirstUserAuthentication
        )
        #endif
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

        try Data("not-json".utf8).write(to: fileURL)
        XCTAssertNil(store.read())
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))

        store.write(.placeholder)
        try Data(count: 2 * 1_024 * 1_024).write(to: fileURL)
        XCTAssertNil(store.read())
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
    }

    func testWidgetStoreRejectsObsoleteSchema() throws {
        let dir = tempDirectory()
        defer { remove(dir) }
        let store = SharedStore(
            containerURL: dir,
            defaults: isolatedDefaults("widget-schema")
        )
        store.write(.placeholder)
        let fileURL = try XCTUnwrap(store.snapshotFileURL)
        var json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: fileURL)) as? [String: Any]
        )
        json["schemaVersion"] = 1
        try JSONSerialization.data(withJSONObject: json).write(to: fileURL, options: .atomic)

        XCTAssertNil(store.read())
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
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
        let values = try fileURL.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)

        #if os(iOS)
        XCTAssertEqual(
            attributes[.protectionKey] as? FileProtectionType,
            .completeUntilFirstUserAuthentication
        )
        #endif
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
        XCTAssertTrue(staleness.staleLabel(asOf: now).hasPrefix("Stale as of "))
        XCTAssertTrue(staleness.shortLabel(asOf: now).hasPrefix("Stale · "))
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
    func loadCached() async -> BudgetStatusResponse? { nil }
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
    func loadCached() async -> BudgetStatusResponse? { nil }
    func clear() async {}
}
