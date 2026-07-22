import Foundation
import CryptoKit
import Models
import Networking

/// Turns freshly-fetched provider alerts into local notifications — the piece
/// that finally connects the background refresh to the user's Lock Screen, so a
/// budget monitor actually tells you when you cross a threshold while you're not
/// looking at the app.
///
/// It sits on top of ``PushScaffold/scheduleAlertNotifications(for:minimumSeverity:)``
/// and adds the three things a real delivery loop needs:
///   1. **Gating** — respects the user's "Budget alerts" master toggle and their
///      minimum-severity choice, and only fires when notifications are actually
///      authorized.
///   2. **De-duplication across runs** — remembers which alerts it has already
///      notified about (persisted), so a background refresh every couple of
///      hours doesn't re-post the same "over budget on Anthropic" every time.
///      An alert that clears and later re-triggers *will* notify again.
///
/// Preferences live in `UserDefaults.standard` (shared within the app process,
/// readable from the background refresh task and writable from the Settings UI)
/// rather than the `@MainActor` `AppSettings`, so the background task can read
/// them without hopping actors or constructing app state.
public enum AlertNotifier {
    private static let enabledKey = "notifications.budgetAlertsEnabled"
    private static let minSeverityKey = "notifications.minimumSeverity"
    private static let deliveredKey = "notifications.deliveredAlertIDs.v2"
    private static let activeScopeKey = "notifications.activeAccountScopeID.v2"

    private static var defaults: UserDefaults { .standard }

    // MARK: Preferences

    /// Whether budget-alert notifications are enabled. Defaults to `false` so
    /// the first notification prompt always follows an explicit, contextual opt-in.
    public static var isEnabled: Bool {
        get { defaults.object(forKey: enabledKey) as? Bool ?? false }
        set { defaults.set(newValue, forKey: enabledKey) }
    }

    /// Lowest severity that should produce a notification. Defaults to `.warning`
    /// (info-level signals are non-interruptive and never notify).
    public static var minimumSeverity: AlertSeverity {
        get { AlertSeverity(rawValue: defaults.string(forKey: minSeverityKey) ?? "") ?? .warning }
        set { defaults.set(newValue.rawValue, forKey: minSeverityKey) }
    }

    // MARK: Delivery

    /// Deliver notifications for any newly-appeared **provider-scoped** alerts.
    @discardableResult
    public static func deliver(
        for items: [(providerTitle: String, providerId: String, alert: ProviderAlert)],
        accountScopeID: String? = nil
    ) async -> [String] {
        guard isEnabled else { return [] }
        guard let accountScopeID = accountScopeID ?? currentAccountScopeID() else { return [] }
        await activateAccountScope(accountScopeID)

        let status = await PushScaffold.authorizationStatus()
        guard status == .authorized || status == .provisional else { return [] }

        let minimum = minimumSeverity
        let surfaced = items.filter { $0.alert.severity.order <= minimum.order }
        // Provider-scoped identity so two providers with the same alert code
        // do not suppress each other.
        let surfacedIDs = Set(surfaced.map { "\($0.providerId)|\($0.alert.id)" })

        let historyKey = scopedHistoryKey(accountScopeID)
        let previouslyDelivered = Set(defaults.stringArray(forKey: historyKey) ?? [])
        let fresh = surfaced.filter {
            !previouslyDelivered.contains("\($0.providerId)|\($0.alert.id)")
        }

        guard !fresh.isEmpty else {
            defaults.set(
                Array(nextDeliveryHistory(
                    previous: previouslyDelivered,
                    surfaced: surfacedIDs,
                    successfullyScheduled: []
                )).sorted(),
                forKey: historyKey
            )
            return []
        }
        let scheduled = await PushScaffold.scheduleAlertNotifications(
            for: fresh,
            accountScopeID: accountScopeID,
            minimumSeverity: minimum
        )
        let scheduledSet = Set(scheduled)
        let successfullyDelivered = Set(fresh.compactMap { item -> String? in
            let requestID = PushScaffold.notificationIdentifier(
                accountScopeID: accountScopeID,
                providerID: item.providerId,
                alertID: item.alert.id
            )
            guard scheduledSet.contains(requestID) else { return nil }
            return "\(item.providerId)|\(item.alert.id)"
        })
        defaults.set(
            Array(nextDeliveryHistory(
                previous: previouslyDelivered,
                surfaced: surfacedIDs,
                successfullyScheduled: successfullyDelivered
            )).sorted(),
            forKey: historyKey
        )
        return scheduled
    }

    /// Flat-alert convenience (no provider identity) — prefer the tuple overload.
    @discardableResult
    public static func deliver(
        for alerts: [ProviderAlert],
        accountScopeID: String = "legacy"
    ) async -> [String] {
        await deliver(for: alerts.map {
            (providerTitle: $0.title, providerId: "unknown", alert: $0)
        }, accountScopeID: accountScopeID)
    }

    /// Testing/reset hook: forget the delivered-alert history.
    public static func resetDeliveryHistory(accountScopeID: String = "legacy") {
        defaults.removeObject(forKey: scopedHistoryKey(accountScopeID))
    }

    public static func accountDidChange(from oldScopeID: String?) async {
        guard let oldScopeID else { return }
        await PushScaffold.removeNotifications(accountScopeID: oldScopeID)
    }

    /// Opaque host+credential identity. Only the SHA-256 digest is persisted or
    /// used in notification IDs; the bearer token never leaves Keychain-backed
    /// memory and is never logged.
    public static func currentAccountScopeID(hostOverride: String? = nil) -> String? {
        let tokenStore = KeychainTokenStore()
        guard let token = tokenStore.token()?.trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty
        else { return nil }
        let rawHost = hostOverride
            ?? UserDefaults.standard.string(forKey: "settings.baseHost")
            ?? ""
        let configuration = APIConfiguration.fromUserInput(rawHost) ?? .production
        let input = "\(configuration.baseURL.absoluteString)|\(token)"
        return SHA256.hash(data: Data(input.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    /// Track the active account and remove pending/delivered notifications for
    /// the previous one. Dedupe history remains scoped so switching back is
    /// safe and does not manufacture a re-trigger.
    public static func activateAccountScope(_ scopeID: String?) async {
        let previous = defaults.string(forKey: activeScopeKey)
        guard previous != scopeID else { return }
        defaults.set(scopeID, forKey: activeScopeKey)
        if let previous {
            await accountDidChange(from: previous)
        } else if scopeID != nil {
            // First activation after upgrading from the unscoped v1 scheme:
            // remove requests whose identifiers cannot be assigned safely.
            await PushScaffold.removeAllAlertNotifications()
        }
    }

    private static func scopedHistoryKey(_ accountScopeID: String) -> String {
        "\(deliveredKey).\(accountScopeID)"
    }

    /// Pure state transition used by delivery and regression tests. Cleared
    /// alerts are forgotten so they can notify if they later re-fire; failed
    /// schedules are not recorded, so a transient notification-center error is
    /// retried on the next refresh.
    static func nextDeliveryHistory(
        previous: Set<String>,
        surfaced: Set<String>,
        successfullyScheduled: Set<String>
    ) -> Set<String> {
        previous.intersection(surfaced).union(successfullyScheduled)
    }
}
