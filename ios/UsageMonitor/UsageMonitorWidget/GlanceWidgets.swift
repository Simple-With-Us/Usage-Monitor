import WidgetKit
import SwiftUI
import WidgetShared
import DesignSystem

// MARK: - Dedicated Mac + Alerts tiles

/// Machine stats need their own tile: three live percents do not fit a
/// budget-style hero.  Same extension bundle and size families.
///
/// This used to be a `StaticConfiguration` with no Edit Widget options at all,
/// even though the snapshot can carry flags, process rows, and an explicit
/// host identity worth choosing between.
struct MacGlanceWidget: Widget {
    let kind = "MacGlanceWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: kind,
            intent: SelectMacAlertsIntent.self,
            provider: DedicatedTopicProvider(topic: .mac)
        ) { entry in
            UsageMonitorWidgetView(entry: entry)
                .containerBackground(Theme.Colors.background, for: .widget)
                .widgetURL(URL(string: "usageclientmonitor://computers"))
        }
        .configurationDisplayName("Mac")
        .description("CPU, memory, and disk from this Mac.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

/// A count-only Alerts topic is too thin.  This tile lists open alerts.
struct AlertsGlanceWidget: Widget {
    let kind = "AlertsGlanceWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: kind,
            intent: SelectMacAlertsIntent.self,
            provider: DedicatedTopicProvider(topic: .alerts)
        ) { entry in
            DedicatedAlertsWidgetView(entry: entry)
                .containerBackground(Theme.Colors.background, for: .widget)
                .widgetURL(URL(string: "usageclientmonitor://alerts"))
        }
        .configurationDisplayName("Alerts")
        .description("Open alerts that need attention.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

/// Quotas gets a dedicated tile because "how much plan is left" is the question
/// people check most often, and burying it in a topic picker means it is never
/// on the Home Screen.
struct QuotasGlanceWidget: Widget {
    let kind = "QuotasGlanceWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: kind,
            intent: SelectQuotasIntent.self,
            provider: QuotasTopicProvider()
        ) { entry in
            UsageMonitorWidgetView(entry: entry)
                .containerBackground(Theme.Colors.background, for: .widget)
                .widgetURL(URL(string: "usageclientmonitor://dashboard"))
        }
        .configurationDisplayName("Quotas")
        .description("How much of each plan window is left.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

struct DedicatedTopicProvider: AppIntentTimelineProvider {
    typealias Intent = SelectMacAlertsIntent
    let topic: WidgetTopic

    init(topic: WidgetTopic) {
        self.topic = topic
    }

    func placeholder(in context: Context) -> BudgetEntry {
        entry(snapshot: .placeholder, configuration: nil)
    }

    func snapshot(for configuration: SelectMacAlertsIntent, in context: Context) async -> BudgetEntry {
        let snapshot = context.isPreview
            ? WidgetSnapshot.placeholder
            : (WidgetSnapshotResolver.shared.read() ?? .empty)
        return entry(snapshot: snapshot, configuration: configuration)
    }

    func timeline(for configuration: SelectMacAlertsIntent, in context: Context) async -> Timeline<BudgetEntry> {
        let snapshot = WidgetSnapshotResolver.shared.read() ?? .empty
        let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date())
            ?? Date().addingTimeInterval(1800)
        return Timeline(
            entries: [entry(snapshot: snapshot, configuration: configuration)],
            policy: .after(next)
        )
    }

    private func entry(snapshot: WidgetSnapshot, configuration: SelectMacAlertsIntent?) -> BudgetEntry {
        BudgetEntry(
            date: Date(),
            snapshot: snapshot,
            content: WidgetTopicPresentation.topicContent(
                from: snapshot,
                topic: topic,
                budgetFocus: .overall,
                llmProviderId: nil,
                serverFocus: .service,
                maxMeters: configuration?.maxMeters ?? 4
            )
        )
    }
}

/// Dedicated-tile timeline provider for the Quotas widget, whose intent exposes
/// a Sort parameter that ``DedicatedTopicProvider`` does not (it is bound to
/// ``SelectMacAlertsIntent``).  Reusing the Mac+Alerts provider would silently
/// drop `sortOrder` (the picker would render and the entries would still rank
/// by the previous implementation's hard-coded utilisation), so this is a
/// separate type whose `Intent` matches the widget's configuration intent.
struct QuotasTopicProvider: AppIntentTimelineProvider {
    typealias Intent = SelectQuotasIntent

    func placeholder(in context: Context) -> BudgetEntry {
        entry(snapshot: .placeholder, configuration: nil)
    }

    func snapshot(for configuration: SelectQuotasIntent, in context: Context) async -> BudgetEntry {
        let snapshot = context.isPreview
            ? WidgetSnapshot.placeholder
            : (WidgetSnapshotResolver.shared.read() ?? .empty)
        return entry(snapshot: snapshot, configuration: configuration)
    }

    func timeline(for configuration: SelectQuotasIntent, in context: Context) async -> Timeline<BudgetEntry> {
        let snapshot = WidgetSnapshotResolver.shared.read() ?? .empty
        let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date())
            ?? Date().addingTimeInterval(1800)
        return Timeline(
            entries: [entry(snapshot: snapshot, configuration: configuration)],
            policy: .after(next)
        )
    }

    private func entry(snapshot: WidgetSnapshot, configuration: SelectQuotasIntent?) -> BudgetEntry {
        BudgetEntry(
            date: Date(),
            snapshot: snapshot,
            content: WidgetTopicPresentation.topicContent(
                from: snapshot,
                topic: .quotas,
                budgetFocus: .overall,
                llmProviderId: nil,
                serverFocus: .service,
                maxMeters: configuration?.maxMeters ?? 4,
                sortOrder: configuration?.sort ?? .utilisation
            )
        )
    }
}

struct DedicatedAlertsWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: BudgetEntry

    var body: some View {
        switch entry.content {
        case .unavailable(let unavailable):
            UnavailableTopicView(content: unavailable, family: family)
        case .alerts(let alerts):
            AlertsTopicView(alerts: alerts, family: family, showsList: true)
        default:
            UnavailableTopicView(
                content: WidgetUnavailableContent(
                    title: "Alerts",
                    message: "Open the app to load alerts.",
                    deepLink: URL(string: "usageclientmonitor://alerts")
                ),
                family: family
            )
        }
    }
}

