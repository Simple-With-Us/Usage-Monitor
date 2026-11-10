import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking

/// Root of the **ProjectBudgets** lane (tab `.projects`).
///
/// Per-project budget tracking: a list of projects with spend-vs-budget meters
/// and a project detail screen. Budget data comes from the shared
/// `BudgetStore` (the single authenticated fetch). Add/edit/delete run through
/// the session-gated monitor API (`POST/PUT/DELETE /api/projects`) via
/// `ProjectManagementStore` — offered only while a dashboard session is active,
/// exactly like the provider/subscription management in Settings.
///
/// Public entry point — keep `ProjectBudgetsRootView` + `public init()` stable.
public struct ProjectBudgetsRootView: View {
    @Environment(BudgetStore.self) private var store
    /// Optional so previews (store-only) don't trap; the app injects it.
    @Environment(AppEnvironment.self) private var env: AppEnvironment?
    @State private var detailID: String?
    @State private var managementStore = ProjectManagementStore()
    @State private var editorContext: ProjectEditorContext?

    public init() {}

    private var mergedProjects: [ProjectBudgetStatus] {
        ProjectBudgetsListModel.sorted(store.projects)
    }

    private var phase: ProjectBudgetsPhase {
        ProjectBudgetsListModel.phase(state: store.state, projects: mergedProjects)
    }

    public var body: some View {
        NavigationStack {
            ProjectBudgetsContentView(
                phase: phase,
                rollup: ProjectBudgetsRollup(projects: mergedProjects),
                lastError: store.lastError,
                onRefresh: { await store.refresh() },
                onRetry: { Task { await store.load() } },
                onConnect: { env?.selectTab?(.settings) },
                onSelect: { detailID = $0.id },
                onAdd: managementStore.canManage ? { editorContext = .add } : nil
            )
            .navigationTitle(AppTab.projects.title)
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(item: $detailID) { id in
                projectDetail(id: id)
            }
            .toolbar {
                if managementStore.canManage {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            Haptics.tap()
                            editorContext = .add
                        } label: {
                            Image(systemName: "plus")
                        }
                        .accessibilityLabel("Add project")
                    }
                }
            }
            .sheet(item: $editorContext) { context in
                if let env {
                    ProjectBudgetEditView(
                        existing: context.existing,
                        store: managementStore,
                        client: env.apiClient,
                        budgetStore: store
                    )
                }
            }
            .task { await store.loadIfNeeded() }
            .task(id: env?.accessIdentityRevision ?? 0) { [apiClient = env?.apiClient] in
                if let apiClient {
                    await managementStore.probeCapabilities(using: apiClient)
                }
            }
        }
    }

    @ViewBuilder
    private func projectDetail(id: String) -> some View {
        if let project = mergedProjects.first(where: { $0.id == id }) {
            ProjectBudgetDetailView(
                presentation: ProjectBudgetPresentation(project),
                onEdit: managementStore.canManage ? { editorContext = .edit(project) } : nil
            )
        } else {
            EmptyState(
                systemImage: "folder",
                title: "Project unavailable",
                message: "This project is no longer in the latest data."
            )
        }
    }

}

/// What the add/edit sheet is editing: a new project, or an existing one.
private enum ProjectEditorContext: Identifiable {
    case add
    case edit(ProjectBudgetStatus)

    var id: String {
        switch self {
        case .add: return "add"
        case .edit(let project): return project.id
        }
    }

    var existing: ProjectBudgetStatus? {
        guard case .edit(let project) = self else { return nil }
        return project
    }
}

// MARK: - Content (pure, value-driven — previewable without a live store)

/// The screen body for a given display ``ProjectBudgetsPhase``. Split out from
/// the root so every state (loading / empty / error / loaded) is previewable and
/// the root stays a thin `BudgetStore` adapter.
struct ProjectBudgetsContentView: View {
    let phase: ProjectBudgetsPhase
    let rollup: ProjectBudgetsRollup
    let lastError: Networking.APIError?
    let onRefresh: @Sendable () async -> Void
    let onRetry: () -> Void
    /// Jump to Settings for a configuration error (missing/rejected token). Nil
    /// in previews.
    var onConnect: (() -> Void)? = nil
    let onSelect: (ProjectBudgetPresentation) -> Void
    var onAdd: (() -> Void)? = nil

