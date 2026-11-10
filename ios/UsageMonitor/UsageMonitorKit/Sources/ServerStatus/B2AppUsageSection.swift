import SwiftUI
import DesignSystem
import Models
import Networking
import AppCore
import Providers

/// Which daily metric the B2 stacked bars show.
enum B2DailyMetric: String, CaseIterable, Identifiable, Sendable {
    case download = "Download"
    case classC = "Class C"

    var id: String { rawValue }
}

/// Red-family shades for the used portion of a daily bar (one per app) and
/// the emerald headroom left under the daily free cap.  Mirrors the web
/// `QuotaUsageBar` palette.
enum B2DailyPalette {
    static let segments: [Color] = [
        Color(red: 0.937, green: 0.267, blue: 0.267), // red-500
        Color(red: 0.863, green: 0.149, blue: 0.149), // red-600
        Color(red: 0.725, green: 0.110, blue: 0.110), // red-700
        Color(red: 0.973, green: 0.443, blue: 0.443), // red-400
        Color(red: 0.600, green: 0.106, blue: 0.106), // red-800
    ]

    static let remaining = Color(red: 0.020, green: 0.588, blue: 0.412) // emerald-600

    /// Account-level usage above the bucket sum (deleted buckets,
    /// unattributed operations).  Renders as its own slice so the bar fills
    /// truthfully instead of showing phantom headroom.
    static let unattributed = Color(red: 0.612, green: 0.643, blue: 0.690) // gray-400

    static func color(forIndex index: Int) -> Color {
        segments[index % segments.count]
    }
}

/// One app's slice of a single day's stacked bar.
struct B2DailySegment: Identifiable, Hashable {
    let id: String
    let label: String
    let value: Double
    /// Share of the rendered bar (0...1).
    let fraction: Double
    let colorIndex: Int
    /// Account-level usage above the bucket sum (gray slice, not an app shade).
    let isUnattributed: Bool

    init(
        id: String,
        label: String,
        value: Double,
        fraction: Double,
        colorIndex: Int,
        isUnattributed: Bool = false
    ) {
        self.id = id
        self.label = label
        self.value = value
        self.fraction = fraction
        self.colorIndex = colorIndex
        self.isUnattributed = isUnattributed
    }
}

/// One calendar day's stacked bar.
struct B2DailyRow: Identifiable, Hashable {
    let id: String
    let date: String
    let total: Double
    let cap: Double
    let overCap: Bool
    let segments: [B2DailySegment]

    /// Headroom left under the cap, as a share of the bar.
    var remainingFraction: Double {
        guard !overCap, cap > 0 else { return 0 }
        return max(0, cap - total) / cap
    }
}

/// One app's legend entry.
struct B2DailyLegendEntry: Identifiable, Hashable {
    let id: String
    let label: String
    let colorIndex: Int
    let isUnattributed: Bool

    init(id: String, label: String, colorIndex: Int, isUnattributed: Bool = false) {
        self.id = id
        self.label = label
        self.colorIndex = colorIndex
        self.isUnattributed = isUnattributed
    }
}

struct B2AppUsageSection: View {
    @Bindable var store: B2AppUsageStore
    let hasCredential: Bool
    let onRefresh: () async -> Void

    @State private var dailyMetric: B2DailyMetric = .download

