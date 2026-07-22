import Foundation
import Observation
import Models
import Networking

/// The single dependency container the app injects into the SwiftUI
/// environment. Feature roots read it with `@Environment(AppEnvironment.self)`
/// and never construct an `APIClient`, `AppSettings`, or `BudgetStore`
/// themselves — they consume the shared instances here.
///
/// ## What lives here
///   - ``settings``   — persisted appearance / host / app-lock preferences.
///   - ``apiClient``  — the shared `Networking.APIClient` actor.
///   - ``budgetStore``— the shared `BudgetStore` that owns the single
///     `GET /api/budget-status` fetch powering Dashboard, Providers, Alerts,
///     and Project budgets. Read it; don't create your own.
///
/// The base host (Settings) can change at runtime; ``reconfigure(host:)``
/// rebuilds the API client and rewires the budget store so a staging switch
/// takes effect without relaunching.
@MainActor
@Observable
public final class AppEnvironment {
    /// Persisted, non-sensitive app preferences.
    public let settings: AppSettings

    /// The shared network client. Rebuilt by ``reconfigure(host:)``.
    public private(set) var apiClient: APIClient

    /// The shared budget-status store. Every budget-driven feature reads this.
    public let budgetStore: BudgetStore

    /// Monotonic identity revision for feature-local stores that depend on the
    /// active host or bearer credential. SwiftUI roots use it with `.task(id:)`
    /// to cancel stale probes and refresh against the replacement API client.
    public private(set) var accessIdentityRevision: UInt = 0

    /// Programmatic tab selection, wired by the app shell (`RootView`). Lets any
    /// feature lane request a jump to another tab — e.g. a "No API token" error
    /// state offering "Connect your monitor" that lands the user on Settings, so
    /// no screen is ever a dead end. `nil` in previews/tests (no shell attached).
    public var selectTab: ((AppTab) -> Void)?

    private let tokenStore: TokenStoring
    private var activeConfiguration: APIConfiguration

    /// - Parameters:
    ///   - settings: preferences store (defaults to `UserDefaults.standard`).
    ///   - tokenStore: Keychain-backed by default; inject `InMemoryTokenStore`
    ///     for previews/tests.
    ///   - snapshotSink: where each successful response is persisted (disk
    ///     cache + widget snapshot). Defaults to a no-op; the app target wires
    ///     the real `OfflineCache`/`WidgetShared` adapter.
    public init(
        settings: AppSettings? = nil,
        tokenStore: TokenStoring? = nil,
        snapshotSink: BudgetSnapshotSink = NullBudgetSnapshotSink()
    ) {
        // Construct the defaults here (inside the MainActor-isolated init body)
        // rather than as default-argument expressions, which are evaluated in a
        // nonisolated context and cannot call these @MainActor initializers.
        let settings = settings ?? AppSettings()
        let tokenStore = tokenStore ?? KeychainTokenStore()
        self.settings = settings
        self.tokenStore = tokenStore
        let configuration = Self.resolveConfiguration(host: settings.baseHost)
        self.activeConfiguration = configuration
        let client = APIClient(configuration: configuration, tokenStore: tokenStore)
        self.apiClient = client
        self.budgetStore = BudgetStore(apiClient: client, sink: snapshotSink)
    }

    /// Whether an API token is currently stored (drives onboarding vs. data).
    public var hasToken: Bool { tokenStore.hasToken }

    /// Persist (or clear, when `nil`/empty) the API token. Settings calls this
    /// after a successful `apiClient.verifyToken()`.
    public func setToken(_ token: String?) throws {
        let previousToken = Self.normalizedToken(tokenStore.token())
        try tokenStore.setToken(token)
        if previousToken != Self.normalizedToken(tokenStore.token()) {
            budgetStore.invalidateDataSource()
            accessIdentityRevision &+= 1
        }
    }

    /// Rebuild the API client after the Settings base host changes, then rewire
    /// the shared budget store to the new client.
    public func reconfigure(host: String) {
        let configuration = Self.resolveConfiguration(host: host)
        if configuration != activeConfiguration {
            APIClient.clearDashboardSessionCookies(for: activeConfiguration.baseURL)
        }
        let client = APIClient(configuration: configuration, tokenStore: tokenStore)
        activeConfiguration = configuration
        self.apiClient = client
        budgetStore.replaceClient(client)
        accessIdentityRevision &+= 1
    }

    /// Resolve a user-entered host to an `APIConfiguration`, falling back to
    /// the production monitor when the field is empty or malformed.
    public static func resolveConfiguration(host: String) -> APIConfiguration {
        APIConfiguration.fromUserInput(host) ?? .production
    }

    private static func normalizedToken(_ token: String?) -> String? {
        let trimmed = token?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty ?? true) ? nil : trimmed
    }

    /// A preview/test environment seeded with an in-memory token and no
    /// network side effects.
    public static func preview(token: String? = "preview-token") -> AppEnvironment {
        AppEnvironment(
            settings: AppSettings(defaults: UserDefaults(suiteName: "preview.usage.monitor") ?? .standard),
            tokenStore: InMemoryTokenStore(token: token)
        )
    }
}
