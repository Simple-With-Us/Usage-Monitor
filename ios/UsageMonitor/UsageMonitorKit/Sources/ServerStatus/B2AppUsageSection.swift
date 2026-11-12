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

/// One app's slice of a single day's stacked bar.
struct B2DailySegment: Identifiable, Hashable {
    let id: String
    let label: String
    let value: Double
    /// Share of the rendered bar (0...1).
    let fraction: Double
    let isUnattributed: Bool
    let isOverCap: Bool

    init(
        id: String,
        label: String,
        value: Double,
        fraction: Double,
        isUnattributed: Bool = false,
        isOverCap: Bool = false
    ) {
        self.id = id
        self.label = label
        self.value = value
        self.fraction = fraction
        self.isUnattributed = isUnattributed
        self.isOverCap = isOverCap
    }

    var fillColor: Color {
        if isOverCap { return B2FleetAppColors.overCap }
        if isUnattributed { return B2FleetAppColors.unattributed }
        return B2FleetAppColors.color(forAppId: id)
    }
}

/// One calendar day's stacked bar.
struct B2DailyRow: Identifiable, Hashable {
    let id: String
    let dateISO: String
    let displayDate: String
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
    let isUnattributed: Bool

    var fillColor: Color {
        if isUnattributed { return B2FleetAppColors.unattributed }
        return B2FleetAppColors.color(forAppId: id)
    }
}

struct B2AppUsageSection: View {
    @Bindable var store: B2AppUsageStore
    let hasCredential: Bool
    let onRefresh: () async -> Void

    @State private var dailyMetric: B2DailyMetric = .download

