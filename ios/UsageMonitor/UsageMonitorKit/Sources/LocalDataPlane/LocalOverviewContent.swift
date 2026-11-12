import SwiftUI
import DesignSystem
import LocalBudget

/// Overview body that mirrors remote/web Dashboard structure as closely as
/// on-device money-truth allows (no OTLP intelligence, no fleet ops).
struct LocalOverviewContent: View {
    let summary: BudgetEngine.Summary
    let alertCount: Int
    var needsKeyCount: Int = 0
    var onOpenProvider: (String) -> Void
    var onOpenAlerts: () -> Void
    var onAddProvider: () -> Void
    var onShowNeedsKey: (() -> Void)? = nil

    private let columns = [
        GridItem(.flexible(), spacing: Theme.Spacing.md),
        GridItem(.flexible(), spacing: Theme.Spacing.md),
    ]

    private var activeOrSpending: [BudgetEngine.ProviderSpend] {
        summary.providers.filter {
            $0.spentUsd > 0.000_5 || $0.pollVariableUsd > 0.000_5 || $0.isActive
        }
    }

    private var attentionRows: [BudgetEngine.ProviderSpend] {
        (summary.providers.filter { $0.level == .exceeded }
            + summary.providers.filter { $0.level == .warning })
            .prefix(4)
            .map { $0 }
    }

