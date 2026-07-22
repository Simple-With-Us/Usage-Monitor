import Foundation
import UserNotifications
#if canImport(UIKit)
import UIKit
#endif
import Models

/// Public entry point for the **PushScaffold** lane: the client-side plumbing
/// for `UserNotifications` + APNs so budget/alert notifications can be
/// delivered and their taps routed to the right screen. Depends only on
/// `AppCore` + `Models`.
///
/// Scope (see ARCHITECTURE-CONTRACT.md):
///   - `requestAuthorization()` — asks for alert/badge/sound permission.
///   - `registerForRemoteNotifications()` — triggers APNs device-token
///     registration (the app forwards the token via `setAPNsDeviceToken(_:)`).
///   - `configureNotificationCategories()` — registers the alert category so a
///     tapped notification carries a routable action.
///   - `scheduleAlertNotifications(for:)` — client-side local notifications
///     built from `[ProviderAlert]`, usable *before* any server push exists.
///   - Tap routing lives in `PushRouter` + `PushNotificationDelegate`.
///
/// **Server-side APNs delivery is a documented backend follow-up.** This lane
/// sets the client up correctly (authorization, token intake, category, tap
/// routing, local fallback) but does not — and cannot — fake a push arriving
/// from a server. See the integration notes returned to the Assemble agent.
public enum PushScaffold {

    // MARK: Authorization

    /// Request notification authorization. Returns whether it was granted.
    /// Safe, no-network. Idempotent — calling again returns the current grant.
    @discardableResult
    public static func requestAuthorization(
        options: UNAuthorizationOptions = [.alert, .badge, .sound]
    ) async -> Bool {
        let center = UNUserNotificationCenter.current()
        do {
            return try await center.requestAuthorization(options: options)
        } catch {
            return false
        }
    }

    /// Current authorization status, for surfacing state in Settings.
    public static func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    // MARK: Categories

    /// Register the notification categories/actions the app understands. Call
    /// once at launch (before authorization is fine). The alert category makes
    /// a tapped alert notification route into the Alerts tab.
    public static func configureNotificationCategories() {
        let openAction = UNNotificationAction(
            identifier: PushIdentifiers.openAlertsAction,
            title: "View Alerts",
            options: [.foreground]
        )
        let alertCategory = UNNotificationCategory(
            identifier: PushIdentifiers.alertCategory,
            actions: [openAction],
            intentIdentifiers: [],
            options: [.customDismissAction]
        )
        UNUserNotificationCenter.current().setNotificationCategories([alertCategory])
    }

    // MARK: Remote (APNs) registration

    /// Trigger APNs registration. On success the system calls the app
    /// delegate's `didRegisterForRemoteNotificationsWithDeviceToken`, which
    /// must forward the token to `setAPNsDeviceToken(_:)`.
    ///
    /// No-op where UIKit is unavailable (tests / previews).
    @MainActor
    public static func registerForRemoteNotifications() {
        #if canImport(UIKit)
        UIApplication.shared.registerForRemoteNotifications()
        #endif
    }

    /// APNs device-token intake. The app forwards the raw token from
    /// `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`.
    ///
    /// This lane records the hex-encoded token on `PushRouter.shared` so the
    /// (future) backend can be handed it during device enrollment. It does
    /// **not** transmit the token anywhere — server enrollment is the
    /// documented backend follow-up.
    public static func setAPNsDeviceToken(_ token: Data) {
        let hex = deviceTokenHexString(from: token)
        Task { @MainActor in
            PushRouter.shared.deviceTokenHex = hex
        }
    }

