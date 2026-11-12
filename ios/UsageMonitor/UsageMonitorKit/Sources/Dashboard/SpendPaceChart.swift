import SwiftUI
import Charts
import DesignSystem
import Models

/// A native Swift Charts month-pace forecast: month-to-date spend extended to a
/// projected month-end, against an even-spend reference line and the budget.
/// Reads as a burn-up projection — clearly a forecast, built entirely from the
/// snapshot's real figures.
struct SpendPaceChart: View {
    let pace: SpendPace
    let status: Theme.SemanticStatus

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var projectionColor: Color { status == .neutral ? Theme.Colors.accent : status.tint }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Month Pace", subtitle: "Projected from spend so far") {
                Text("Day \(pace.currentDay) of \(pace.daysInMonth)")
                    .font(Theme.Typography.captionEmphasis)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.secondaryText)
            }

            chart
                .frame(height: 168)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Month pace forecast")
                .accessibilityValue(accessibilitySummary)

            legend
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    // MARK: - Chart

    private var chart: some View {
        Chart {
            // Budget reference line.
            RuleMark(y: .value("Budget", pace.budget))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .foregroundStyle(Theme.Colors.secondaryText.opacity(0.7))
                .annotation(position: .top, alignment: .leading, spacing: 2) {
                    Text("Budget \(CurrencyFormat.compactUSD(pace.budget))")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }

            // Even-spend reference.
            ForEach(pace.idealPace) { point in
                LineMark(
                    x: .value("Day", point.day),
                    y: .value("Even pace", point.value),
                    series: .value("Series", "Even pace")
                )
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 4]))
                .foregroundStyle(Theme.Colors.tertiaryText)
            }

            // Spend to date — solid, with a soft area fill.
            ForEach(pace.toDate) { point in
                AreaMark(
                    x: .value("Day", point.day),
                    y: .value("Spent", point.value),
                    series: .value("Series", "Spent")
                )
                .foregroundStyle(
                    LinearGradient(
                        colors: [projectionColor.opacity(0.22), projectionColor.opacity(0.0)],
                        startPoint: .top, endPoint: .bottom
                    )
                )
                .interpolationMethod(.monotone)
            }
            ForEach(pace.toDate) { point in
                LineMark(
                    x: .value("Day", point.day),
                    y: .value("Spent", point.value),
                    series: .value("Series", "Spent")
                )
                .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .foregroundStyle(projectionColor)
            }

            // Projection — dashed forecast segment to month end.
            ForEach(pace.projection) { point in
                LineMark(
                    x: .value("Day", point.day),
                    y: .value("Projected", point.value),
                    series: .value("Series", "Projected")
                )
                .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, dash: [5, 4]))
                .foregroundStyle(projectionColor.opacity(0.65))
            }

            // Emphasise today's actual and the projected endpoint.
            PointMark(
                x: .value("Day", pace.currentDay),
                y: .value("Spent", pace.spent)
            )
            .symbolSize(70)
            .foregroundStyle(projectionColor)

            PointMark(
                x: .value("Day", pace.daysInMonth),
                y: .value("Projected", pace.projected)
            )
            .symbolSize(50)
            .foregroundStyle(projectionColor.opacity(0.65))
        }
        .chartYScale(domain: 0...pace.yUpperBound)
        .chartXScale(domain: 0...pace.daysInMonth)
        .chartXAxis {
            AxisMarks(values: [1, pace.daysInMonth]) { value in
                AxisValueLabel {
                    if let day = value.as(Int.self) {
                        Text(day == 1 ? "1" : "\(pace.daysInMonth)")
                            .font(Theme.Typography.caption)
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { value in
                AxisGridLine().foregroundStyle(Theme.Colors.separator.opacity(0.4))
                AxisValueLabel {
                    if let amount = value.as(Double.self) {
                        Text(CurrencyFormat.compactUSD(amount))
                            .font(Theme.Typography.caption)
                    }
                }
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.5), value: pace)
    }

    // MARK: - Legend

    private var legend: some View {
        HStack(spacing: Theme.Spacing.lg) {
            legendItem(color: projectionColor, label: "Spent", dashed: false)
            legendItem(color: projectionColor.opacity(0.65), label: "Projected", dashed: true)
            legendItem(color: Theme.Colors.tertiaryText, label: "Even pace", dashed: true)
        }
        .accessibilityHidden(true)
    }

    private func legendItem(color: Color, label: String, dashed: Bool) -> some View {
        HStack(spacing: Theme.Spacing.xs) {
            Capsule()
                .fill(color)
                .frame(width: dashed ? 6 : 14, height: 3)
            Text(label)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    private var accessibilitySummary: String {
        let projected = "projected \(CurrencyFormat.usd(pace.projected)) by day \(pace.daysInMonth)"
        let against = "against a \(CurrencyFormat.usd(pace.budget)) budget"
        return "\(CurrencyFormat.usd(pace.spent)) spent by day \(pace.currentDay), \(projected), \(against)."
    }
}

#Preview("Pace — projected over", traits: .sizeThatFitsLayout) {
    let pace = SpendPace.make(
        month: "2026-07",
        generatedAt: ISO8601DateParser.date(from: "2026-07-19T09:15:00.000Z"),
        spent: 461.55, projected: 690.4, budget: 570
    )!
    return SpendPaceChart(pace: pace, status: .warning)
        .padding()
        .background(Theme.Colors.background)
}

#Preview("Pace — under budget (dark)", traits: .sizeThatFitsLayout) {
    let pace = SpendPace.make(
        month: "2026-07",
        generatedAt: ISO8601DateParser.date(from: "2026-07-12T09:15:00.000Z"),
        spent: 96.2, projected: 151.8, budget: 200
    )!
    return SpendPaceChart(pace: pace, status: .ok)
        .padding()
        .background(Theme.Colors.background)
        .preferredColorScheme(.dark)
}