    var body: some View {
        switch phase {
        case .loading:
            loading
        case .failed(let error):
            BudgetErrorState(
                error: error,
                onRetry: onRetry,
                onConnect: onConnect
            )
            .frame(maxHeight: .infinity)
            .dsScreenBackground()
        case .empty:
            emptyState
        case .loaded(let items):
            loaded(items)
        }
    }

    private var loading: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                SkeletonBlock(width: 180, height: 108, radius: Theme.Radius.lg)
                    .frame(maxWidth: .infinity)
                SkeletonList(rows: 4)
            }
            .padding(Theme.Spacing.lg)
        }
        .dsScreenBackground()
    }

    private var emptyState: some View {
        VStack(spacing: Theme.Spacing.md) {
            EmptyState(
                systemImage: "folder.badge.plus",
                title: "No project budgets yet",
                message: onAdd != nil
                    ? "Track spend per project. Add your first project to start budgeting."
                    : "Track spend per project. Sign in for full access in Settings to manage projects here, or use the web dashboard.",
                actionTitle: onAdd != nil ? "Add project" : nil,
                action: onAdd
            )
        }
        .frame(maxHeight: .infinity)
        .dsScreenBackground()
    }

    private func loaded(_ items: [ProjectBudgetPresentation]) -> some View {
        RefreshableScrollView(onRefresh: onRefresh) {
            if let lastError {
                RefreshErrorBanner(error: lastError)
            }

            if rollup.budgetedCount + rollup.unbudgetedCount > 0 {
                ProjectsRollupCard(rollup: rollup)
            }

            // Do not repeat the tab title ("Projects") as an in-content header;
            // the navigation bar already names the screen.
            HStack {
                Text("Month to Date")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                Spacer()
                Text("\(items.count)")
                    .font(Theme.Typography.captionEmphasis)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(items.count) projects, month to date")

            VStack(spacing: Theme.Spacing.md) {
                ForEach(items) { item in
                    Button {
                        Haptics.tap()
                        onSelect(item)
                    } label: {
                        ProjectBudgetCard(presentation: item)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

/// The provider-agnostic project rollup card at the top of the list.
struct ProjectsRollupCard: View {
    let rollup: ProjectBudgetsRollup

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    Text("All Projects")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                    Text(rollup.totalSpentDisplay)
                        .font(Theme.Typography.hero)
                        .monospacedDigit()
                        .foregroundStyle(Theme.Colors.primaryText)
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                }
                Spacer(minLength: Theme.Spacing.sm)
                if rollup.overBudgetCount > 0 {
                    StatusBadge(
                        "\(rollup.overBudgetCount) over",
                        status: .danger,
                        systemImage: "exclamationmark.octagon.fill"
                    )
                }
            }

            if rollup.hasBudget {
                BudgetMeter(fraction: rollup.fraction, status: rollup.status)
                HStack {
                    Text("of \(rollup.totalBudgetDisplay) budgeted")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                    Spacer()
                    Text("\(rollup.remainingDisplay) left")
                        .font(Theme.Typography.caption)
                        .monospacedDigit()
                        .foregroundStyle(rollup.remaining < 0 ? Theme.Colors.danger : Theme.Colors.secondaryText)
                }
            } else {
                Text("No monthly budgets set yet.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .dsCard()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("All projects. Spent \(rollup.totalSpentDisplay)\(rollup.hasBudget ? " of \(rollup.totalBudgetDisplay)" : "").")
    }
}

/// A soft, non-blocking banner shown when a refresh fails but stale data remains.
struct RefreshErrorBanner: View {
    let error: Networking.APIError

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "wifi.exclamationmark")
                .foregroundStyle(Theme.Colors.warning)
            Text(error.title)
                .font(Theme.Typography.captionEmphasis)
                .foregroundStyle(Theme.Colors.primaryText)
            Spacer(minLength: 0)
            Text("Showing saved data")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.Colors.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(error.title). Showing saved data.")
    }
}

/// One project as a tappable card with an inline budget meter.
struct ProjectBudgetCard: View {
    let presentation: ProjectBudgetPresentation

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.md) {
                monogram
                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    Text(presentation.title)
                        .font(Theme.Typography.callout.weight(.semibold))
                        .foregroundStyle(Theme.Colors.primaryText)
                        .lineLimit(1)
                    Text(presentation.subtitle ?? presentation.statusSummary)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .lineLimit(1)
                }
                Spacer(minLength: Theme.Spacing.sm)
                VStack(alignment: .trailing, spacing: Theme.Spacing.xxs) {
                    Text(presentation.rowValue)
                        .font(Theme.Typography.callout.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.Colors.primaryText)
                    if let caption = presentation.rowCaption {
                        Text(caption)
                            .font(Theme.Typography.caption)
                            .monospacedDigit()
                            .foregroundStyle(presentation.status == .neutral ? Theme.Colors.tertiaryText : presentation.status.tint)
                    }
                }
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }

            if presentation.hasBudget {
                BudgetMeter(fraction: presentation.meterFraction, status: presentation.status)
            }

            if presentation.showsCoverageCaveat || presentation.hasIncompleteAllocation {
                HStack(spacing: Theme.Spacing.sm) {
                    if presentation.showsCoverageCaveat {
                        StatusBadge(presentation.coverage.label, status: presentation.coverageStatus, systemImage: "chart.bar.doc.horizontal")
                    }
                    if presentation.hasIncompleteAllocation {
                        StatusBadge("Allocating", status: .warning, systemImage: "arrow.triangle.2.circlepath")
                    }
                }
            }
        }
        .dsCard()
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint("Opens project detail")
    }

    private var monogram: some View {
        Text(presentation.title.prefix(1).uppercased())
            .font(.subheadline.weight(.bold))
            .foregroundStyle(presentation.status == .neutral ? Theme.Colors.accent : presentation.status.tint)
            .frame(width: 34, height: 34)
            .background(
                presentation.status == .neutral ? Theme.Colors.accentSoft : presentation.status.wash,
                in: RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
            )
    }

    private var accessibilityLabel: String {
        var parts = [presentation.title, presentation.meterDetail]
        if let percent = presentation.percentDisplay { parts.append("\(percent) used") }
        if presentation.isOverBudget { parts.append("over budget") }
        return parts.joined(separator: ", ")
    }
}

