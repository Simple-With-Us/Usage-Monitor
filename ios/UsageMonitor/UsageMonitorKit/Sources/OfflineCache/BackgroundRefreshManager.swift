import Foundation
import Models
import Networking
import WidgetShared

#if canImport(BackgroundTasks)
import BackgroundTasks
#endif

/// Drives a `BGAppRefreshTask` that quietly refreshes budget status in the
/// background: it fetches `GET /api/budget-status`, writes the timestamped disk
/// cache (offline-first first paint) and the compact `WidgetSnapshot` into the
/// app group (so the home-screen widget shows fresh data without the app being
/// launched), then reloads widget timelines.
///
/// Owned by the **OfflineCache** lane. `AppCore`-free by design — it builds its
/// own `APIClient` from `Networking` defaults (same Keychain token, same
/// production base URL). The app may inject a custom `makeClient` at
/// ``configure(makeClient:cacheDirectory:earliestInterval:)`` time if it needs
/// to honour a user host override.
///
/// ## App-target wiring (see integration notes)
///  1. `Info.plist` already declares `com.simplewithus.usage.client.refresh` in
///     `BGTaskSchedulerPermittedIdentifiers` and the `fetch` background mode.
///  2. During launch, **before the app finishes launching**, call
///     `BackgroundRefreshManager.shared.configure(...)` then `.register()`.
///  3. When entering the background, call `.schedule()`.
public final class BackgroundRefreshManager: @unchecked Sendable {
    /// Shared instance; registration must happen once per launch.
    public static let shared = BackgroundRefreshManager()

    /// Must match `BGTaskSchedulerPermittedIdentifiers` in the app `Info.plist`.
    public static let taskIdentifier = "com.simplewithus.usage.client.refresh"

    private let lock = NSLock()
    private var _makeClient: @Sendable () -> APIClient = { APIClient() }
    private var _cacheDirectory: URL?
    private var _earliestInterval: TimeInterval = 2 * 60 * 60
    private var _alertNotifier: (
        @Sendable ([(providerTitle: String, providerId: String, alert: ProviderAlert)]) async -> Void
    )?

    public init() {}

    /// Configure how background refresh builds its client and where it writes.
    /// - Parameters:
    ///   - makeClient: builds the `APIClient` used for the background fetch.
    ///     Defaults to `APIClient()` (production base URL + Keychain token).
    ///     Pass a host-aware factory so staging overrides apply in background.
    ///   - cacheDirectory: where to persist the disk cache. Defaults to the app
    ///     group container so the cache is shared with the widget.
    ///   - earliestInterval: soonest the system should run the next refresh.
    ///   - alertNotifier: invoked after a successful fetch with provider-scoped
    ///     alerts for Lock Screen delivery.
    public func configure(
        makeClient: @escaping @Sendable () -> APIClient = { APIClient() },
        cacheDirectory: URL? = nil,
        earliestInterval: TimeInterval = 2 * 60 * 60,
        alertNotifier: (
            @Sendable ([(providerTitle: String, providerId: String, alert: ProviderAlert)]) async -> Void
        )? = nil
    ) {
        lock.lock(); defer { lock.unlock() }
        _makeClient = makeClient
        _cacheDirectory = cacheDirectory ?? AppGroup.containerURL
        _earliestInterval = earliestInterval
        _alertNotifier = alertNotifier
    }

    private var makeClient: @Sendable () -> APIClient {
        lock.lock(); defer { lock.unlock() }
        return _makeClient
    }

    private var cacheDirectory: URL? {
        lock.lock(); defer { lock.unlock() }
        return _cacheDirectory
    }

    private var earliestInterval: TimeInterval {
        lock.lock(); defer { lock.unlock() }
        return _earliestInterval
    }

    private var alertNotifier: (
        @Sendable ([(providerTitle: String, providerId: String, alert: ProviderAlert)]) async -> Void
    )? {
        lock.lock(); defer { lock.unlock() }
        return _alertNotifier
    }

