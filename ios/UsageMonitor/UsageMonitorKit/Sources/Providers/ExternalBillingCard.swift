import SwiftUI
import DesignSystem
import Models

/// Compact native equivalent of the web's `ExternalBillingDetails`: the
/// provider-reported billing records synced from the provider's own billing
/// API. Read-only evidence — these records never create or duplicate local
/// Subscription charges.
struct ExternalBillingCard: View {
    let records: [ExternalBillingRecord]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(
                "Provider-reported billing",
                subtitle: "Synced from the provider — read-only"
            ) {
                Text("\(records.count)")
                    .font(Theme.Typography.captionEmphasis)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }

            VStack(spacing: Theme.Spacing.md) {
                ForEach(records) { record in
                    row(record)
                }
            }

            Text("Provider-reported data does not create or duplicate tracked subscription charges.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.tertiaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    private func row(_ record: ExternalBillingRecord) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(spacing: Theme.Spacing.sm) {
                Text(record.displayName)
                    .font(Theme.Typography.callout.weight(.semibold))
                    .foregroundStyle(Theme.Colors.primaryText)
                    .lineLimit(1)
                Spacer(minLength: Theme.Spacing.sm)
                if let status = record.status, !status.isEmpty {
                    StatusBadge(
                        status.capitalized,
                        status: Self.semanticStatus(for: status),
                        systemImage: "doc.text.magnifyingglass"
                    )
                }
            }

            HStack(spacing: Theme.Spacing.xs) {
                if let amount = record.amountUsd {
                    Text(CurrencyFormat.usd(amount))
                        .font(Theme.Typography.callout.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.Colors.primaryText)
                    if let interval = record.billingInterval, !interval.isEmpty {
                        Text("/ \(interval)")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
                if let qty = record.usageQuantity, qty > 0 {
                    Text("· \(record.formattedUsage)")
                        .font(Theme.Typography.callout.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(Theme.Colors.accent)
                }
                Spacer(minLength: 0)
                Text("\(record.source) · \(record.kind)")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
                    .lineLimit(1)
            }

            if let period = periodDescription(record) {
                Text(period)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }

            if let synced = record.syncedDate {
                Text("Synced \(synced.formatted(.relative(presentation: .named)))")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel(record))
    }

    private func periodDescription(_ record: ExternalBillingRecord) -> String? {
        guard let start = record.currentPeriodStartDate else { return nil }
        let end = record.currentPeriodEndDate
        let style: Date.FormatStyle = .dateTime.month(.abbreviated).day().year()
        if let end {
            return "Current period: \(start.formatted(style)) – \(end.formatted(style))"
        }
        return "Current period from \(start.formatted(style))"
    }

    private func accessibilityLabel(_ record: ExternalBillingRecord) -> String {
        var parts = [record.displayName]
        if let status = record.status { parts.append("status \(status)") }
        if let amount = record.amountUsd {
            var amountPart = CurrencyFormat.usd(amount)
            if let interval = record.billingInterval { amountPart += " per \(interval)" }
            parts.append(amountPart)
        }
        parts.append("source \(record.source)")
        return parts.joined(separator: ", ")
    }

    /// Map the provider's raw status vocabulary to a design-system status,
    /// mirroring the web's `statusClass` buckets (green/amber/red/neutral).
    static func semanticStatus(for status: String) -> Theme.SemanticStatus {
        switch status.lowercased() {
        case "active", "paid", "trialing", "enabled":
            return .ok
        case "past_due", "past-due", "warning", "paused":
            return .warning
        case "canceled", "cancelled", "unpaid", "disabled":
            return .danger
        default:
            return .neutral
        }
    }
}

// MARK: - Previews

#Preview("External billing") {
    ScrollView {
        ExternalBillingCard(records: [
            ExternalBillingRecord(
                source: "stripe",
                externalId: "sub_123",
                kind: "subscription",
                serviceName: "Workers Paid",
                status: "active",
                amountUsd: 5,
                billingInterval: "monthly",
                currentPeriodStart: "2026-07-17T00:00:00.000Z",
                currentPeriodEnd: "2026-08-17T00:00:00.000Z",
                syncedAt: "2026-07-29T08:00:00.000Z"
            ),
            ExternalBillingRecord(
                source: "vercel",
                kind: "plan",
                planName: "Pro",
                status: "past_due",
                amountUsd: 20,
                billingInterval: "monthly",
                syncedAt: "2026-07-29T08:00:00.000Z"
            ),
        ])
        .padding(Theme.Spacing.lg)
    }
    .dsScreenBackground()
}
