import XCTest
@testable import AppCore

/// The customizable-tab-bar membership set: canonical order, 2–4 bounds,
/// persistence round-trip, and stale-value hygiene — the same contract as
/// the socratictrade.com mobile console's `mobile-tabs.ts`.
@MainActor
final class TabPreferencesTests: XCTestCase {

    private func makeDefaults() -> UserDefaults {
        UserDefaults(suiteName: "test.tabPreferences.\(UUID().uuidString)")!
    }

    func testDefaultsPinOverviewProvidersAlertsServer() {
        let prefs = TabPreferences(defaults: makeDefaults())
        XCTAssertEqual(prefs.pinned, [.dashboard, .providers, .alerts, .serverStatus])
    }

    func testTogglePersistsAndSurvivesRelaunch() {
        let defaults = makeDefaults()
        let prefs = TabPreferences(defaults: defaults)

        prefs.togglePin(.serverStatus) // unpin
        prefs.togglePin(.settings)     // pin

        XCTAssertEqual(prefs.pinned, [.dashboard, .providers, .alerts, .settings])

        // Relaunch: a fresh instance reads the same defaults.
        let relaunched = TabPreferences(defaults: defaults)
        XCTAssertEqual(relaunched.pinned, [.dashboard, .providers, .alerts, .settings])
    }

    func testCanonicalOrderIgnoresPinInsertionOrder() {
        let prefs = TabPreferences(defaults: makeDefaults())

        prefs.togglePin(.dashboard) // unpin first
        prefs.togglePin(.settings)  // pin last-canonical

        // Settings is canonical-last even though it was pinned most recently.
        XCTAssertEqual(prefs.pinned, [.providers, .alerts, .serverStatus, .settings])
    }

    func testMinimumBoundBlocksUnpinning() {
        let prefs = TabPreferences(defaults: makeDefaults())
        prefs.togglePin(.serverStatus)
        prefs.togglePin(.alerts)
        XCTAssertEqual(prefs.pinned, [.dashboard, .providers])

        XCTAssertFalse(prefs.canToggle(.dashboard))
        prefs.togglePin(.dashboard) // must be a no-op at the floor
        XCTAssertEqual(prefs.pinned, [.dashboard, .providers])
    }

    func testMaximumBoundBlocksPinning() {
        let prefs = TabPreferences(defaults: makeDefaults())
        XCTAssertEqual(prefs.pinned.count, TabPreferences.maxPinned)

        XCTAssertFalse(prefs.canToggle(.settings))
        prefs.togglePin(.settings) // must be a no-op at the ceiling
        XCTAssertEqual(prefs.pinned.count, TabPreferences.maxPinned)
        XCTAssertFalse(prefs.isPinned(.settings))
    }

    func testStaleStoredValuesAreDroppedSilently() {
        let defaults = makeDefaults()
        defaults.set(
            ["dashboard", "renamedTabThatNoLongerExists", "providers", "alerts"],
            forKey: TabPreferences.storageKey
        )

        let prefs = TabPreferences(defaults: defaults)
        XCTAssertEqual(prefs.pinned, [.dashboard, .providers, .alerts])
    }

    func testStoredSelectionBelowMinimumFallsBackToDefaults() {
        let defaults = makeDefaults()
        defaults.set(["settings"], forKey: TabPreferences.storageKey)

        let prefs = TabPreferences(defaults: defaults)
        XCTAssertEqual(prefs.pinned, TabPreferences.defaultPinned)
    }

    func testDeepLinkVocabularyIncludesServerStatus() {
        // The widget/notification deep-link vocabulary is AppTab raw values;
        // the new tab must be reachable that way too.
        XCTAssertEqual(AppTab(rawValue: "serverStatus"), .serverStatus)
        XCTAssertEqual(AppTab.serverStatus.title, "Server")
        XCTAssertTrue(AppTab.serverStatus.summary.contains("Host usage"))
    }

    func testDeepLinkVocabularyIncludesComputers() {
        XCTAssertEqual(AppTab(rawValue: "computers"), .computers)
        XCTAssertEqual(AppTab.computers.title, "Computers")
        XCTAssertFalse(TabPreferences.defaultPinned.contains(.computers))
    }

    func testMoreSheetDetentFitsEveryDestinationOnAPhone() {
        // iPhone 16 logical height is 852.  Medium (~50%) is ~426 and clips
        // Settings; the fitted detent must clear every row.
        let phone: CGFloat = 852
        let height = MoreSheetLayout.detentHeight(
            tabCount: AppTab.allCases.count,
            maxDetentValue: phone
        )
        let needed = MoreSheetLayout.chromeHeight
            + MoreSheetLayout.rowHeight * CGFloat(AppTab.allCases.count)
        XCTAssertEqual(AppTab.allCases.count, 9)
        XCTAssertEqual(height, min(needed, phone * MoreSheetLayout.maxScreenFraction))
        XCTAssertGreaterThan(height, phone * 0.5)
        XCTAssertLessThanOrEqual(height, phone * MoreSheetLayout.maxScreenFraction)
    }

    func testMoreSheetDetentCapsAtEightyEightPercent() {
        let shortPhone: CGFloat = 667
        let height = MoreSheetLayout.detentHeight(
            tabCount: AppTab.allCases.count,
            maxDetentValue: shortPhone
        )
        XCTAssertEqual(height, shortPhone * MoreSheetLayout.maxScreenFraction)
    }
}
