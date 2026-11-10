import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking

/// The **Providers** feature root (owned by the Providers lane).
///
/// A searchable, sortable, filterable list of every tracked provider with
/// status pills and compact rows, pushing a rich per-provider budget detail.
/// List and detail budget data come from the shared `BudgetStore`
/// (`GET /api/budget-status`); the detail additionally loads recorded history
/// and external billing through session-gated routes when a dashboard session
/// is active (see `ProviderDepthStore`).
public struct ProvidersRootView: View {
    @Environment(BudgetStore.self) private var store
    /// Optional so previews (store-only) don't trap; the app injects it.
    @Environment(AppEnvironment.self) private var env: AppEnvironment?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var model = ProvidersListModel()
    /// Owned path so cross-tab deep links (Dashboard attention rows, push) can
    /// push a provider detail without Dashboard importing this module.
    @State private var path = NavigationPath()

    public init() {}

    public var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle(AppTab.providers.title)
                // Inline (centered compact) title — avoid large left-aligned title at rest.
                .navigationBarTitleDisplayMode(.inline)
                .navigationDestination(for: ProviderRoute.self) { route in
                    ProviderDetailView(route: route)
                }
                .navigationDestination(for: ProvidersExtraRoute.self) { route in
                    switch route {
                    case .money: MoneyScreen()
                    case .keysAndApps: KeysAndAppsScreen()
                    }
                }
                .toolbar { sortMenu }
                .toolbar { moreMenu }
                .task { await store.loadIfNeeded() }
                // Re-run when a cross-tab deep link lands a new pending id.
                .task(id: env?.pendingProviderID) {
                    consumePendingProviderRoute()
                }
        }
    }

    /// Drain `AppEnvironment.pendingProviderID` into the local navigation path.
    private func consumePendingProviderRoute() {
        guard let env, let id = env.pendingProviderID, !id.isEmpty else { return }
        env.pendingProviderID = nil
        // Avoid stacking the same provider if already on top.
        path.append(ProviderRoute(id: id))
        Haptics.tap()
    }

    // MARK: - Phase routing

    @ViewBuilder
    private var content: some View {
        if store.state.isInitialLoading {
            loadingState
        } else if let error = store.state.error {
            errorState(error)
        } else if store.providers.isEmpty {
            emptyState
        } else {
            loadedList
        }
    }

    // MARK: - Loading

    private var loadingState: some View {
        ScrollView {
            SkeletonList(rows: 6)
                .padding(Theme.Spacing.lg)
        }
        .background(Theme.Colors.background)
    }

    // MARK: - Error (no data yet)

    private func errorState(_ error: APIError) -> some View {
        BudgetErrorState(
            error: error,
            onRetry: { Task { await store.refresh() } },
            onConnect: { env?.selectTab?(.settings) }
        )
        .frame(maxHeight: .infinity)
        .dsScreenBackground()
    }

    // MARK: - Empty (loaded, but no providers)

    private var emptyState: some View {
        ScrollView {
            EmptyState(
                systemImage: "square.stack.3d.up.slash",
                title: "No providers yet",
                message: "Once the monitor is tracking providers, they'll appear here with their budget status.",
                actionTitle: "Refresh"
            ) {
                Task { await store.refresh() }
            }
            .padding(.top, Theme.Spacing.xxxl)
        }
        .background(Theme.Colors.background)
        .refreshable { await store.refresh() }
    }

    // MARK: - Loaded

    private var results: [ProviderBudgetStatus] {
        model.results(from: store.providers)
    }

    private var filterCounts: [ProviderFilter: Int] {
        Dictionary(uniqueKeysWithValues: ProviderFilter.allCases.map { facet in
            (facet, model.count(for: facet, in: store.providers))
        })
    }

    private var loadedList: some View {
        ScrollViewReader { proxy in
            List {
                if let lastError = store.lastError {
                    Section { staleBanner(lastError) }
                        .listRowInsets(EdgeInsets(top: 0, leading: Theme.Spacing.lg, bottom: 0, trailing: Theme.Spacing.lg))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }

                Section {
                    summaryHeader
                }
                .listRowInsets(EdgeInsets(top: Theme.Spacing.xs, leading: Theme.Spacing.lg, bottom: Theme.Spacing.xs, trailing: Theme.Spacing.lg))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)

                Section {
                    StatusFilterBar(
                        selection: $model.filter,
                        counts: filterCounts,
                        onChange: { Haptics.selection() }
                    )
                    .listRowInsets(EdgeInsets())
                }
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)

                if results.isEmpty {
                    Section { filteredEmptyRow }
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                } else {
                    Section {
                        ForEach(results) { provider in
                            Button {
                                Haptics.tap()
                                path.append(ProviderRoute(id: provider.id))
                            } label: {
                                ProviderRow(
                                    title: provider.title,
                                    subtitle: provider.rowSubtitle,
                                    value: provider.rowValue,
                                    valueCaption: provider.rowValueCaption,
                                    status: provider.semanticStatus,
                                    showsChevron: true
                                )
                            }
                            .buttonStyle(.plain)
                            .contentShape(Rectangle())
                            .id(provider.id)
                            .contextMenu {
                                Button {
                                    Haptics.tap()
                                    path.append(ProviderRoute(id: provider.id))
                                } label: {
                                    Label("Open details", systemImage: "doc.text")
                                }
                                Button {
                                    Haptics.tap()
                                    path.append(ProviderRoute(id: provider.id))
                                } label: {
                                    Label("Edit Budget / Plan", systemImage: "slider.horizontal.3")
                                }
                                if !provider.spendCoverage.isComplete {
                                    Text("Spend may omit tax & invoice fees")
                                }
                            }
                        }
                    } header: {
                        Text(resultsHeaderText)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.Colors.background)
            .searchable(
                text: $model.searchText,
                placement: .navigationBarDrawer(displayMode: .automatic),
                prompt: "Search providers"
            )
            .refreshable { await store.refresh() }
            .animation(reduceMotion ? nil : .default, value: model.filter)
            .animation(reduceMotion ? nil : .default, value: results.count)
            .task(id: results.last?.id) {
                if ProcessInfo.processInfo.arguments.contains("-ScreenshotScrollBottom"), let lastId = results.last?.id {
                    try? await Task.sleep(for: .milliseconds(300))
                    withAnimation {
                        proxy.scrollTo(lastId, anchor: .bottom)
                    }
                }
            }
        }
    }

    // MARK: - Pieces

    private var summaryHeader: some View {
        let providers = store.providers
        let totalSpent = providers.reduce(0) { $0 + $1.spentUsd }
        let overCount = providers.filter { $0.status == .exceeded }.count
        let warnCount = providers.filter { $0.status == .warning }.count

        return VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                Text(CurrencyFormat.usd(totalSpent))
                    .font(Theme.Typography.hero)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.primaryText)
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
                Text("this month")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                Spacer(minLength: 0)
            }
            HStack(spacing: Theme.Spacing.sm) {
                Text("\(providers.count) provider\(providers.count == 1 ? "" : "s")")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                if overCount > 0 {
                    StatusBadge("\(overCount) Over", status: .danger, systemImage: "exclamationmark.octagon.fill")
                }
                if warnCount > 0 {
                    StatusBadge("\(warnCount) Warning", status: .warning, systemImage: "gauge.with.dots.needle.67percent")
                }
                if overCount == 0 && warnCount == 0 {
                    StatusBadge("All on Track", status: .ok, systemImage: "checkmark.circle.fill")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(providers.count) providers, \(CurrencyFormat.usd(totalSpent)) spent this month")
    }

    private var resultsHeaderText: String {
        let shown = results.count
        let total = store.providers.count
        if model.isFiltering && shown != total {
            return "Showing \(shown) of \(total)"
        }
        return "\(total) provider\(total == 1 ? "" : "s")"
    }

    private var filteredEmptyRow: some View {
        EmptyState(
            systemImage: "line.3.horizontal.decrease.circle",
            title: "No matches",
            message: model.searchText.isEmpty
                ? "No providers match the \(model.filter.label.lowercased()) filter."
                : "No providers match “\(model.searchText)”.",
            actionTitle: "Clear filters"
        ) {
            withAnimation { model.reset() }
            Haptics.selection()
        }
        .padding(.vertical, Theme.Spacing.xl)
    }

    private func staleBanner(_ error: APIError) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "wifi.exclamationmark")
            Text("Couldn't refresh — showing last loaded data.")
                .font(Theme.Typography.caption)
            Spacer(minLength: 0)
        }
        .foregroundStyle(Theme.Colors.warning)
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Refresh failed. Showing last loaded data. \(error.message)")
    }

    /// The two web surfaces that have no tab of their own.  The tab bar is
    /// already at its iPhone limit, so Money and Keys & Apps live here — one
    /// tap from Providers, which is the lane both of them are about.
    private var moreMenu: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Menu {
                Button {
                    Haptics.tap()
                    path.append(ProvidersExtraRoute.money)
                } label: {
                    Label("Money", systemImage: "creditcard.fill")
                }
                Button {
                    Haptics.tap()
                    path.append(ProvidersExtraRoute.keysAndApps)
                } label: {
                    Label("Keys & Apps", systemImage: "key.horizontal.fill")
                }
            } label: {
                Label("More", systemImage: "ellipsis.circle")
            }
            .accessibilityLabel("More provider views")
        }
    }

    private var sortMenu: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Picker("Sort by", selection: $model.sort) {
                    ForEach(ProviderSort.allCases) { option in
                        Label(option.label, systemImage: option.systemImage).tag(option)
                    }
                }
            } label: {
                Label("Sort", systemImage: "arrow.up.arrow.down")
            }
            .onChange(of: model.sort) { _, _ in Haptics.selection() }
            .accessibilityLabel("Sort providers")
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Providers — list (light)") {
    ProvidersListPreviewHost(response: .sample)
        .preferredColorScheme(.light)
}

#Preview("Providers — list (dark)") {
    ProvidersListPreviewHost(response: .sample)
        .preferredColorScheme(.dark)
}

#Preview("Providers — empty") {
    ProvidersListPreviewHost(response: .sampleEmpty)
}

private struct ProvidersListPreviewHost: View {
    @State private var store: BudgetStore

    init(response: BudgetStatusResponse) {
        _store = State(initialValue: ProviderPreview.store(with: response))
    }

    var body: some View {
        ProvidersRootView()
            .environment(store)
    }
}
#endif

/// Routes for the two web surfaces that have no tab of their own.
/// Kept separate from `ProviderRoute` so provider deep links stay unambiguous.
enum ProvidersExtraRoute: Hashable {
    case money
    case keysAndApps
}
