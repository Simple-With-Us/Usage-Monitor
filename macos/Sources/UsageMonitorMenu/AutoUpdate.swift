import AppKit
import Combine
import Sparkle

/// Whether this build can update itself, decided from its own Info.plist
/// before Sparkle is touched.
///
/// Sparkle raises a modal "updater failed to start" alert at launch when the
/// feed or the signing key is missing.  scripts/mac-release-build.sh leaves
/// both out of development builds on purpose, so a local `swift build` or a
/// test host has to be ruled out here rather than greeted with that alert.
/// See docs/AUTO-UPDATE.md.
enum AutoUpdateAvailability: Equatable {
    case enabled(feed: URL)
    case disabled(reason: String)

    static let feedKey = "SUFeedURL"
    static let publicKeyKey = "SUPublicEDKey"

    static func evaluate(info: [String: Any]?, bundleURL: URL) -> AutoUpdateAvailability {
        guard bundleURL.pathExtension == "app" else {
            return .disabled(reason: "Not running from an app bundle.")
        }
        guard let rawFeed = info?[feedKey] as? String,
              let feed = URL(string: rawFeed.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = feed.scheme?.lowercased(),
              let host = feed.host(), !host.isEmpty else {
            return .disabled(reason: "This build has no update feed.")
        }
        // Plain HTTP only reaches this Mac itself, which is how an update is
        // rehearsed locally.  Anything that leaves the machine must be HTTPS.
        guard scheme == "https" || (scheme == "http" && isLoopback(host)) else {
            return .disabled(reason: "The update feed is not HTTPS.")
        }
        guard let rawKey = info?[publicKeyKey] as? String,
              let key = Data(base64Encoded: rawKey.trimmingCharacters(in: .whitespacesAndNewlines)),
              key.count == 32 else {
            return .disabled(reason: "This build has no update signing key.")
        }
        return .enabled(feed: feed)
    }

    static func isLoopback(_ host: String) -> Bool {
        host == "localhost" || host == "127.0.0.1"
    }

    var isEnabled: Bool {
        if case .enabled = self { return true }
        return false
    }

    /// One line for Settings.
    var summary: String {
        switch self {
        case .enabled: "On"
        case .disabled(let reason): "Off · \(reason)"
        }
    }
}

/// Owns Sparkle for the life of the app.
///
/// Updates are checked hourly, downloaded in the background, and installed
/// without a prompt: Sparkle hands over an install-and-relaunch block once an
/// update is ready, and it runs the moment Usage Monitor is not the frontmost
/// app, which for a menu-bar app is nearly always.  If the owner is using
/// Usage Monitor at that moment, the install waits until they switch away.
@MainActor
final class AppUpdater: NSObject, ObservableObject, SPUUpdaterDelegate {
    static let shared = AppUpdater()

    let availability: AutoUpdateAvailability
    @Published private(set) var canCheckForUpdates = false

    private var controller: SPUStandardUpdaterController?
    private var canCheckObservation: NSKeyValueObservation?
    private var resignActiveObserver: NSObjectProtocol?
    private var pendingInstall: (() -> Void)?

    private override init() {
        availability = AutoUpdateAvailability.evaluate(info: Bundle.main.infoDictionary,
                                                       bundleURL: Bundle.main.bundleURL)
        super.init()
    }

    func start() {
        guard availability.isEnabled, controller == nil else { return }
        let controller = SPUStandardUpdaterController(startingUpdater: true,
                                                      updaterDelegate: self,
                                                      userDriverDelegate: nil)
        self.controller = controller
        canCheckObservation = controller.updater.observe(\.canCheckForUpdates, options: [.initial, .new]) { [weak self] updater, _ in
            let canCheck = updater.canCheckForUpdates
            Task { @MainActor in self?.canCheckForUpdates = canCheck }
        }
        resignActiveObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didResignActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.installPendingUpdateIfIdle() }
        }
    }

    /// The "Check For Updates…" command.  An accessory app is never frontmost
    /// on its own, so it is activated first or Sparkle's window opens behind
    /// whatever the owner is looking at.
    func checkForUpdates() {
        guard let controller else { return }
        NSApp.activate(ignoringOtherApps: true)
        controller.checkForUpdates(nil)
    }

    // MARK: - SPUUpdaterDelegate

    func updater(_ updater: SPUUpdater,
                 willInstallUpdateOnQuit item: SUAppcastItem,
                 immediateInstallationBlock immediateInstallHandler: @escaping () -> Void) -> Bool {
        pendingInstall = immediateInstallHandler
        installPendingUpdateIfIdle()
        return true
    }

    private func installPendingUpdateIfIdle() {
        guard let install = pendingInstall, !NSApp.isActive else { return }
        pendingInstall = nil
        install()
    }
}
