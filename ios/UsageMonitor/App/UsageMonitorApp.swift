import SwiftUI
import AppCore
import Dashboard
import Providers
import Alerts
import ProjectBudgets
import Settings
import AppLock
import Networking
import OfflineCache
import PushScaffold
#if canImport(UIKit)
import UIKit
#endif

/// The application entry point. Its entire job is composition: construct the
/// shared `AppEnvironment` (wiring the OfflineCache + widget snapshot sink),
/// supply each feature lane's root view to `AppCore`'s shell, wrap the whole
/// thing in the AppLock gate, and route notification / widget deep links to the
/// right tab. It owns no feature UI itself.
@main
struct UsageMonitorApp: App {
    #if canImport(UIKit)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif

    @Environment(\.scenePhase) private var scenePhase

    @State private var environment: AppEnvironment
    /// The shared push router (also the target of the notification-center
    /// delegate the AppDelegate attaches at launch).
    @State private var pushRouter = PushRouter.shared
    /// App-owned tab selection, seeded from any cold-launch deep link and
    /// updated on warm-launch notification / widget taps.
    @State private var selection: AppTab = PushRouter.shared.launchTab

    init() {
        // The shared BudgetStore transparently persists every successful
        // response to disk (offline-first) and to the widget app group.
        _environment = State(
            initialValue: AppEnvironment(
                tokenStore: AccountChangeNotifyingTokenStore(),
                snapshotSink: OfflineCacheSnapshotSink()
            )
        )
    }

    var body: some Scene {
        WindowGroup {
            AppLockGate {
                RootView(environment: environment, features: .live, selection: $selection)
            }
            // AppLockGate sits outside RootView, so give it the environment too.
            .environment(environment)
            .environment(pushRouter)
            // Widget deep link (usagemonitor://<tab>) → select that tab.
            .onOpenURL { url in
                if let tab = appTab(from: url) { selection = tab }
            }
            // Warm-launch notification taps land here via the router.
            .onChange(of: pushRouter.pendingLink) { _, link in
                guard let link else { return }
                selection = link.tab
                pushRouter.consume()
            }
            .task {
                await AlertNotifier.activateAccountScope(
                    AlertNotifier.currentAccountScopeID(hostOverride: environment.settings.baseHost)
                )
                // Permission is requested only from the contextual Settings
                // control. On later launches, silently restore APNs registration
                // only when the user opted in and authorization already exists.
                guard environment.hasToken, AlertNotifier.isEnabled else { return }
                let status = await PushScaffold.authorizationStatus()
                guard status == .authorized || status == .provisional else { return }
                PushScaffold.registerForRemoteNotifications()
            }
            .task {
                for await _ in NotificationCenter.default.notifications(
                    named: .usageMonitorAccountDidChange
                ) {
                    await activateCurrentAccountScope()
                }
            }
            .onChange(of: environment.settings.baseHost) { _, _ in
                Task { await activateCurrentAccountScope() }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            Task {
                await activateCurrentAccountScope()
            }
            // Queue the next background budget refresh when leaving foreground.
            if phase == .background {
                BackgroundRefreshManager.shared.schedule()
            }
        }
    }

    private func activateCurrentAccountScope() async {
        await AlertNotifier.activateAccountScope(
            AlertNotifier.currentAccountScopeID(hostOverride: environment.settings.baseHost)
        )
    }

    /// Map a widget/app deep-link URL (`usagemonitor://dashboard`) to a tab.
    private func appTab(from url: URL) -> AppTab? {
        guard url.scheme == "usagemonitor" else { return nil }
        let key = url.host ?? url.pathComponents.last(where: { $0 != "/" }) ?? ""
        return AppTab(rawValue: key)
    }
}

private extension AppFeatures {
    /// The production wiring: each feature lane's public root view. Adding a
    /// screen never touches this beyond swapping in a richer root — the lane
    /// owns everything inside its own module.
    static let live = AppFeatures(
        dashboard: { AnyView(DashboardRootView()) },
        providers: { AnyView(ProvidersRootView()) },
        alerts: { AnyView(AlertsRootView()) },
        projects: { AnyView(ProjectBudgetsRootView()) },
        settings: { AnyView(SettingsRootView()) }
    )
}

#if canImport(UIKit)
/// UIKit application delegate — the home for APNs registration callbacks and
/// the once-per-launch setup that must run before the app finishes launching
/// (`BGTaskScheduler` registration and the notification-center delegate).
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Background budget refresh: configure + register the BGTask handler
        // BEFORE launch completes (a hard BGTaskScheduler requirement). The
        // alertNotifier closure is what finally connects the background fetch to
        // the Lock Screen: every refresh diffs the alert set and posts a local
        // notification for newly-crossed thresholds (gated on the user's
        // "Budget alerts" toggle + minimum severity, deduped across runs).
        BackgroundRefreshManager.shared.configure(
            // Honour Settings host override (same UserDefaults key as AppSettings).
            makeClient: {
                let host = UserDefaults.standard.string(forKey: "settings.baseHost") ?? ""
                let configuration =
                    APIConfiguration.fromUserInput(host) ?? .production
                return APIClient(
                    configuration: configuration,
                    tokenStore: KeychainTokenStore()
                )
            },
            alertNotifier: { items in await AlertNotifier.deliver(for: items) }
        )
        BackgroundRefreshManager.shared.register()

        // Notification tap routing: install the UN delegate and the alert
        // category before any launch-time tap is delivered.
        PushRouter.shared.attachAsNotificationDelegate()
        PushScaffold.configureNotificationCategories()
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        PushScaffold.setAPNsDeviceToken(deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Registration can legitimately fail (no network, no APNs entitlement in
        // a dev build). Non-fatal — the app works without remote push.
        #if DEBUG
        print("[Push] Remote notification registration failed: \(error.localizedDescription)")
        #endif
    }
}
#endif
