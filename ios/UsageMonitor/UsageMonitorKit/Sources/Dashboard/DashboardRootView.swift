import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking

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

    public init() {}

    public var body: some View {
        NavigationStack {
            content
                .navigationTitle(AppTab.dashboard.title)
                .toolbar {
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
            if let error = store.lastError {
                StaleDataBanner(error: error)
            }

            DashboardContentView(data: data, generatedAt: store.state.value?.generatedAtDate)

            LastUpdatedFooter(date: store.lastUpdated, incompleteCoverage: data.hasIncompleteCoverage)
        }
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
        DashboardHaptics.play(success: store.lastError == nil)
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

// MARK: - Footer

/// The "Updated <when>" line under the overview, plus a coverage note when spend
/// may be incomplete.
private struct LastUpdatedFooter: View {
    let date: Date?
    let incompleteCoverage: Bool

    var body: some View {
        VStack(spacing: Theme.Spacing.xs) {
            if let date {
                Text("Updated \(date.formatted(.relative(presentation: .named)))")
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

// MARK: - Haptics

/// Light success/warning feedback on refresh. No-ops off UIKit platforms.
enum DashboardHaptics {
    @MainActor
    static func play(success: Bool) {
        #if canImport(UIKit)
        let generator = UINotificationFeedbackGenerator()
        generator.notificationOccurred(success ? .success : .warning)
        #endif
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
