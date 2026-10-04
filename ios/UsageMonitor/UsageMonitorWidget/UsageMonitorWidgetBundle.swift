import WidgetKit
import SwiftUI
import AppIntents
import WidgetShared
import DesignSystem

/// The widget extension entry point. Owned jointly by the **WidgetShared** lane
/// (the data bridge, already built) and the **Widget UI** lane (these views).
///
/// The extension is deliberately model- and networking-free: it renders the
/// compact `WidgetSnapshot` the app persists to the shared app-group container
/// after every successful refresh.  Edit Widget picks a topic.  Dedicated Mac
/// and Alerts tiles live in this same bundle when a count-only card is too thin.
@main
struct UsageMonitorWidgetBundle: WidgetBundle {
    var body: some Widget {
        BudgetSummaryWidget()
        MacGlanceWidget()
        AlertsGlanceWidget()
        QuotasGlanceWidget()
    }
}

// MARK: - Timeline

struct BudgetEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
    let content: WidgetTopicContent
}

struct BudgetTimelineProvider: AppIntentTimelineProvider {
    typealias Intent = SelectBudgetIntent

    func placeholder(in context: Context) -> BudgetEntry {
        entry(
            snapshot: .placeholder,
            topic: .budget,
            budgetFocus: .overall,
            llmProviderId: nil,
            serverFocus: .service
        )
    }

    func snapshot(for configuration: SelectBudgetIntent, in context: Context) async -> BudgetEntry {
        let snapshot = context.isPreview
            ? WidgetSnapshot.placeholder
            : (WidgetSnapshotResolver.shared.read() ?? .empty)
        return entry(snapshot: snapshot, configuration: configuration)
    }

    func timeline(for configuration: SelectBudgetIntent, in context: Context) async -> Timeline<BudgetEntry> {
        let snapshot = WidgetSnapshotResolver.shared.read() ?? .empty
        let item = entry(snapshot: snapshot, configuration: configuration)
        // The app refreshes the snapshot on foreground / background fetch; the
        // widget just re-reads periodically.  30 min is a battery-safe cadence
        // that still keeps spend reasonably fresh through the day.
        let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date())
            ?? Date().addingTimeInterval(1800)
        return Timeline(entries: [item], policy: .after(next))
    }

    private func entry(snapshot: WidgetSnapshot, configuration: SelectBudgetIntent) -> BudgetEntry {
        entry(
            snapshot: snapshot,
            topic: configuration.resolvedTopic,
            budgetFocus: configuration.focus,
            llmProviderId: configuration.llmProvider?.id,
            serverFocus: configuration.resolvedServerFocus,
            maxMeters: configuration.maxMeters,
            sortOrder: configuration.sort
        )
    }

    private func entry(
        snapshot: WidgetSnapshot,
        topic: WidgetTopic,
        budgetFocus: WidgetBudgetFocus,
        llmProviderId: String?,
        serverFocus: WidgetServerFocus,
        maxMeters: Int = 3,
        sortOrder: WidgetSortOrder = .utilisation
    ) -> BudgetEntry {
        BudgetEntry(
            date: Date(),
            snapshot: snapshot,
            content: WidgetTopicPresentation.topicContent(
                from: snapshot,
                topic: topic,
                budgetFocus: budgetFocus,
                llmProviderId: llmProviderId,
                serverFocus: serverFocus,
                maxMeters: maxMeters,
                sortOrder: sortOrder
            )
        )
    }
}

// MARK: - Widget

struct BudgetSummaryWidget: Widget {
    let kind = "BudgetSummaryWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: kind,
            intent: SelectBudgetIntent.self,
            provider: BudgetTimelineProvider()
        ) { entry in
            UsageMonitorWidgetView(entry: entry)
                .containerBackground(Theme.Colors.background, for: .widget)
                .widgetURL(widgetURL(for: entry.content))
        }
        .configurationDisplayName("Usage Monitor")
        .description("Budget, LLM quotas, servers, Mac, alerts, or providers.  Edit Widget to choose a topic.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }

    private func widgetURL(for content: WidgetTopicContent) -> URL? {
        switch content {
        case .budget(let budget): return budget.deepLink
        case .llm(let llm): return llm.deepLink
        case .quota(let quota): return quota.deepLink
        case .server(let server): return server.deepLink
        case .mac(let mac): return mac.deepLink
        case .alerts(let alerts): return alerts.deepLink
        case .providers(let providers): return providers.deepLink
        case .projects(let projects): return projects.deepLink
        case .unavailable(let unavailable): return unavailable.deepLink
        }
    }
}

