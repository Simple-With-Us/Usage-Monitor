import Foundation
import LocalStore

/// Portable on-device backup (no Keychain secrets). Better than web for privacy:
/// one phone-owned archive of money-truth without server credentials.
public enum LocalExportBuilder {
    public static let formatVersion = 1

    public static func build(store: SQLiteLocalStore) async throws -> Data {
        let providers = try await store.listProviders()
        var plans: [LocalProviderPlan] = []
        for p in providers {
            if let plan = try await store.getPlan(providerId: p.id) {
                plans.append(plan)
            }
        }
        let subscriptions = try await store.listSubscriptions()
        let charges = try await store.allCharges()
        let projects = try await store.listProjects()
        let snapshots = try await store.allSnapshots()

        let payload: [String: Any] = [
            "format": "usage-monitor-local-export",
            "formatVersion": formatVersion,
            "exportedAt": ISO8601.string(from: Date()),
            "schemaVersion": await store.schemaVersion,
            "note": "No API keys or secrets. Re-enter keys after import on a new device.",
            "providers": providers.map { p -> [String: Any?] in
                [
                    "id": p.id,
                    "name": p.name,
                    "displayName": p.displayName,
                    "type": p.type,
                    "adapterKind": p.adapterKind,
                    "category": p.category,
                    "isActive": p.isActive,
                    "refreshIntervalMin": p.refreshIntervalMin,
                    "label": p.label,
                    "hasKeychainCredential": p.keychainAccountId != nil,
                    "lastFetchAt": p.lastFetchAt.map(ISO8601.string(from:)),
                    "lastFetchError": p.lastFetchError,
                ]
            },
            "plans": plans.map { plan -> [String: Any?] in
                [
                    "providerId": plan.providerId,
                    "billingMode": plan.billingMode,
                    "fixedMonthlyCostUsd": plan.fixedMonthlyCostUsd,
                    "monthlyBudgetUsd": plan.monthlyBudgetUsd,
                    "billingInterval": plan.billingInterval,
                    "notes": plan.notes,
                ]
            },
            "subscriptions": subscriptions.map { s -> [String: Any?] in
                [
                    "id": s.id,
                    "providerId": s.providerId,
                    "projectId": s.projectId,
                    "name": s.name,
                    "costUsd": s.costUsd,
                    "interval": s.interval,
                    "status": s.status,
                    "currentPeriodStart": ISO8601.string(from: s.currentPeriodStart),
                    "nextRenewalAt": ISO8601.string(from: s.nextRenewalAt),
                ]
            },
            "charges": charges.map { c -> [String: Any?] in
                [
                    "id": c.id,
                    "subscriptionId": c.subscriptionId,
                    "providerId": c.providerId,
                    "projectId": c.projectId,
                    "periodStart": ISO8601.string(from: c.periodStart),
                    "periodEnd": ISO8601.string(from: c.periodEnd),
                    "costUsd": c.costUsd,
                ]
            },
            "projects": projects.map { p -> [String: Any?] in
                [
                    "id": p.id,
                    "name": p.name,
                    "description": p.description,
                    "monthlyBudgetUsd": p.monthlyBudgetUsd,
                ]
            },
            "snapshots": snapshots.prefix(500).map { s -> [String: Any?] in
                [
                    "id": s.id,
                    "providerId": s.providerId,
                    "fetchedAt": ISO8601.string(from: s.fetchedAt),
                    "balance": s.balance,
                    "totalCost": s.totalCost,
                    "fixedCostIncludedUsd": s.fixedCostIncludedUsd,
                    "credits": s.credits,
                    "costCoverageCaveatCode": s.costCoverageCaveatCode,
                    "costCoverageCaveatMessage": s.costCoverageCaveatMessage,
                ]
            },
        ]

        // Strip optionals for JSONSerialization.
        let cleaned = stripNils(payload)
        return try JSONSerialization.data(withJSONObject: cleaned, options: [.prettyPrinted, .sortedKeys])
    }

    private static func stripNils(_ value: Any) -> Any {
        if let dict = value as? [String: Any?] {
            var out: [String: Any] = [:]
            for (k, v) in dict {
                guard let v else { continue }
                out[k] = stripNils(v)
            }
            return out
        }
        if let dict = value as? [String: Any] {
            return dict.mapValues { stripNils($0) }
        }
        if let arr = value as? [Any] {
            return arr.map { stripNils($0) }
        }
        if let arr = value as? [[String: Any?]] {
            return arr.map { stripNils($0) }
        }
        return value
    }
}
