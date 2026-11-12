import SwiftUI

/// A horizontal budget meter: a rounded track filled proportionally to
/// `fraction`, tinted by `status`, with an optional over-budget overshoot
/// treatment. The fill animates when the value changes.
///
/// `fraction` is spent ÷ budget (0…∞). Values above 1 clamp the visible fill to
/// full and switch to the danger tint so an over-budget provider is unmistakable.
public struct BudgetMeter: View {
    private let fraction: Double
    private let status: Theme.SemanticStatus
    private let height: CGFloat

    public init(fraction: Double, status: Theme.SemanticStatus, height: CGFloat = 10) {
        self.fraction = fraction
        self.status = status
        self.height = height
    }

    private var clamped: Double { min(max(fraction, 0), 1) }

    public var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Theme.Colors.meterTrack)
                Capsule()
                    .fill(status.tint.gradient)
                    .frame(width: max(height, geo.size.width * clamped))
            }
        }
        .frame(height: height)
        .animation(.spring(response: 0.5, dampingFraction: 0.85), value: clamped)
        .accessibilityElement()
        .accessibilityLabel("Budget used")
        .accessibilityValue("\(Int((fraction * 100).rounded())) percent")
    }
}

/// A meter with an inline label row above it: title on the left, spent/budget on
/// the right, then the bar. The most common way budgets appear in lists.
public struct LabeledBudgetMeter: View {
    private let title: String
    private let detail: String
    private let fraction: Double
    private let status: Theme.SemanticStatus

    public init(title: String, detail: String, fraction: Double, status: Theme.SemanticStatus) {
        self.title = title
        self.detail = detail
        self.fraction = fraction
        self.status = status
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack {
                Text(title)
                    .font(Theme.Typography.callout.weight(.medium))
                    .foregroundStyle(Theme.Colors.primaryText)
                    .lineLimit(1)
                Spacer(minLength: Theme.Spacing.sm)
                Text(detail)
                    .font(Theme.Typography.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            BudgetMeter(fraction: fraction, status: status)
        }
        .accessibilityElement(children: .combine)
    }
}

#Preview {
    VStack(spacing: Theme.Spacing.xl) {
        LabeledBudgetMeter(title: "Anthropic", detail: "$212 / $250", fraction: 0.85, status: .warning)
        LabeledBudgetMeter(title: "OpenAI", detail: "$96 / $200", fraction: 0.48, status: .ok)
        LabeledBudgetMeter(title: "OpenRouter", detail: "$135 / $120", fraction: 1.12, status: .danger)
    }
    .padding()
    .dsCard()
    .padding()
    .background(Theme.Colors.background)
}
