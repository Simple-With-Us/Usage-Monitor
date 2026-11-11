import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking
import OfflineCache
import ProjectBudgets

#if canImport(UIKit)
import UIKit
#endif

/// The **Overview** home — the first, most-polished screen. Owns its
/// `NavigationStack` + title and renders the shared `BudgetStore` through the
/// standard four-phase `LoadState`: skeleton on first load, a typed `ErrorState`
/// when there's nothing to show, and the full overview (hero, stats, month-pace
/// chart, top providers) once data arrives. A refresh failure over existing data
/// keeps the data on screen and surfaces a soft banner.
public struct DashboardRootView: View {
    @Environment(BudgetStore.self) private var store
    /// Optional so SwiftUI previews (which inject only a `BudgetStore`) don't
    /// trap; the live app always provides it via `RootView`.
    @Environment(AppEnvironment.self) private var env: AppEnvironment?

    @State private var intelligenceStore = IntelligenceStore()
    @State private var portfolioHistoryStore = PortfolioHistoryStore()
    @State private var quotaWindowsStore = QuotaWindowsStore()
    @State private var showBudgetSheet = false

    public init() {}

    public var body: some View {
        NavigationStack {
            content
                .navigationTitle(AppTab.dashboard.title)
                // Inline (centered compact) title — avoid large left-aligned title at rest.
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    // Chart range lives in-content (PortfolioHistorySection), not the nav bar —
                    // a toolbar picker looked global and used to filter nothing.
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            Task { await refresh() }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                        }
                        .accessibilityLabel("Refresh")
                        .disabled(store.state.isInitialLoading)
                    }
                }
                .task { await store.loadIfNeeded() }
                // Quiet refresh: if cache age ≥ 30m, pull again (don't label "stale").
                .task(id: store.lastCachedAt) {
                    guard let cachedAt = store.lastCachedAt else { return }
                    let staleness = BudgetStaleness(cachedAt: cachedAt)
                    if staleness.isStale() {
                        await store.refresh()
                    }
                }
                // While Overview is visible, re-check about every 30 minutes.
                .task {
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(30 * 60))
                        guard !Task.isCancelled else { return }
                        if let cachedAt = store.lastCachedAt,
                           BudgetStaleness(cachedAt: cachedAt).isStale() {
                            await store.refresh()
                        } else if store.lastCachedAt == nil {
                            await store.loadIfNeeded()
                        }
                    }
                }
                .task(id: env?.accessIdentityRevision) { [apiClient = env?.apiClient] in
                    intelligenceStore.reset()
                    portfolioHistoryStore.reset()
                    quotaWindowsStore.reset()
                    if let apiClient {
                        await intelligenceStore.loadIfNeeded(using: apiClient)
                        await portfolioHistoryStore.loadIfNeeded(using: apiClient)
                        await quotaWindowsStore.loadIfNeeded(using: apiClient)
                    }
                }
                .sheet(isPresented: $showBudgetSheet) {
                    BudgetConfigSheet(
                        providers: store.state.value?.providers ?? [],
                        client: env?.apiClient,
                        onSaved: { Task { await refresh() } },
                        onRequestSignIn: { env?.openSettingsForBudgetManagement() }
                    )
                    .presentationDetents([.medium, .large])
                }
        }
    }

    // MARK: - Phase routing

    @ViewBuilder
    private var content: some View {
        if let response = store.state.value {
            let data = DashboardViewData(response)
            if data.isEmpty {
                emptyState
            } else {
                loaded(data)
            }
        } else if let error = store.state.error {
            errorState(error)
        } else {
            skeleton
        }
    }

    // MARK: - Loaded

    private func loaded(_ data: DashboardViewData) -> some View {
        RefreshableScrollView(onRefresh: { await refresh() }) {
            // Only surface a banner when a refresh *failed*. Quietly stale
            // cache age alone is noise — the footer already shows "Updated …"
            // and load/refresh will pull fresh data without nagging.
            if let error = store.lastError {
                StaleDataBanner(error: error)
            }

            DashboardContentView(
                data: data,
                generatedAt: store.state.value?.generatedAtDate,
                onSelectProvider: { id in env?.openProvider(id: id) },
                // Tap the budget card → in-place config sheet (owner 2026-08-31);
                // the Settings deep link remains the signed-out fallback inside
                // the sheet itself.
                onManageBudgets: { showBudgetSheet = true },
                projectRollup: ProjectBudgetsRollup(projects: store.projects),
                onOpenProjects: { env?.openProjects() }
            )

            SubscriptionQuotasCard(
                store: quotaWindowsStore,
                onOpenSettings: { env?.selectTab?(.settings) }
            )

            PortfolioHistorySection(
                store: portfolioHistoryStore,
                onOpenSettings: { env?.selectTab?(.settings) },
                onSelectTimeframe: { option in
                    Task {
                        await portfolioHistoryStore.selectTimeframe(
                            option,
                            using: env?.apiClient
                        )
                    }
                }
            )

            IntelligenceSection(
                store: intelligenceStore,
                onOpenSettings: { env?.selectTab?(.settings) }
            )

            LastUpdatedFooter(
                staleness: budgetStaleness,
                incompleteCoverage: data.hasIncompleteCoverage
            )
        }
    }

    private var budgetStaleness: BudgetStaleness? {
        store.lastCachedAt.map { BudgetStaleness(cachedAt: $0) }
    }

    // MARK: - Empty

    private var emptyState: some View {
        RefreshableScrollView(onRefresh: { await refresh() }) {
            EmptyState(
                systemImage: "chart.pie",
                title: "No spend yet",
                message: "Once your providers report usage this month, your budget overview appears here. Pull to refresh."
            )
            .padding(.top, Theme.Spacing.xxl)
        }
    }

    // MARK: - Error

    private func errorState(_ error: APIError) -> some View {
        RefreshableScrollView(onRefresh: { await refresh() }) {
            BudgetErrorState(
                error: error,
                onRetry: { Task { await refresh() } },
                onConnect: { env?.selectTab?(.settings) }
            )
            .padding(.top, Theme.Spacing.xxl)
        }
    }

    // MARK: - Skeleton

    private var skeleton: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                SkeletonBlock(height: 150, radius: Theme.Radius.lg)
                LazyVGrid(
                    columns: [GridItem(.flexible(), spacing: Theme.Spacing.md),
                              GridItem(.flexible(), spacing: Theme.Spacing.md)],
                    spacing: Theme.Spacing.md
                ) {
                    ForEach(0..<4, id: \.self) { _ in
                        SkeletonBlock(height: 84, radius: Theme.Radius.lg)
                    }
                }
                SkeletonBlock(height: 200, radius: Theme.Radius.lg)
                SkeletonList(rows: 3)
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.lg)
        }
        .background(Theme.Colors.background)
        .accessibilityLabel("Loading overview")
    }

    // MARK: - Actions

    @MainActor
    private func refresh() async {
        await store.refresh()
        if let apiClient = env?.apiClient {
            await intelligenceStore.refresh(using: apiClient)
            await portfolioHistoryStore.refresh(using: apiClient)
            await quotaWindowsStore.refresh(using: apiClient)
        }
        if store.lastError == nil {
            Haptics.success()
        } else {
            Haptics.warning()
        }
    }
}

