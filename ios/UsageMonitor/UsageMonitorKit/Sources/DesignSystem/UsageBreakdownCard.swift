import SwiftUI
import Charts

/// A model-free item representing one slice in a usage/storage breakdown.
public struct UsageBreakdownItem: Identifiable, Sendable, Hashable {
    public let id: String
    public let title: String
    public let subtitle: String?
    public let value: Double
    public let formattedValue: String
    public let secondaryValue: String?
    public let percentage: Double
    public let status: Theme.SemanticStatus
    public let color: Color

    public init(
        id: String,
        title: String,
        subtitle: String? = nil,
        value: Double,
        formattedValue: String,
        secondaryValue: String? = nil,
        percentage: Double,
        status: Theme.SemanticStatus = .neutral,
        color: Color
    ) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.value = value
        self.formattedValue = formattedValue
        self.secondaryValue = secondaryValue
        self.percentage = percentage
        self.status = status
        self.color = color
    }
}

/// Chart style selection: Donut vs Horizontal Bar chart.
public enum BreakdownChartStyle: String, CaseIterable, Identifiable, Sendable {
    case donut = "Donut"
    case bar = "Bar"

    public var id: String { rawValue }
}

/// A model-free design-system card displaying a proportional breakdown of usage
/// with interactive Donut Chart and Bar Chart modes, a proportional bar, and item list.
public struct UsageBreakdownCard: View {
    public let title: String
    public let subtitle: String?
    public let items: [UsageBreakdownItem]
    public let totalFormatted: String
    public let totalLabel: String

    @State private var chartStyle: BreakdownChartStyle = .donut

    public init(
        title: String = "Usage by Application",
        subtitle: String? = nil,
        items: [UsageBreakdownItem],
        totalFormatted: String,
        totalLabel: String = "Total"
    ) {
        self.title = title
        self.subtitle = subtitle
        self.items = items
        self.totalFormatted = totalFormatted
        self.totalLabel = totalLabel
    }

    private var totalValue: Double {
        items.reduce(0) { $0 + max(0, $1.value) }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            header

            if items.count > 1 {
                chartSection
                proportionalBar
            }

            itemList
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(title)
                    .font(Theme.Typography.sectionHeader)
                    .foregroundStyle(Theme.Colors.primaryText)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            Spacer(minLength: Theme.Spacing.sm)

            if items.count > 1 {
                Picker("Chart Style", selection: $chartStyle) {
                    ForEach(BreakdownChartStyle.allCases) { style in
                        Text(style.rawValue).tag(style)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 130)
                .accessibilityLabel("Chart presentation style")
            }
        }
    }

    // MARK: - Chart

    @ViewBuilder
    private var chartSection: some View {
        if totalValue > 0 {
            switch chartStyle {
            case .donut:
                donutChart
            case .bar:
                barChart
            }
        }
    }

