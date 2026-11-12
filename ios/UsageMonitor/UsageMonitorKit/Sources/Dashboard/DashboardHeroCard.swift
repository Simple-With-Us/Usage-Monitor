import SwiftUI
import DesignSystem
import AppCore
import Models

/// The Dashboard's centerpiece: total month-to-date spend as a hero number, a
/// prominent budget meter, a status badge, and the month-end projection. This is
/// the first thing the user sees, so it carries the account's headline health.
struct DashboardHeroCard: View {
    let data: DashboardViewData
    /// When set, the card is tappable and opens provider budget management.
    var onManageBudgets: (() -> Void)? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var status: Theme.SemanticStatus { .init(data.overallStatus) }

    var body: some View {
        Group {
            if let onManageBudgets {
                Button {
                    Haptics.tap()
                    onManageBudgets()
                } label: {
                    cardContent
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens provider budget settings")
            } else {
                cardContent
            }
        }
    }

    private var cardContent: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            header

            Text(CurrencyFormat.usd(data.totalSpent))
                .font(Theme.Typography.hero)
                .monospacedDigit()
                .foregroundStyle(Theme.Colors.primaryText)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
                .contentTransition(reduceMotion ? .identity : .numericText())
                .copyableValue(CurrencyFormat.usd(data.totalSpent), label: "Total Spent")
                .accessibilityLabel("Total spent this month")
                .accessibilityValue(CurrencyFormat.usd(data.totalSpent))

            if data.hasBudget {
                budgetSection
                budgetBasisCaption
            } else {
                noBudgetSection
            }

            if data.hasIncompleteCoverage {
                coverageCaveat
            }

            if onManageBudgets != nil {
                manageBudgetsFooter
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
        .contentShape(Rectangle())
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .center) {
            Label("Spent This Month", systemImage: "creditcard.fill")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
                .labelStyle(.titleAndIcon)
            Spacer(minLength: Theme.Spacing.sm)
            StatusBadge(statusText, status: status, systemImage: statusSymbol)
        }
    }

    /// Status chip next to the hero — Title Case (heading/chip), not a value.
    private var statusText: String {
        switch data.overallStatus {
        case .exceeded: return "Over Budget"
        case .warning: return "Watch Spend"
        case .ok: return "On Track"
        case .unconfigured: return "No Budget Set"
        }
    }

    private var statusSymbol: String {
        switch data.overallStatus {
        case .exceeded: return "exclamationmark.octagon.fill"
        case .warning: return "gauge.with.dots.needle.67percent"
        case .ok: return "checkmark.circle.fill"
        case .unconfigured: return "slider.horizontal.3"
        }
    }

    // MARK: - Budgeted presentation

    private var budgetSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            BudgetMeter(fraction: data.spentFraction, status: status, height: 14)

            HStack(alignment: .firstTextBaseline) {
                Text("\(CurrencyFormat.percent(data.percentUsedDisplay)) of \(CurrencyFormat.usd(data.totalBudget))")
                    .font(Theme.Typography.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.secondaryText)
                Spacer(minLength: Theme.Spacing.sm)
                remainingLabel
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Budget used")
        .accessibilityValue("\(CurrencyFormat.percent(data.percentUsedDisplay)) of \(CurrencyFormat.usd(data.totalBudget)), \(remainingAccessibility)")
    }

    private var remainingLabel: some View {
        let over = data.remaining < 0
        return Text(over
                    ? "\(CurrencyFormat.usd(abs(data.remaining))) over"
                    : "\(CurrencyFormat.usd(data.remaining)) left")
            .font(Theme.Typography.captionEmphasis)
            .monospacedDigit()
            .foregroundStyle(over ? Theme.Colors.danger : Theme.Colors.secondaryText)
    }

    private var remainingAccessibility: String {
        data.remaining < 0
            ? "\(CurrencyFormat.usd(abs(data.remaining))) over budget"
            : "\(CurrencyFormat.usd(data.remaining)) remaining"
    }

    /// Clarifies that the hero total is the sum of configured provider budgets
    /// (not project budgets or a server-side account cap).
    private var budgetBasisCaption: some View {
        let count = data.configuredProviderCount
        return Text(count == 1
                    ? "Across 1 provider budget"
                    : "Across \(count) provider budgets")
            .font(Theme.Typography.caption)
            .foregroundStyle(Theme.Colors.tertiaryText)
            .accessibilityLabel(count == 1
                                ? "Across 1 provider budget"
                                : "Across \(count) provider budgets")
    }

    // MARK: - Unconfigured presentation

    private var noBudgetSection: some View {
        Text("No monthly budget is configured yet. Tracked spend still appears below and in Providers.")
            .font(Theme.Typography.caption)
            .foregroundStyle(Theme.Colors.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var manageBudgetsFooter: some View {
        HStack(spacing: Theme.Spacing.xs) {
            Text("Manage provider budgets")
                .font(Theme.Typography.captionEmphasis)
                .foregroundStyle(Theme.Colors.accent)
            Spacer(minLength: Theme.Spacing.sm)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.Colors.tertiaryText)
        }
        .padding(.top, Theme.Spacing.xxs)
        .accessibilityHidden(true)
    }

    // MARK: - Coverage caveat

    private var coverageCaveat: some View {
        Label("Some spend may be incomplete — coverage is still syncing.", systemImage: "info.circle")
            .font(Theme.Typography.caption)
            .foregroundStyle(Theme.Colors.warning)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel("Some spend may be incomplete. Coverage is still syncing.")
    }
}

#Preview("Hero — over budget", traits: .sizeThatFitsLayout) {
    DashboardHeroCard(data: DashboardViewData(.sample))
        .padding()
        .background(Theme.Colors.background)
}

#Preview("Hero — on track", traits: .sizeThatFitsLayout) {
    let response = BudgetStatusResponse(
        ok: true,
        generatedAt: "2026-07-12T09:15:00.000Z",
        month: "2026-07",
        providers: [.sampleOk],
        projects: nil,
        summary: BudgetSummary(
            totalBudgetUsd: 200, budgetedSpentUsd: 96.2, unbudgetedSpentUsd: 0,
            totalSpentUsd: 96.2, estimatedApiEquivalentUsd: 140, remainingUsd: 103.8,
            percentUsed: 0.481, overBudget: false, warning: false
        )
    )
    return DashboardHeroCard(data: DashboardViewData(response))
        .padding()
        .background(Theme.Colors.background)
        .preferredColorScheme(.dark)
}
