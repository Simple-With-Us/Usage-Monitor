import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking

/// Mac host heartbeat: CPU / memory / disk, issue flags, and process rows.
struct ComputersSection: View {
    let store: ComputersStore
    let onReload: @Sendable () async -> Void
    var onOpenSettings: (() -> Void)? = nil

    var body: some View {
        Section {
            content
        } header: {
            HStack {
                Text("Mac")
                Spacer()
                if case let .loaded(health) = store.state {
                    StatusBadge(
                        statusLabel(health.status),
                        status: semanticStatus(health.status),
                        systemImage: health.ok ? "laptopcomputer" : "exclamationmark.triangle.fill"
                    )
                    .textCase(nil)
                }
            }
        } footer: {
            Text(footerText)
        }
    }

    private var footerText: String {
        if case let .loaded(health) = store.state, let ago = health.secondsSinceHeartbeat {
            return "Last heartbeat \(ago)s ago.  Pull to refresh."
        }
        return "CPU, memory, disk, and launchd flags from the Mac heartbeat.  Connect a read token or sign in if this is empty."
    }

    @ViewBuilder
    private var content: some View {
        switch store.state {
        case let .failed(error):
            failure(error)
        default:
            if let health = store.state.value {
                loaded(health)
            } else {
                skeleton
            }
        }
    }

    private var skeleton: some View {
        ForEach(0..<4, id: \.self) { _ in
            HStack {
                SkeletonBlock(width: 90, height: 12)
                Spacer()
                SkeletonBlock(width: 48, height: 12)
            }
        }
    }

    @ViewBuilder
    private func failure(_ error: APIError) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(error.computersTitle)
                .font(Theme.Typography.captionEmphasis)
            Text(error.computersMessage)
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