// MARK: - Mac

struct MacTopicView: View {
    let mac: WidgetMacContent
    let family: WidgetFamily

    var body: some View {
        switch family {
        case .systemMedium:
            MediumMacWidget(mac: mac)
        case .systemLarge:
            LargeMacWidget(mac: mac)
        default:
            SmallMacWidget(mac: mac)
        }
    }
}

private struct MacHero: View {
    let mac: WidgetMacContent
    var showsUpdatedAt = true

    private var section: WidgetSnapshot.MacSection { mac.section }
    private var stale: Bool { WidgetTopicPresentation.macIsStale(section) }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            TopicHeader(
                title: section.hostname ?? "Mac",
                generatedAt: section.generatedAt,
                forceStale: stale
            )
            StatusBadge(
                WidgetTopicPresentation.macLabel(section),
                status: WidgetTopicPresentation.macStatus(section),
                systemImage: section.ok ? "laptopcomputer" : "exclamationmark.triangle.fill"
            )
            HStack(spacing: Theme.Spacing.md) {
                macStat("CPU", section.cpuUsagePct)
                macStat("Memory", section.memoryUsagePct)
                macStat("Disk", section.diskUsagePct)
            }
            if showsUpdatedAt {
                UpdatedCaption(generatedAt: section.generatedAt)
            }
        }
    }

    private func macStat(_ title: String, _ value: Double?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.tertiaryText)
            if let label = WidgetTopicPresentation.macPercentLabel(value) {
                Text(label)
                    .font(Theme.Typography.callout.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.primaryText)
            } else {
                Text("—")
                    .font(Theme.Typography.callout)
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct SmallMacWidget: View {
    let mac: WidgetMacContent

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MacHero(mac: mac)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct MediumMacWidget: View {
    let mac: WidgetMacContent
    private var section: WidgetSnapshot.MacSection { mac.section }

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.lg) {
            MacHero(mac: mac)
                .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                if let uptime = section.uptimeSeconds {
                    labeled("Uptime", UptimeFormat.string(fromSeconds: uptime))
                }
                if let chip = section.arch {
                    labeled("Chip", chip)
                }
                if let first = section.flags.first {
                    Text(first)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.warning)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func labeled(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.tertiaryText)
            Text(value)
                .font(Theme.Typography.caption.weight(.medium))
        }
    }
}

