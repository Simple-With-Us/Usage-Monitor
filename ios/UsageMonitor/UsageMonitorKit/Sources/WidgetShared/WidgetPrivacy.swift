import Foundation

/// App-group privacy flags the widget extension can read without launching the host app.
public enum WidgetPrivacy {
    public static let appLockEnabledKey = "settings.appLockEnabled"
    public static let redactedAmount = "••••"
    public static let lockedLabel = "Locked"

    public static func setAppLockEnabled(_ enabled: Bool, defaults: UserDefaults = AppGroup.defaults) {
        defaults.set(enabled, forKey: appLockEnabledKey)
    }

    public static func isAppLockEnabled(defaults: UserDefaults = AppGroup.defaults) -> Bool {
        guard defaults.object(forKey: appLockEnabledKey) != nil else { return false }
        return defaults.bool(forKey: appLockEnabledKey)
    }
}
