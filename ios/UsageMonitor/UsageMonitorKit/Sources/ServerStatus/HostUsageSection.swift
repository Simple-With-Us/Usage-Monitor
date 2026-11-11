import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking

/// Hetzner host utilization (whole server) plus Coolify app resources.
/// Lives on the Server tab as its own grouped Form sections — not a buried
/// Settings block, and not a row of tiny in-card captions.
struct HostUsageSection: View {
    let store: HostUsageStore
    let hasCredential: Bool
    let onReload: @Sendable () async -> Void

    var body: some View {
        Group {
            if !hasCredential {
                Section {
                    Text("Sign in or add a read token to see host usage.")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                } header: {
                    hostHeader
                } footer: {
                    Text(footerText)
                }
            } else {
                switch store.state {
                case let .failed(error):
                    Section {
                        failure(error)
                    } header: {
                        hostHeader
                    }
                default:
                    if let metrics = store.state.value {
                        loaded(metrics)
                    } else {
                        Section {
                            skeleton
                        } header: {
                            hostHeader
                        }
                    }
                }
            }
        }
    }

    private var hostHeader: some View {
        HStack {
            Text("Host Usage")
            Spacer()
            if case let .loaded(metrics) = store.state {
                StatusBadge(
                    metrics.stale ? "Stale" : (metrics.degraded ? "Degraded" : "Live"),
                    status: metrics.stale || metrics.degraded ? .warning : .ok,
                    systemImage: metrics.stale || metrics.degraded
                        ? "exclamationmark.triangle.fill"
                        : "server.rack"
                )
                .textCase(nil)
            }
        }
    }

    private var footerText: String {
        if !hasCredential {
            return "Connect a read token or sign in with the dashboard password to load Hetzner host metrics."
        }
        if case let .loaded(metrics) = store.state, let asOf = metrics.asOf {
            return "Host-wide CPU and network from Hetzner · app list from Coolify · checked \(asOf)."
        }
        return "Host-wide CPU and network from Hetzner · app list from Coolify."
    }

    private var skeleton: some View {
        ForEach(0..<4, id: \.self) { _ in
            HStack {
                SkeletonBlock(width: 100, height: 12)
                Spacer()
                SkeletonBlock(width: 48, height: 12)
            }
        }
    }

