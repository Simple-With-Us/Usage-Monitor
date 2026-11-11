import SwiftUI

/// A tappable row summarizing one provider (or any titled entity): a colored
/// status dot / monogram, a title + subtitle, a trailing value with an optional
/// caption, and a chevron. Model-free — the Providers feature maps a
/// `ProviderBudgetStatus` onto these primitives.
public struct ProviderRow: View {
    private let title: String
    private let subtitle: String?
    private let value: String
    private let valueCaption: String?
    private let status: Theme.SemanticStatus
    private let showsChevron: Bool

    public init(
        title: String,
        subtitle: String? = nil,
        value: String,
        valueCaption: String? = nil,
        status: Theme.SemanticStatus = .neutral,
        showsChevron: Bool = true
    ) {
        self.title = title
        self.subtitle = subtitle
        self.value = value
        self.valueCaption = valueCaption
        self.status = status
        self.showsChevron = showsChevron
    }

    public var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            ProviderMonogram(title: title, status: status)

            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(title)
                    .font(Theme.Typography.callout.weight(.semibold))
                    .foregroundStyle(Theme.Colors.primaryText)
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: Theme.Spacing.sm)

            VStack(alignment: .trailing, spacing: Theme.Spacing.xxs) {
                Text(value)
                    .font(Theme.Typography.callout.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.primaryText)
                if let valueCaption {
                    Text(valueCaption)
                        .font(Theme.Typography.caption)
                        .monospacedDigit()
                        .foregroundStyle(status == .neutral ? Theme.Colors.tertiaryText : status.tint)
                }
            }

            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }
        }
        .padding(.vertical, Theme.Spacing.xs)
        .contentShape(Rectangle())
        .copyableValue(value, label: title)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(value)\(valueCaption.map { ", \($0)" } ?? "")")
    }
}

#Preview {
    VStack(spacing: 0) {
        ProviderRow(title: "OpenRouter", subtitle: "Over by $15", value: "$134.90", valueCaption: "112%", status: .danger)
        Divider().padding(.leading, 46)
        ProviderRow(title: "Anthropic", subtitle: "Warning", value: "$212.40", valueCaption: "85%", status: .warning)
        Divider().padding(.leading, 46)
        ProviderRow(title: "OpenAI", subtitle: "On track", value: "$96.20", valueCaption: "48%", status: .ok)
    }
    .dsCard(padding: Theme.Spacing.md)
    .padding()
    .background(Theme.Colors.background)
}