// MARK: - Previews

#Preview("Small · Budget", as: .systemSmall) {
    BudgetSummaryWidget()
} timeline: {
    BudgetEntry(
        date: .now,
        snapshot: .placeholder,
        content: WidgetTopicPresentation.topicContent(
            from: .placeholder,
            topic: .budget,
            budgetFocus: .overall,
            llmProviderId: nil,
            serverFocus: .service
        )
    )
}

#Preview("Medium · LLM", as: .systemMedium) {
    BudgetSummaryWidget()
} timeline: {
    BudgetEntry(
        date: .now,
        snapshot: .placeholder,
        content: WidgetTopicPresentation.topicContent(
            from: .placeholder,
            topic: .llmQuotas,
            budgetFocus: .overall,
            llmProviderId: "anthropic",
            serverFocus: .service
        )
    )
}

#Preview("Large · Servers", as: .systemLarge) {
    BudgetSummaryWidget()
} timeline: {
    BudgetEntry(
        date: .now,
        snapshot: .placeholder,
        content: WidgetTopicPresentation.topicContent(
            from: .placeholder,
            topic: .servers,
            budgetFocus: .overall,
            llmProviderId: nil,
            serverFocus: .service
        )
    )
}

// MARK: - Root view (topic + family)

struct UsageMonitorWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: BudgetEntry

    var body: some View {
        switch entry.content {
        case .unavailable(let unavailable):
            UnavailableTopicView(content: unavailable, family: family)
        case .budget(let budget):
            BudgetTopicView(entry: entry, budget: budget, family: family)
        case .llm(let llm):
            LlmTopicView(entry: entry, llm: llm, family: family)
        case .quota(let quota):
            QuotaTopicView(entry: entry, quota: quota, family: family)
        case .server(let server):
            ServerTopicView(entry: entry, server: server, family: family)
        case .mac(let mac):
            MacTopicView(mac: mac, family: family)
        case .alerts(let alerts):
            AlertsTopicView(alerts: alerts, family: family, showsList: false)
        case .providers(let providers):
            ProvidersTopicView(providers: providers, family: family)
        case .projects(let projects):
            ProjectsTopicView(entry: entry, projects: projects, family: family)
        }
    }
}

// MARK: - Shared chrome

struct TopicHeader: View {
    var title: String
    var generatedAt: Date?
    var forceStale: Bool = false

    private var stale: Bool {
        if forceStale { return true }
        guard let generatedAt else { return false }
        return WidgetTopicPresentation.isStale(generatedAt: generatedAt)
    }

    var body: some View {
        HStack(spacing: Theme.Spacing.xs) {
            Text(title)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
                .lineLimit(1)
            if stale {
                Text("STALE")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(Theme.Colors.warning)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(
                        Theme.Colors.warning.opacity(0.15),
                        in: Capsule()
                    )
                    .accessibilityLabel("Data is stale")
            }
        }
    }
}

struct UpdatedCaption: View {
    var generatedAt: Date?

    private var stale: Bool {
        guard let generatedAt else { return false }
        return WidgetTopicPresentation.isStale(generatedAt: generatedAt)
    }

    var body: some View {
        if let generatedAt,
           let caption = WidgetTopicPresentation.updatedCaption(generatedAt: generatedAt) {
            HStack(spacing: Theme.Spacing.xxs) {
                Image(systemName: stale ? "clock.badge.exclamationmark" : "clock")
                Text(caption)
            }
            .font(Theme.Typography.caption)
            .foregroundStyle(stale ? Theme.Colors.warning : Theme.Colors.tertiaryText)
            .padding(.top, Theme.Spacing.xxs)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(caption)
        }
    }
}

