import SwiftUI
import DesignSystem
import AppCore
import Models

/// The Dashboard's "Top providers" section: the highest-spending providers as
/// labeled budget meters, so the biggest cost centers are scannable at a glance.
/// Rows open the provider detail via the cross-tab `onSelectProvider` callback.
struct TopProvidersCard: View {
    let providers: [ProviderBudgetStatus]
    let totalCount: Int
    var onSelectProvider: ((String) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Top Providers", subtitle: "Month to date") {
                if totalCount > providers.count {
                    Text("\(totalCount) total")
                        .font(Theme.Typography.captionEmphasis)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }

            VStack(spacing: Theme.Spacing.lg) {
                ForEach(Array(providers.enumerated()), id: \.element.id) { index, provider in
                    Button {
                        Haptics.tap()
                        onSelectProvider?(provider.id)
                    } label: {
                        ProviderMeterRow(provider: provider, showsChevron: onSelectProvider != nil)
                    }
                    .buttonStyle(.plain)
                    .disabled(onSelectProvider == nil)
                    .accessibilityHint(onSelectProvider == nil ? "" : "Opens provider detail")

                    if index < providers.count - 1 {
                        Divider().overlay(Theme.Colors.separator.opacity(0.5))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }
}

/// One provider line inside the Top-providers card: a budget meter when the
/// provider has a configured budget, otherwise a plain spend row.
private struct ProviderMeterRow: View {
    let provider: ProviderBudgetStatus
    var showsChevron: Bool = false

    private var status: Theme.SemanticStatus { .init(provider.status) }

    var body: some View {
        HStack(alignment: .center, spacing: Theme.Spacing.sm) {
            ProviderMonogram(title: provider.title, status: status, size: 28)

            Group {
                if provider.hasBudget, let budget = provider.monthlyBudgetUsd {
                    LabeledBudgetMeter(
                        title: provider.title,
                        detail: "\(CurrencyFormat.compactUSD(provider.spentUsd)) / \(CurrencyFormat.compactUSD(budget))",
                        fraction: provider.percentUsed ?? (budget > 0 ? provider.spentUsd / budget : 0),
                        status: status
                    )
                } else {
                    HStack(alignment: .firstTextBaseline) {
                        Text(provider.title)
                            .font(Theme.Typography.callout.weight(.medium))
                            .foregroundStyle(Theme.Colors.primaryText)
                            .lineLimit(1)
                        Spacer(minLength: Theme.Spacing.sm)
                        Text(CurrencyFormat.usd(provider.spentUsd))
                            .font(Theme.Typography.caption)
                            .monospacedDigit()
                            .foregroundStyle(Theme.Colors.secondaryText)
                        StatusBadge("No Budget", status: .neutral)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(provider.title), \(CurrencyFormat.usd(provider.spentUsd)) spent, no budget set")
                }
            }

            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }
        }
        .contentShape(Rectangle())
    }
}

#Preview("Top providers", traits: .sizeThatFitsLayout) {
    TopProvidersCard(providers: ProviderBudgetStatus.sampleList, totalCount: 6)
        .padding()
        .background(Theme.Colors.background)
}

#Preview("Top providers (dark)", traits: .sizeThatFitsLayout) {
    TopProvidersCard(providers: Array(ProviderBudgetStatus.sampleList.prefix(3)), totalCount: 3)
        .padding()
        .background(Theme.Colors.background)
        .preferredColorScheme(.dark)
}