    private var donutChart: some View {
        ZStack {
            Chart(items) { item in
                SectorMark(
                    angle: .value("Usage", max(0.001, item.value)),
                    innerRadius: .ratio(0.62),
                    angularInset: 1.5
                )
                .cornerRadius(4)
                .foregroundStyle(item.color)
            }
            .frame(height: 180)

            VStack(spacing: Theme.Spacing.xxs) {
                Text(totalFormatted)
                    .font(Theme.Typography.title.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.primaryText)
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
                Text(totalLabel)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            .padding(.horizontal, Theme.Spacing.md)
        }
        .padding(.vertical, Theme.Spacing.xs)
    }

    private var barChart: some View {
        Chart(items) { item in
            BarMark(
                x: .value("Usage", item.value),
                y: .value("App", item.title)
            )
            .cornerRadius(4)
            .foregroundStyle(item.color)
            .annotation(position: .trailing, alignment: .leading, spacing: 4) {
                Text(item.formattedValue)
                    .font(Theme.Typography.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .chartXAxis(.hidden)
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisValueLabel {
                    if let str = value.as(String.self) {
                        Text(str)
                            .font(Theme.Typography.caption.weight(.medium))
                            .foregroundStyle(Theme.Colors.primaryText)
                            .lineLimit(1)
                    }
                }
            }
        }
        .frame(height: CGFloat(max(100, items.count * 38)))
        .padding(.vertical, Theme.Spacing.xs)
    }

    // MARK: - Proportional Bar

    private var proportionalBar: some View {
        GeometryReader { geo in
            HStack(spacing: 2) {
                ForEach(items) { item in
                    let width = max(geo.size.width * CGFloat(item.percentage), 4)
                    Capsule()
                        .fill(item.color)
                        .frame(width: width)
                }
            }
        }
        .frame(height: 8)
        .clipShape(Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Usage distribution bar")
    }

    // MARK: - Item List

    private var itemList: some View {
        VStack(spacing: Theme.Spacing.sm) {
            ForEach(items) { item in
                HStack(alignment: .center, spacing: Theme.Spacing.sm) {
                    Circle()
                        .fill(item.color)
                        .frame(width: 10, height: 10)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                            .font(Theme.Typography.callout.weight(.semibold))
                            .foregroundStyle(Theme.Colors.primaryText)
                            .lineLimit(1)
                        if let sub = item.subtitle, !sub.isEmpty {
                            Text(sub)
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.tertiaryText)
                                .lineLimit(1)
                        }
                    }

                    Spacer(minLength: Theme.Spacing.sm)

                    VStack(alignment: .trailing, spacing: 2) {
                        Text(item.formattedValue)
                            .font(Theme.Typography.callout.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(Theme.Colors.primaryText)
                        HStack(spacing: Theme.Spacing.xs) {
                            if let sec = item.secondaryValue, !sec.isEmpty {
                                Text(sec)
                                    .font(Theme.Typography.caption)
                                    .foregroundStyle(Theme.Colors.secondaryText)
                            }
                            Text(CurrencyFormat.percent(item.percentage))
                                .font(Theme.Typography.caption.weight(.medium))
                                .monospacedDigit()
                                .foregroundStyle(item.color)
                        }
                    }
                }
                .padding(.vertical, Theme.Spacing.xs)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(item.title), \(item.formattedValue), \(CurrencyFormat.percent(item.percentage)) of total")
            }
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview("Usage Breakdown Card — Donut") {
    ScrollView {
        UsageBreakdownCard(
            title: "Storage by Application",
            subtitle: "196.1 GB across 4 buckets",
            items: [
                UsageBreakdownItem(
                    id: "st",
                    title: "Socratic.Trade",
                    subtitle: "jays-socratic-trade-eu",
                    value: 150.0,
                    formattedValue: "150.0 GB",
                    secondaryValue: "$0.90",
                    percentage: 0.765,
                    color: Theme.Colors.accent
                ),
                UsageBreakdownItem(
                    id: "ct",
                    title: "Congress.Trade",
                    subtitle: "jays-congress-trade-eu",
                    value: 30.5,
                    formattedValue: "30.5 GB",
                    secondaryValue: "$0.18",
                    percentage: 0.155,
                    color: Color.blue
                ),
                UsageBreakdownItem(
                    id: "um",
                    title: "Usage Monitor",
                    subtitle: "jays-usage-monitor-eu",
                    value: 12.0,
                    formattedValue: "12.0 GB",
                    secondaryValue: "$0.07",
                    percentage: 0.061,
                    color: Color.purple
                ),
                UsageBreakdownItem(
                    id: "fleet",
                    title: "Fleet Infra",
                    subtitle: "jays-fleet-eu",
                    value: 3.6,
                    formattedValue: "3.6 GB",
                    secondaryValue: "$0.02",
                    percentage: 0.019,
                    color: Color.teal
                ),
            ],
            totalFormatted: "196.1 GB",
            totalLabel: "Total Storage"
        )
        .padding(Theme.Spacing.lg)
    }
    .dsScreenBackground()
}
#endif
