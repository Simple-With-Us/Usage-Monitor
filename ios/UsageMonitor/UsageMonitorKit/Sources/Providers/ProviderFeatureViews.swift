import SwiftUI
import DesignSystem
import Models

// ---------------------------------------------------------------------------
// Small, feature-local SwiftUI components for the Providers lane. These are
// intentionally kept in the feature target (not DesignSystem) because they
// encode Providers-specific composition; they are still built purely from
// `Theme` tokens so they read as native design-system parts.
// ---------------------------------------------------------------------------

/// A horizontally-scrolling row of status filter chips with live counts.
struct StatusFilterBar: View {
    @Binding var selection: ProviderFilter
    let counts: [ProviderFilter: Int]
    var onChange: (() -> Void)? = nil

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.sm) {
                ForEach(ProviderFilter.allCases) { facet in
                    chip(facet)
                }
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.xs)
        }
        .accessibilityLabel("Filter providers by status")
    }

    private func chip(_ facet: ProviderFilter) -> some View {
        let isSelected = selection == facet
        let tint = facet.status == .neutral ? Theme.Colors.accent : facet.status.tint
        let count = counts[facet] ?? 0
        var traits = AccessibilityTraits.isButton
        if isSelected { _ = traits.insert(.isSelected) }
        return Button {
            guard selection != facet else { return }
            selection = facet
            onChange?()
        } label: {
            HStack(spacing: Theme.Spacing.xs) {
                if SystemImage.resolved(facet.systemImage) != nil {
                    Image(safeSystemName: facet.systemImage).imageScale(.small)
                }
                Text(facet.label)
                if facet != .all {
                    Text("\(count)")
                        .font(Theme.Typography.caption.weight(.bold))
                        .monospacedDigit()
                        .opacity(isSelected ? 0.9 : 0.6)
                }
            }
            .font(Theme.Typography.captionEmphasis)
            .foregroundStyle(isSelected ? Color.white : tint)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.sm)
            .background(
                isSelected ? tint : tint.opacity(0.14),
                in: Capsule()
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(facet.label)\(facet == .all ? "" : ", \(count)")")
        .accessibilityAddTraits(traits)
    }
}

/// A stacked, proportional bar visualising how a provider's month-to-date spend
/// breaks down (usage vs. subscription vs. fixed), with a legend beneath.
struct SpendCompositionBar: View {
    let components: [SpendComponent]
    var height: CGFloat = 14

    private var total: Double { components.reduce(0) { $0 + $1.amount } }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            GeometryReader { geo in
                HStack(spacing: 2) {
                    ForEach(components) { component in
                        Capsule()
                            .fill(component.kind.color.gradient)
                            .frame(width: width(for: component, in: geo.size.width))
                    }
                }
            }
            .frame(height: height)
            .clipShape(Capsule())

            // Legend
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                ForEach(components) { component in
                    HStack(spacing: Theme.Spacing.sm) {
                        Circle()
                            .fill(component.kind.color)
                            .frame(width: 9, height: 9)
                        Image(safeSystemName: component.kind.systemImage, fallback: "circle")
                            .font(.caption2)
                            .foregroundStyle(Theme.Colors.secondaryText)
                        Text(component.label)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                        Spacer(minLength: Theme.Spacing.sm)
                        Text(CurrencyFormat.usd(component.amount))
                            .font(Theme.Typography.caption.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(Theme.Colors.primaryText)
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Spend breakdown")
        .accessibilityValue(
            components
                .map { "\($0.label) \(CurrencyFormat.usd($0.amount))" }
                .joined(separator: ", ")
        )
    }

    private func width(for component: SpendComponent, in available: CGFloat) -> CGFloat {
        guard total > 0 else { return 0 }
        let gaps = CGFloat(max(components.count - 1, 0)) * 2
        let usable = max(available - gaps, 0)
        // Guarantee each visible slice is at least a few points wide so tiny
        // components remain perceptible.
        return max(usable * CGFloat(component.amount / total), 4)
    }
}

/// A labelled key/value line used across the detail's info cards.
struct DetailStatRow: View {
    let label: String
    let value: String
    var valueStatus: Theme.SemanticStatus = .neutral
    var monospaced: Bool = true

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.md) {
            Text(label)
                .font(Theme.Typography.callout)
                .foregroundStyle(Theme.Colors.secondaryText)
            Spacer(minLength: Theme.Spacing.sm)
            Text(value)
                .font(Theme.Typography.callout.weight(.semibold))
                .foregroundStyle(valueStatus == .neutral ? Theme.Colors.primaryText : valueStatus.tint)
                .modifier(MonospacedDigitIf(enabled: monospaced))
                .multilineTextAlignment(.trailing)
        }
        .contentShape(Rectangle())
        .copyableValue(value, label: label)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label), \(value)")
    }
}

private struct MonospacedDigitIf: ViewModifier {
    let enabled: Bool
    func body(content: Content) -> some View {
        if enabled { content.monospacedDigit() } else { content }
    }
}

#Preview("Filter bar") {
    StatePreview()
        .background(Theme.Colors.background)
}

private struct StatePreview: View {
    @State private var filter: ProviderFilter = .all
    var body: some View {
        VStack(spacing: Theme.Spacing.xl) {
            StatusFilterBar(
                selection: $filter,
                counts: [.overBudget: 1, .attention: 1, .onTrack: 1, .noBudget: 1]
            )
            SpendCompositionBar(components: ProviderBudgetStatus.sampleWarning.spendComponents.isEmpty
                ? [SpendComponent(kind: .variable, amount: 180),
                   SpendComponent(kind: .subscription, amount: 100),
                   SpendComponent(kind: .fixed, amount: 20)]
                : ProviderBudgetStatus.sampleWarning.spendComponents)
                .padding()
                .dsCard()
                .padding(.horizontal, Theme.Spacing.lg)
        }
    }
}
