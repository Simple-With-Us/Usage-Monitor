import XCTest
@testable import Models
@testable import AppCore
@testable import Alerts

/// Alerts-lane tests: the resolved-alert diff (the feature's core non-trivial
/// logic, since the backend payload has no "resolved" concept) plus severity
/// filtering and counting. Pure value logic — no UI, no network.
final class AlertsResolutionTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_780_000_000)

    private func item(provider: String, code: String, severity: AlertSeverity, message: String) -> ProviderAlertItem {
        ProviderAlertItem(
            provider: ProviderBudgetStatus(id: provider, name: provider, displayName: provider.capitalized),
            alert: ProviderAlert(code: code, severity: severity, message: message)
        )
    }

    // MARK: - Reconciler

    func testFirstLoadRecordsNoResolutions() {
        let active = [item(provider: "openai", code: "budget_warning", severity: .warning, message: "80%")]
        let result = AlertResolutionReconciler.reconcile(
            activeItems: active, previousActive: [], existingResolved: [], now: now
        )
        XCTAssertTrue(result.resolved.isEmpty)
        XCTAssertEqual(result.trackedActive.count, 1)
        XCTAssertEqual(result.trackedActive.first?.id, active.first?.id)
    }

    func testDisappearedAlertBecomesResolved() {
        let previous = [
            TrackedActiveAlert(providerId: "openai", providerTitle: "OpenAI", code: "budget_warning", severity: .warning, message: "80%"),
            TrackedActiveAlert(providerId: "anthropic", providerTitle: "Anthropic", code: "budget_exceeded", severity: .critical, message: "over"),
        ]
        // Anthropic still active; OpenAI cleared.
        let active = [item(provider: "anthropic", code: "budget_exceeded", severity: .critical, message: "over")]

        let result = AlertResolutionReconciler.reconcile(
            activeItems: active, previousActive: previous, existingResolved: [], now: now
        )

        XCTAssertEqual(result.resolved.count, 1)
        let resolved = try? XCTUnwrap(result.resolved.first)
        XCTAssertEqual(resolved?.providerId, "openai")
        XCTAssertEqual(resolved?.code, "budget_warning")
        XCTAssertEqual(resolved?.resolvedAt, now)
        XCTAssertEqual(result.trackedActive.count, 1)
        XCTAssertEqual(result.trackedActive.first?.providerId, "anthropic")
    }

    func testRefiredAlertLeavesResolvedList() {
        let existingResolved = [
            ResolvedAlert(providerId: "openai", providerTitle: "OpenAI", code: "budget_warning", severity: .warning, message: "80%", resolvedAt: now.addingTimeInterval(-3600)),
        ]
        // Same alert is active again.
        let active = [item(provider: "openai", code: "budget_warning", severity: .warning, message: "80%")]

        let result = AlertResolutionReconciler.reconcile(
            activeItems: active, previousActive: [], existingResolved: existingResolved, now: now
        )

        XCTAssertTrue(result.resolved.isEmpty, "A re-fired alert must leave the resolved list")
        XCTAssertEqual(result.trackedActive.count, 1)
    }

    func testResolvedEntriesArePrunedByAge() {
        let old = ResolvedAlert(providerId: "p", providerTitle: "P", code: "stale_snapshot", severity: .info, message: "old", resolvedAt: now.addingTimeInterval(-8 * 24 * 3600))
        let recent = ResolvedAlert(providerId: "q", providerTitle: "Q", code: "stale_snapshot", severity: .info, message: "recent", resolvedAt: now.addingTimeInterval(-1 * 24 * 3600))

        let result = AlertResolutionReconciler.reconcile(
            activeItems: [], previousActive: [], existingResolved: [old, recent], now: now,
            maxAge: 7 * 24 * 3600
        )

        XCTAssertEqual(result.resolved.map(\.id), [recent.id])
    }

    func testResolvedListIsCappedNewestFirst() {
        let existing = (0..<40).map { i in
            ResolvedAlert(providerId: "p\(i)", providerTitle: "P", code: "c", severity: .info, message: "m\(i)", resolvedAt: now.addingTimeInterval(-Double(i) * 60))
        }
        let result = AlertResolutionReconciler.reconcile(
            activeItems: [], previousActive: [], existingResolved: existing, now: now, maxCount: 30
        )
        XCTAssertEqual(result.resolved.count, 30)
        // Newest (smallest offset) first, oldest dropped.
        XCTAssertEqual(result.resolved.first?.message, "m0")
        XCTAssertEqual(result.resolved.last?.message, "m29")
    }

    func testNoFalseResolutionWhenSetUnchanged() {
        let previous = [TrackedActiveAlert(providerId: "openai", providerTitle: "OpenAI", code: "budget_warning", severity: .warning, message: "80%")]
        let active = [item(provider: "openai", code: "budget_warning", severity: .warning, message: "80%")]
        let result = AlertResolutionReconciler.reconcile(
            activeItems: active, previousActive: previous, existingResolved: [], now: now
        )
        XCTAssertTrue(result.resolved.isEmpty)
    }

    // MARK: - Tracker persistence

    @MainActor
    func testTrackerPersistsAcrossInstances() {
        let suite = "test.alerts.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        let first = ResolvedAlertTracker(defaults: defaults)
        first.reconcile(
            activeItems: [item(provider: "openai", code: "budget_warning", severity: .warning, message: "80%")],
            now: now
        )
        // Same alert gone next load → it should resolve and persist.
        first.reconcile(activeItems: [], now: now.addingTimeInterval(60))
        XCTAssertEqual(first.resolved.count, 1)

        let reloaded = ResolvedAlertTracker(defaults: defaults)
        XCTAssertEqual(reloaded.resolved.count, 1)
        XCTAssertEqual(reloaded.resolved.first?.providerId, "openai")
    }

    @MainActor
    func testTrackerKeepsAccountHistoriesIsolated() {
        let suite = "test.alerts.scoped.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        let tracker = ResolvedAlertTracker(defaults: defaults, accountScopeID: "account-a")
        tracker.reconcile(
            activeItems: [item(provider: "openai", code: "budget_warning", severity: .warning, message: "80%")],
            now: now
        )
        tracker.reconcile(activeItems: [], now: now.addingTimeInterval(60))
        XCTAssertEqual(tracker.resolved.count, 1)

        tracker.useAccountScope("account-b")
        XCTAssertTrue(tracker.resolved.isEmpty)

        tracker.useAccountScope("account-a")
        XCTAssertEqual(tracker.resolved.count, 1)
    }

    // MARK: - Filtering & counting

    @MainActor
    func testSeverityFilterMatching() {
        XCTAssertTrue(AlertSeverityFilter.all.matches(.info))
        XCTAssertTrue(AlertSeverityFilter.critical.matches(.critical))
        XCTAssertFalse(AlertSeverityFilter.critical.matches(.warning))
    }

    @MainActor
    func testModelFilteredAndCounts() {
        let model = AlertsModel(tracker: ResolvedAlertTracker(defaults: UserDefaults(suiteName: "t.\(UUID().uuidString)")!))
        let items = [
            item(provider: "a", code: "budget_exceeded", severity: .critical, message: "x"),
            item(provider: "b", code: "budget_warning", severity: .warning, message: "y"),
            item(provider: "c", code: "billing_sync_incomplete", severity: .info, message: "z"),
            item(provider: "d", code: "budget_warning", severity: .warning, message: "w"),
        ]
        let counts = model.counts(items)
        XCTAssertEqual(counts[.warning], 2)
        XCTAssertEqual(counts[.critical], 1)

        model.filter = .warning
        XCTAssertEqual(model.filtered(items).count, 2)
        model.filter = .all
        XCTAssertEqual(model.filtered(items).count, 4)
    }
}