private struct LargeMacWidget: View {
    let mac: WidgetMacContent
    private var section: WidgetSnapshot.MacSection { mac.section }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            MacHero(mac: mac)
            if let uptime = section.uptimeSeconds {
                labeled("Uptime", UptimeFormat.string(fromSeconds: uptime))
            }
            if let os = section.osVersion {
                labeled("System", os)
            }
            if let chip = section.arch {
                labeled("Chip", chip)
            }
            ForEach(section.flags.prefix(3), id: \.self) { flag in
                Text(flag)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.warning)
            }
            ForEach(section.processes.prefix(4)) { process in
                HStack {
                    Text(WidgetTopicPresentation.macProcessName(process.name))
                    Spacer()
                    Text(WidgetTopicPresentation.macProcessLabel(process.status))
                        .foregroundStyle(WidgetTopicPresentation.macProcessStatus(process.status).tint)
                }
                .font(Theme.Typography.caption)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func labeled(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(value)
        }
        .font(Theme.Typography.caption)
    }
}

// MARK: - Alerts

struct AlertsTopicView: View {
    let alerts: WidgetAlertsContent
    let family: WidgetFamily
    var showsList: Bool

    var body: some View {
        if showsList {
            switch family {
            case .systemMedium:
                MediumAlertsListWidget(alerts: alerts)
            case .systemLarge:
                LargeAlertsListWidget(alerts: alerts)
            default:
                SmallAlertsListWidget(alerts: alerts)
            }
        } else {
            AlertsCountWidget(alerts: alerts, family: family)
        }
    }
}

private struct AlertsCountWidget: View {
    let alerts: WidgetAlertsContent
    let family: WidgetFamily

