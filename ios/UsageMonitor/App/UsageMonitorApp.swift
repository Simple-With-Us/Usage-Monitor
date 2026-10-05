import SwiftUI
import AppCore
import Dashboard
import Providers
import Alerts
import Platforms
import ProjectBudgets
import ServerStatus
import Computers
import Settings
import AppLock
import Networking
import Models
import OfflineCache
import PushScaffold
import WidgetShared
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
        // `-ScreenshotDemo` paints fixture budget data (no live network) for ASC.
        if ScreenshotDemo.isEnabled {
            let settings = AppSettings(sharedDefaults: AppGroup.defaults)
            settings.appLockEnabled = false
            _environment = State(
                initialValue: AppEnvironment(
                    settings: settings,
                    tokenStore: InMemoryTokenStore(token: "screenshot-demo-token"),
                    snapshotSink: ScreenshotDemoSnapshotSink()
                )
            )
            if let tab = ScreenshotDemo.preferredTab {
                _selection = State(initialValue: tab)
            }
        } else {
            let tokenStore = AccountChangeNotifyingTokenStore()
            if let token = ProcessInfo.processInfo.environment["USAGE_READ_TOKEN"] {
                try? tokenStore.setToken(token)
            }
            let args = ProcessInfo.processInfo.arguments
            if let idx = args.firstIndex(of: "-ReadToken"), args.indices.contains(idx + 1) {
                try? tokenStore.setToken(args[idx + 1])
            }
            _environment = State(
                initialValue: AppEnvironment(
                    settings: AppSettings(sharedDefaults: AppGroup.defaults),
                    tokenStore: tokenStore,
                    snapshotSink: OfflineCacheSnapshotSink()
                )
            )
            if let tab = ScreenshotDemo.preferredTab {
                _selection = State(initialValue: tab)
            }
        }
    }

    var body: some Scene {
        WindowGroup {
            AppLockGate {
                RootView(environment: environment, features: .live, selection: $selection)
            }
            // AppLockGate sits outside RootView, so give it the environment too.
            .environment(environment)
            .environment(pushRouter)
            // Widget deep link (usageclientmonitor://<tab>) → select that tab.
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
                if ScreenshotDemo.isEnabled {
                    environment.budgetStore.seedScreenshotFixture(.sample)
                }
                await AlertNotifier.activateAccountScope(
                    AlertNotifier.currentAccountScopeID(hostOverride: environment.settings.baseHost)
                )
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
            .frame(minWidth: 420, minHeight: 640)
            .appUpdatePrompt()
        }
        .defaultSize(width: 480, height: 860)
        .onChange(of: scenePhase) { _, phase in
            Task {
                await activateCurrentAccountScope()
            }
            if phase == .active {
                // Ensure secondary widget data (LLM, Mac, Servers) loads even if the user
                // doesn't navigate to those specific tabs.  Screenshot capture must stay on
                // fixtures: a live refresh would stamp real spend into the app-group cache
                // and the widget snapshot that ASC reads.
                if !ScreenshotDemo.isEnabled {
                    Task { await BackgroundRefreshManager.shared.performRefresh() }
                }
            }
            // Queue the next background budget refresh when leaving foreground.
            if phase == .background, PlatformRuntime.supportsBackgroundAppRefresh {
                BackgroundRefreshManager.shared.schedule()
            }
        }
    }

    private func activateCurrentAccountScope() async {
        await AlertNotifier.activateAccountScope(
            AlertNotifier.currentAccountScopeID(hostOverride: environment.settings.baseHost)
        )
    }

    /// Map a widget/app deep-link URL (`usageclientmonitor://dashboard`) to a tab.
    private func appTab(from url: URL) -> AppTab? {
        guard url.scheme == "usageclientmonitor" else { return nil }
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
        serverStatus: { AnyView(ServerStatusRootView()) },
        computers: { AnyView(ComputersRootView()) },
        agents: { AnyView(AgentsRootView()) },
        platforms: { AnyView(PlatformsRootView()) },
        projects: { AnyView(ProjectBudgetsRootView()) },
        settings: { AnyView(SettingsRootView()) }
    )
}

#if canImport(UIKit)
/// UIKit application delegate — the home for the once-per-launch setup that
/// must run before the app finishes launching (`BGTaskScheduler` registration
/// and the notification-center delegate). The app has no remote-push path, so
/// there are deliberately no APNs registration callbacks here.
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
        // iOS-on-Mac: skip BGTask registration. Designed-for-iPhone Mac installs
        // do not get reliable BGAppRefresh and registration has been observed to
        // fail launch (open error -10671 / immediate exit) with minOS 26 + beta hosts.
        if PlatformRuntime.supportsBackgroundAppRefresh {
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
        }

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
        let tokenString = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        Task {
            let host = UserDefaults.standard.string(forKey: "settings.baseHost") ?? ""
            let config = APIConfiguration.fromUserInput(host) ?? .production
            let client = APIClient(configuration: config, tokenStore: KeychainTokenStore())
            await PushScaffold.handleAPNsDeviceToken(tokenString, client: client)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        print("[APNs] Failed to register for remote notifications: \(error)")
    }
}
#endif
