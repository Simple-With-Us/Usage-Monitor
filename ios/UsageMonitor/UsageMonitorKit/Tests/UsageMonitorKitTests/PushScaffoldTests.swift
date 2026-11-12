import XCTest
@testable import Models
@testable import AppCore
@testable import PushScaffold

/// PushScaffold-lane tests: the pure, testable logic in the lane — local
/// notification identity and notification `userInfo` ⇄ `PushDeepLink` routing —
/// plus the router's pending-link lifecycle, plus a guard that the app does not
/// claim remote-push capability it cannot use. No UI, no network, no live
/// notification center.
final class PushScaffoldTests: XCTestCase {

    // MARK: - Local notification identity

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

    // MARK: - No unbacked remote-push capability

    /// The app target directory, resolved from this file's own location so the
    /// check does not depend on a bundle, a simulator, or the wall clock.
    /// `Tests/UsageMonitorKitTests/<file>` → up 4 → `ios/UsageMonitor`.
    private static var appTargetDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // UsageMonitorKitTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // UsageMonitorKit
            .deletingLastPathComponent()  // UsageMonitor
            .appendingPathComponent("App/Resources")
    }

    private func plist(named name: String) throws -> [String: Any] {
        let url = Self.appTargetDirectory.appendingPathComponent(name)
        let data = try Data(contentsOf: url)
        let parsed = try PropertyListSerialization.propertyList(from: data, format: nil)
        return try XCTUnwrap(parsed as? [String: Any], "\(name) is not a plist dictionary")
    }

    /// Device enrollment shipped in #928: Settings registers for remote
    /// notifications and uploads the token to `POST /api/apns/device-tokens`,
    /// so the app now legitimately claims `aps-environment`. The checked-in
    /// value stays `development` — App Store submission rewrites it to
    /// `production` for distribution builds, so a hardcoded `production` here
    /// would be the regression to catch.
    ///
    /// Alert pushes are visible notifications (not silent), so
    /// ``testBackgroundModesDeclareFetchOnly`` keeps `remote-notification` out
    /// of `UIBackgroundModes`. Background fetch still drives local fallback.
    func testAppEntitlementsMatchShippedPushCapability() throws {
        let entitlements = try plist(named: "UsageMonitor.entitlements")
        XCTAssertEqual(entitlements["aps-environment"] as? String, "development")
        // The app-group entitlement the widget shares must survive.
        let groups = entitlements["com.apple.security.application-groups"] as? [String]
        XCTAssertEqual(groups, ["group.com.simplewithus.usage"])
    }

    /// `remote-notification` background mode is only legitimate with a server
    /// pushing silent notifications. `fetch` must remain — BGTaskScheduler
    /// drives the local alert delivery that actually ships.
    func testBackgroundModesDeclareFetchOnly() throws {
        let info = try plist(named: "Info.plist")
        let modes = try XCTUnwrap(info["UIBackgroundModes"] as? [String])
        XCTAssertEqual(modes, ["fetch"])
    }
}
