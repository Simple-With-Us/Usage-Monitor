import SwiftUI
import DesignSystem
import AppCore
import Models
import ProjectBudgets

/// The loaded Dashboard: hero, key stats, month-pace forecast, attention peek,
/// and top providers, composed into the standard scrolling screen. Pure
/// presentation over a `DashboardViewData` — no loading/error logic lives here.
struct DashboardContentView: View {
    let data: DashboardViewData
    let generatedAt: Date?
    /// Cross-tab open of a provider detail (wired by `DashboardRootView` via
    /// `AppEnvironment.openProvider`). Optional so previews stay standalone.
    var onSelectProvider: ((String) -> Void)? = nil
    /// Opens Settings → provider inventory to edit monthly budgets.
    var onManageBudgets: (() -> Void)? = nil
    /// Optional project rollup for a second budget lens (distinct from provider totals).
    var projectRollup: ProjectBudgetsRollup? = nil
    /// Jump to the Projects tab for project budget detail.
    var onOpenProjects: (() -> Void)? = nil

    private let columns = [
        GridItem(.flexible(), spacing: Theme.Spacing.md),
        GridItem(.flexible(), spacing: Theme.Spacing.md),
    ]

    var body: some View {
        DashboardHeroCard(data: data, onManageBudgets: onManageBudgets)

        if let rollup = projectRollup, rollup.budgetedCount + rollup.unbudgetedCount > 0 {
            ProjectBudgetsOverviewCard(rollup: rollup, onOpen: onOpenProjects)
        }

        statsGrid

        if data.projectedEom > 0.005 {
            ProjectedCostBreakdownCard(data: data)
        }

        if let pace = spendPace {
            SpendPaceChart(pace: pace, status: .init(data.projectionStatus))
        }

        if !attentionProviders.isEmpty {
            AttentionCard(providers: attentionProviders, onSelectProvider: onSelectProvider)
        }

        if !topProviders.isEmpty {
            TopProvidersCard(
                providers: topProviders,
                totalCount: data.providers.count,
                onSelectProvider: onSelectProvider
            )
        }
    }

    // MARK: - Stat tiles

    private var statsGrid: some View {
        LazyVGrid(columns: columns, spacing: Theme.Spacing.md) {
            StatTile(
                label: "Projected End of Month",
                value: CurrencyFormat.compactUSD(data.projectedEom),
                secondary: projectedSecondary,
                systemImage: "chart.line.uptrend.xyaxis",
                status: .init(data.projectionStatus)
            )

            // Without a configured budget, remaining = 0 − spent (negative) and
            // must not show a dollar "Over Budget" figure — value is the answer
            // "no budget set" (sentence case per fleet UI copy rules).
            if data.hasBudget {
                StatTile(
                    label: data.remaining < 0 ? "Over Budget" : "Remaining",
                    value: CurrencyFormat.compactUSD(abs(data.remaining)),
                    secondary: "of \(CurrencyFormat.compactUSD(data.totalBudget))",
                    systemImage: data.remaining < 0 ? "exclamationmark.triangle.fill" : "banknote",
                    status: data.remaining < 0 ? .danger : .ok
                )
            } else {
                StatTile(
                    label: "Budget",
                    value: "no budget set",
                    secondary: nil,
                    systemImage: "banknote",
                    status: .neutral
                )
            }

            StatTile(
                label: "Needs Attention",
                value: "\(data.overBudgetProviders.count + data.warningProviders.count)",
                secondary: attentionSecondary,
                systemImage: "bell.badge",
                status: attentionStatus
            )

            if data.hasApiEquivalentSavings {
                StatTile(
                    label: "Saved vs API Rates",
                    value: CurrencyFormat.compactUSD(data.apiEquivalentSavings),
                    secondary: "vs \(CurrencyFormat.compactUSD(data.estimatedApiEquivalent))",
                    systemImage: "sparkles",
                    status: .ok
                )
            } else {
                StatTile(
                    label: "Providers Tracked",
                    value: "\(data.providers.count)",
                    secondary: "\(data.configuredProviderCount) with budgets",
                    systemImage: "square.grid.2x2",
                    status: .neutral
                )
            }
        }
    }

