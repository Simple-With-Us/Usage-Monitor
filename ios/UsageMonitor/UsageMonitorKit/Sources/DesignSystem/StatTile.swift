import SwiftUI

/// A compact metric tile: a small caption label, a large value, and an optional
/// secondary line (delta, projection, caveat). Designed to sit in a 2-up or
/// 3-up grid on the dashboard.
public struct StatTile: View {
    private let label: String
    private let value: String
    private let secondary: String?
    private let systemImage: String?
    private let status: Theme.SemanticStatus

    public init(
        label: String,
        value: String,
        secondary: String? = nil,
        systemImage: String? = nil,
        status: Theme.SemanticStatus = .neutral
    ) {
        self.label = label
        self.value = value
        self.secondary = secondary
        self.systemImage = systemImage
        self.status = status
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.xs) {
                if SystemImage.resolved(systemImage) != nil {
                    Image(safeSystemName: systemImage)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(status == .neutral ? Theme.Colors.secondaryText : status.tint)
                }
                Text(label)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }

            Text(value)
                .font(Theme.Typography.statValue)
                .monospacedDigit()
                .foregroundStyle(Theme.Colors.primaryText)
                .minimumScaleFactor(0.6)
                .lineLimit(1)

            if let secondary {
                Text(secondary)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(status == .neutral ? Theme.Colors.tertiaryText : status.tint)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
        .dsCard(padding: Theme.Spacing.md)
        .copyableValue(value, label: label)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
        .accessibilityValue(secondary ?? "")
    }
}

#Preview {
    ScrollView {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: Theme.Spacing.md) {
            StatTile(label: "Spent", value: "$461.55", secondary: "of $570", systemImage: "creditcard.fill")
            StatTile(label: "Projected", value: "$690.40", secondary: "+21% over", systemImage: "chart.line.uptrend.xyaxis", status: .warning)
            StatTile(label: "Remaining", value: "$126.50", systemImage: "banknote", status: .ok)
            StatTile(label: "Over budget", value: "1", secondary: "provider", systemImage: "exclamationmark.octagon.fill", status: .danger)
        }
        .padding()
    }
    .background(Theme.Colors.background)
}
