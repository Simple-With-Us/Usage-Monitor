import SwiftUI
import Models
import AppCore
import DesignSystem

/// The tap-through destination from an alert: the owning provider's budget
/// context plus the full list of that provider's alerts.
///
/// Self-contained within the Alerts lane — it reads the shared `BudgetStore`
/// (never a per-provider fetch, which the bearer-token API can't serve anyway)
/// and is built only from DesignSystem components. It takes a `fallback`
/// snapshot captured at navigation time so it always renders even if the
/// provider momentarily drops out of a refreshed response.
struct ProviderAlertDetailView: View {
    let providerId: String
    let fallback: ProviderBudgetStatus

    @Environment(BudgetStore.self) private var store

    /// Prefer the freshest copy from the store; fall back to the navigated snapshot.
    private var provider: ProviderBudgetStatus {
        store.providers.first { $0.id == providerId } ?? fallback
    }

    private var status: Theme.SemanticStatus { .init(provider.status) }

    private var sortedAlerts: [ProviderAlert] {
        provider.alerts.sorted { $0.severity.order < $1.severity.order }
    }

    var body: some View {
        RefreshableScrollView(onRefresh: { await store.refresh() }) {
            header

            if provider.hasBudget {
                budgetCard
            }

            statsGrid

            if let records = provider.externalBilling, !records.isEmpty {
                ProviderAlertBreakdownCard(
                    providerTitle: provider.title,
                    records: records
                )
            }

            alertsSection
        }
        .navigationTitle(provider.title)
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack(spacing: Theme.Spacing.md) {
                Text(provider.title.prefix(1).uppercased())
                    .font(.title2.weight(.bold))
                    .foregroundStyle(status == .neutral ? Theme.Colors.accent : status.tint)
                    .frame(width: 48, height: 48)
                    .background(
                        (status == .neutral ? Theme.Colors.accentSoft : status.wash),
                        in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    )

                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    Text(provider.title)
                        .font(Theme.Typography.title)
                        .foregroundStyle(Theme.Colors.primaryText)
                    Text(provider.alerts.isEmpty ? "No active alerts" : "\(provider.alerts.count) active alert\(provider.alerts.count == 1 ? "" : "s")")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                Spacer(minLength: 0)
            }

            HStack(spacing: Theme.Spacing.sm) {
                StatusBadge(statusLabel, status: status, systemImage: statusSymbol)
                if !provider.spendCoverage.isComplete {
                    StatusBadge(provider.spendCoverage.label, status: .init(coverage: provider.spendCoverage), systemImage: "chart.bar.doc.horizontal")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    private var budgetCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            LabeledBudgetMeter(
                title: "Monthly budget",
                detail: budgetDetail,
                fraction: fraction,
                status: status
            )
            if let percentUsed = provider.percentUsed {
                Text("\(CurrencyFormat.percent(percentUsed)) of budget used")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    private var statsGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: Theme.Spacing.md) {
            StatTile(
                label: "Spent",
                value: CurrencyFormat.usd(provider.spentUsd),
                systemImage: "creditcard.fill",
                status: status
            )
            StatTile(
                label: "Projected EOM",
                value: CurrencyFormat.usd(provider.projectedEomUsd),
                systemImage: "chart.line.uptrend.xyaxis"
            )
            if provider.hasBudget, let remaining = provider.remainingUsd {
                StatTile(
                    label: remaining < 0 ? "Over Budget" : "Remaining",
                    value: CurrencyFormat.usd(abs(remaining)),
                    systemImage: remaining < 0 ? "exclamationmark.triangle.fill" : "banknote",
                    status: remaining < 0 ? .danger : .ok
                )
            } else if !provider.hasBudget {
                StatTile(
                    label: "Budget",
                    value: "no budget set",
                    systemImage: "banknote",
                    status: .neutral
                )
            }
            if let budget = provider.monthlyBudgetUsd, budget > 0 {
                StatTile(
                    label: "Budget",
                    value: CurrencyFormat.usd(budget),
                    systemImage: "target"
                )
            }
        }
    }

    @ViewBuilder private var alertsSection: some View {
        if sortedAlerts.isEmpty {
            EmptyState(
                systemImage: "checkmark.circle.fill",
                title: "No active alerts",
                message: "This provider is clear. Pull to refresh for the latest."
            )
            .dsCard()
        } else {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                SectionHeader("Alerts") {
                    Text("\(sortedAlerts.count)")
                        .font(Theme.Typography.captionEmphasis)
                        .foregroundStyle(status.tint)
                }
                VStack(spacing: 0) {
                    ForEach(Array(sortedAlerts.enumerated()), id: \.element.id) { index, alert in
                        AlertDetailRow(alert: alert)
                        if index < sortedAlerts.count - 1 {
                            Divider().padding(.leading, 44)
                        }
                    }
                }
                .dsCard(padding: Theme.Spacing.md)
            }
        }
    }

    // MARK: - Derived text

    private var fraction: Double {
        if let percentUsed = provider.percentUsed { return percentUsed }
        guard let budget = provider.monthlyBudgetUsd, budget > 0 else { return 0 }
        return provider.spentUsd / budget
    }

    private var budgetDetail: String {
        guard let budget = provider.monthlyBudgetUsd else { return CurrencyFormat.usd(provider.spentUsd) }
        return "\(CurrencyFormat.usd(provider.spentUsd)) / \(CurrencyFormat.usd(budget))"
    }

    private var statusLabel: String {
        switch provider.status {
        case .ok: return "On Track"
        case .warning: return "Approaching Budget"
        case .exceeded: return "Over Budget"
        case .unconfigured: return "No Budget Set"
        }
    }

    private var statusSymbol: String {
        switch provider.status {
        case .ok: return "checkmark.circle.fill"
        case .warning: return "gauge.with.dots.needle.67percent"
        case .exceeded: return "exclamationmark.octagon.fill"
        case .unconfigured: return "questionmark.circle"
        }
    }
}
