import WidgetKit
import SwiftUI
import WidgetShared
import DesignSystem

// MARK: - Quotas topic

/// Subscription plan capacity. Answers "how close am I to being cut off",
/// which no existing topic did — LLM Burn is trailing-window *spend*.
struct QuotaTopicView: View {
    let entry: BudgetEntry
    let quota: WidgetQuotaContent
    let family: WidgetFamily
    private let redacted = WidgetPresentation.shouldRedactAmounts()

    var body: some View {
        switch family {
        case .systemMedium:
            MediumQuotaWidget(quota: quota, redacted: redacted)
        case .systemLarge:
            LargeQuotaWidget(quota: quota, redacted: redacted)
        default:
            SmallQuotaWidget(quota: quota, redacted: redacted)
        }
    }
}

private struct QuotaRow: View {
    let window: WidgetSnapshot.QuotaSection.Window
    let redacted: Bool
    var showsCaption = true

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            HStack(spacing: Theme.Spacing.xs) {
                Text(window.providerLabel)
                    .font(Theme.Typography.caption.weight(.medium))
                    .foregroundStyle(Theme.Colors.primaryText)
                    .lineLimit(1)
                if let label = WidgetTopicPresentation.quotaLabel(window) {
                    StatusBadge(
                        label,
                        status: WidgetTopicPresentation.quotaStatus(window),
                        systemImage: WidgetTopicPresentation.quotaSymbol(window)
                    )
                }
                Spacer(minLength: 0)
                Text(WidgetTopicPresentation.quotaRemainingCaption(window))
                    .font(Theme.Typography.caption)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(1)
            }
            BudgetMeter(
                fraction: redacted ? 0 : WidgetTopicPresentation.quotaFractionUsed(window),
                status: WidgetTopicPresentation.quotaStatus(window),
                height: 6
            )
            if showsCaption,
               let caption = WidgetTopicPresentation.quotaWindowCaption(window) {
                Text(caption)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
                    .lineLimit(1)
            }
        }
    }
}

private struct SmallQuotaWidget: View {
    let quota: WidgetQuotaContent
    let redacted: Bool

    private var worst: WidgetSnapshot.QuotaSection.Window? { quota.windows.first }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            TopicHeader(title: "Quotas", generatedAt: quota.generatedAt)
            if let worst {
                Text(WidgetTopicPresentation.quotaRemainingCaption(worst))
                    .font(Theme.Typography.title)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.primaryText)
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
                Text(worst.providerLabel)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(1)
                BudgetMeter(
                    fraction: redacted ? 0 : WidgetTopicPresentation.quotaFractionUsed(worst),
                    status: WidgetTopicPresentation.quotaStatus(worst),
                    height: 8
                )
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct MediumQuotaWidget: View {
    let quota: WidgetQuotaContent
    let redacted: Bool

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                TopicHeader(title: "Quotas", generatedAt: quota.generatedAt)
                if let worst = quota.windows.first {
                    Text(WidgetTopicPresentation.quotaRemainingCaption(worst))
                        .font(Theme.Typography.title)
                        .monospacedDigit()
                        .foregroundStyle(Theme.Colors.primaryText)
                        .minimumScaleFactor(0.7)
                        .lineLimit(1)
                    Text(worst.providerLabel)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                // The hero column already renders the most-urgent window; the
                // medium layout shows the rest alongside it. The small widget
                // is hero-only and the large widget shows the full list.
                ForEach(Array(quota.windows.dropFirst())) { window in
                    QuotaRow(window: window, redacted: redacted, showsCaption: false)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct LargeQuotaWidget: View {
    let quota: WidgetQuotaContent
    let redacted: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            TopicHeader(title: "Quotas", generatedAt: quota.generatedAt)
            ForEach(quota.windows) { window in
                QuotaRow(window: window, redacted: redacted)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Projects topic

/// Every project budget as its own topic, rather than only reachable by
/// picking one project as the Budget topic's focus.
struct ProjectsTopicView: View {
    let entry: BudgetEntry
    let projects: WidgetProjectsContent
    let family: WidgetFamily
    private let redacted = WidgetPresentation.shouldRedactAmounts()

    var body: some View {
        switch family {
        case .systemMedium:
            MediumProjectsWidget(projects: projects, redacted: redacted)
        case .systemLarge:
            LargeProjectsWidget(projects: projects, redacted: redacted)
        default:
            SmallProjectsWidget(projects: projects, redacted: redacted)
        }
    }
}

private struct SmallProjectsWidget: View {
    let projects: WidgetProjectsContent
    let redacted: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            TopicHeader(title: "Projects", generatedAt: projects.generatedAt)
            Text(WidgetPresentation.displayAmount(projects.totalSpentUsd, redacted: redacted))
                .font(Theme.Typography.title)
                .monospacedDigit()
                .foregroundStyle(Theme.Colors.primaryText)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            if let caption = WidgetPresentation.budgetCaptionForTotal(projects.totalBudgetUsd) {
                Text(caption)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct MediumProjectsWidget: View {
    let projects: WidgetProjectsContent
    let redacted: Bool

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                TopicHeader(title: "Projects", generatedAt: projects.generatedAt)
                Text(WidgetPresentation.displayAmount(projects.totalSpentUsd, redacted: redacted))
                    .font(Theme.Typography.title)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Colors.primaryText)
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
                if let caption = WidgetPresentation.budgetCaptionForTotal(projects.totalBudgetUsd) {
                    Text(caption)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.tertiaryText)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                ForEach(projects.projects) { project in
                    LabeledBudgetMeter(
                        title: project.name,
                        detail: WidgetPresentation.displayMeterDetail(
                            spent: project.spentUsd,
                            budget: project.budgetUsd,
                            redacted: redacted
                        ),
                        fraction: redacted
                            ? 0
                            : WidgetPresentation.fraction(
                                spent: project.spentUsd,
                                budget: project.budgetUsd
                            ),
                        status: WidgetPresentation.semanticStatus(forRawStatus: project.status)
                    )
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct LargeProjectsWidget: View {
    let projects: WidgetProjectsContent
    let redacted: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            TopicHeader(title: "Projects", generatedAt: projects.generatedAt)
            ForEach(projects.projects) { project in
                LabeledBudgetMeter(
                    title: project.name,
                    detail: WidgetPresentation.displayMeterDetail(
                        spent: project.spentUsd,
                        budget: project.budgetUsd,
                        redacted: redacted
                    ),
                    fraction: redacted
                        ? 0
                        : WidgetPresentation.fraction(
                            spent: project.spentUsd,
                            budget: project.budgetUsd
                        ),
                    status: WidgetPresentation.semanticStatus(forRawStatus: project.status)
                )
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}
