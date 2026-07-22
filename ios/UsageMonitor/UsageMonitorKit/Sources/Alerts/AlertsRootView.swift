import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking
import PushScaffold

/// The **Alerts** feature root (contract-mandated public entry point).
///
/// Aggregates every provider alert into one severity-sorted feed backed by the
/// shared `BudgetStore` (the sole owner of the `budget-status` fetch). Shows:
///   - an **Active** section, filterable by severity, each row drilling into
///     the owning provider;
///   - a **Recently resolved** section derived by the Alerts-local
///     `ResolvedAlertTracker` (the backend payload has no resolved concept);
///   - loading skeleton, typed error + retry, and an all-clear empty state;
///   - pull-to-refresh, haptics, full Dynamic Type / VoiceOver, light + dark,
///     and reduce-motion respect.
public struct AlertsRootView: View {
    @Environment(BudgetStore.self) private var store
    /// Optional so previews (store-only) don't trap; the app injects it.
    @Environment(AppEnvironment.self) private var env: AppEnvironment?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var model = AlertsModel()

    public init() {}

    /// Preview/test seam — inject a model with seeded resolved data or a
    /// scratch UserDefaults suite. The contract's `public init()` is unchanged.
    init(model: AlertsModel) {
        _model = State(initialValue: model)
    }

    public var body: some View {
        NavigationStack {
            content
                .navigationTitle(AppTab.alerts.title)
                .toolbar { toolbarContent }
                .navigationDestination(for: ProviderAlertItem.self) { item in
                    ProviderAlertDetailView(providerId: item.provider.id, fallback: item.provider)
                }
                .task {
                    model.useAccountScope(currentAccountScopeID)
                    await initialLoad()
                }
                .onChange(of: store.lastUpdated) { _, _ in
                    model.useAccountScope(currentAccountScopeID)
                    reconcile()
                }
        }
    }

    // MARK: - State routing

    @ViewBuilder private var content: some View {
        if store.state.isInitialLoading {
            loadingView
        } else if let error = store.state.error {
            errorView(error)
        } else {
            loadedView
        }
    }

    private var loadingView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                SkeletonBlock(width: 180, height: 30)
                    .padding(.bottom, Theme.Spacing.xs)
                SkeletonList(rows: 4)
            }
            .padding(Theme.Spacing.lg)
        }
        .background(Theme.Colors.background)
        .accessibilityLabel("Loading alerts")
    }

    private func errorView(_ error: APIError) -> some View {
        refreshableCentered {
            BudgetErrorState(
                error: error,
                onRetry: { Task { await manualRefresh() } },
                onConnect: { env?.selectTab?(.settings) }
            )
        }
    }

    @ViewBuilder private var loadedView: some View {
        let active = store.alertItems
        let resolved = model.resolved

        if active.isEmpty && resolved.isEmpty {
            refreshableCentered {
                EmptyState(
                    systemImage: "checkmark.seal.fill",
                    title: "All clear",
                    message: "No active alerts. Every provider is within budget and reporting normally."
                )
            }
        } else {
            RefreshableScrollView(onRefresh: { await manualRefresh() }) {
                if let lastError = store.lastError {
                    StaleDataBanner(error: lastError)
                }

                if !active.isEmpty {
                    SeveritySummaryBar(
                        counts: model.counts(active),
                        selection: Binding(
                            get: { model.filter },
                            set: { select($0) }
                        ),
                        onSelect: select
                    )
                }

                activeSection(active)

                if !resolved.isEmpty {
                    resolvedSection(resolved)
                }
            }
        }
    }

    // MARK: - Active / resolved sections

    @ViewBuilder private func activeSection(_ active: [ProviderAlertItem]) -> some View {
        let filtered = model.filtered(active)

        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Active", subtitle: activeSubtitle(active)) {
                Text("\(active.count)")
                    .font(Theme.Typography.captionEmphasis)
                    .foregroundStyle(active.isEmpty ? Theme.Colors.secondaryText : Theme.Colors.danger)
            }

            if filtered.isEmpty {
                Text("No \(model.filter.title.lowercased()) alerts.")
                    .font(Theme.Typography.callout)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, Theme.Spacing.sm)
            } else {
                ForEach(filtered) { item in
                    NavigationLink(value: item) {
                        AlertCard(item: item)
                    }
                    .buttonStyle(.plain)
                    .simultaneousGesture(TapGesture().onEnded {
                        AlertsHaptics.selection()
                    })
                }
            }
        }
    }

    private func resolvedSection(_ resolved: [ResolvedAlert]) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Recently resolved", subtitle: "Cleared in the last 7 days") {
                Text("\(resolved.count)")
                    .font(Theme.Typography.captionEmphasis)
                    .foregroundStyle(Theme.Colors.success)
            }

            VStack(spacing: 0) {
                ForEach(Array(resolved.enumerated()), id: \.element.id) { index, item in
                    ResolvedAlertRow(resolved: item)
                    if index < resolved.count - 1 {
                        Divider().padding(.leading, 44)
                    }
                }
            }
            .dsCard(padding: Theme.Spacing.md)
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Picker("Severity", selection: Binding(get: { model.filter }, set: { select($0) })) {
                    ForEach(AlertSeverityFilter.allCases) { filter in
                        Text(filter.title).tag(filter)
                    }
                }
            } label: {
                Label("Filter", systemImage: model.filter == .all ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
            }
            .accessibilityLabel("Filter by severity")
        }
    }

    // MARK: - Actions

    private func initialLoad() async {
        await store.loadIfNeeded()
        reconcile()
    }

    private func manualRefresh() async {
        await store.refresh()
        reconcile()
        if store.lastError == nil {
            AlertsHaptics.notify(.success)
        } else {
            AlertsHaptics.notify(.warning)
        }
    }

    /// Only fold a genuinely-loaded response into the resolved tracker — never a
    /// failed/empty initial load, which would spuriously "resolve" everything.
    private func reconcile() {
        guard store.state.value != nil else { return }
        model.reconcile(active: store.alertItems)
    }

    private func select(_ filter: AlertSeverityFilter) {
        guard filter != model.filter else { return }
        if reduceMotion {
            model.filter = filter
        } else {
            withAnimation(.easeInOut(duration: 0.2)) { model.filter = filter }
        }
        AlertsHaptics.impact(.light)
    }

    private var currentAccountScopeID: String? {
        AlertNotifier.currentAccountScopeID(hostOverride: env?.settings.baseHost)
    }

    // MARK: - Helpers

    private func activeSubtitle(_ active: [ProviderAlertItem]) -> String? {
        guard !active.isEmpty else { return "No active alerts" }
        let counts = model.counts(active)
        let parts: [String] = [AlertSeverity.critical, .warning, .info].compactMap { severity in
            guard let count = counts[severity], count > 0 else { return nil }
            return "\(count) \(severity.badgeText.lowercased())"
        }
        return parts.joined(separator: " · ")
    }

    /// A refreshable, vertically-centered container for full-screen empty/error
    /// states so pull-to-refresh still works there.
    @ViewBuilder private func refreshableCentered<C: View>(@ViewBuilder _ inner: @escaping () -> C) -> some View {
        GeometryReader { proxy in
            ScrollView {
                inner()
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
            .refreshable { await manualRefresh() }
        }
        .background(Theme.Colors.background)
    }
}
