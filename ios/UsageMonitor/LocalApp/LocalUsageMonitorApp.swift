import SwiftUI
import LocalDataPlane
import AppCore
import AppLock

/// Entry point for **Usage Monitor Local** — on-device self-host product.
/// App Lock + appearance without a remote API client (phone is the instance).
@main
struct LocalUsageMonitorApp: App {
    @State private var settings = AppSettings()

    var body: some Scene {
        WindowGroup {
            LocalAppLockGate(settings: settings) {
                LocalRootView(settings: settings)
            }
            .preferredColorScheme(settings.theme.colorScheme)
            // Designed-for-iPhone Mac: force a usable desktop window; some TF
            // installs opened with a zero-sized or unresponsive chrome when
            // the scene had no preferred size.
            .frame(minWidth: 420, minHeight: 640)
            .appUpdatePrompt()
        }
        .defaultSize(width: 480, height: 860)
    }
}
