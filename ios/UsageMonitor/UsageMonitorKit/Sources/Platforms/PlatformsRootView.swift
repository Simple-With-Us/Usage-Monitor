import AppCore
import DesignSystem
import Models
import Networking
import SwiftUI

/// Root of the **Platforms** lane (tab `.platforms`).
///
/// The operator's single "is anything on fire" screen.  Three reads, each
/// independently fallible:
///   1. `/api/server-metrics` — the Hetzner host and every Coolify app on it,
///      plus per-app backup coverage for the whole fleet.
///   2. `/api/platform-status` — one card per external platform the fleet runs
///      on, including the ones with no credentials configured yet.
///   3. `/api/operations` — the fleet operations rollup (peer app health, R2
///      free tier, receipt inbox).
///
/// Server monitoring also remains in Settings, where the read token is
/// entered.  This tab is the place to *look* at it; Settings is the place to
/// *configure* it.
///
/// Public entry point — keep `PlatformsRootView` + `public init()` stable.
public struct PlatformsRootView: View {
    @Environment(AppEnvironment.self) private var env: AppEnvironment?
    @State private var store = PlatformsStore()

    public init() {}

    public var body: some View {
        NavigationStack {
            content
                .navigationTitle(AppTab.platforms.title)
                .navigationBarTitleDisplayMode(.inline)
                // Dense ops cards overflow at the largest accessibility sizes.
                .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
        }
        // One task owns this screen's entire load lifetime, keyed on the access
        // identity.  A host switch or credential change rebuilds the API client
        // and bumps the revision, and `.task(id:)` cancels the running task
        // before restarting it — so an in-flight read against the old host is
        // torn down instead of landing last and overwriting the new host's
        // data.  A second, unkeyed `.task` alongside this one would survive the
        // switch and reintroduce exactly that race, so there must only be one.
        // The initial load runs here too: the first `nil -> 0` revision (or the
        // starting value when `env` is already present) fires the task once.
        .task(id: env?.accessIdentityRevision) {
            guard let env else { return }
            store.reset()
            let client = env.apiClient
            await store.loadIfNeeded(using: client)
            await pollWhileVisible(using: client)
        }
    }

    /// Visibility-scoped refresh cadence.  AGENTS.md requires operational
    /// surfaces to poll about once a minute *only while visible*; the web
    /// Operations page runs the same 60-second beat.
    private static let pollInterval: Duration = .seconds(60)

    /// Re-reads all three endpoints once a minute for as long as this task
    /// lives.  It is the tail of the identity-keyed `.task`, which is what
    /// scopes it: SwiftUI cancels that task when the tab disappears or the
    /// access identity changes, so the loop never polls a view that is gone and
    /// a second loop can never stack behind the first.
    ///
    /// `refresh` keeps the last good value on failure, so a blip mid-poll
    /// leaves the screen showing data rather than blanking it.
    @MainActor
    private func pollWhileVisible(using client: APIClient) async {
        while !Task.isCancelled {
            do {
                try await Task.sleep(for: Self.pollInterval)
            } catch {
                return  // Cancelled mid-sleep — the view is gone.
            }
            guard !Task.isCancelled else { return }
            await store.refresh(using: client)
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.isInitialLoad, store.platformState.isInitialLoading {
            loadingView
        } else if let error = blockingError {
            errorView(for: error)
        } else {
            loadedView
        }
    }

    /// Only treat an error as blocking when nothing at all loaded.  A partial
    /// failure renders inline within its own section instead.
    private var blockingError: APIError? {
        guard store.platformState.value == nil,
            store.hostState.value == nil,
            store.operationsState.value == nil
        else { return nil }
        return store.platformState.error ?? store.hostState.error ?? store.operationsState.error
    }

    private var loadingView: some View {
        VStack(spacing: Theme.Spacing.lg) {
            SkeletonList(rows: 6)
        }
        .padding(.horizontal, Theme.Spacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.Colors.background)
    }

    @ViewBuilder
    private func errorView(for error: APIError) -> some View {
        let needsCredentials = error == .missingToken || error == .unauthorized
        ErrorState(
            systemImage: needsCredentials ? "key.horizontal.fill" : "exclamationmark.triangle.fill",
            title: needsCredentials ? "Connection Required" : "Platform Status Unavailable",
            message: needsCredentials
                ? "Add your read token in Settings to see platform and host status."
                : error.localizedDescription,
            actionTitle: needsCredentials ? "Open Settings" : nil,
            action: needsCredentials ? { env?.selectTab?(.settings) } : nil,
            retry: {
                guard let env else { return }
                Task { await store.load(using: env.apiClient) }
            }
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.Colors.background)
    }

    private var loadedView: some View {
        RefreshableScrollView(
            onRefresh: { [store] in
                guard let client = await MainActor.run(body: { env?.apiClient }) else { return }
                await store.refresh(using: client)
            }
        ) {
            summaryHeader

            // Each read is independent, so each failure is reported where its
            // sections would have been.  Silently dropping a section would tell
            // an operator "nothing to see here" about an endpoint that is down.
            if let metrics = store.hostState.value {
                FleetHostSection(metrics: metrics)
                FleetAppsSection(metrics: metrics)
            } else if let error = store.hostState.error {
                inlineFailure("Host Metrics", error: error)
            }

            if let operations = store.operationsState.value {
                FleetOperationsSection(operations: operations)
            } else if let error = store.operationsState.error {
                inlineFailure("Operations", error: error)
            }

            if let payload = store.platformState.value {
                PlatformCardsSection(payload: payload)
            } else if let error = store.platformState.error {
                inlineFailure("Platform Status", error: error)
            }
        }
        .background(Theme.Colors.background)
    }

    @ViewBuilder
    private var summaryHeader: some View {
        let attention = store.attentionCount
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(attention == 0 ? "All Systems Normal" : "\(attention) Need Attention")
                .font(Theme.Typography.sectionHeader)
                .foregroundStyle(Theme.Colors.primaryText)
                .fixedSize(horizontal: false, vertical: true)
            if let summary = store.platformState.value?.summary {
                Text(summaryLine(summary))
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func summaryLine(_ summary: PlatformStatusPayload.Summary) -> String {
        let configured = summary.configured ?? 0
        let healthy = summary.healthy ?? 0
        let unconfigured = summary.unconfigured ?? 0
        return "\(healthy) healthy of \(configured) configured · \(unconfigured) not configured"
    }

    @ViewBuilder
    private func inlineFailure(_ title: String, error: APIError) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            SectionHeader(title)
            Text(error.localizedDescription)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }
}