    private var projectedSecondary: String? {
        // Prefer the two-part composition so users see subscriptions are included
        // (or still missing from server data), not only budget over/under.
        // Secondary lines are *values* → sentence/lower case (ST fleet rule).
        if data.hasSubscriptionProjectionComponent {
            return "usage + subscriptions"
        }
        if data.projectedVariableUsage > 0.005 {
            return "usage pace"
        }
        guard data.hasBudget, let overage = data.projectedOverageFraction else { return nil }
        if overage > 0 {
            return "+\(CurrencyFormat.percent(overage)) over"
        }
        return "\(CurrencyFormat.percent(abs(overage))) under"
    }

    private var attentionSecondary: String {
        let over = data.overBudgetProviders.count
        if over > 0 { return over == 1 ? "1 over budget" : "\(over) over budget" }
        if data.warningProviders.isEmpty { return "all on track" }
        return data.warningProviders.count == 1 ? "1 approaching" : "\(data.warningProviders.count) approaching"
    }

    private var attentionStatus: Theme.SemanticStatus {
        if !data.overBudgetProviders.isEmpty { return .danger }
        if !data.warningProviders.isEmpty { return .warning }
        return .ok
    }

    // MARK: - Derived collections

    private var topProviders: [ProviderBudgetStatus] { data.topProviders(limit: 5) }

    /// Over-budget first, then approaching — the providers worth surfacing.
    private var attentionProviders: [ProviderBudgetStatus] {
        (data.overBudgetProviders + data.warningProviders).prefix(4).map { $0 }
    }

    private var spendPace: SpendPace? {
        SpendPace.make(
            month: data.response.month,
            generatedAt: generatedAt,
            spent: data.totalSpent,
            projected: data.projectedEom,
            budget: data.totalBudget
        )
    }
}

/// Compact project-budget rollup on Overview — separate from the provider-scoped
/// hero card so the two budget lenses are never summed or double-counted.
private struct ProjectBudgetsOverviewCard: View {
    let rollup: ProjectBudgetsRollup
    var onOpen: (() -> Void)?

    var body: some View {
        Group {
            if let onOpen {
                Button {
                    Haptics.tap()
                    onOpen()
                } label: {
                    cardBody
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens project budgets")
            } else {
                cardBody
            }
        }
    }

    private var cardBody: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(alignment: .firstTextBaseline) {
                Label("Project Budgets", systemImage: "folder.fill")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .labelStyle(.titleAndIcon)
                Spacer(minLength: Theme.Spacing.sm)
                if onOpen != nil {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.Colors.tertiaryText)
                }
            }

            Text(rollup.totalSpentDisplay)
                .font(Theme.Typography.title)
                .monospacedDigit()
                .foregroundStyle(Theme.Colors.primaryText)

            if rollup.hasBudget {
                BudgetMeter(fraction: rollup.fraction, status: rollup.status)
                HStack {
                    Text("of \(rollup.totalBudgetDisplay) across projects")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                    Spacer()
                    Text("\(rollup.remainingDisplay) left")
                        .font(Theme.Typography.caption)
                        .monospacedDigit()
                        .foregroundStyle(rollup.remaining < 0 ? Theme.Colors.danger : Theme.Colors.secondaryText)
                }
            } else {
                Text("No project monthly budgets set yet.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }

            Text("Project totals are separate from provider budgets above.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.tertiaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Project budgets. Spent \(rollup.totalSpentDisplay).")
    }
}

/// Explicit two-part EOM projection: paced usage + fixed accrued + known renewals.
/// Matches web `ProjectedCostBreakdownModal` / server `projectedEomUsd` composition.
struct ProjectedCostBreakdownCard: View {
    let data: DashboardViewData

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(
                "Projected End of Month",
                subtitle: "Usage paced to month end + known subscription charges"
            )

            Text(CurrencyFormat.usd(data.projectedEom))
                .font(Theme.Typography.hero)
                .monospacedDigit()
                .foregroundStyle(Theme.Colors.primaryText)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
                .accessibilityLabel("Projected end of month \(CurrencyFormat.usd(data.projectedEom))")