    private static let contentInsets = EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16)

    var body: some View {
        switch store.state {
        case .idle, .loading:
            Section {
                ProgressView()
                    .listRowInsets(Self.contentInsets)
            } header: {
                sectionHeading("Backblaze B2")
            }
        case .failed(let error):
            Section {
                Text(error.localizedDescription)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.warning)
                    .listRowInsets(Self.contentInsets)
            } header: {
                sectionHeading("Backblaze B2")
            }
        case .loaded(let breakdown):
            if breakdown.apps.isEmpty && !breakdown.configured {
                Section {
                    Text("Configure the Backblaze monitor key on the server to load B2 breakdown.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .listRowInsets(Self.contentInsets)
                } header: {
                    sectionHeading("Backblaze B2")
                }
            } else {
                Section {
                    b2BreakdownCard(breakdown)
                        .listRowInsets(Self.contentInsets)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                    dailySection(breakdown)
                        .listRowInsets(Self.contentInsets)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
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
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Daily")
                            .font(Theme.Typography.sectionHeader)
                            .foregroundStyle(Theme.Colors.primaryText)
                        Text(dailyCapLabel(breakdown))
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                    Spacer(minLength: Theme.Spacing.sm)
                    Picker("Metric", selection: $dailyMetric) {
                        ForEach(B2DailyMetric.allCases) { metric in
                            Text(metric.rawValue).tag(metric)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 150)
                    .tint(Theme.Colors.accent)
                    .accessibilityLabel("Daily metric")
                }

                ForEach(rows) { row in
                    dailyRow(row)
                }

                dailyLegend(breakdown, rows)
            }
            .padding(.vertical, Theme.Spacing.xs)
        }
    }

    private func dailyRow(_ row: B2DailyRow) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            HStack(spacing: Theme.Spacing.sm) {
                Text(row.displayDate)
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
                            .fill(segment.fillColor)
                            .frame(width: max(0, geo.size.width * CGFloat(segment.fraction)))
                    }
                    if !row.overCap {
                        Rectangle()
                            .fill(B2FleetAppColors.remaining)
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

    private func dailyLegend(_ breakdown: B2AppUsageBreakdown, _ rows: [B2DailyRow]) -> some View {
        let entries = legendEntries(breakdown, rows)
        let hasHeadroom = rows.contains { !$0.overCap }
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.md) {
                ForEach(entries) { entry in
                    HStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(entry.fillColor)
                            .frame(width: 8, height: 8)
                        Text(entry.label)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
                if hasHeadroom {
                    HStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(B2FleetAppColors.remaining)
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

        var seriesAppIds: [String] = []
        for day in days {
            for appId in day.byApp.keys where !seriesAppIds.contains(appId) {
                seriesAppIds.append(appId)
            }
        }
        let orderedAppIds = B2FleetAppColors.orderedAppIds(
            payloadIds: breakdown.apps.map(\.id),
            extraIds: seriesAppIds
        )

        return days.map { day in
            let entries = day.byApp
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
                .sorted { lhs, rhs in
                    let li = orderedAppIds.firstIndex(of: lhs.id) ?? Int.max
                    let ri = orderedAppIds.firstIndex(of: rhs.id) ?? Int.max
                    if li != ri { return li < ri }
                    return lhs.label < rhs.label
                }

            let byAppSum = entries.reduce(0) { $0 + $1.value }
            let accountTotal: Double = dailyMetric == .download
                ? day.accountDownloadedGb
                : Double(day.accountClassCTotal)
            let excess = accountTotal.isFinite ? accountTotal - byAppSum : 0
            let unattributedValue = excess > 1e-9 * max(1, abs(accountTotal)) ? excess : 0
            var allEntries = entries
            if unattributedValue > 0 {
                allEntries.append((
                    id: B2FleetAppColors.unattributedAppId,
                    label: "Unattributed",
                    value: unattributedValue
                ))
            }

            let total = byAppSum + unattributedValue
            let overCap = total > 0 && total > cap
            var segments: [B2DailySegment] = []
            if overCap {
                let safeTotal = max(total, 1e-12)
                let capShare = cap / safeTotal
                for entry in allEntries {
                    segments.append(
                        B2DailySegment(
                            id: entry.id,
                            label: entry.label,
                            value: entry.value,
                            fraction: (entry.value / safeTotal) * capShare,
                            isUnattributed: entry.id == B2FleetAppColors.unattributedAppId
                        )
                    )
                }
                let overValue = total - cap
                segments.append(
                    B2DailySegment(
                        id: "over-cap",
                        label: "Over cap",
                        value: overValue,
                        fraction: overValue / safeTotal,
                        isOverCap: true
                    )
                )
            } else {
                let scale = max(total, max(cap, 0))
                segments = allEntries.map { entry in
                    B2DailySegment(
                        id: entry.id,
                        label: entry.label,
                        value: entry.value,
                        fraction: scale > 0 ? entry.value / scale : 0,
                        isUnattributed: entry.id == B2FleetAppColors.unattributedAppId
                    )
                }
            }
            return B2DailyRow(
                id: day.date,
                dateISO: day.date,
                displayDate: formatDailyDate(day.date),
                total: total,
                cap: cap,
                overCap: overCap,
                segments: segments
            )
        }
    }

    private func legendEntries(
        _ breakdown: B2AppUsageBreakdown,
        _ rows: [B2DailyRow]
    ) -> [B2DailyLegendEntry] {
        let renderedIds = Set(rows.flatMap(\.segments).filter { !$0.isOverCap }.map(\.id))
        var labels: [String: String] = [:]
        for app in breakdown.apps where !app.label.isEmpty {
            labels[app.id] = app.label
        }

        var seriesExtras: [String] = []
        for id in renderedIds where labels[id] == nil && id != B2FleetAppColors.unattributedAppId {
            seriesExtras.append(id)
        }

        let ordered = B2FleetAppColors.orderedAppIds(
            payloadIds: breakdown.apps.map(\.id),
            extraIds: seriesExtras
        )

        return ordered.compactMap { appId in
            guard renderedIds.contains(appId) else { return nil }
            return B2DailyLegendEntry(
                id: appId,
                label: labels[appId] ?? B2AppUsageBreakdown.displayLabel(forAppId: appId),
                isUnattributed: false
            )
        } + (renderedIds.contains(B2FleetAppColors.unattributedAppId)
            ? [B2DailyLegendEntry(id: B2FleetAppColors.unattributedAppId, label: "Unattributed", isUnattributed: true)]
            : [])
    }

    private func accessibilityLabel(for row: B2DailyRow) -> String {
        let appPart = row.segments
            .filter { !$0.isOverCap }
            .map { "\($0.label) \(formatMetric($0.value))" }
            .joined(separator: ", ")
        if row.overCap {
            return "\(row.displayDate): \(appPart), \(formatMetric(row.total - row.cap)) over the \(formatMetric(row.cap)) free cap"
        }
        let remaining = max(0, row.cap - row.total)
        return "\(row.displayDate): \(appPart), \(formatMetric(remaining)) left of \(formatMetric(row.cap)) free cap"
    }

    private func formatMetric(_ value: Double) -> String {
        switch dailyMetric {
        case .download:
            let rounded = (value * 10).rounded() / 10
            return "\(rounded.formatted(.number.precision(.fractionLength(1)))) GB"
        case .classC:
            return "\(b2SafeRoundedInt(value).formatted()) Class C txns"
        }
    }

    private func dailyCapLabel(_ breakdown: B2AppUsageBreakdown) -> String {
        switch dailyMetric {
        case .download:
            let cap = breakdown.caps.downloadGbDailyFree
            let capText = cap == 1 ? "1 GB" : "\(cap.formatted()) GB"
            return "Daily download, \(capText) free"
        case .classC:
            let cap = breakdown.caps.classCDailyFree
            return "Daily Class C, \(cap.formatted()) free"
        }
    }

    private func formatDailyDate(_ isoDay: String) -> String {
        let parts = isoDay.split(separator: "-")
        guard parts.count == 3,
              let year = Int(parts[0]),
              let month = Int(parts[1]),
              let day = Int(parts[2]),
              let date = Calendar(identifier: .gregorian).date(from: DateComponents(year: year, month: month, day: day))
        else { return isoDay }
        return Self.dailyDateFormatter.string(from: date)
    }

    private static let dailyDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "E, MMM d"
        return formatter
    }()

    private func sectionHeading(_ title: String) -> some View {
        Text(title)
            .font(Theme.Typography.sectionHeader)
            .foregroundStyle(Theme.Colors.primaryText)
            .frame(maxWidth: .infinity, alignment: .center)
            .textCase(nil)
            .padding(.vertical, 2)
    }
}