    /// Pure, testable APNs-token → lowercase hex-string encoding (the format
    /// APNs enrollment APIs expect).
    public static func deviceTokenHexString(from token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: Local notifications (client-side fallback)

    /// Schedule immediate local notifications for the given provider alerts —
    /// a client-only path that works before any server push infrastructure
    /// exists. De-duplicates by alert identity so re-scheduling the same alert
    /// set does not spam the user. Returns the identifiers scheduled.
    ///
    /// Only alerts at or above `minimumSeverity` are surfaced; `.info` is
    /// treated as non-interruptive and skipped by default.
    /// Schedule local notifications for provider-scoped alerts. Prefer this
    /// over the bare-alert overload so titles/ids include the provider name.
    @discardableResult
    public static func scheduleAlertNotifications(
        for items: [(providerTitle: String, providerId: String, alert: ProviderAlert)],
        accountScopeID: String,
        minimumSeverity: AlertSeverity = .warning
    ) async -> [String] {
        let center = UNUserNotificationCenter.current()
        let surfaced = items.filter { $0.alert.severity.order <= minimumSeverity.order }
        guard !surfaced.isEmpty else { return [] }

        let pending = await center.pendingNotificationRequests().map(\.identifier)
        var knownIdentifiers = Set(pending)

        var scheduled: [String] = []
        for item in surfaced {
            // Include provider id so identical codes on two providers do not collide.
            let identifier = notificationIdentifier(
                accountScopeID: accountScopeID,
                providerID: item.providerId,
                alertID: item.alert.id
            )
            guard !knownIdentifiers.contains(identifier) else { continue }

            let content = UNMutableNotificationContent()
            content.title = "\(item.providerTitle): \(item.alert.title)"
            content.body = item.alert.message
            content.sound = .default
            content.categoryIdentifier = PushIdentifiers.alertCategory
            content.interruptionLevel = item.alert.severity.interruptionLevel
            content.userInfo = PushDeepLink(tab: .alerts, alertCode: item.alert.code).userInfo

            let request = UNNotificationRequest(
                identifier: identifier,
                content: content,
                trigger: nil
            )
            do {
                try await center.add(request)
                scheduled.append(identifier)
                knownIdentifiers.insert(identifier)
            } catch {
                continue
            }
        }
        return scheduled
    }

    /// Legacy bare-alert path (no provider identity) — prefer the tuple overload.
    @discardableResult
    public static func scheduleAlertNotifications(
        for alerts: [ProviderAlert],
        accountScopeID: String = "legacy",
        minimumSeverity: AlertSeverity = .warning
    ) async -> [String] {
        await scheduleAlertNotifications(
            for: alerts.map { (providerTitle: $0.title, providerId: "unknown", alert: $0) },
            accountScopeID: accountScopeID,
            minimumSeverity: minimumSeverity
        )
    }

    /// Stable request identity. Account scope is required so identical provider
    /// alert IDs from two monitor accounts never suppress each other.
    public static func notificationIdentifier(
        accountScopeID: String,
        providerID: String,
        alertID: String
    ) -> String {
        "\(PushIdentifiers.localAlertPrefix)\(accountScopeID)|\(providerID)|\(alertID)"
    }

    /// Remove notifications that belong to the account being disconnected.
    public static func removeNotifications(accountScopeID: String) async {
        let center = UNUserNotificationCenter.current()
        let prefix = "\(PushIdentifiers.localAlertPrefix)\(accountScopeID)|"
        let pending = await center.pendingNotificationRequests()
            .map(\.identifier)
            .filter { $0.hasPrefix(prefix) }
        center.removePendingNotificationRequests(withIdentifiers: pending)

        let delivered = await center.deliveredNotifications()
            .map { $0.request.identifier }
            .filter { $0.hasPrefix(prefix) }
        center.removeDeliveredNotifications(withIdentifiers: delivered)
    }

    /// Upgrade cleanup for notification identifiers created before account
    /// scoping existed. Used only when no prior active scope is recorded.
    public static func removeAllAlertNotifications() async {
        let center = UNUserNotificationCenter.current()
        let pending = await center.pendingNotificationRequests()
            .map(\.identifier)
            .filter { $0.hasPrefix(PushIdentifiers.localAlertPrefix) }
        center.removePendingNotificationRequests(withIdentifiers: pending)

        let delivered = await center.deliveredNotifications()
            .map { $0.request.identifier }
            .filter { $0.hasPrefix(PushIdentifiers.localAlertPrefix) }
        center.removeDeliveredNotifications(withIdentifiers: delivered)
    }
}

private extension AlertSeverity {
    /// Map domain severity to a notification interruption level. `.critical`
    /// uses `.timeSensitive` (falls back gracefully if the Time-Sensitive
    /// entitlement is absent).
    var interruptionLevel: UNNotificationInterruptionLevel {
        switch self {
        case .critical: return .timeSensitive
        case .warning: return .active
        case .info: return .passive
        }
    }
}
