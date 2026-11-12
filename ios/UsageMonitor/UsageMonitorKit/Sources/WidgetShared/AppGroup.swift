import Foundation

/// Shared identifiers and container access for the app <-> widget boundary.
///
/// The app writes a compact `WidgetSnapshot` after each successful refresh;
/// the WidgetKit `TimelineProvider` reads it back. Both sides go through the
/// app-group container so the widget can render real, recently-cached data
/// even when the host app isn't running.
public enum AppGroup {
    /// Must match the `com.apple.security.application-groups` entitlement in
    /// both `UsageMonitor.entitlements` and `UsageMonitorWidget.entitlements`.
    public static let identifier = "group.com.simplewithus.usage"

    /// The shared container URL, or `nil` when the app group is not
    /// provisioned (e.g. an unsigned CI build or a SwiftUI preview). Callers
    /// must degrade gracefully rather than force-unwrap.
    public static var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier)
    }

    /// A `UserDefaults` scoped to the app group, or `.standard` as a fallback
    /// so previews and unsigned builds don't crash or trigger cfprefsd detaches.
    public static var defaults: UserDefaults {
        guard containerURL != nil, let groupDefaults = UserDefaults(suiteName: identifier) else {
            return .standard
        }
        return groupDefaults
    }
}
