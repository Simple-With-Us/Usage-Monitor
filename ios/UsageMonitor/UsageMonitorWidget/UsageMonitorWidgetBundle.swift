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

