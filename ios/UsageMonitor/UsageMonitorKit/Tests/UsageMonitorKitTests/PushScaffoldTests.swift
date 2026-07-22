import XCTest
@testable import Models
@testable import AppCore
@testable import PushScaffold

/// PushScaffold-lane tests: the two pieces of pure, testable logic in the lane
/// — APNs token hex encoding and notification `userInfo` ⇄ `PushDeepLink`
/// routing — plus the router's pending-link lifecycle. No UI, no network,
/// no live notification center.
final class PushScaffoldTests: XCTestCase {

    // MARK: - Device token encoding

    func testDeviceTokenHexEncoding() {
        let token = Data([0x00, 0x0f, 0xa1, 0xff])
        XCTAssertEqual(PushScaffold.deviceTokenHexString(from: token), "000fa1ff")
    }

    func testEmptyDeviceTokenEncodesEmpty() {
        XCTAssertEqual(PushScaffold.deviceTokenHexString(from: Data()), "")
    }

    func testNotificationIdentityIsAccountScoped() {
        let first = PushScaffold.notificationIdentifier(
            accountScopeID: "account-a",
            providerID: "openai",
            alertID: "budget_warning"
        )
        let second = PushScaffold.notificationIdentifier(
            accountScopeID: "account-b",
            providerID: "openai",
            alertID: "budget_warning"
        )
        XCTAssertNotEqual(first, second)
        XCTAssertTrue(first.contains("account-a|openai|budget_warning"))
    }

    func testDeliveryHistoryForgetsClearedAndDoesNotRecordFailedSchedules() {
        let next = AlertNotifier.nextDeliveryHistory(
            previous: ["openai|warning", "anthropic|critical"],
            surfaced: ["openai|warning", "mistral|warning", "xai|warning"],
            successfullyScheduled: ["mistral|warning"]
        )
        XCTAssertEqual(next, ["openai|warning", "mistral|warning"])
        XCTAssertFalse(next.contains("xai|warning"), "failed schedules must remain retryable")
        XCTAssertFalse(next.contains("anthropic|critical"), "cleared alerts must be re-notifiable")
    }

    // MARK: - Deep-link parsing

    func testExplicitTabWins() {
        let link = PushDeepLink(userInfo: [
            PushPayloadKey.tab: "providers",
            PushPayloadKey.providerID: "openai",
            PushPayloadKey.alertCode: "budget_exceeded"
        ])
        XCTAssertEqual(link?.tab, .providers)
        XCTAssertEqual(link?.providerID, "openai")
        XCTAssertEqual(link?.alertCode, "budget_exceeded")
    }

    func testAlertCodeWithoutTabDefaultsToAlerts() {
        let link = PushDeepLink(userInfo: [PushPayloadKey.alertCode: "budget_warning"])
        XCTAssertEqual(link?.tab, .alerts)
        XCTAssertEqual(link?.alertCode, "budget_warning")
    }

    func testUnknownTabWithAlertCodeFallsBackToAlerts() {
        let link = PushDeepLink(userInfo: [
            PushPayloadKey.tab: "not_a_tab",
            PushPayloadKey.alertCode: "stale_snapshot"
        ])
        XCTAssertEqual(link?.tab, .alerts)
    }

    func testUnroutablePayloadReturnsNil() {
        XCTAssertNil(PushDeepLink(userInfo: ["unrelated": "value"]))
        XCTAssertNil(PushDeepLink(userInfo: [:]))
        // Unknown tab and no alert marker → nothing routable.
        XCTAssertNil(PushDeepLink(userInfo: [PushPayloadKey.tab: "not_a_tab"]))
    }

    func testUserInfoRoundTrip() {
        let original = PushDeepLink(tab: .providers, providerID: "anthropic", alertCode: "balance_low")
        let parsed = PushDeepLink(userInfo: original.userInfo)
        XCTAssertEqual(parsed, original)
    }

    func testUserInfoOmitsNilFields() {
        let link = PushDeepLink(tab: .alerts)
        XCTAssertEqual(link.userInfo, [PushPayloadKey.tab: "alerts"])
    }

    // MARK: - Router lifecycle

    @MainActor
    func testRouterHandleAndConsume() {
        let router = PushRouter()
        XCTAssertNil(router.pendingLink)
        XCTAssertEqual(router.launchTab, .dashboard)

        router.handle(PushDeepLink(tab: .alerts, alertCode: "budget_exceeded"))
        XCTAssertEqual(router.pendingLink?.tab, .alerts)
        XCTAssertEqual(router.launchTab, .alerts)

        // Newest link wins.
        router.handle(PushDeepLink(tab: .providers, providerID: "openai"))
        XCTAssertEqual(router.pendingLink?.tab, .providers)
        XCTAssertEqual(router.launchTab, .providers)

        router.consume()
        XCTAssertNil(router.pendingLink)
        XCTAssertEqual(router.launchTab, .dashboard)
    }
}
