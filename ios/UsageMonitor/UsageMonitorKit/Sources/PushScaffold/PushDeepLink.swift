import Foundation
import AppCore

/// Stable string identifiers shared between category registration, local
/// notification content, and the tap-handling delegate. Keep these constant —
/// a server APNs payload must use the same `categoryIdentifier` and userInfo
/// keys for taps to route correctly.
public enum PushIdentifiers {
    /// Category attached to every budget/alert notification.
    public static let alertCategory = "USAGE_ALERT"
    /// Foreground action that opens the Alerts tab.
    public static let openAlertsAction = "OPEN_ALERTS"
    /// Prefix for locally-scheduled alert notification identifiers.
    public static let localAlertPrefix = "local.alert."
}

/// userInfo payload keys. A server push should set these top-level (alongside
/// the `aps` dictionary) so taps deep-link identically to local notifications.
public enum PushPayloadKey {
    /// Destination tab, an `AppTab` raw value (e.g. `"alerts"`, `"providers"`).
    public static let tab = "tab"
    /// Optional provider identifier for a provider-scoped deep link.
    public static let providerID = "providerId"
    /// Optional originating alert code (informational; from `ProviderAlert.code`).
    public static let alertCode = "alertCode"
}

/// A parsed, routable destination derived from a notification's userInfo.
///
/// `AppTab` is the app's deep-link vocabulary (per the architecture contract):
/// a notification tap selects a tab, optionally scoped to a provider.
public struct PushDeepLink: Equatable, Hashable, Sendable {
    public var tab: AppTab
    public var providerID: String?
    public var alertCode: String?

    public init(tab: AppTab, providerID: String? = nil, alertCode: String? = nil) {
        self.tab = tab
        self.providerID = providerID
        self.alertCode = alertCode
    }

    /// Parse a notification `userInfo` dictionary into a deep link.
    ///
    /// - An explicit `tab` key (a valid `AppTab` raw value) wins.
    /// - Otherwise, if the payload carries any recognized alert marker
    ///   (`alertCode`, or the alert category), it defaults to the Alerts tab.
    /// - Returns `nil` when nothing routable is present, so the caller can
    ///   leave the current screen untouched.
    public init?(userInfo: [AnyHashable: Any]) {
        let tabRaw = userInfo[PushPayloadKey.tab] as? String
        let alertCode = userInfo[PushPayloadKey.alertCode] as? String
        let providerID = userInfo[PushPayloadKey.providerID] as? String

        if let tabRaw, let tab = AppTab(rawValue: tabRaw) {
            self.init(tab: tab, providerID: providerID, alertCode: alertCode)
        } else if alertCode != nil {
            // Alert push without an explicit tab → Alerts.
            self.init(tab: .alerts, providerID: providerID, alertCode: alertCode)
        } else {
            return nil
        }
    }

    /// The userInfo dictionary representation, used when composing local
    /// notifications so their taps route through the same parser.
    public var userInfo: [String: String] {
        var dict = [PushPayloadKey.tab: tab.rawValue]
        if let providerID { dict[PushPayloadKey.providerID] = providerID }
        if let alertCode { dict[PushPayloadKey.alertCode] = alertCode }
        return dict
    }
}
