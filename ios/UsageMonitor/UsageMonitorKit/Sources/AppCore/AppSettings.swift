import SwiftUI
import Observation

/// User-facing appearance preference, persisted and applied app-wide.
public enum AppTheme: String, CaseIterable, Sendable, Identifiable {
    case system
    case light
    case dark

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    /// The SwiftUI color scheme to force, or `nil` to follow the system.
    public var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

/// App-wide preferences that outlive a launch. Backed by `UserDefaults`
/// (non-sensitive settings only — the API token lives in the Keychain via
/// `Networking.KeychainTokenStore`). Observable so views react to changes.
@MainActor
@Observable
public final class AppSettings {
    private let defaults: UserDefaults
    private let sharedDefaults: UserDefaults?
    private enum Key {
        static let theme = "settings.appearance"
        static let host = "settings.baseHost"
        static let appLockEnabled = "settings.appLockEnabled"
    }

    public var theme: AppTheme {
        didSet { defaults.set(theme.rawValue, forKey: Key.theme) }
    }

    /// Optional base-host override (e.g. a staging deployment). Empty means the
    /// production default. Stored as text; the app maps it to an
    /// `APIConfiguration` when constructing the client.
    public var baseHost: String {
        didSet { defaults.set(baseHost, forKey: Key.host) }
    }

    /// Whether the AppLock integration should require authentication on launch.
    /// AppCore only stores the flag; the AppLock target reads/enforces it.
    public var appLockEnabled: Bool {
        didSet {
            defaults.set(appLockEnabled, forKey: Key.appLockEnabled)
            mirrorAppLockToSharedDefaults()
        }
    }

    public init(defaults: UserDefaults = .standard, sharedDefaults: UserDefaults? = nil) {
        self.defaults = defaults
        self.sharedDefaults = sharedDefaults
        // Owner 2026-08-10: light is the product default (not system/OS dark).
        self.theme = AppTheme(rawValue: defaults.string(forKey: Key.theme) ?? "") ?? .light
        self.baseHost = defaults.string(forKey: Key.host) ?? ""
        self.appLockEnabled = defaults.bool(forKey: Key.appLockEnabled)
        // didSet does not fire during init assignment — mirror explicitly.
        mirrorAppLockToSharedDefaults()
    }

    /// Push lock preference into the widget-readable suite (no-op if unset).
    public func mirrorAppLockToSharedDefaults() {
        sharedDefaults?.set(appLockEnabled, forKey: Key.appLockEnabled)
    }
}
