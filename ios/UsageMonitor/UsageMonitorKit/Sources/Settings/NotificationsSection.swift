import SwiftUI
import UserNotifications
import DesignSystem
import Models
import PushScaffold

#if canImport(UIKit)
import UIKit
#endif

/// Settings → **Notifications**. Gives the budget-alert loop a user-facing home:
///   - a master "Budget alerts" toggle (persisted via ``AlertNotifier``),
///   - a minimum-severity picker (Warning & above / Critical only),
///   - the live system authorization state, with a one-tap jump to iOS Settings
///     when the user has denied permission.
///
/// This is the contextual opt-in that replaces the old cold, first-launch system
/// prompt: flipping the toggle on is what triggers the permission request, so the
/// dialog only appears once the user has expressed intent to be notified.
struct NotificationsSection: View {
    @State private var model = NotificationsSettingsModel()

    var body: some View {
        Section {
            Toggle(isOn: $model.isEnabled) {
                Label("Budget alerts", systemImage: "bell.badge.fill")
            }
            .tint(Theme.Colors.accent)
            .onChange(of: model.isEnabled) { _, enabled in
                Haptics.selection()
                if enabled { Task { await model.enableAndRequestIfNeeded() } }
            }

            if model.isEnabled {
                Picker(selection: $model.minimumSeverity) {
                    Text("Warning & above").tag(AlertSeverity.warning)
                    Text("Critical only").tag(AlertSeverity.critical)
                } label: {
                    Label("Notify me about", systemImage: "slider.horizontal.3")
                }
                .onChange(of: model.minimumSeverity) { _, _ in Haptics.selection() }

                if model.showsDeniedRow {
                    Button {
                        model.openSystemSettings()
                    } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 1) {
                                Text("Notifications are turned off")
                                    .foregroundStyle(Theme.Colors.primaryText)
                                Text("Enable them in iOS Settings to get alerts.")
                                    .font(Theme.Typography.caption)
                                    .foregroundStyle(Theme.Colors.secondaryText)
                            }
                        } icon: {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(Theme.Colors.warning)
                        }
                    }
                }

                Button {
                    model.registerRemoteAPNs()
                } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(model.hasApnsToken ? "APNs Remote Push Registered" : "Enable Remote Push (APNs)")
                                .foregroundStyle(Theme.Colors.primaryText)
                            Text(model.hasApnsToken ? "Token saved to server for native iOS push alerts." : "Register device token with your \(AppInfo.displayName) server.")
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.secondaryText)
                        }
                    } icon: {
                        Image(systemName: model.hasApnsToken ? "checkmark.seal.fill" : "antenna.radiowaves.left.and.right")
                            .foregroundStyle(model.hasApnsToken ? Theme.Colors.success : Theme.Colors.accent)
                    }
                }
            }
        } header: {
            Text("Notifications & APNs Push")
        } footer: {
            Text(footerText)
        }
        .task { await model.refreshStatus() }
    }

    private var footerText: String {
        guard model.isEnabled else {
            return "Local budget alerts need a read token (or full-access session) so background refresh can check spend. Remote push only works after the server registers this device for APNs."
        }
        switch model.authorizationStatus {
        case .denied:
            return "\(AppInfo.displayName) can't send notifications until you allow them in iOS Settings. Local/background alerts still require a read token; remote push only when the server has this device registered."
        case .notDetermined:
            return "You'll be asked to allow notifications. Local alerts use background refresh with a read token; remote push is scaffolded until the server registers the device."
        default:
            return "Local alerts fire from background budget checks (needs a read token) and are deduplicated. Remote APNs push only delivers when the monitor has registered this device — the button above is the registration scaffold, not a guarantee of server-side push."
        }
    }
}

/// Observable wrapper around the (non-observable) `UserDefaults`-backed
/// ``AlertNotifier`` preferences plus the system authorization status, so the
/// SwiftUI section can bind to them.
@MainActor
@Observable
final class NotificationsSettingsModel {
    var isEnabled: Bool {
        didSet { AlertNotifier.isEnabled = isEnabled }
    }
    var minimumSeverity: AlertSeverity {
        didSet { AlertNotifier.minimumSeverity = minimumSeverity }
    }
    private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined

    init() {
        isEnabled = AlertNotifier.isEnabled
        minimumSeverity = AlertNotifier.minimumSeverity
    }

    /// Show the "turned off" row only when the user wants alerts but the system
    /// won't deliver them.
    var showsDeniedRow: Bool {
        isEnabled && authorizationStatus == .denied
    }

    var hasApnsToken: Bool {
        let token = UserDefaults.standard.string(forKey: "apns.deviceToken") ?? ""
        return !token.isEmpty
    }

    func refreshStatus() async {
        authorizationStatus = await PushScaffold.authorizationStatus()
    }

    /// Request permission the first time the user opts in (the contextual
    /// prompt). Alerts are delivered as local notifications from the background
    /// refresh, so nothing else needs to happen once permission is granted.
    func enableAndRequestIfNeeded() async {
        if authorizationStatus == .notDetermined {
            _ = await PushScaffold.requestAuthorization()
        }
        await refreshStatus()
        registerRemoteAPNs()
    }

    func registerRemoteAPNs() {
        PushScaffold.registerForRemoteNotifications()
    }

    func openSystemSettings() {
        #if canImport(UIKit)
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
        #endif
    }
}