            VStack(spacing: Theme.Spacing.sm) {
                breakdownRow(
                    label: "Usage (Extrapolated)",
                    detail: "Variable spend paced across the UTC month",
                    value: data.projectedVariableUsage
                )
                breakdownRow(
                    label: "Fixed Accrued MTD",
                    detail: "Subscription and fixed charges already on the books",
                    value: data.projectedFixedAccrued
                )
                breakdownRow(
                    label: "Known Renewals Remaining",
                    detail: "Scheduled subscription bills still due this month",
                    value: data.projectedKnownRenewals
                )
            }

            if !data.hasSubscriptionProjectionComponent {
                Text("No remaining subscription renewals are scheduled in this projection. Active Subscriptions with a next bill date will appear here even before they charge.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Combined total = usage pace + fixed accrued + known renewals. Budgets stay month-to-date.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    private func breakdownRow(label: String, detail: String, value: Double) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(Theme.Typography.callout.weight(.medium))
                    .foregroundStyle(Theme.Colors.primaryText)
                Text(detail)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: Theme.Spacing.sm)
            Text(CurrencyFormat.usd(value))
                .font(Theme.Typography.callout.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(Theme.Colors.primaryText)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label) \(CurrencyFormat.usd(value))")
    }
}

/// A compact "Needs attention" card summarizing providers that are over or
/// approaching their budget, with their most severe alert reason.
private struct AttentionCard: View {
    let providers: [ProviderBudgetStatus]
    var onSelectProvider: ((String) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Needs Attention")

            VStack(spacing: Theme.Spacing.sm) {
                ForEach(providers) { provider in
                    Button {
                        Haptics.tap()
                        onSelectProvider?(provider.id)
                    } label: {
                        HStack(spacing: Theme.Spacing.sm) {
                            ProviderMonogram(
                                title: provider.title,
                                status: .init(provider.status),
                                size: 28
                            )

                            VStack(alignment: .leading, spacing: 1) {
                                Text(provider.title)
                                    .font(Theme.Typography.callout.weight(.medium))
                                    .foregroundStyle(Theme.Colors.primaryText)
                                    .lineLimit(1)
                                if let reason = provider.mostSevereAlert?.message ?? attentionFallback(provider) {
                                    Text(reason)
                                        .font(Theme.Typography.caption)
                                        .foregroundStyle(Theme.Colors.secondaryText)
                                        .lineLimit(2)
                                        .multilineTextAlignment(.leading)
                                }
                            }
                            Spacer(minLength: Theme.Spacing.sm)
                            if let percent = provider.percentUsed {
                                Text(CurrencyFormat.percent(percent))
                                    .font(Theme.Typography.captionEmphasis)
                                    .monospacedDigit()
                                    .foregroundStyle(Theme.SemanticStatus(provider.status).tint)
                            }
                            if onSelectProvider != nil {
                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(Theme.Colors.tertiaryText)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(onSelectProvider == nil)
                    .accessibilityElement(children: .combine)
                    .accessibilityHint(onSelectProvider == nil ? "" : "Opens provider detail")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    private func attentionFallback(_ provider: ProviderBudgetStatus) -> String? {
        switch provider.status {
        case .exceeded: return "Over its monthly budget."
        case .warning: return "Approaching its monthly budget."
        default: return nil
        }
    }
}

#Preview("Content", traits: .sizeThatFitsLayout) {
    ScrollView {
        VStack(spacing: Theme.Spacing.lg) {
            DashboardContentView(
                data: DashboardViewData(.sample),
                generatedAt: BudgetStatusResponse.sample.generatedAtDate
            )
        }
        .padding()
    }
    .background(Theme.Colors.background)
}

#Preview("Content (dark)", traits: .sizeThatFitsLayout) {
    ScrollView {
        VStack(spacing: Theme.Spacing.lg) {
            DashboardContentView(
                data: DashboardViewData(.sample),
                generatedAt: BudgetStatusResponse.sample.generatedAtDate
            )
        }
        .padding()
    }
    .background(Theme.Colors.background)
    .preferredColorScheme(.dark)
}
