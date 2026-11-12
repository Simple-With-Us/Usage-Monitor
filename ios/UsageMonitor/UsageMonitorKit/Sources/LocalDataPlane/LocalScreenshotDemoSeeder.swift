import Foundation
import LocalStore
import LocalBudget

/// Seeds realistic on-device money rows for App Store screenshots.
/// Invoked only when the process is launched with `-ScreenshotDemo`.
public enum LocalScreenshotDemoSeeder {
    public static var isEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("-ScreenshotDemo")
    }

    /// Preferred tab raw value when `-ScreenshotTab overview|providers|projects|alerts|settings` is set.
    public static var preferredTabRawValue: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let idx = args.firstIndex(of: "-ScreenshotTab"), args.indices.contains(idx + 1) else {
            return nil
        }
        return args[idx + 1]
    }

    public static func seedIfNeeded(store: SQLiteLocalStore) async throws {
        guard isEnabled else { return }

        // Prefer attaching spend to catalog rows that ensureCatalog already created.
        let providers = try await store.listProviders()
        if providers.contains(where: { $0.label == "Screenshot demo" }) {
            return
        }

        let now = Date()
        let monthStart = Calendar.current.date(
            from: Calendar.current.dateComponents([.year, .month], from: now)
        ) ?? now
        let nextRenewal = Calendar.current.date(byAdding: .month, value: 1, to: monthStart) ?? now

        let demos: [(name: String, budget: Double, cost: Double)] = [
            ("openrouter", 120, 134.90),
            ("anthropic", 250, 212.40),
            ("openai", 200, 96.20),
            ("deepseek", 40, 12.50),
        ]

        for demo in demos {
            guard var provider = providers.first(where: {
                $0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == demo.name
            }) else { continue }

            provider.isActive = true
            provider.label = "Screenshot demo"
            provider.lastFetchAt = now.addingTimeInterval(-900)
            provider.lastFetchError = nil
            provider.updatedAt = now
            // Synthetic keychain marker so UI treats the row as connected (no real secret).
            if provider.keychainAccountId == nil {
                provider.keychainAccountId = "screenshot-demo-\(demo.name)"
            }
            try await store.upsertProvider(provider)

            try await store.upsertPlan(
                LocalProviderPlan(
                    providerId: provider.id,
                    billingMode: "manual",
                    monthlyBudgetUsd: demo.budget,
                    billingInterval: "monthly",
                    updatedAt: now
                )
            )

            try await store.insertSnapshot(
                LocalUsageSnapshot(
                    id: "screenshot-snap-\(demo.name)",
                    providerId: provider.id,
                    fetchedAt: now.addingTimeInterval(-900),
                    totalCost: demo.cost,
                    fixedCostIncludedUsd: 0,
                    costWindowStart: monthStart,
                    costWindowEnd: now,
                    costScope: "month_to_date",
                    costIncludesUnknownFixed: false,
                    totalRequests: Int(demo.cost * 40)
                )
            )
        }

        // Projects (upsert by fixed ids)
        try await store.upsertProject(
            LocalProject(
                id: "screenshot-proj-socratic",
                name: "Socratic Trade",
                description: "Cost-aware trading loop",
                monthlyBudgetUsd: 400,
                createdAt: now.addingTimeInterval(-86400 * 30),
                updatedAt: now
            )
        )
        try await store.upsertProject(
            LocalProject(
                id: "screenshot-proj-monitor",
                name: "Usage Monitor",
                description: "Internal tooling",
                monthlyBudgetUsd: 150,
                createdAt: now.addingTimeInterval(-86400 * 20),
                updatedAt: now
            )
        )

        if let anthropic = providers.first(where: {
            $0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "anthropic"
        }) {
            try await store.upsertSubscription(
                LocalSubscription(
                    id: "screenshot-sub-claude",
                    providerId: anthropic.id,
                    projectId: "screenshot-proj-socratic",
                    name: "Claude Max",
                    costUsd: 100,
                    currency: "USD",
                    interval: "monthly",
                    intervalCount: 1,
                    startDate: now.addingTimeInterval(-86400 * 180),
                    currentPeriodStart: monthStart,
                    nextRenewalAt: nextRenewal,
                    autoRenew: true,
                    status: "active",
                    createdAt: now.addingTimeInterval(-86400 * 180),
                    updatedAt: now
                )
            )
        }
    }
}