            if let onOpenSettings, error == .missingToken || error == .unauthorized {
                Button(action: onOpenSettings) {
                    Label("Open Settings", systemImage: "gearshape")
                        .font(Theme.Typography.caption.weight(.semibold))
                }
                .buttonStyle(.borderless)
                .tint(Theme.Colors.accent)
            }
        }
    }

    @ViewBuilder
    private func loaded(_ health: MacHealthResponse) -> some View {
        if let mac = health.mac {
            let hostTitle: String = {
                if let user = mac.username, let ts = mac.tailscaleHostname {
                    return "\(mac.hostname) (\(user) · \(ts))"
                } else if let user = mac.username {
                    return "\(mac.hostname) (\(user))"
                } else if let ts = mac.tailscaleHostname {
                    return "\(mac.hostname) (\(ts))"
                }
                return mac.hostname
            }()
            LabeledContent("Name", value: hostTitle)
                .copyableRow(label: "Host Name", value: hostTitle)
            if let os = mac.osVersion {
                LabeledContent("System", value: os)
                    .copyableRow(label: "System", value: os)
            }
            let chip = mac.chipName ?? mac.arch ?? "Apple M5"
            LabeledContent("Chip", value: chip)
                .copyableRow(label: "Chip", value: chip)
            let uptimeString = UptimeFormat.string(fromSeconds: mac.uptimeSeconds)
            LabeledContent("Uptime", value: uptimeString)
                .copyableRow(label: "Uptime", value: uptimeString)

            let cpuString = percent(mac.cpuUsagePct)
            LabeledContent("CPU", value: cpuString)
                .copyableRow(label: "CPU", value: cpuString)
            let memoryString = percent(mac.memoryUsagePct)
            LabeledContent("Memory", value: memoryString)
                .copyableRow(label: "Memory", value: memoryString)
            let diskString = percent(mac.diskUsagePct)
            LabeledContent("Data Disk", value: diskString)
                .copyableRow(label: "Data Disk", value: diskString)

            let flags = issueFlags(health)
            if flags.isEmpty {
                LabeledContent("Flags") {
                    StatusBadge("None", status: .ok, systemImage: "checkmark.circle.fill")
                }
                .copyableRow(label: "Flags", value: "None")
            } else {
                Text("Flags")
                    .font(Theme.Typography.captionEmphasis)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 2, trailing: 20))
                    .accessibilityAddTraits(.isHeader)
                ForEach(flags, id: \.self) { flag in
                    Label(flag, systemImage: "exclamationmark.triangle.fill")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.warning)
                        .copyableValue(flag, label: "Flag")
                }
            }

            // Owner (2026-08-31): not-enabled services are noise on this tab —
            // show only processes that are actually expected to run.
            let rows = mac.processRows.filter { !isNotEnabledStatus($0.status) }
            if !rows.isEmpty {
                Text("Local Services")
                    .font(Theme.Typography.captionEmphasis)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 2, trailing: 20))
                    .accessibilityAddTraits(.isHeader)
                ForEach(rows, id: \.name) { row in
                    let name = displayProcessName(row.name)
                    let statusText = processLabel(row.status)
                    LabeledContent(name) {
                        StatusBadge(
                            statusText,
                            status: processStatus(row.status),
                            systemImage: processStatus(row.status) == .ok
                                ? "checkmark.circle.fill"
                                : processStatus(row.status) == .neutral
                                ? "circle"
                                : "exclamationmark.circle.fill"
                        )
                    }
                    .copyableRow(label: name, value: statusText)
                }
            }

            if let pm2 = mac.pm2Processes, !pm2.isEmpty {
                Text("PM2 Fleet (\(pm2.count))")
                    .font(Theme.Typography.captionEmphasis)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 2, trailing: 20))
                    .accessibilityAddTraits(.isHeader)
                ForEach(pm2, id: \.name) { p in
                    let statusText = processLabel(p.status)
                    LabeledContent(p.name) {
                        StatusBadge(
                            statusText,
                            status: processStatus(p.status),
                            systemImage: processStatus(p.status) == .ok ? "checkmark.circle.fill" : "circle"
                        )
                    }
                    .copyableRow(label: p.name, value: statusText)
                }
            }

            if let launchd = mac.launchdProcesses, !launchd.isEmpty {
                Text("Launchd Daemons (\(launchd.count))")
                    .font(Theme.Typography.captionEmphasis)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 2, trailing: 20))
                    .accessibilityAddTraits(.isHeader)
                ForEach(launchd, id: \.name) { l in
                    let clean = l.name.replacingOccurrences(of: "com.jay.", with: "").replacingOccurrences(of: "com.jays.", with: "")
                    let statusText = processLabel(l.status)
                    LabeledContent(clean) {
                        StatusBadge(
                            statusText,
                            status: processStatus(l.status),
                            systemImage: processStatus(l.status) == .ok ? "checkmark.circle.fill" : "circle"
                        )
                    }
                    .copyableRow(label: clean, value: statusText)
                }
            }
        } else {
            Text("No Mac heartbeats yet.  The watchdog on the Mac has not checked in.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    private func percent(_ value: Double) -> String {
        String(format: "%.0f%%", value)
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "online": return "Online"
        case "degraded": return "High Load"
        case "offline": return "Offline"
        default: return status.capitalized
        }
    }

    private func semanticStatus(_ status: String) -> Theme.SemanticStatus {
        switch status {
        case "online": return .ok
        case "degraded": return .warning
        default: return .danger
        }
    }

    private func processLabel(_ status: String) -> String {
        switch status.lowercased() {
        case "running", "online", "ok": return "Running"
        case "degraded": return "Degraded"
        case "stopped": return "Stopped"
        case "not_enabled", "not-enabled", "disabled": return "Not Enabled"
        case "idle": return "Idle"
        default: return status.capitalized
        }
    }

    private func processStatus(_ status: String) -> Theme.SemanticStatus {
        switch status.lowercased() {
        case "running", "online", "ok": return .ok
        case "degraded": return .warning
        case "not_enabled", "not-enabled", "disabled", "idle": return .neutral
        default: return .danger
        }
    }

    private func shortProcessName(_ name: String) -> String {
        name.replacingOccurrences(of: "com.jay.", with: "").replacingOccurrences(of: "com.jays.", with: "")
    }

    /// Pretty names for the fixed process keys the Mac watchdog reports.
    private static let processDisplayNames: [String: String] = [
        "docker": "Docker",
        "orbstack": "OrbStack",
        "ollama": "Ollama",
        "litestream": "Litestream",
    ]

    private func displayProcessName(_ name: String) -> String {
        let short = shortProcessName(name)
        return Self.processDisplayNames[short.lowercased()] ?? short
    }

    private func isNotEnabledStatus(_ status: String) -> Bool {
        let s = status.lowercased()
        return s == "not_enabled" || s == "not-enabled" || s == "disabled"
    }

    private func isIgnoredStatus(_ status: String) -> Bool {
        let s = status.lowercased()
        return s == "running" || s == "online" || s == "ok" || s == "not_enabled" || s == "not-enabled" || s == "disabled" || s == "idle"
    }

    private func issueFlags(_ health: MacHealthResponse) -> [String] {
        var flags: [String] = []
        if health.status == "offline" {
            flags.append("Heartbeat stale — Mac looks offline.")
        }
        guard let mac = health.mac else { return flags }
        if mac.cpuUsagePct > 90 { flags.append("CPU above 90%.") }
        if mac.memoryUsagePct > 90 { flags.append("Memory above 90%.") }
        if mac.diskUsagePct > 95 { flags.append("Disk above 95%.") }
        for row in mac.processRows where !isIgnoredStatus(row.status) {
            flags.append("\(shortProcessName(row.name)) is \(row.status).")
        }
        return flags
    }
}
