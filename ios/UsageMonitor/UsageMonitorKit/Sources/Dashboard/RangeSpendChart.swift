import SwiftUI
import Charts
import DesignSystem
import Models

/// Daily spend bars for a non-"This month" chart-range selection. Unlike
/// `SpendPaceChart` (always the current calendar month, always MTD budget
/// math) this never shows a projection — only the actual per-day totals the
/// range's window covered.
struct RangeSpendChart: View {
    let series: RangeSpendSeries

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .firstTextBaseline) {
                Text(CurrencyFormat.usd(series.totalCostUsd))
                    .font(Theme.Typography.title)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.primaryText)
                Spacer()
            }
            Text(series.captionLabel)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)

            chart
                .frame(height: 140)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Daily spend, \(series.captionLabel)")
                .accessibilityValue(CurrencyFormat.usd(series.totalCostUsd))
        }
    }

    private var chart: some View {
        Chart {
            ForEach(series.points) { point in
                BarMark(
                    x: .value("Day", point.day, unit: .day),
                    y: .value("Spend", point.value)
                )
                .foregroundStyle(Theme.Colors.accent)
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                AxisValueLabel(format: .dateTime.month(.abbreviated).day())
                    .font(Theme.Typography.caption)
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
    }
}

#Preview("Range spend — 30 days", traits: .sizeThatFitsLayout) {
    let calendar = Calendar(identifier: .gregorian)
    let points = (0..<30).map { offset -> RangeSpendPoint in
        let day = calendar.date(byAdding: .day, value: -offset, to: Date())!
        return RangeSpendPoint(day: day, value: Double.random(in: 4...40))
    }
    let series = RangeSpendSeries(timeframe: .rolling(days: 30), points: points, isClamped: false)
    return RangeSpendChart(series: series)
        .padding()
        .background(Theme.Colors.background)
}