    var body: some View {
        switch store.state {
        case .idle, .loading:
            Section {
                ProgressView()
            } header: {
                sectionHeading("B2 Usage by Application")
            }
        case .failed(let error):
            Section {
                Text(error.localizedDescription)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.warning)
            } header: {
                sectionHeading("B2 Usage by Application")
            }
        case .loaded(let breakdown):
            if breakdown.apps.isEmpty && !breakdown.configured {
                Section {
                    Text("Configure the Backblaze monitor key on the server to load B2 breakdown.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                } header: {
                    sectionHeading("B2 Usage by Application")
                }
            } else {
                Section {
                    b2BreakdownCard(breakdown)
                    dailySection(breakdown)
                } header: {
                    sectionHeading("B2 Usage by Application")
                } footer: {
                    if !breakdown.warnings.isEmpty {
                        Text(breakdown.warnings.joined(separator: " · "))
                            .font(Theme.Typography.caption)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func b2BreakdownCard(_ breakdown: B2AppUsageBreakdown) -> some View {
        let records = breakdown.apps.compactMap { app -> ExternalBillingRecord? in
            guard app.storageGb > 0 || app.latestDay != nil else { return nil }
            let bucket = app.bucketNames.first ?? app.id
            return ExternalBillingRecord(
                source: "backblaze-b2-bucket-storage",
                externalId: app.id,
                kind: "service_plan",
                serviceName: bucket,
                planName: "B2 bucket",
                status: "active",
                amountUsd: nil,
                currency: "USD",
                usageQuantity: app.storageGb,
                usageUnit: "GB",
                syncedAt: breakdown.asOf
            )
        }
        if records.isEmpty {
            Text("No B2 usage data yet.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
        } else {
            ProviderUsageBreakdownCard(
                providerTitle: "Backblaze B2",
                records: records
            )
            if breakdown.alerts.classCSpike || breakdown.alerts.classCNearCap || breakdown.alerts.downloadNearCap {
                let parts = [
                    breakdown.alerts.classCSpike ? "Class C spike" : nil,
                    breakdown.alerts.classCNearCap ? "Class C near cap" : nil,
                    breakdown.alerts.downloadNearCap ? "Download near cap" : nil,
                ].compactMap { $0 }
                Text(parts.joined(separator: " · "))
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.warning)
            }
        }
    }

    // MARK: - Daily stacked bars

    @ViewBuilder
    private func dailySection(_ breakdown: B2AppUsageBreakdown) -> some View {
        let rows = dailyRows(breakdown)
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                HStack(alignment: .center, spacing: Theme.Spacing.sm) {
                    Text("Daily")
                        .font(Theme.Typography.sectionHeader)
                        .foregroundStyle(Theme.Colors.primaryText)
                    Spacer(minLength: Theme.Spacing.sm)
                    Picker("Metric", selection: $dailyMetric) {
                        ForEach(B2DailyMetric.allCases) { metric in
                            Text(metric.rawValue).tag(metric)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 150)
                    .accessibilityLabel("Daily metric")
                }

                ForEach(rows) { row in
                    dailyRow(row)
                }

                dailyLegend(rows)
            }
            .padding(.vertical, Theme.Spacing.xs)
        }
    }

    private func dailyRow(_ row: B2DailyRow) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            HStack(spacing: Theme.Spacing.sm) {
                Text(row.date)
                    .font(Theme.Typography.caption.weight(.medium))
                    .foregroundStyle(Theme.Colors.primaryText)
                Spacer(minLength: Theme.Spacing.sm)
                Text(row.overCap
                     ? "\(formatMetric(row.total - row.cap)) over"
                     : "\(formatMetric(row.total)) used")
                    .font(Theme.Typography.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.secondaryText)
                if row.overCap {
                    Text("Over Cap")
                        .font(Theme.Typography.caption.weight(.semibold))
                        .foregroundStyle(Theme.Colors.danger)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Theme.Colors.danger.opacity(0.14), in: Capsule())
                }
            }

            GeometryReader { geo in
                HStack(spacing: 0) {
                    ForEach(row.segments) { segment in
                        Rectangle()
                            .fill(segment.isUnattributed
                                ? B2DailyPalette.unattributed
                                : B2DailyPalette.color(forIndex: segment.colorIndex))
                            .frame(width: max(0, geo.size.width * CGFloat(segment.fraction)))
                    }
                    if !row.overCap {
                        Rectangle()
                            .fill(B2DailyPalette.remaining)
                            .frame(width: max(0, geo.size.width * CGFloat(row.remainingFraction)))
                    }
                }
            }
            .frame(height: 10)
            .background(Theme.Colors.meterTrack, in: Capsule())
            .clipShape(Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityLabel(for: row))
        }
    }

    private func dailyLegend(_ rows: [B2DailyRow]) -> some View {
        let entries = legendEntries(rows)
        let hasHeadroom = rows.contains { !$0.overCap }
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.md) {
                ForEach(entries) { entry in
                    HStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(entry.isUnattributed
                                ? B2DailyPalette.unattributed
                                : B2DailyPalette.color(forIndex: entry.colorIndex))
                            .frame(width: 8, height: 8)
                        Text(entry.label)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
                if hasHeadroom {
                    HStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(B2DailyPalette.remaining)
                            .frame(width: 8, height: 8)
                        Text("Left")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
            }
            .padding(.vertical, 2)
        }
    }

    // MARK: - Daily math

    private func dailyRows(_ breakdown: B2AppUsageBreakdown) -> [B2DailyRow] {
        let cap = dailyMetric == .download
            ? Double(breakdown.caps.downloadGbDailyFree)
            : Double(breakdown.caps.classCDailyFree)
        var labels: [String: String] = [:]
        for app in breakdown.apps where !app.label.isEmpty {
            labels[app.id] = app.label
        }

        let days = breakdown.dailySeries
            .filter { !$0.date.isEmpty }
            .sorted { $0.date > $1.date }

        // Stable app order and shade: payload order first, then anything the
        // daily series knows about but the app list does not.
        var appIds: [String] = []
        for day in days {
            for appId in day.byApp.keys.sorted() {
                if !appIds.contains(appId) { appIds.append(appId) }
            }
        }
        appIds.sort { lhs, rhs in
            let li = breakdown.apps.firstIndex { $0.id == lhs } ?? Int.max
            let ri = breakdown.apps.firstIndex { $0.id == rhs } ?? Int.max
            return li < ri
        }
        let colorIndexById = Dictionary(
            uniqueKeysWithValues: appIds.enumerated().map { ($0.element, $0.offset) }
        )

        return days.map { day in
            var entries = day.byApp
                .map { entry -> (id: String, label: String, value: Double) in
                    let appId = entry.key
                    let usage = entry.value
                    let value = dailyMetric == .download
                        ? usage.downloadedGb
                        : Double(usage.classCTransactions)
                    return (
                        appId,
                        labels[appId] ?? B2AppUsageBreakdown.displayLabel(forAppId: appId),
                        value
                    )
                }
                .filter { $0.value.isFinite && $0.value > 0 }
                .sorted { $0.value > $1.value }

            // The report can carry account-level rows larger than the bucket
            // rows (deleted buckets, unattributed operations), and the
            // near-cap alerts already evaluate those account totals — the bar
            // must not understate them.
            let byAppSum = entries.reduce(0) { $0 + $1.value }
            let accountTotal: Double = dailyMetric == .download
                ? day.accountDownloadedGb
                : Double(day.accountClassCTotal)
            // Ignore floating-point dust (0.9 - (0.6 + 0.3) ≈ 1e-16) so a
            // fully attributed day never grows an "Unattributed 0 GB" slice.
            let excess = accountTotal.isFinite ? accountTotal - byAppSum : 0
            let unattributedValue = excess > 1e-9 * max(1, abs(accountTotal)) ? excess : 0
            if unattributedValue > 0 {
                entries.append((id: "unattributed", label: "Unattributed", value: unattributedValue))
            }

            let total = byAppSum + unattributedValue
            let overCap = total > 0 && total > cap
            let scale = max(total, max(cap, 0))
            let segments = entries.map { entry in
                B2DailySegment(
                    id: entry.id,
                    label: entry.label,
                    value: entry.value,
                    fraction: scale > 0 ? entry.value / scale : 0,
                    colorIndex: colorIndexById[entry.id] ?? 0,
                    isUnattributed: entry.id == "unattributed"
                )
            }
            return B2DailyRow(
                id: day.date,
                date: day.date,
                total: total,
                cap: cap,
                overCap: overCap,
                segments: segments
            )
        }
    }

    private func legendEntries(_ rows: [B2DailyRow]) -> [B2DailyLegendEntry] {
        var entries: [B2DailyLegendEntry] = []
        for row in rows {
            for segment in row.segments where !entries.contains(where: { $0.id == segment.id }) {
                entries.append(
                    B2DailyLegendEntry(
                        id: segment.id,
                        label: segment.label,
                        colorIndex: segment.colorIndex,
                        isUnattributed: segment.isUnattributed
                    )
                )
            }
        }
        return entries
    }

    private func accessibilityLabel(for row: B2DailyRow) -> String {
        let appPart = row.segments
            .map { "\($0.label) \(formatMetric($0.value))" }
            .joined(separator: ", ")
        if row.overCap {
            return "\(row.date): \(appPart), \(formatMetric(row.total - row.cap)) over the \(formatMetric(row.cap)) free cap"
        }
        let remaining = max(0, row.cap - row.total)
        return "\(row.date): \(appPart), \(formatMetric(remaining)) left of \(formatMetric(row.cap)) free cap"
    }

    private func formatMetric(_ value: Double) -> String {
        switch dailyMetric {
        case .download:
            let rounded = (value * 10).rounded() / 10
            if rounded == rounded.rounded() {
                return "\(b2SafeRoundedInt(rounded).formatted()) GB"
            }
            return "\(rounded.formatted(.number.precision(.fractionLength(1)))) GB"
        case .classC:
            return "\(b2SafeRoundedInt(value).formatted()) Class C txns"
        }
    }

    private func sectionHeading(_ title: String) -> some View {
        Text(title)
            .font(Theme.Typography.sectionHeader)
            .foregroundStyle(Theme.Colors.primaryText)
            .frame(maxWidth: .infinity, alignment: .center)
            .textCase(nil)
            .padding(.vertical, 2)
    }
}