    /// Perform one refresh cycle: fetch, persist cache + widget snapshot, reload
    /// widgets. Returns `true` on a successful fetch. Safe to call directly
    /// (e.g. from `applicationDidEnterBackground` or a manual "refresh now").
    @discardableResult
    public func performRefresh() async -> Bool {
        let client = makeClient()
        guard await client.hasToken else { return false }
        do {
            let response = try await client.budgetStatus()
            BudgetDiskCache(directory: cacheDirectory).save(response)
            WidgetSnapshotStore.updateBudget(response)
            // Start the quota fetch in the background; it must not block
            // the LLM / server / Mac mirrors, the Lock Screen alert, or the
            // final forced widget reload. We await it after the alert
            // notifier has fired so the quota mirror still lands on success.
            let quotaTask = Task { [client] in
                try? await client.fetchQuotaWindows()
            }
            // LLM / server / Mac mirrors only — quota handling lives below.
            await refreshSecondaryWidgetSections(using: client)
            // The whole point of a background budget monitor: turn a freshly
            // fetched over/near-budget alert into a Lock Screen notification
            // while the app is closed. The notifier dedupes across runs and
            // honours the user's toggle/severity — see `AlertNotifier`. The
            // alert must not wait on the quota task.
            if let alertNotifier {
                let items = response.providers.flatMap { provider in
                    provider.alerts.map {
                        (
                            providerTitle: provider.title,
                            providerId: provider.id,
                            alert: $0
                        )
                    }
                }
                await alertNotifier(items)
            }
            // Fire the forced widget reload *before* awaiting the quota task
            // so a slow or hung quota response cannot gate the timeline
            // refresh — `BGAppRefreshTask` calls `setTaskCompleted(success:)`
            // with whatever `performRefresh` returns, so the whole background
            // budget cycle must return promptly even when the quota endpoint
            // is slow. The quota mirror still lands on success afterwards.
            reloadWidgets()
            if let quotas = await quotaTask.value {
                WidgetSnapshotStore.updateQuotas(quotas)
            }
            return true
        } catch {
            return false
        }
    }

    /// Best-effort LLM + server + Mac cache. Failures leave the previous
    /// section in place so a 401 or timeout cannot stamp empty tiles as live.
    ///
    /// Quota fetching lives in `performRefresh` and is awaited *after* the
    /// forced widget reload has fired, so a slow subscription-quota response
    /// cannot gate the Lock Screen alert or the final forced widget reload.
    private func refreshSecondaryWidgetSections(
        using client: APIClient
    ) async {
        if let burn = try? await client.llmBurn() {
            WidgetSnapshotStore.updateLlm(burn)
        }
        if let health = try? await client.health() {
            let readiness = try? await client.readiness()
            WidgetSnapshotStore.updateServerService(health: health, readiness: readiness)
        }
        if let metrics = try? await client.serverMetrics() {
            WidgetSnapshotStore.updateServerHost(metrics)
        }
        if let mac = try? await client.macHealth() {
            WidgetSnapshotStore.updateMac(mac)
        }
    }

    private func reloadWidgets() {
        WidgetSnapshotStore.reloadWidgetsIfNeeded(force: true)
    }

    #if canImport(BackgroundTasks) && os(iOS)
    /// Register the `BGAppRefreshTask` handler. Call **once**, during launch,
    /// before the app finishes launching (`BGTaskScheduler` requires this).
    public func register() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.taskIdentifier,
            using: nil
        ) { [weak self] task in
            guard let self, let refreshTask = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            self.handle(refreshTask)
        }
    }

    /// Submit the next `BGAppRefreshTask`. Call when entering the background (and
    /// it re-chains itself after each run). Best-effort — throws are swallowed.
    public func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: Self.taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: earliestInterval)
        try? BGTaskScheduler.shared.submit(request)
    }

    private func handle(_ task: BGAppRefreshTask) {
        // Chain the next refresh before doing work, so a mid-run expiration
        // still leaves a future refresh queued.
        schedule()

        let work = Task {
            let success = await performRefresh()
            task.setTaskCompleted(success: success)
        }
        task.expirationHandler = { work.cancel() }
    }
    #endif
}
