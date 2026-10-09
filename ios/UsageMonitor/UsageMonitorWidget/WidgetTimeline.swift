import WidgetKit
import SwiftUI
import AppIntents
import WidgetShared

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
            sortOrder: configuration.sort,
            providersSort: configuration.providersSort
        )
    }

    private func entry(
        snapshot: WidgetSnapshot,
        topic: WidgetTopic,
        budgetFocus: WidgetBudgetFocus,
        llmProviderId: String?,
        serverFocus: WidgetServerFocus,
        maxMeters: Int = 3,
        sortOrder: WidgetSortOrder = .utilisation,
        providersSort: WidgetSortOrder = .spend
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
                sortOrder: sortOrder,
                providersSort: providersSort
            )
        )
    }
}