    private var section: WidgetSnapshot.AlertsSection { alerts.section }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            TopicHeader(title: "Alerts", generatedAt: section.generatedAt)
            Text(WidgetTopicPresentation.alertsHeadline(openCount: section.openCount))
                .font(Theme.Typography.title)
                .foregroundStyle(
                    section.openCount == 0 ? Theme.Colors.primaryText : Theme.Colors.danger
                )
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            if let label = WidgetTopicPresentation.alertsNeedsAttentionLabel(
                count: section.needsAttentionCount
            ) {
                StatusBadge(
                    label,
                    status: .warning,
                    systemImage: "bell.badge.fill"
                )
            }
            if let title = section.latestTitle {
                Text(title)
                    .font(family == .systemSmall ? Theme.Typography.caption : Theme.Typography.callout)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(2)
                if let provider = section.latestProvider {
                    Text(provider)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.tertiaryText)
                        .lineLimit(1)
                }
            } else if section.openCount == 0 {
                Text("No open alerts.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }
            UpdatedCaption(generatedAt: section.generatedAt)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct SmallAlertsListWidget: View {
    let alerts: WidgetAlertsContent
    private var section: WidgetSnapshot.AlertsSection { alerts.section }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            TopicHeader(title: "Alerts", generatedAt: section.generatedAt)
            Text(WidgetTopicPresentation.alertsHeadline(openCount: section.openCount))
                .font(Theme.Typography.title)
                .foregroundStyle(
                    section.openCount == 0 ? Theme.Colors.primaryText : Theme.Colors.danger
                )
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            if let first = section.items.first {
                Text(first.title)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(2)
            } else {
                Text("No open alerts.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }
            UpdatedCaption(generatedAt: section.generatedAt)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct MediumAlertsListWidget: View {
    let alerts: WidgetAlertsContent
    private var section: WidgetSnapshot.AlertsSection { alerts.section }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            TopicHeader(title: "Alerts", generatedAt: section.generatedAt)
            Text(WidgetTopicPresentation.alertsHeadline(openCount: section.openCount))
                .font(Theme.Typography.callout.weight(.semibold))
                .foregroundStyle(
                    section.openCount == 0 ? Theme.Colors.primaryText : Theme.Colors.danger
                )
            if section.items.isEmpty {
                Text("No open alerts.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
            } else {
                ForEach(section.items.prefix(3)) { item in
                    alertRow(item)
                }
            }
            UpdatedCaption(generatedAt: section.generatedAt)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct LargeAlertsListWidget: View {
    let alerts: WidgetAlertsContent
    private var section: WidgetSnapshot.AlertsSection { alerts.section }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            TopicHeader(title: "Alerts", generatedAt: section.generatedAt)
            Text(WidgetTopicPresentation.alertsHeadline(openCount: section.openCount))
                .font(Theme.Typography.title)
                .foregroundStyle(
                    section.openCount == 0 ? Theme.Colors.primaryText : Theme.Colors.danger
                )
            if let label = WidgetTopicPresentation.alertsNeedsAttentionLabel(
                count: section.needsAttentionCount
            ) {
                StatusBadge(label, status: .warning, systemImage: "bell.badge.fill")
            }
            if section.items.isEmpty {
                Text("No open alerts.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
            } else {
                ForEach(section.items.prefix(6)) { item in
                    alertRow(item)
                }
            }
            UpdatedCaption(generatedAt: section.generatedAt)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private func alertRow(_ item: WidgetSnapshot.AlertsSection.Item) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.xs) {
        VStack(alignment: .leading, spacing: 1) {
            Text(item.title)
                .font(Theme.Typography.caption.weight(.medium))
                .lineLimit(1)
            Text(item.providerName)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.tertiaryText)
                .lineLimit(1)
        }
        Spacer(minLength: 4)
        Text(WidgetTopicPresentation.alertsSeverityLabel(item.severity))
            .font(Theme.Typography.caption)
            .foregroundStyle(WidgetTopicPresentation.alertsSeverityStatus(item.severity).tint)
    }
}

// MARK: - Providers

struct ProvidersTopicView: View {
    let providers: WidgetProvidersContent
    let family: WidgetFamily
    private var redacted: Bool { WidgetPresentation.shouldRedactAmounts() }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            TopicHeader(title: providers.title, generatedAt: providers.generatedAt)
            Text(WidgetPresentation.displayAmount(providers.spentUsd, redacted: redacted))
                .font(Theme.Typography.title)
                .monospacedDigit()
                .foregroundStyle(Theme.Colors.primaryText)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
                .privacySensitive(redacted)
            if providers.budgetUsd > 0, !redacted {
                Text("of \(CurrencyFormat.compactUSD(providers.budgetUsd))")
                    .font(Theme.Typography.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }
            let visible = family == .systemSmall ? 1 : (family == .systemMedium ? 3 : 6)
            ForEach(providers.meters.prefix(visible)) { meter in
                LabeledBudgetMeter(
                    title: meter.name,
                    detail: WidgetPresentation.displayMeterDetail(
                        spent: meter.spentUsd,
                        budget: meter.budgetUsd,
                        redacted: redacted
                    ),
                    fraction: redacted
                        ? 0
                        : WidgetPresentation.fraction(spent: meter.spentUsd, budget: meter.budgetUsd),
                    status: WidgetPresentation.semanticStatus(forRawStatus: meter.status)
                )
                .privacySensitive(redacted)
            }
            UpdatedCaption(generatedAt: providers.generatedAt)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
