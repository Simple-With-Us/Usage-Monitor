import SwiftUI
import DesignSystem
import Models

/// Renders the per-application / per-bucket breakdown on the alert detail view.
struct ProviderAlertBreakdownCard: View {
    let providerTitle: String
    let records: [ExternalBillingRecord]

    private var hasUsageQuantities: Bool {
        records.contains { ($0.usageQuantity ?? 0) > 0 }
    }

    private var totalUsageQuantity: Double {
        records.reduce(0) { $0 + max(0, $1.usageQuantity ?? 0) }
    }

    private var totalAmountUsd: Double {
        records.reduce(0) { $0 + max(0, $1.amountUsd ?? 0) }
    }

    private var unit: String {
        records.compactMap(\.usageUnit).first { !$0.isEmpty } ?? "GB"
    }

    private var items: [UsageBreakdownItem] {
        let palette = [
            Theme.Colors.accent,
            Color(red: 0.20, green: 0.60, blue: 0.95),
            Color(red: 0.62, green: 0.38, blue: 0.95),
            Color(red: 0.18, green: 0.78, blue: 0.64),
            Color(red: 0.94, green: 0.35, blue: 0.58),
            Color(red: 0.95, green: 0.68, blue: 0.18),
            Color(red: 0.45, green: 0.55, blue: 0.95),
            Color(red: 0.55, green: 0.75, blue: 0.25),
        ]

        let total = hasUsageQuantities ? totalUsageQuantity : totalAmountUsd
        let sorted = records.sorted {
            let val0 = hasUsageQuantities ? ($0.usageQuantity ?? 0) : ($0.amountUsd ?? 0)
            let val1 = hasUsageQuantities ? ($1.usageQuantity ?? 0) : ($1.amountUsd ?? 0)
            return val0 > val1
        }

        return sorted.enumerated().map { index, record in
            let val = hasUsageQuantities ? max(0, record.usageQuantity ?? 0) : max(0, record.amountUsd ?? 0)
            let pct = total > 0 ? (val / total) : (1.0 / Double(max(1, records.count)))
            let color = palette[index % palette.count]
            let secondary: String? = {
                if hasUsageQuantities, let amt = record.amountUsd, amt > 0 {
                    return CurrencyFormat.usd(amt)
                }
                return nil
            }()

            return UsageBreakdownItem(
                id: record.id,
                title: record.resolvedAppName,
                subtitle: record.serviceName ?? record.displayName,
                value: val,
                formattedValue: record.formattedUsage,
                secondaryValue: secondary,
                percentage: pct,
                status: semanticStatus(for: record.status ?? "active"),
                color: color
            )
        }
    }

    private var totalFormatted: String {
        if hasUsageQuantities {
            if totalUsageQuantity >= 10 {
                return String(format: "%.1f %@", totalUsageQuantity, unit)
            } else if totalUsageQuantity >= 1 {
                return String(format: "%.2f %@", totalUsageQuantity, unit)
            } else {
                return String(format: "%.3f %@", totalUsageQuantity, unit)
            }
        }
        return CurrencyFormat.usd(totalAmountUsd)
    }

    private var totalLabel: String {
        if hasUsageQuantities {
            return "Total \(unit == "GB" ? "Storage" : "Usage")"
        }
        return "Total Tracked"
    }

    private var cardTitle: String {
        if providerTitle.lowercased().contains("backblaze") {
            return "Storage by Application"
        }
        return "Usage by Application"
    }

    private var cardSubtitle: String {
        let count = records.count
        let noun = providerTitle.lowercased().contains("backblaze") ? "bucket" : "service"
        let plural = count == 1 ? noun : "\(noun)s"
        return "\(totalFormatted) across \(count) \(plural)"
    }

    var body: some View {
        UsageBreakdownCard(
            title: cardTitle,
            subtitle: cardSubtitle,
            items: items,
            totalFormatted: totalFormatted,
            totalLabel: totalLabel
        )
    }

    private func semanticStatus(for status: String) -> Theme.SemanticStatus {
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
