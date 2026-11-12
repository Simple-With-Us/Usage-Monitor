import Foundation
import Observation

/// Persisted, user-customizable tab-bar selection — the iOS twin of the
/// socratictrade.com mobile console's pinned bottom tabs (`mobile-tabs.ts`):
/// a **membership set** of pinned destinations rendered in canonical
/// (`AppTab.allCases`) order, bounded to 2–4 pins, with everything else always
/// reachable through the permanent **More** slot.
///
/// Persistence rules match the web console:
///  - stored by stable raw value, not display label (renames are safe);
///  - unknown/stale raw values (a tab renamed or removed since the value was
///    saved) are dropped silently rather than surfaced as an error;
///  - a stored selection that falls below the minimum is discarded in favor
///    of the defaults.
@MainActor
@Observable
public final class TabPreferences {
    public static let minPinned = 2
    public static let maxPinned = 4

    /// Owner-decided default pins: Overview, Providers, Alerts, Server.
    /// Computers, Platforms, Projects, and Settings start under More.
    public static let defaultPinned: [AppTab] = [.dashboard, .providers, .alerts, .serverStatus]

    /// Versioned like the web console's `console.mobileTabs.v1`.
    static let storageKey = "app.tabBar.pinned.v1"

    /// Pinned tabs in canonical order. Membership set semantics: order is
    /// derived from `AppTab.allCases`, never from insertion order.
    public private(set) var pinned: [AppTab]

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.pinned = Self.read(from: defaults)
    }

    public func isPinned(_ tab: AppTab) -> Bool {
        pinned.contains(tab)
    }

    /// True if this tab could be pinned/unpinned right now (i.e. the action
    /// would not violate the min/max bound). Drives the pin control's
    /// disabled state.
    public func canToggle(_ tab: AppTab) -> Bool {
        isPinned(tab) ? pinned.count > Self.minPinned : pinned.count < Self.maxPinned
    }

    public func togglePin(_ tab: AppTab) {
        var membership = Set(pinned)
        if membership.contains(tab) {
            guard pinned.count > Self.minPinned else { return }
            membership.remove(tab)
        } else {
            guard pinned.count < Self.maxPinned else { return }
            membership.insert(tab)
        }
        pinned = AppTab.allCases.filter { membership.contains($0) }
        write()
    }

    private func write() {
        defaults.set(pinned.map(\.rawValue), forKey: Self.storageKey)
    }

    private static func read(from defaults: UserDefaults) -> [AppTab] {
        guard let raw = defaults.stringArray(forKey: storageKey) else {
            return defaultPinned
        }
        let stored = Set(raw.compactMap(AppTab.init(rawValue:)))
        let cleaned = AppTab.allCases.filter { stored.contains($0) }
        guard cleaned.count >= minPinned else { return defaultPinned }
        return Array(cleaned.prefix(maxPinned))
    }
}
