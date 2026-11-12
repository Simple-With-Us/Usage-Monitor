import Foundation
import LocalStore
import LocalBudget

public enum LocalImportMode: String, Sendable {
    /// Skip rows whose id/name already exists.
    case merge
    /// Wipe all local money data first, then import (keys still re-entered by user).
    case replace
}

public struct LocalImportResult: Sendable, Equatable {
    public var providers: Int
    public var plans: Int
    public var subscriptions: Int
    public var charges: Int
    public var projects: Int
    public var snapshots: Int
    public var skipped: Int

    /// Owner-facing success line after Import Package.  Always reminds that
    /// API keys are not in the website JSON / phone export.
    public var summaryLine: String {
        var line =
            "Imported \(providers) providers, \(subscriptions) fees, \(charges) charges, \(snapshots) snapshots"
        if skipped > 0 {
            line += " (\(skipped) skipped)"
        }
        line += ".  Re-enter API keys — they are not in this file."
        return line
    }
}

/// Import a secret-free Local export package.
public enum LocalImportBuilder {
    public static func importPackage(
        data: Data,
        store: SQLiteLocalStore,
        mode: LocalImportMode
    ) async throws -> LocalImportResult {
        try await store.open()
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw LocalWriteError.validation("Invalid JSON")
        }
        let format = root["format"] as? String
        guard format == "usage-monitor-local-export" else {
            throw LocalWriteError.validation("Unrecognized export format")
        }
        let version = root["formatVersion"] as? Int ?? 0
        guard version == LocalExportBuilder.formatVersion else {
            throw LocalWriteError.validation("Unsupported export version \(version)")
        }

        if mode == .replace {
            try await store.wipeAll()
        }

        let existingProviders = try await store.listProviders()
        let existingNames = Set(existingProviders.map(\.name))
        let existingIds = Set(existingProviders.map(\.id))
        var skipped = 0
        var nProviders = 0
        var nPlans = 0
        var nSubs = 0
        var nCharges = 0
        var nProjects = 0
        var nSnaps = 0

        let providers = root["providers"] as? [[String: Any]] ?? []
        for row in providers {
            guard let name = row["name"] as? String,
                  let displayName = row["displayName"] as? String,
                  let adapterKind = row["adapterKind"] as? String
            else {
                skipped += 1
                continue
            }
            let id = (row["id"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString
            if mode == .merge, existingNames.contains(name) || existingIds.contains(id) {
                skipped += 1
                continue
            }
            var p = LocalProvider(
                id: id,
                name: name,
                displayName: displayName,
                type: row["type"] as? String ?? "builtin",
                adapterKind: adapterKind,
                category: row["category"] as? String,
                isActive: row["isActive"] as? Bool ?? false,
                refreshIntervalMin: row["refreshIntervalMin"] as? Int ?? 60,
                label: row["label"] as? String
            )
            // Never import keychain account ids — credentials must be re-added.
            p.keychainAccountId = nil
            p.updatedAt = Date()
            try await store.upsertProvider(p)
            nProviders += 1
        }

        let plans = root["plans"] as? [[String: Any]] ?? []
        for row in plans {
            guard let providerId = row["providerId"] as? String else {
                skipped += 1
                continue
            }
            var plan = LocalProviderPlan(
                providerId: providerId,
                billingMode: row["billingMode"] as? String ?? "manual",
                fixedMonthlyCostUsd: row["fixedMonthlyCostUsd"] as? Double,
                monthlyBudgetUsd: row["monthlyBudgetUsd"] as? Double,
                billingInterval: row["billingInterval"] as? String,
                notes: row["notes"] as? String
            )
            plan.updatedAt = Date()
            try await store.upsertPlan(plan)
            nPlans += 1
        }

        let projects = root["projects"] as? [[String: Any]] ?? []
        for row in projects {
            guard let name = row["name"] as? String else {
                skipped += 1
                continue
            }
            let id = (row["id"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString
            var project = LocalProject(
                id: id,
                name: name,
                description: row["description"] as? String,
                monthlyBudgetUsd: row["monthlyBudgetUsd"] as? Double
            )
            project.updatedAt = Date()
            try await store.upsertProject(project)
            nProjects += 1
        }

        let subs = root["subscriptions"] as? [[String: Any]] ?? []
        for row in subs {
            guard let providerId = row["providerId"] as? String,
                  let name = row["name"] as? String,
                  let cost = row["costUsd"] as? Double
            else {
                skipped += 1
                continue
            }
            let id = (row["id"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString
            let periodStart = parseDate(row["currentPeriodStart"]) ?? BudgetEngine.utcMonthStart()
            let next = parseDate(row["nextRenewalAt"])
                ?? SubscriptionPeriodMath.advancePeriod(
                    periodStart: periodStart,
                    interval: row["interval"] as? String ?? "monthly",
                    intervalCount: 1
                )
            var sub = LocalSubscription(
                id: id,
                providerId: providerId,
                projectId: row["projectId"] as? String,
                name: name,
                costUsd: cost,
                interval: row["interval"] as? String ?? "monthly",
                startDate: periodStart,
                currentPeriodStart: periodStart,
                nextRenewalAt: next,
                status: row["status"] as? String ?? "active"
            )
            sub.updatedAt = Date()
            try await store.upsertSubscription(sub)
            nSubs += 1
        }

        let charges = root["charges"] as? [[String: Any]] ?? []
        for row in charges {
            guard let subscriptionId = row["subscriptionId"] as? String,
                  let providerId = row["providerId"] as? String,
                  let cost = row["costUsd"] as? Double,
                  let ps = parseDate(row["periodStart"]),
                  let pe = parseDate(row["periodEnd"])
            else {
                skipped += 1
                continue
            }
            let id = (row["id"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString
            let charge = LocalSubscriptionCharge(
                id: id,
                subscriptionId: subscriptionId,
                providerId: providerId,
                projectId: row["projectId"] as? String,
                periodStart: ps,
                periodEnd: pe,
                costUsd: cost,
                materializedAt: Date()
            )
            try? await store.insertCharge(charge)
            nCharges += 1
        }

        let snaps = root["snapshots"] as? [[String: Any]] ?? []
        for row in snaps.prefix(500) {
            guard let providerId = row["providerId"] as? String,
                  let fetched = parseDate(row["fetchedAt"])
            else {
                skipped += 1
                continue
            }
            let snap = LocalUsageSnapshot(
                id: (row["id"] as? String) ?? UUID().uuidString,
                providerId: providerId,
                fetchedAt: fetched,
                balance: row["balance"] as? Double,
                totalCost: row["totalCost"] as? Double,
                fixedCostIncludedUsd: row["fixedCostIncludedUsd"] as? Double,
                credits: row["credits"] as? Double,
                costCoverageCaveatCode: row["costCoverageCaveatCode"] as? String,
                costCoverageCaveatMessage: row["costCoverageCaveatMessage"] as? String
            )
            try? await store.insertSnapshot(snap)
            nSnaps += 1
        }

        return LocalImportResult(
            providers: nProviders,
            plans: nPlans,
            subscriptions: nSubs,
            charges: nCharges,
            projects: nProjects,
            snapshots: nSnaps,
            skipped: skipped
        )
    }

    private static func parseDate(_ any: Any?) -> Date? {
        guard let s = any as? String else { return nil }
        if let d = ISO8601DateFormatter().date(from: s) { return d }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s)
    }
}
