import SwiftUI
import DesignSystem
import Models

/// Detail for one project budget: a headline meter, a spend breakdown (direct
/// vs. allocated), projection, remaining, and data-quality caveats. An Edit
/// button opens the add/edit form seeded with this project.
struct ProjectBudgetDetailView: View {
    let presentation: ProjectBudgetPresentation
    /// `nil` hides Edit — project mutation is not available on the bearer API.
    var onEdit: (() -> Void)? = nil

    var body: some View {
        RefreshableScrollView(onRefresh: {}) {
            header
            meterCard
            breakdownCard
            if presentation.showsCoverageCaveat || presentation.hasIncompleteAllocation {
                caveatsCard
            }
        }
        .navigationTitle(presentation.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let onEdit {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Haptics.tap()
                        onEdit()
                    } label: {
                        Text("Edit")
                    }
                }
            }
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            if let subtitle = presentation.subtitle {
                Text(subtitle)
                    .font(Theme.Typography.callout)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            HStack(spacing: Theme.Spacing.sm) {
                StatusBadge(
                    presentation.statusSummary,
                    status: presentation.status,
                    systemImage: statusSymbol
                )
                if presentation.isOverBudget {
                    StatusBadge("Over Budget", status: .danger, systemImage: "exclamationmark.octagon.fill")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var statusSymbol: String {
        switch presentation.status {
        case .danger: return "exclamationmark.octagon.fill"
        case .warning: return "gauge.with.dots.needle.67percent"
        case .ok: return "checkmark.circle.fill"
        case .neutral: return "minus.circle"
        }
    }

    // MARK: Meter

    private var meterCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            if presentation.hasBudget {
                LabeledBudgetMeter(
                    title: "Spend vs budget",
                    detail: presentation.meterDetail,
                    fraction: presentation.meterFraction,
                    status: presentation.status
                )
                HStack {
                    if let percent = presentation.percentDisplay {
                        Text("\(percent) used")
                            .font(Theme.Typography.caption)
                            .monospacedDigit()
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                    Spacer()
                    if let remaining = presentation.remainingDisplay {
                        Text("\(remaining) remaining")
                            .font(Theme.Typography.caption)
                            .monospacedDigit()
                            .foregroundStyle(presentation.isOverBudget ? Theme.Colors.danger : Theme.Colors.secondaryText)
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text("Spent this month")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                    Text(presentation.spentDisplay)
                        .font(Theme.Typography.hero)
                        .monospacedDigit()
                        .foregroundStyle(Theme.Colors.primaryText)
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                    Text("No monthly budget set. Tap Edit to add one.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.tertiaryText)
                }
            }
        }
        .dsCard()
    }

    // MARK: Breakdown

    private var breakdownCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Breakdown", subtitle: "Where this month's spend comes from")

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: Theme.Spacing.md) {
                StatTile(
                    label: "Spent",
                    value: presentation.spentDisplay,
                    secondary: presentation.percentDisplay.map { "\($0) of budget" },
                    systemImage: "creditcard.fill",
                    status: presentation.status
                )
                StatTile(
                    label: "Projected",
                    value: presentation.projectedDisplay,
                    secondary: "end of month",
                    systemImage: "chart.line.uptrend.xyaxis",
                    status: projectedStatus
                )
                if let direct = presentation.directDisplay {
                    StatTile(
                        label: "Direct usage",
                        value: direct,
                        secondary: "attributed to project",
                        systemImage: "arrow.down.right.circle"
                    )
                }
                if let allocated = presentation.allocatedDisplay {
                    StatTile(
                        label: "Allocated",
                        value: allocated,
                        secondary: "from shared providers",
                        systemImage: "arrow.triangle.branch"
                    )
                }
                if presentation.hasBudget, let budget = presentation.budgetDisplay {
                    StatTile(
                        label: "Monthly budget",
                        value: budget,
                        systemImage: "target"
                    )
                }
                if let remaining = presentation.remainingDisplay {
                    StatTile(
                        label: "Remaining",
                        value: remaining,
                        systemImage: "banknote",
                        status: presentation.isOverBudget ? .danger : .ok
                    )
                }
            }
        }
    }

    private var projectedStatus: Theme.SemanticStatus {
        guard let budget = presentation.monthlyBudget, budget > 0 else { return .neutral }
        if presentation.projectedEndOfMonth > budget { return .danger }
        if presentation.projectedEndOfMonth >= budget * 0.8 { return .warning }
        return .ok
    }

    // MARK: Caveats

    private var caveatsCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Data quality")
            if presentation.showsCoverageCaveat {
                CaveatRow(
                    symbol: "chart.bar.doc.horizontal",
                    status: presentation.coverageStatus,
                    title: "\(presentation.coverage.label) spend coverage",
                    message: "Some spend for this project may not be fully reported yet, so the total could rise."
                )
            }
            if presentation.hasIncompleteAllocation {
                CaveatRow(
                    symbol: "arrow.triangle.2.circlepath",
                    status: .warning,
                    title: "Allocation in progress",
                    message: presentation.incompleteAllocationMessage
                )
            }
        }
        .dsCard()
    }
}

/// A titled caveat with an icon and explanatory copy.
private struct CaveatRow: View {
    let symbol: String
    let status: Theme.SemanticStatus
    let title: String
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.md) {
            Image(safeSystemName: symbol, fallback: "info.circle")
                .font(.body.weight(.semibold))
                .foregroundStyle(status.tint)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(title)
                    .font(Theme.Typography.callout.weight(.semibold))
                    .foregroundStyle(Theme.Colors.primaryText)
                Text(message)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Previews

#Preview("Detail — warning") {
    NavigationStack {
        ProjectBudgetDetailView(presentation: ProjectBudgetPresentation(.sampleTrade), onEdit: {})
    }
}

#Preview("Detail — on track (dark)") {
    NavigationStack {
        ProjectBudgetDetailView(presentation: ProjectBudgetPresentation(.sampleMonitor), onEdit: {})
    }
    .preferredColorScheme(.dark)
}

#Preview("Detail — no budget") {
    NavigationStack {
        ProjectBudgetDetailView(
            presentation: ProjectBudgetPresentation(
                ProjectBudgetStatus(
                    id: "proj_np",
                    name: "Prototype",
                    description: "Not yet budgeted",
                    spentUsd: 63.20,
                    projectedEomUsd: 98.00,
                    spendCoverage: .partial,
                    directUsd: 63.20,
                    incompleteAllocatedProviderCount: 2,
                    status: .unconfigured
                )
            ),
            onEdit: {}
        )
    }
}