// MARK: - Previews

#Preview("List — loaded") {
    NavigationStack {
        ProjectBudgetsContentView(
            phase: .loaded(ProjectBudgetStatus.sampleList.map(ProjectBudgetPresentation.init)),
            rollup: ProjectBudgetsRollup(projects: ProjectBudgetStatus.sampleList),
            lastError: nil,
            onRefresh: {}, onRetry: {}, onSelect: { _ in }
        )
        .navigationTitle("Projects")
            .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview("List — loaded (dark)") {
    NavigationStack {
        ProjectBudgetsContentView(
            phase: .loaded(ProjectBudgetStatus.sampleList.map(ProjectBudgetPresentation.init)),
            rollup: ProjectBudgetsRollup(projects: ProjectBudgetStatus.sampleList),
            lastError: .offline,
            onRefresh: {}, onRetry: {}, onSelect: { _ in }
        )
        .navigationTitle("Projects")
            .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}

#Preview("List — empty") {
    NavigationStack {
        ProjectBudgetsContentView(
            phase: .empty,
            rollup: ProjectBudgetsRollup(projects: []),
            lastError: nil,
            onRefresh: {}, onRetry: {}, onSelect: { _ in }
        )
        .navigationTitle("Projects")
            .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview("List — loading") {
    NavigationStack {
        ProjectBudgetsContentView(
            phase: .loading, rollup: ProjectBudgetsRollup(projects: []),
            lastError: nil, onRefresh: {}, onRetry: {}, onSelect: { _ in }, onAdd: {}
        )
        .navigationTitle("Projects")
            .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview("List — error") {
    NavigationStack {
        ProjectBudgetsContentView(
            phase: .failed(.offline), rollup: ProjectBudgetsRollup(projects: []),
            lastError: nil, onRefresh: {}, onRetry: {}, onSelect: { _ in }, onAdd: {}
        )
        .navigationTitle("Projects")
            .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}
