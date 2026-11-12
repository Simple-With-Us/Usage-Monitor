import Foundation
import Observation
import UserNotifications
import AppCore

/// Observable owner of push state + the pending deep-link destination.
///
/// The app injects the shared instance into the SwiftUI environment and reacts
/// to `pendingLink`: at cold launch it seeds `RootView(initialTab:)`; while
/// running, a view observing this object switches tabs when a new link arrives.
/// The app calls `consume()` once it has honored the link.
///
/// A single shared instance (`.shared`) exists so the `UNUserNotificationCenter`
/// delegate — which the system may invoke before the SwiftUI graph is built —
/// has a stable target.
@MainActor
@Observable
public final class PushRouter {
    /// Process-wide shared router. The app should inject this exact instance.
    public static let shared = PushRouter()

    /// The most recent unrouted deep link, or `nil` when nothing is pending.
    public private(set) var pendingLink: PushDeepLink?

    /// Retained notification-center delegate (the center holds it weakly).
    private var delegate: PushNotificationDelegate?

    public init() {}

    /// Record a deep link to be honored by the UI. The newest link wins.
    public func handle(_ link: PushDeepLink) {
        pendingLink = link
    }

    /// Clear the pending link after the UI has navigated to it.
    public func consume() {
        pendingLink = nil
    }

    /// The tab to open the app on, honoring any cold-launch deep link. Pass to
    /// `RootView(initialTab:)`. Defaults to `.dashboard`.
    public var launchTab: AppTab {
        pendingLink?.tab ?? .dashboard
    }

    /// Install this router as the `UNUserNotificationCenter` delegate so
    /// foreground presentation and taps are handled. Call once at launch. The
    /// router retains the delegate; the delegate holds the router weakly.
    public func attachAsNotificationDelegate(
        center: UNUserNotificationCenter = .current()
    ) {
        let delegate = PushNotificationDelegate(router: self)
        self.delegate = delegate
        center.delegate = delegate
    }
}