// MARK: - Stale-data banner

/// A soft, non-blocking banner shown over still-visible data when the latest
/// refresh failed — the data on screen is stale but useful.
private struct StaleDataBanner: View {
    let error: APIError

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .foregroundStyle(Theme.Colors.warning)
            VStack(alignment: .leading, spacing: 1) {
                Text("Showing saved data")
                    .font(Theme.Typography.captionEmphasis)
                    .foregroundStyle(Theme.Colors.primaryText)
                Text(error.title)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(1)
            }
            Spacer()
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Showing saved data. \(error.title). \(error.message)")
    }
}

/// A non-blocking banner when on-screen budget data is older than the staleness
/// threshold but still the best available snapshot.
private struct BudgetStalenessBanner: View {
    let staleness: BudgetStaleness

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "clock.badge.exclamationmark")
                .foregroundStyle(Theme.Colors.warning)
            Text(staleness.staleLabel())
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
        }
        .padding(Theme.Spacing.md)
        .background(Theme.Colors.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(staleness.staleLabel())
    }
}

// MARK: - Footer

/// The "Updated <when>" line under the overview, plus a coverage note when spend
/// may be incomplete.
private struct LastUpdatedFooter: View {
    let staleness: BudgetStaleness?
    let incompleteCoverage: Bool

    var body: some View {
        VStack(spacing: Theme.Spacing.xs) {
            if let staleness {
                Text(staleness.shortLabel())
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }
            if incompleteCoverage {
                Text("Some spend is still syncing and may rise.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, Theme.Spacing.xs)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Overview — loaded") {
    DashboardRootView()
        .environment(DashboardPreview.store(.sample))
}

#Preview("Overview — loaded (dark)") {
    DashboardRootView()
        .environment(DashboardPreview.store(.sample))
        .preferredColorScheme(.dark)
}

#Preview("Overview — empty") {
    DashboardRootView()
        .environment(DashboardPreview.store(.sampleEmpty))
}

#Preview("Overview — error") {
    DashboardRootView()
        .environment(DashboardPreview.store(.sampleEmpty, statusCode: 503))
}
#endif