struct UnavailableTopicView: View {
    let content: WidgetUnavailableContent
    let family: WidgetFamily

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(content.title)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
            Text(content.message)
                .font(family == .systemSmall ? Theme.Typography.caption : Theme.Typography.callout)
                .foregroundStyle(Theme.Colors.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Budget

private struct BudgetTopicView: View {
    let entry: BudgetEntry
    let budget: WidgetBudgetContent
    let family: WidgetFamily

    var body: some View {
        switch family {
        case .systemMedium:
            MediumBudgetWidget(entry: entry, budget: budget)
        case .systemLarge:
            LargeBudgetWidget(entry: entry, budget: budget)
        default:
            SmallBudgetWidget(entry: entry, budget: budget)
        }
    }
}

private struct BudgetSummaryColumn: View {
    let entry: BudgetEntry
    let budget: WidgetBudgetContent
    var showsBadge = true
    var showsUpdatedAt = true

    private var redacted: Bool { WidgetPresentation.shouldRedactAmounts() }
    private var generatedAt: Date? {
        WidgetTopicPresentation.generatedAt(for: entry.content, snapshot: entry.snapshot)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            TopicHeader(title: budget.title, generatedAt: generatedAt)

            Text(WidgetPresentation.displayAmount(budget.spentUsd, redacted: redacted))
                .font(Theme.Typography.title)
                .monospacedDigit()
                .foregroundStyle(Theme.Colors.primaryText)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
                .privacySensitive(redacted)

            if !redacted, let caption = WidgetPresentation.budgetCaption(for: budget) {
                Text(caption)
                    .font(Theme.Typography.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }

            if budget.budgetUsd > 0, !redacted {
                BudgetMeter(
                    fraction: WidgetPresentation.fraction(
                        spent: budget.spentUsd,
                        budget: budget.budgetUsd
                    ),
                    status: WidgetPresentation.status(for: budget),
                    height: 8
                )
                .padding(.top, Theme.Spacing.xxs)
            }

            if showsBadge, let label = WidgetPresentation.label(for: budget) {
                StatusBadge(
                    label,
                    status: WidgetPresentation.status(for: budget),
                    systemImage: WidgetPresentation.symbol(for: budget)
                )
                .padding(.top, Theme.Spacing.xxs)
            }

            if showsUpdatedAt {
                UpdatedCaption(generatedAt: generatedAt)
            }
        }
    }
}

private struct SmallBudgetWidget: View {
    let entry: BudgetEntry
    let budget: WidgetBudgetContent
    private var redacted: Bool { WidgetPresentation.shouldRedactAmounts() }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            BudgetSummaryColumn(entry: entry, budget: budget)
            Spacer(minLength: 0)
            if budget.projectedEomUsd > 0 {
                Text("Proj. \(WidgetPresentation.displayAmount(budget.projectedEomUsd, redacted: redacted))")
                    .font(Theme.Typography.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .privacySensitive(redacted)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct MediumBudgetWidget: View {
    let entry: BudgetEntry
    let budget: WidgetBudgetContent
    private var redacted: Bool { WidgetPresentation.shouldRedactAmounts() }

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.lg) {
            BudgetSummaryColumn(entry: entry, budget: budget)
                .frame(maxWidth: .infinity, alignment: .leading)

            if budget.focus != .overall {
                projectSidePanel
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if budget.meters.isEmpty {
                emptyMeters
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                meterList(budget.meters)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func meterList(_ meters: [WidgetSnapshot.Meter]) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            ForEach(meters) { meter in
                LabeledBudgetMeter(
                    title: meter.name,
                    detail: WidgetPresentation.displayMeterDetail(
                        spent: meter.spentUsd,
                        budget: meter.budgetUsd,
                        redacted: redacted
                    ),
                    fraction: redacted
                        ? 0
                        : WidgetPresentation.fraction(
                            spent: meter.spentUsd,
                            budget: meter.budgetUsd
                        ),
                    status: WidgetPresentation.semanticStatus(forRawStatus: meter.status)
                )
                .privacySensitive(redacted)
            }
            Spacer(minLength: 0)
        }
    }

    private var projectSidePanel: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Image(systemName: "folder.fill")
                .foregroundStyle(Theme.Colors.tertiaryText)
            Text("Project Budget")
                .font(Theme.Typography.callout.weight(.medium))
                .foregroundStyle(Theme.Colors.secondaryText)
            Text("Edit Widget to switch to Overall or another project.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.tertiaryText)
            Spacer(minLength: 0)
        }
        .frame(maxHeight: .infinity, alignment: .center)
    }

    private var emptyMeters: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Image(systemName: "gauge.with.dots.needle.bottom.50percent")
                .foregroundStyle(Theme.Colors.tertiaryText)
            Text("No Budgets Set")
                .font(Theme.Typography.callout.weight(.medium))
                .foregroundStyle(Theme.Colors.secondaryText)
            Text("Configure provider budgets to track them here.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.tertiaryText)
        }
        .frame(maxHeight: .infinity, alignment: .center)
    }
}

private struct LargeBudgetWidget: View {
    let entry: BudgetEntry
    let budget: WidgetBudgetContent
    private var redacted: Bool { WidgetPresentation.shouldRedactAmounts() }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            BudgetSummaryColumn(entry: entry, budget: budget)
            if budget.projectedEomUsd > 0 {
                Text("Projected \(WidgetPresentation.displayAmount(budget.projectedEomUsd, redacted: redacted))")
                    .font(Theme.Typography.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .privacySensitive(redacted)
            }
            if budget.focus == .overall {
                if budget.meters.isEmpty {
                    Text("No provider budgets are set.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.tertiaryText)
                } else {
                    ForEach(budget.meters) { meter in
                        LabeledBudgetMeter(
                            title: meter.name,
                            detail: WidgetPresentation.displayMeterDetail(
                                spent: meter.spentUsd,
                                budget: meter.budgetUsd,
                                redacted: redacted
                            ),
                            fraction: redacted
                                ? 0
                                : WidgetPresentation.fraction(
                                    spent: meter.spentUsd,
                                    budget: meter.budgetUsd
                                ),
                            status: WidgetPresentation.semanticStatus(forRawStatus: meter.status)
                        )
                        .privacySensitive(redacted)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - LLM Quotas

private struct LlmTopicView: View {
    let entry: BudgetEntry
    let llm: WidgetLlmContent
    let family: WidgetFamily

    var body: some View {
        switch family {
        case .systemMedium:
            MediumLlmWidget(llm: llm)
        case .systemLarge:
            LargeLlmWidget(llm: llm)
        default:
            SmallLlmWidget(llm: llm)
        }
    }
}

private struct LlmHero: View {
    let llm: WidgetLlmContent
    private var redacted: Bool { WidgetPresentation.shouldRedactAmounts() }
    private var provider: WidgetSnapshot.LlmSection.Provider { llm.provider }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            TopicHeader(title: provider.name, generatedAt: llm.generatedAt)
            if let cost = WidgetTopicPresentation.llmCostCaption(for: provider, redacted: redacted) {
                Text(cost)
                    .font(Theme.Typography.title)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.primaryText)
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
                    .privacySensitive(redacted)
            } else {
                Text(WidgetTopicPresentation.llmTokenCaption(for: provider))
                    .font(Theme.Typography.title)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.primaryText)
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
            }
            if WidgetTopicPresentation.llmDisplayCostUsd(for: provider) != nil {
                Text(WidgetTopicPresentation.llmTokenCaption(for: provider))
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            if let window = WidgetTopicPresentation.llmWindowCaption(hours: llm.windowHours) {
                Text(window)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }
            if provider.quiet {
                Text("Quiet")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }
            if let label = WidgetTopicPresentation.llmBudgetLabel(provider.budgetStatus) {
                StatusBadge(
                    label,
                    status: WidgetTopicPresentation.llmBudgetStatus(provider.budgetStatus),
                    systemImage: "flame.fill"
                )
            }
            UpdatedCaption(generatedAt: llm.generatedAt)
        }
    }
}

private struct SmallLlmWidget: View {
    let llm: WidgetLlmContent

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            LlmHero(llm: llm)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct MediumLlmWidget: View {
    let llm: WidgetLlmContent
    private var redacted: Bool { WidgetPresentation.shouldRedactAmounts() }

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.lg) {
            LlmHero(llm: llm)
                .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                if llm.peers.isEmpty {
                    Text("No other providers in the latest window.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.tertiaryText)
                } else {
                    ForEach(llm.peers.prefix(3)) { peer in
                        HStack {
                            Text(peer.name)
                                .font(Theme.Typography.caption.weight(.medium))
                                .lineLimit(1)
                            Spacer()
                            Text(peerCaption(peer))
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.secondaryText)
                                .privacySensitive(redacted)
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func peerCaption(_ peer: WidgetSnapshot.LlmSection.Provider) -> String {
        if let cost = WidgetTopicPresentation.llmCostCaption(for: peer, redacted: redacted) {
            return cost
        }
        if peer.quiet { return "Quiet" }
        return WidgetTopicPresentation.llmTokenCaption(for: peer)
    }
}

private struct LargeLlmWidget: View {
    let llm: WidgetLlmContent
    private var redacted: Bool { WidgetPresentation.shouldRedactAmounts() }
    private var provider: WidgetSnapshot.LlmSection.Provider { llm.provider }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            LlmHero(llm: llm)
            HStack {
                labeled("Input", WidgetTopicPresentation.compactCount(provider.tokensInput))
                labeled("Output", WidgetTopicPresentation.compactCount(provider.tokensOutput))
            }
            if let rate = provider.usdPerHour, !redacted {
                labeled("Per Hour", WidgetPresentation.displayAmount(rate, redacted: false))
            } else if let tokensPerHour = provider.tokensPerHour {
                labeled("Per Hour", "\(WidgetTopicPresentation.compactCount(tokensPerHour)) tok")
            }
            if let budget = provider.monthlyBudgetUsd, budget > 0, !redacted {
                labeled("Monthly Budget", WidgetPresentation.displayAmount(budget, redacted: false))
            }
            if let projected = provider.projectedMonthEndUsd, !redacted {
                labeled("Projected Month End", WidgetPresentation.displayAmount(projected, redacted: false))
            }
            ForEach(llm.peers.prefix(4)) { peer in
                HStack {
                    Text(peer.name)
                        .font(Theme.Typography.caption.weight(.medium))
                    Spacer()
                    if let cost = WidgetTopicPresentation.llmCostCaption(for: peer, redacted: redacted) {
                        Text(cost)
                            .font(Theme.Typography.caption)
                            .privacySensitive(redacted)
                    } else {
                        Text(peer.quiet ? "Quiet" : WidgetTopicPresentation.llmTokenCaption(for: peer))
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
            }
            Spacer(minLength: 0)
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
                .monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Servers

private struct ServerTopicView: View {
    let entry: BudgetEntry
    let server: WidgetServerContent
    let family: WidgetFamily

    var body: some View {
        switch family {
        case .systemMedium:
            MediumServerWidget(server: server)
        case .systemLarge:
            LargeServerWidget(server: server)
        default:
            SmallServerWidget(server: server)
        }
    }
}

private struct SmallServerWidget: View {
    let server: WidgetServerContent

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            TopicHeader(title: server.title, generatedAt: server.generatedAt)
            serverHero
            UpdatedCaption(generatedAt: server.generatedAt)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private var serverHero: some View {
        if let service = server.service, server.focus == .service {
            StatusBadge(
                WidgetTopicPresentation.serverOverallLabel(for: service),
                status: WidgetTopicPresentation.serverOverallStatus(for: service),
                systemImage: service.ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill"
            )
            if let uptime = service.uptimeSeconds {
                Text(UptimeFormat.string(fromSeconds: uptime))
                    .font(Theme.Typography.callout.weight(.medium))
                    .foregroundStyle(Theme.Colors.primaryText)
            }
        } else if let host = server.host, server.focus == .host {
            StatusBadge(
                WidgetTopicPresentation.hostLabel(host),
                status: WidgetTopicPresentation.hostStatus(host),
                systemImage: "server.rack"
            )
            if let cpu = DiskFormat.cpuString(host.cpuPct) {
                Text(cpu)
                    .font(Theme.Typography.title)
                    .monospacedDigit()
            } else {
                Text("CPU not in the latest cache.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }
        } else if let app = server.app {
            StatusBadge(
                WidgetTopicPresentation.appLabel(app.status),
                status: WidgetTopicPresentation.appStatus(app.status),
                systemImage: "app.badge"
            )
        }
    }
}

private struct MediumServerWidget: View {
    let server: WidgetServerContent

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.lg) {
            SmallServerWidget(server: server)
                .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                sideRows
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private var sideRows: some View {
        if let service = server.service, server.focus == .service {
            ForEach(service.checks.prefix(4)) { check in
                HStack {
                    Text(check.name)
                        .font(Theme.Typography.caption)
                    Spacer()
                    Text(WidgetTopicPresentation.serverCheckLabel(check))
                        .font(Theme.Typography.caption.weight(.medium))
                        .foregroundStyle(WidgetTopicPresentation.serverCheckStatus(check).tint)
                }
            }
        } else if let host = server.host, server.focus == .host {
            if let mem = host.memoryTotalBytes {
                labeled("Memory", DiskFormat.byteString(mem))
            }
            if let used = host.diskUsedPct {
                labeled("Disk", "\(used)%")
            } else if let disk = DiskFormat.summary(free: host.diskFreeBytes, total: host.diskTotalBytes) {
                labeled("Disk", disk)
            }
            if let total = host.appsTotal, let down = host.appsDown {
                labeled("Apps", "\(total - down)/\(total) up")
            }
        } else if let app = server.app {
            labeled("Status", WidgetTopicPresentation.appLabel(app.status))
            if app.selfApp {
                Text("This app")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }
        }
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

private struct LargeServerWidget: View {
    let server: WidgetServerContent

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            TopicHeader(title: server.title, generatedAt: server.generatedAt)
            if let service = server.service, server.focus == .service {
                StatusBadge(
                    WidgetTopicPresentation.serverOverallLabel(for: service),
                    status: WidgetTopicPresentation.serverOverallStatus(for: service),
                    systemImage: service.ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill"
                )
                if let uptime = service.uptimeSeconds {
                    Text("Uptime \(UptimeFormat.string(fromSeconds: uptime))")
                        .font(Theme.Typography.callout.weight(.medium))
                }
                ForEach(service.checks.prefix(8)) { check in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(check.name)
                            Spacer()
                            Text(WidgetTopicPresentation.serverCheckLabel(check))
                                .foregroundStyle(Theme.Colors.secondaryText)
                        }
                        .font(Theme.Typography.caption)
                        if let detail = WidgetTopicPresentation.serverCheckDetail(check) {
                            Text(detail)
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.tertiaryText)
                        }
                    }
                }
            } else if let host = server.host, server.focus == .host {
                StatusBadge(
                    WidgetTopicPresentation.hostLabel(host),
                    status: WidgetTopicPresentation.hostStatus(host),
                    systemImage: "server.rack"
                )
                if let cpu = DiskFormat.cpuString(host.cpuPct) {
                    labeled("CPU", cpu)
                } else {
                    Text("CPU not in the latest cache.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.tertiaryText)
                }
                if let mem = host.memoryTotalBytes {
                    labeled("Memory", DiskFormat.byteString(mem))
                }
                if let used = host.diskUsedPct {
                    labeled("Disk Used", "\(used)%")
                }
                if let disk = DiskFormat.summary(free: host.diskFreeBytes, total: host.diskTotalBytes) {
                    labeled("Disk", disk)
                }
                if let total = host.appsTotal, let down = host.appsDown {
                    labeled("Apps", "\(total - down)/\(total) up")
                }
                ForEach(server.apps.prefix(4)) { app in
                    HStack {
                        Text(app.name)
                        Spacer()
                        Text(WidgetTopicPresentation.appLabel(app.status))
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                    .font(Theme.Typography.caption)
                }
            } else if let app = server.app {
                StatusBadge(
                    WidgetTopicPresentation.appLabel(app.status),
                    status: WidgetTopicPresentation.appStatus(app.status),
                    systemImage: "app.badge"
                )
                if app.selfApp {
                    Text("This app")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.tertiaryText)
                }
            }
            UpdatedCaption(generatedAt: server.generatedAt)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func labeled(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(value)
                .monospacedDigit()
        }
        .font(Theme.Typography.caption)
    }
}
