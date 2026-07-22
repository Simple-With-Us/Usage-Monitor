import Foundation
import Models
import WidgetShared

/// Derives the compact `WidgetShared.WidgetSnapshot` from a full
/// `BudgetStatusResponse`. Owned by the **OfflineCache** lane (it already
/// depends on both `Models` and `WidgetShared`). Working starter — the lane may
/// refine meter selection, ordering, or add per-project rollups.
public enum WidgetSnapshotBuilder {
    /// Build a snapshot capturing the summary plus the highest-utilisation
    /// budgeted providers.
    /// - Parameter maxMeters: how many provider meters to keep for the widget.
    public static func snapshot(from response: BudgetStatusResponse, maxMeters: Int = 3) -> WidgetSnapshot {
        let meters: [WidgetSnapshot.Meter] = response.providers
            .filter { $0.hasBudget }
            .sorted { ($0.percentUsed ?? 0) > ($1.percentUsed ?? 0) }
            .prefix(maxMeters)
            .map { provider in
                WidgetSnapshot.Meter(
                    id: provider.id,
                    name: provider.title,
                    spentUsd: provider.spentUsd,
                    budgetUsd: provider.monthlyBudgetUsd,
                    percentUsed: provider.percentUsed,
                    status: provider.status.rawValue
                )
            }

        // Provider-scoped account totals (server summary is project-budget scoped).
        let totalSpent = response.providers.reduce(0) { $0 + $1.spentUsd }
        let totalBudget = response.providers
            .compactMap(\.monthlyBudgetUsd)
            .filter { $0 > 0 }
            .reduce(0, +)
        let projected = response.providers.reduce(0) { $0 + $1.projectedEomUsd }
        let overBudget =
            response.providers.contains { $0.status == .exceeded }
            || (totalBudget > 0 && totalSpent >= totalBudget)
        let warning =
            overBudget
            || response.providers.contains { $0.status == .warning }
            || (totalBudget > 0 && totalSpent / totalBudget >= 0.8)
        let percentUsed = totalBudget > 0 ? totalSpent / totalBudget : nil

        return WidgetSnapshot(
            generatedAt: response.generatedAtDate ?? Date(),
            month: response.month,
            totalSpentUsd: totalSpent,
            totalBudgetUsd: totalBudget,
            projectedEomUsd: projected,
            percentUsed: percentUsed,
            overBudget: overBudget,
            warning: warning,
            topMeters: meters
        )
    }
}
