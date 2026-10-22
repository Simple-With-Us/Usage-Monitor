import Foundation
import Models
import WidgetShared

/// Derives the compact `WidgetShared.WidgetSnapshot` from a full
/// `BudgetStatusResponse`. Owned by the **OfflineCache** lane (it already
/// depends on both `Models` and `WidgetShared`).
public enum WidgetSnapshotBuilder {
    /// Build a snapshot capturing the overall (provider-scoped) summary, top
    /// provider meters, and every project so the widget can focus overall or
    /// on a single project budget.
    /// - Parameter maxMeters: how many provider meters to keep for the overall view.
    /// - Parameter maxSpenders: how many top-spend providers to keep for Providers.
    public static func snapshot(
        from response: BudgetStatusResponse,
        maxMeters: Int = 3,
        maxSpenders: Int = 6
    ) -> WidgetSnapshot {
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
                    status: provider.status.rawValue,
                    projectedEomUsd: provider.projectedEomUsd
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

        let projects: [WidgetSnapshot.Meter] = (response.projects ?? [])
            .sorted { lhs, rhs in
                let lp = lhs.percentUsed ?? -1
                let rp = rhs.percentUsed ?? -1
                if lp != rp { return lp > rp }
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
            .map { project in
                WidgetSnapshot.Meter(
                    id: project.id,
                    name: project.name,
                    spentUsd: project.spentUsd,
                    budgetUsd: project.monthlyBudgetUsd,
                    percentUsed: project.percentUsed,
                    status: project.status.rawValue,
                    projectedEomUsd: project.projectedEomUsd
                )
            }

        return WidgetSnapshot(
            generatedAt: response.generatedAtDate ?? Date(),
            month: response.month,
            totalSpentUsd: totalSpent,
            totalBudgetUsd: totalBudget,
            projectedEomUsd: projected,
            percentUsed: percentUsed,
            overBudget: overBudget,
            warning: warning,
            topMeters: meters,
            projects: projects,
            spenders: spenders(from: response, maxSpenders: maxSpenders),
            alerts: alertsSection(from: response)
        )
    }

    /// Highest month-to-date spend, including providers with no budget.
    /// Zero-spend rows stay out so the tile cannot show a fake $0 ranking.
    public static func spenders(
        from response: BudgetStatusResponse,
        maxSpenders: Int = 6
    ) -> [WidgetSnapshot.Meter] {
        Array(
            response.providers
                .filter { $0.spentUsd > 0 }
                .sorted { lhs, rhs in
                    if lhs.spentUsd != rhs.spentUsd { return lhs.spentUsd > rhs.spentUsd }
                    return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
                }
                .prefix(maxSpenders)
                .map { provider in
                    WidgetSnapshot.Meter(
                        id: provider.id,
                        name: provider.title,
                        spentUsd: provider.spentUsd,
                        budgetUsd: provider.monthlyBudgetUsd,
                        percentUsed: provider.percentUsed,
                        status: provider.status.rawValue,
                        projectedEomUsd: provider.projectedEomUsd
                    )
                }
        )
    }

    /// Active alerts in the same severity order as `BudgetStore.alertItems`.
    public static func alertsSection(
        from response: BudgetStatusResponse,
        maxItems: Int = 6
    ) -> WidgetSnapshot.AlertsSection {
        let items = response.providers
            .flatMap { provider in
                provider.alerts.map { alert in
                    WidgetSnapshot.AlertsSection.Item(
                        id: "\(provider.id)|\(alert.id)",
                        title: alert.title,
                        providerName: provider.title,
                        severity: alert.severity.rawValue
                    )
                }
            }
            .sorted { lhs, rhs in
                severityOrder(lhs.severity) < severityOrder(rhs.severity)
            }
        let latest = items.first
        let needsAttention = items.filter {
            $0.severity == AlertSeverity.critical.rawValue
                || $0.severity == AlertSeverity.warning.rawValue
        }.count
        return WidgetSnapshot.AlertsSection(
            generatedAt: response.generatedAtDate ?? Date(),
            openCount: items.count,
            needsAttentionCount: needsAttention,
            latestTitle: latest?.title,
            latestProvider: latest?.providerName,
            latestSeverity: latest?.severity,
            items: Array(items.prefix(maxItems))
        )
    }

    /// Mac heartbeat.  Always returns a section so "not reported" is distinct
    /// from "never cached".
    public static func macSection(
        from response: MacHealthResponse,
        now: Date = Date()
    ) -> WidgetSnapshot.MacSection {
        let heartbeat = response.lastHeartbeatAt.flatMap(ISO8601DateParser.date(from:))
            ?? response.mac?.lastHeartbeatAt.flatMap(ISO8601DateParser.date(from:))
        let mac = response.mac
        return WidgetSnapshot.MacSection(
            generatedAt: heartbeat ?? now,
            ok: response.ok,
            status: response.status,
            reported: mac != nil,
            hostname: mac?.hostname,
            osVersion: mac?.osVersion,
            arch: mac?.chipName ?? mac?.arch,
            cpuUsagePct: mac?.cpuUsagePct,
            memoryUsagePct: mac?.memoryUsagePct,
            diskUsagePct: mac?.diskUsagePct,
            uptimeSeconds: mac?.uptimeSeconds,
            lastHeartbeatAt: heartbeat,
            secondsSinceHeartbeat: response.secondsSinceHeartbeat,
            flags: macFlags(from: response),
            processes: (mac?.processRows ?? []).map {
                WidgetSnapshot.MacSection.Process(name: $0.name, status: $0.status)
            }
        )
    }

    /// Compact LLM section from the kit's `LlmBurnResponse`.  Refuses a
    /// non-ok payload so a failed fetch cannot stamp empty providers as live.
    public static func llmSection(from response: LlmBurnResponse, now: Date = Date()) -> WidgetSnapshot.LlmSection? {
        guard response.ok else { return nil }
        let generatedAt = response.generatedAt.flatMap(ISO8601DateParser.date(from:)) ?? now
        var providers: [WidgetSnapshot.LlmSection.Provider] = response.providers.map {
            llmProvider($0, quiet: false)
        }
        for quiet in response.quietProviders ?? [] {
            if providers.contains(where: { $0.id.caseInsensitiveCompare(quiet.provider) == .orderedSame }) {
                continue
            }
            providers.append(llmProvider(quiet, quiet: true))
        }
        return WidgetSnapshot.LlmSection(
            generatedAt: generatedAt,
            windowHours: response.windowHours,
            providers: providers
        )
    }

    /// Service probe from public health + readiness.  Readiness is optional.
    public static func serverService(
        health: ServerHealth,
        readiness: ServerReadiness?,
        now: Date = Date()
    ) -> WidgetSnapshot.ServerSection.Service {
        WidgetSnapshot.ServerSection.Service(
            generatedAt: now,
            name: health.service ?? "usage-monitor",
            ok: health.ok,
            status: health.status,
            uptimeSeconds: health.uptimeSeconds,
            readyOk: readiness?.ok,
            checks: serviceChecks(from: readiness)
        )
    }

    /// Host + Coolify app inventory from `ServerMetrics`.
    public static func serverHost(
        from metrics: ServerMetrics,
        now: Date = Date()
    ) -> (host: WidgetSnapshot.ServerSection.Host, apps: [WidgetSnapshot.ServerSection.App]) {
        let summary = metrics.prevention?.summary
        let disk = metrics.appDisk
        let host = WidgetSnapshot.ServerSection.Host(
            generatedAt: now,
            name: metrics.host?.name,
            status: metrics.host?.status,
            cpuPct: metrics.hostUsage?.cpuPct,
            memoryTotalBytes: metrics.host?.memoryTotalBytes,
            diskUsedPct: summary?.diskUsedPct ?? disk?.usedPct,
            diskFreeBytes: summary?.diskFreeBytes ?? disk?.freeBytes,
            diskTotalBytes: summary?.diskTotalBytes ?? disk?.totalBytes,
            degraded: metrics.degraded,
            stale: metrics.stale,
            preventionOverall: metrics.prevention?.overall,
            appsHealthy: summary?.appsHealthy,
            appsDown: summary?.appsDown,
            appsTotal: summary?.appsTotal
        )
        let apps = metrics.resources.map { resource in
            WidgetSnapshot.ServerSection.App(
                id: resource.uuid,
                name: resource.fleetLabel ?? resource.name,
                status: resource.status,
                selfApp: resource.selfApp
            )
        }
        return (host, apps)
    }

    /// Same issue flags the Computers tab already shows.  Do not invent new
    /// thresholds here.
    static func macFlags(from health: MacHealthResponse) -> [String] {
        var flags: [String] = []
        if health.status == "offline" {
            flags.append("Heartbeat stale — Mac looks offline.")
        }
        guard let mac = health.mac else { return flags }
        if mac.cpuUsagePct > 90 { flags.append("CPU above 90%.") }
        if mac.memoryUsagePct > 90 { flags.append("Memory above 90%.") }
        if mac.diskUsagePct > 95 { flags.append("Disk above 95%.") }
        for row in mac.processRows where row.status != "running" {
            flags.append("\(shortProcessName(row.name)) is \(row.status).")
        }
        return flags
    }

    private static func shortProcessName(_ name: String) -> String {
        name.replacingOccurrences(of: "com.jay.", with: "")
    }

    private static func severityOrder(_ raw: String) -> Int {
        switch raw {
        case AlertSeverity.critical.rawValue: return 0
        case AlertSeverity.warning.rawValue: return 1
        case AlertSeverity.info.rawValue: return 2
        default: return 3
        }
    }

    private static func llmProvider(
        _ row: LlmBurnProviderReport,
        quiet: Bool
    ) -> WidgetSnapshot.LlmSection.Provider {
        WidgetSnapshot.LlmSection.Provider(
            id: row.provider,
            name: row.provider,
            quiet: quiet,
            tokensTotal: row.window.tokens.total,
            tokensInput: row.window.tokens.input,
            tokensOutput: row.window.tokens.output,
            derivedCostUsd: row.window.derivedCostUsd,
            reportedCostUsd: row.window.reportedCostUsd,
            estimateUsd: row.window.estimateUsd,
            tokensPerHour: row.window.tokensPerHour,
            usdPerHour: row.window.usdPerHour,
            monthlyBudgetUsd: row.budget?.monthlyBudgetUsd,
            budgetStatus: row.budget?.status,
            projectedMonthEndUsd: row.budget?.projectedMonthEndUsd
        )
    }

    /// Mirrors `ServerStatusSnapshot` dependency + backup-layer rows so the
    /// widget shows the same checks the Server tab already computes.
    private static func serviceChecks(from readiness: ServerReadiness?) -> [WidgetSnapshot.ServerSection.Check] {
        guard let checks = readiness?.checks else { return [] }
        var rows: [WidgetSnapshot.ServerSection.Check] = []
        if let c = checks.database {
            rows.append(.init(name: "Database", ok: c.ok, gatesService: true))
        }
        if let c = checks.scheduler {
            rows.append(.init(name: "Scheduler", ok: c.ok, gatesService: true))
        }
        if let c = checks.startup {
            rows.append(.init(name: "Startup", ok: c.ok, gatesService: true))
        }
        if let d = checks.disk {
            rows.append(.init(
                name: "Disk",
                ok: d.ok,
                gatesService: false,
                freeBytes: d.freeBytes,
                totalBytes: d.totalBytes
            ))
        }
        if let layers = checks.backupLayers {
            let layered = backupLayerChecks(layers)
            if !layered.isEmpty {
                rows.append(contentsOf: layered)
                return rows
            }
        }
        if let c = checks.backup {
            rows.append(.init(name: "Backup (Off-Site)", ok: c.ok, gatesService: false))
        }
        return rows
    }

    private static func backupLayerChecks(
        _ layers: ServerReadiness.BackupLayers
    ) -> [WidgetSnapshot.ServerSection.Check] {
        var rows: [WidgetSnapshot.ServerSection.Check] = []
        if let local = layers.local {
            rows.append(.init(
                name: trimmedOrNil(local.title) ?? "Local Backup",
                ok: local.ok,
                gatesService: false,
                detail: trimmedOrNil(local.detail)
            ))
        }
        if let primary = layers.primary {
            rows.append(.init(
                name: trimmedOrNil(primary.title) ?? primaryBackupName(primary),
                ok: primary.ok,
                gatesService: false,
                detail: trimmedOrNil(primary.detail)
            ))
        }
        if let r2 = layers.r2Historic {
            rows.append(.init(
                name: trimmedOrNil(r2.title) ?? "R2 Weekly Archive",
                ok: r2HistoricRowOk(r2),
                gatesService: false,
                detail: trimmedOrNil(r2.detail)
            ))
        }
        return rows
    }

    private static func primaryBackupName(_ primary: ServerReadiness.BackupLayers.PrimaryLayer) -> String {
        switch (primary.label ?? primary.target)?.lowercased() {
        case "b2": return "B2 Backup"
        case "r2": return "R2 Backup"
        default: return "Off-Site Backup"
        }
    }

    private static func r2HistoricRowOk(_ r2: ServerReadiness.BackupLayers.R2HistoricLayer) -> Bool {
        guard r2.role?.lowercased() == "historic" else { return r2.ok }
        if let archive = r2.weeklyArchive {
            return r2.ok && archive.ok
        }
        return false
    }

    private static func trimmedOrNil(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