    @ViewBuilder
    private func failure(_ error: APIError) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(error.title)
                .font(Theme.Typography.captionEmphasis)
            Text(error.message)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
            Button {
                Task { await onReload() }
            } label: {
                Label("Try Again", systemImage: "arrow.clockwise")
                    .font(Theme.Typography.caption.weight(.semibold))
            }
            .buttonStyle(.borderless)
            .tint(Theme.Colors.accent)
        }
    }

    @ViewBuilder
    private func loaded(_ metrics: ServerMetrics) -> some View {
        Section {
            serverRows(metrics)
        } header: {
            sectionHeading("Server")
        } footer: {
            Text(footerText)
        }

        if let prevention = metrics.prevention {
            Section {
                riskRows(prevention)
            } header: {
                sectionHeading("Risk Indicators")
            }
        }

        Section {
            thisAppRows(metrics)
        } header: {
            sectionHeading("This App")
        }

        if let fleet = metrics.fleetBackups, !fleet.apps.isEmpty {
            Section {
                fleetBackupRows(fleet)
            } header: {
                sectionHeading("Fleet Backups")
            }
        }

        let others = metrics.resources.filter { !$0.selfApp }
        if !others.isEmpty {
            Section {
                allAppsRows(others, fleet: metrics.fleetBackups)
            } header: {
                sectionHeading("All Apps On Host")
            }
        }

        if let error = metrics.error, !error.isEmpty {
            Section {
                Text(error)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.warning)
            }
        }
    }

    /// Real Form section headers sit outside the card.  Center them and use
    /// the section-header token so they read as titles, not leftover captions.
    private func sectionHeading(_ title: String) -> some View {
        Text(title)
            .font(Theme.Typography.sectionHeader)
            .foregroundStyle(Theme.Colors.primaryText)
            .frame(maxWidth: .infinity, alignment: .center)
            .textCase(nil)
            .padding(.vertical, 2)
    }

    @ViewBuilder
    private func serverRows(_ metrics: ServerMetrics) -> some View {
        if let host = metrics.host {
            if let name = host.name {
                LabeledContent("Name", value: name)
                    .copyableRow(label: "Name", value: name)
            }
            if let type = host.serverType, let cpus = host.cpus {
                let typeStr = "\(type) · \(cpus) vCPU"
                LabeledContent("Type", value: typeStr)
                    .copyableRow(label: "Type", value: typeStr)
            } else if let type = host.serverType {
                LabeledContent("Type", value: type)
                    .copyableRow(label: "Type", value: type)
            }
            if let mem = host.memoryTotalBytes {
                let memStr = DiskFormat.byteString(mem)
                LabeledContent("Memory", value: memStr)
                    .copyableRow(label: "Memory", value: memStr)
            }
            if let status = host.status {
                let statStr = status.capitalized
                LabeledContent("Status", value: statStr)
                    .copyableRow(label: "Status", value: statStr)
            }
            if let window = host.backupWindow {
                let bkpStr = "Daily \(window) UTC"
                LabeledContent("Hetzner Backups", value: bkpStr)
                    .copyableRow(label: "Hetzner Backups", value: bkpStr)
            }
        }

        if let usage = metrics.hostUsage {
            if let cpu = DiskFormat.cpuString(usage.cpuPct) {
                LabeledContent("CPU", value: cpu)
                    .copyableRow(label: "CPU", value: cpu)
            }
            if let rx = DiskFormat.rateString(usage.networkRxBytesPerSec),
               let tx = DiskFormat.rateString(usage.networkTxBytesPerSec) {
                let netStr = "↓ \(rx) · ↑ \(tx)"
                LabeledContent("Network", value: netStr)
                    .copyableRow(label: "Network", value: netStr)
            }
            if let read = DiskFormat.rateString(usage.diskReadBytesPerSec),
               let write = DiskFormat.rateString(usage.diskWriteBytesPerSec) {
                let ioStr = "R \(read) · W \(write)"
                LabeledContent("Disk I/O", value: ioStr)
                    .copyableRow(label: "Disk I/O", value: ioStr)
            }
        }
    }

    @ViewBuilder
    private func riskRows(_ prevention: ServerMetrics.Prevention) -> some View {
        let overallLabel = preventionOverallLabel(prevention)
        LabeledContent("Overall") {
            StatusBadge(
                overallLabel,
                status: preventionOverallStatus(prevention.overall),
                systemImage: prevention.overall == "ok"
                    ? "checkmark.shield.fill"
                    : "exclamationmark.shield.fill"
            )
        }
        .copyableRow(label: "Overall", value: overallLabel)

        if let summary = prevention.summary {
            if let peak = summary.cpuPeakPct {
                let peakStr = String(format: "%.0f%%", peak)
                LabeledContent("CPU Peak (1h)", value: peakStr)
                    .copyableRow(label: "CPU Peak (1h)", value: peakStr)
            }
            if let avg = summary.cpuAvgPct {
                let avgStr = String(format: "%.0f%%", avg)
                LabeledContent("CPU Avg (1h)", value: avgStr)
                    .copyableRow(label: "CPU Avg (1h)", value: avgStr)
            }
            if let down = summary.appsDown, let total = summary.appsTotal {
                let appsStr = "\(total - down)/\(total) up"
                LabeledContent("Apps", value: appsStr)
                    .copyableRow(label: "Apps", value: appsStr)
            }
            if let ok = summary.backupAppsOk, let total = summary.backupAppsTotal {
                let bkpStr = "\(ok)/\(total) OK"
                LabeledContent("Backups", value: bkpStr)
                    .copyableRow(label: "Backups", value: bkpStr)
            }
        }

        let topIndicators = Array(prevention.indicators.prefix(4))
        ForEach(topIndicators) { indicator in
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                LabeledContent(indicator.label) {
                    StatusBadge(
                        indicator.severity.capitalized,
                        status: indicatorSeverityStatus(indicator.severity),
                        systemImage: indicator.severity == "critical"
                            ? "xmark.octagon.fill"
                            : "exclamationmark.triangle.fill"
                    )
                }
                Text(indicator.detail)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
        }

        if !prevention.history.isEmpty {
            NavigationLink {
                HostPreventionDetailView(prevention: prevention)
            } label: {
                Label("Open Stats & History", systemImage: "chart.line.uptrend.xyaxis")
                    .font(Theme.Typography.caption.weight(.semibold))
            }
        }
    }

    @ViewBuilder
    private func thisAppRows(_ metrics: ServerMetrics) -> some View {
        if let selfApp = metrics.selfResources.first {
            LabeledContent(selfApp.fleetLabel ?? selfApp.name) {
                StatusBadge(
                    resourceLabel(selfApp.status),
                    status: resourceStatus(selfApp.status),
                    systemImage: resourceStatus(selfApp.status) == .ok
                        ? "checkmark.circle.fill"
                        : "exclamationmark.circle.fill"
                )
            }
        } else {
            Text("Usage Monitor app not listed by Coolify.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
        }

        if let disk = metrics.appDisk {
            if let free = disk.freeBytes, let total = disk.totalBytes {
                LabeledContent("App Disk") {
                    Text(DiskFormat.summary(free: free, total: total) ?? "—")
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            if let used = disk.usedPct {
                LabeledContent("App Disk Used", value: "\(used)%")
            }
        }
    }

    @ViewBuilder
    private func fleetBackupRows(_ fleet: ServerMetrics.FleetBackups) -> some View {
        ForEach(fleet.apps) { app in
            LabeledContent(app.label) {
                StatusBadge(
                    app.ok == false ? "Lagging" : "OK",
                    status: app.ok == false ? .warning : .ok,
                    systemImage: app.ok == false ? "exclamationmark" : "checkmark"
                )
            }
            if let summary = appBackupSummary(app) {
                Text(summary)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }

        NavigationLink {
            FleetBackupDetailView(fleet: fleet)
        } label: {
            Label("Open Backup Locations", systemImage: "externaldrive.badge.timemachine")
                .font(Theme.Typography.caption.weight(.semibold))
        }
    }

    @ViewBuilder
    private func allAppsRows(
        _ others: [ServerMetrics.Resource],
        fleet: ServerMetrics.FleetBackups?
    ) -> some View {
        ForEach(others) { resource in
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                LabeledContent(resource.fleetLabel ?? resource.name) {
                    StatusBadge(
                        resourceLabel(resource.status),
                        status: resourceStatus(resource.status),
                        systemImage: resourceStatus(resource.status) == .ok
                            ? "checkmark"
                            : "exclamationmark"
                    )
                }
                if let backupLine = linkedBackupLine(
                    fleetAppId: resource.fleetAppId,
                    fleet: fleet
                ) {
                    Text(backupLine)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                Text(resource.type.capitalized)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(
                "\(resource.fleetLabel ?? resource.name): \(resourceLabel(resource.status))"
            )
        }
    }

    private func appBackupSummary(_ app: ServerMetrics.FleetBackups.App) -> String? {
        let present = app.locations.filter { $0.present == true || $0.ok == true }
        guard !present.isEmpty else {
            return app.locations.first?.reason.map { humanReason($0) }
        }
        let parts = present.prefix(3).map { loc -> String in
            if let age = loc.latestAgeSeconds {
                return "\(loc.label) \(UptimeFormat.string(fromSeconds: Int(age))) ago"
            }
            return loc.label
        }
        return parts.joined(separator: " · ")
    }

    private func linkedBackupLine(
        fleetAppId: String?,
        fleet: ServerMetrics.FleetBackups?
    ) -> String? {
        guard let fleetAppId, let fleet else { return nil }
        guard let app = fleet.apps.first(where: { $0.id == fleetAppId }) else { return nil }
        return appBackupSummary(app).map { "Backups: \($0)" }
    }

    private func humanReason(_ reason: String) -> String {
        switch reason {
        case let value where value.hasPrefix("peer_health_http_"):
            return "peer was down (health \(value.dropFirst("peer_health_http_".count)))"
        case "peer_health_unreachable":
            return "peer health unreachable"
        case "peer_litestream_age_missing":
            return "peer omitted replica age"
        case "peer_litestream_tiers_degraded":
            return "deep compaction is wedged"
        default:
            return reason
                .replacingOccurrences(of: "_", with: " ")
                .replacingOccurrences(of: "b2 ", with: "B2 ")
                .replacingOccurrences(of: "r2 ", with: "R2 ")
                .replacingOccurrences(of: "ltx ", with: "LTX ")
        }
    }

    /// Prefer the concrete critical cause (App Down) over a generic "Critical"
    /// that reads like the box itself is out of CPU or disk.
    private func preventionOverallLabel(_ prevention: ServerMetrics.Prevention) -> String {
        if prevention.overall == "critical" {
            let criticals = prevention.indicators.filter { $0.severity == "critical" }
            if criticals.count == 1 {
                return criticals[0].label
            }
            return "Critical"
        }
        if prevention.overall == "warning" { return "Watch" }
        return "OK"
    }

    private func preventionOverallStatus(_ overall: String?) -> Theme.SemanticStatus {
        switch overall {
        case "critical": return .danger
        case "warning": return .warning
        default: return .ok
        }
    }

    private func indicatorSeverityStatus(_ severity: String) -> Theme.SemanticStatus {
        switch severity {
        case "critical": return .danger
        case "warning": return .warning
        default: return .ok
        }
    }

    private func resourceLabel(_ status: String) -> String {
        let lower = status.lowercased()
        if lower.hasPrefix("exited") || lower.hasPrefix("stopped") { return "Stopped" }
        if lower.contains("unhealthy") { return "Unhealthy" }
        if lower.contains("healthy") || lower == "running" { return "Healthy" }
        if lower.contains("unknown") { return "Unknown" }
        if lower.contains("degraded") { return "Degraded" }
        return status
    }

    private func resourceStatus(_ status: String) -> Theme.SemanticStatus {
        let lower = status.lowercased()
        if lower.hasPrefix("exited") || lower.hasPrefix("stopped") { return .danger }
        if lower.contains("unhealthy") { return .danger }
        if lower.contains("healthy") || lower == "running" { return .ok }
        if lower.contains("unknown") { return .warning }
        if lower.contains("degraded") { return .warning }
        return .warning
    }
}