    private var topSpend: [BudgetEngine.ProviderSpend] {
        Array(activeOrSpending.prefix(6))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            if needsKeyCount > 0 {
                connectAccountsBanner
            }
            heroCard
            statsGrid

            if summary.totalProjectedEomUsd > 0.005 {
                projectionBreakdown
            }

            if !attentionRows.isEmpty {
                attentionCard
            }

            if !topSpend.isEmpty {
                topProvidersSection
            }
        }
    }

    private var connectAccountsBanner: some View {
        Button {
            Haptics.tap()
            onShowNeedsKey?()
        } label: {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                Image(systemName: "key.fill")
                    .foregroundStyle(Theme.Colors.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Connect Accounts")
                        .font(Theme.Typography.captionEmphasis)
                        .foregroundStyle(Theme.Colors.primaryText)
                    Text("\(needsKeyCount) restored card\(needsKeyCount == 1 ? "" : "s") still need an API key.  Open a provider and tap Connect Account.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }
            .padding(Theme.Spacing.md)
            .background(Theme.Colors.accentSoft, in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityHint("Shows providers that still need a key")
    }

    // MARK: - Hero (web DashboardHero parity)

    private var heroCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            HStack {
                Label("Spent This Month", systemImage: "creditcard.fill")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                Spacer()
                StatusBadge(heroStatusLabel, status: heroStatus, systemImage: heroStatusSymbol)
            }

            Text(CurrencyFormat.usd(summary.totalSpentUsd))
                .font(Theme.Typography.hero)
                .monospacedDigit()
                .foregroundStyle(Theme.Colors.primaryText)
                .minimumScaleFactor(0.6)
                .lineLimit(1)

            if summary.hasBudget, let budget = summary.totalBudgetUsd {
                BudgetMeter(
                    fraction: summary.totalSpentUsd / budget,
                    status: heroStatus,
                    height: 14
                )
                HStack {
                    Text("\(CurrencyFormat.percent(summary.totalSpentUsd / budget)) of \(CurrencyFormat.usd(budget))")
                        .font(Theme.Typography.caption)
                        .monospacedDigit()
                        .foregroundStyle(Theme.Colors.secondaryText)
                    Spacer()
                    if let rem = summary.remainingUsd {
                        Text(rem < 0
                             ? "\(CurrencyFormat.usd(abs(rem))) over"
                             : "\(CurrencyFormat.usd(rem)) left")
                            .font(Theme.Typography.captionEmphasis)
                            .monospacedDigit()
                            .foregroundStyle(rem < 0 ? Theme.Colors.danger : Theme.Colors.secondaryText)
                    }
                }
                Text(summary.configuredBudgetCount == 1
                     ? "Across 1 provider budget"
                     : "Across \(summary.configuredBudgetCount) provider budgets")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
            } else {
                Text("no budget set")
                    .font(Theme.Typography.callout.weight(.semibold))
                    .foregroundStyle(Theme.Colors.secondaryText)
                Text("Open a provider to add a monthly budget.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }

            Text("API poll totals often omit tax. Subscription fees you enter are exact.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.tertiaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    private var heroStatus: Theme.SemanticStatus {
        if summary.exceededCount > 0 || summary.overBudget { return .danger }
        if summary.warningCount > 0 { return .warning }
        if !summary.hasBudget { return .neutral }
        return .ok
    }

    private var heroStatusLabel: String {
        switch heroStatus {
        case .danger: return "Over Budget"
        case .warning: return "Watch Spend"
        case .ok: return "On Track"
        default: return "No Budget Set"
        }
    }

    private var heroStatusSymbol: String {
        switch heroStatus {
        case .danger: return "exclamationmark.octagon.fill"
        case .warning: return "gauge.with.dots.needle.67percent"
        case .ok: return "checkmark.circle.fill"
        default: return "slider.horizontal.3"
        }
    }

    // MARK: - Stats (web/remote Overview tiles)

    private var statsGrid: some View {
        LazyVGrid(columns: columns, spacing: Theme.Spacing.md) {
            StatTile(
                label: "Projected End of Month",
                value: summary.totalProjectedEomUsd > 0.005
                    ? CurrencyFormat.compactUSD(summary.totalProjectedEomUsd)
                    : "—",
                secondary: projectionSecondary,
                systemImage: "chart.line.uptrend.xyaxis",
                status: projectedStatus
            )

            if summary.hasBudget, let rem = summary.remainingUsd {
                StatTile(
                    label: rem < 0 ? "Over Budget" : "Remaining",
                    value: CurrencyFormat.compactUSD(abs(rem)),
                    secondary: summary.totalBudgetUsd.map { "of \(CurrencyFormat.compactUSD($0))" },
                    systemImage: rem < 0 ? "exclamationmark.triangle.fill" : "banknote",
                    status: rem < 0 ? .danger : .ok
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
                value: "\(summary.exceededCount + summary.warningCount)",
                secondary: attentionSecondary,
                systemImage: "bell.badge",
                status: summary.exceededCount > 0
                    ? .danger
                    : (summary.warningCount > 0 ? .warning : .ok)
            )

            StatTile(
                label: "Providers Tracked",
                value: "\(summary.providers.count)",
                secondary: "\(summary.configuredBudgetCount) with budgets",
                systemImage: "square.grid.2x2",
                status: .neutral
            )
        }
    }

    private var projectionSecondary: String? {
        if summary.hasSubscriptionProjectionComponent { return "usage + subscriptions" }
        if summary.totalPacedVariableUsd > 0.005 { return "usage pace" }
        return nil
    }

    private var projectedStatus: Theme.SemanticStatus {
        guard summary.hasBudget, let budget = summary.totalBudgetUsd, budget > 0 else { return .neutral }
        let p = summary.totalProjectedEomUsd
        if p > budget { return .danger }
        if p > budget * 0.9 { return .warning }
        return .ok
    }

    private var attentionSecondary: String {
        if summary.exceededCount > 0 {
            return summary.exceededCount == 1 ? "1 over budget" : "\(summary.exceededCount) over budget"
        }
        if summary.warningCount == 0 { return "all on track" }
        return summary.warningCount == 1 ? "1 approaching" : "\(summary.warningCount) approaching"
    }

    // MARK: - Projection breakdown (web modal parity)

    private var projectionBreakdown: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(
                "Projected End of Month",
                subtitle: "Usage paced to month end + known subscription charges"
            )
            Text(CurrencyFormat.usd(summary.totalProjectedEomUsd))
                .font(Theme.Typography.hero)
                .monospacedDigit()
                .foregroundStyle(Theme.Colors.primaryText)
                .minimumScaleFactor(0.7)
                .lineLimit(1)

            breakdownRow(
                "Usage (Extrapolated)",
                "Variable poll spend paced across the UTC month",
                summary.totalPacedVariableUsd
            )
            breakdownRow(
                "Fixed Accrued MTD",
                "Subscription charges and plan fixed already booked",
                summary.totalFixedAccruedUsd
            )
            breakdownRow(
                "Known Renewals Remaining",
                "Scheduled subscription bills still due this month",
                summary.totalRemainingScheduledUsd
            )

            if !summary.hasSubscriptionProjectionComponent {
                Text("No remaining subscription renewals are scheduled. Add recurring fees on a provider so future charges appear here.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            } else {
                Text("Combined total = usage pace + fixed accrued + known renewals.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    private func breakdownRow(_ label: String, _ detail: String, _ value: Double) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(Theme.Typography.callout.weight(.medium))
                Text(detail)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            Spacer(minLength: Theme.Spacing.sm)
            Text(CurrencyFormat.usd(value))
                .font(Theme.Typography.callout.weight(.semibold))
                .monospacedDigit()
        }
    }

    // MARK: - Attention

    private var attentionCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Needs Attention") {
                if alertCount > 0 {
                    Button("View All", action: onOpenAlerts)
                        .font(Theme.Typography.caption.weight(.semibold))
                }
            }
            ForEach(attentionRows, id: \.providerId) { row in
                Button {
                    onOpenProvider(row.providerId)
                } label: {
                    HStack(spacing: Theme.Spacing.sm) {
                        ProviderMonogram(
                            title: row.displayName,
                            status: semantic(for: row.level),
                            size: 28
                        )
                        VStack(alignment: .leading, spacing: 1) {
                            Text(row.displayName)
                                .font(Theme.Typography.callout.weight(.medium))
                                .foregroundStyle(Theme.Colors.primaryText)
                            Text(attentionReason(row))
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.secondaryText)
                                .lineLimit(2)
                        }
                        Spacer()
                        if let pct = row.percentUsed {
                            Text(CurrencyFormat.percent(pct))
                                .font(Theme.Typography.captionEmphasis)
                                .monospacedDigit()
                                .foregroundStyle(semantic(for: row.level).tint)
                        }
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Theme.Colors.tertiaryText)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    private func attentionReason(_ row: BudgetEngine.ProviderSpend) -> String {
        switch row.level {
        case .exceeded: return "Over its monthly budget."
        case .warning: return "Approaching its monthly budget."
        default: return row.statusNote ?? "Needs review."
        }
    }

    // MARK: - Top providers

    private var topProvidersSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Top Providers", subtitle: "Month to date")
            ForEach(topSpend, id: \.providerId) { row in
                Button {
                    onOpenProvider(row.providerId)
                } label: {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        HStack {
                            ProviderMonogram(
                                title: row.displayName,
                                status: semantic(for: row.level),
                                size: 32
                            )
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.displayName)
                                    .font(Theme.Typography.callout.weight(.semibold))
                                    .foregroundStyle(Theme.Colors.primaryText)
                                Text(compositionCaption(row))
                                    .font(Theme.Typography.caption)
                                    .foregroundStyle(Theme.Colors.tertiaryText)
                                    .lineLimit(1)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 2) {
                                Text(CurrencyFormat.usd(row.spentUsd))
                                    .font(Theme.Typography.callout.weight(.semibold))
                                    .monospacedDigit()
                                    .foregroundStyle(Theme.Colors.primaryText)
                                if let pct = row.percentUsed {
                                    Text(CurrencyFormat.percent(pct))
                                        .font(Theme.Typography.caption)
                                        .monospacedDigit()
                                        .foregroundStyle(semantic(for: row.level).tint)
                                } else {
                                    Text("no budget")
                                        .font(Theme.Typography.caption)
                                        .foregroundStyle(Theme.Colors.tertiaryText)
                                }
                            }
                        }
                        if row.hasBudget, let b = row.monthlyBudgetUsd, b > 0 {
                            BudgetMeter(
                                fraction: row.spentUsd / b,
                                status: semantic(for: row.level)
                            )
                        }
                    }
                    .dsCard(padding: Theme.Spacing.md)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func compositionCaption(_ row: BudgetEngine.ProviderSpend) -> String {
        var parts: [String] = []
        if row.pollVariableUsd > 0.005 {
            parts.append("usage \(CurrencyFormat.compactUSD(row.pollVariableUsd))")
        }
        if row.subscriptionChargesUsd > 0.005 {
            parts.append("subs \(CurrencyFormat.compactUSD(row.subscriptionChargesUsd))")
        }
        if row.planFixedUsd > 0.005 {
            parts.append("fixed \(CurrencyFormat.compactUSD(row.planFixedUsd))")
        }
        if let proj = row.projectedEomUsd, proj > row.spentUsd + 0.005 {
            parts.append("proj \(CurrencyFormat.compactUSD(proj))")
        }
        if parts.isEmpty { return "no spend this month" }
        return parts.joined(separator: " · ")
    }

    private func semantic(for level: BudgetEngine.SpendLevel) -> Theme.SemanticStatus {
        switch level {
        case .ok: return .ok
        case .warning: return .warning
        case .exceeded: return .danger
        case .unconfigured: return .neutral
        }
    }
}
