import XCTest
import Models
import Networking
@testable import UsageMonitor

/// Placeholder host-app test bundle. The bulk of logic is tested in the
/// `UsageMonitorKit` SPM test target (fast, no simulator host). Keep a smoke
/// test here so the app scheme's Test action is wired end to end; feature lanes
/// that need a hosted (UI/integration) test add files alongside this one.
final class AppSmokeTests: XCTestCase {
    func testFixturesAreAvailable() {
        XCTAssertFalse(BudgetStatusResponse.sample.providers.isEmpty)
    }

    func testTokenStorePostsMetadataFreeAccountChangeSignal() throws {
        let center = NotificationCenter()
        let store = AccountChangeNotifyingTokenStore(
            underlying: InMemoryTokenStore(),
            notificationCenter: center
        )
        var receivedNotification: Notification?
        let observer = center.addObserver(
            forName: .usageMonitorAccountDidChange,
            object: nil,
            queue: nil
        ) { notification in
            receivedNotification = notification
        }
        defer { center.removeObserver(observer) }

        try store.setToken("test-token")

        XCTAssertEqual(store.token(), "test-token")
        XCTAssertNotNil(receivedNotification)
        XCTAssertNil(receivedNotification?.object)
        XCTAssertNil(receivedNotification?.userInfo)
    }
}
