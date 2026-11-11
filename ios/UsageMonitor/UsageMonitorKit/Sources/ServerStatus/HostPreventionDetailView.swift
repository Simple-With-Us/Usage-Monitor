import SwiftUI
import DesignSystem
import Models

/// Full host prevention panel: all risk indicators + recent poll history.
/// Aimed at catching OOM-adjacent CPU pegs, disk fill, app downs, and backup lag.
struct HostPreventionDetailView: View {
    let prevention: ServerMetrics.Prevention

    var body: some View {
        List {
            Section {
                LabeledContent("Overall") {
                    StatusBadge(
                        overallLabel,
                        status: overallStatus,
                        systemImage: prevention.overall == "ok"
                            ? "checkmark.shield.fill"
                            : "exclamationmark.shield.fill"
                    )
                }
                .copyableRow(label: "Overall", value: overallLabel)
                if let note = prevention.historyNote {
                    Text(note)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            } footer: {
                Text("Indicators fire before the next outage when possible.  History is process-local and clears on container restart.")
            }

            if let summary = prevention.summary {
                Section("Stats") {
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
                    if let latest = summary.cpuLatestPct {
                        let latestStr = String(format: "%.0f%%", latest)
                        LabeledContent("CPU Latest", value: latestStr)
                            .copyableRow(label: "CPU Latest", value: latestStr)
                    }
                    if let used = summary.diskUsedPct {
                        let usedStr = "\(used)%"
                        LabeledContent("Disk Used", value: usedStr)
                            .copyableRow(label: "Disk Used", value: usedStr)
                    }
                    if let free = summary.diskFreeBytes {
                        let freeStr = DiskFormat.byteString(free)
                        LabeledContent("Disk Free", value: freeStr)
                            .copyableRow(label: "Disk Free", value: freeStr)
                    }
                    if let healthy = summary.appsHealthy, let total = summary.appsTotal {
                        let healthyStr = "\(healthy)/\(total)"
                        LabeledContent("Apps Healthy", value: healthyStr)
                            .copyableRow(label: "Apps Healthy", value: healthyStr)
                    }
                    if let down = summary.appsDown, down > 0 {
                        let downStr = "\(down)"
                        LabeledContent("Apps Down", value: downStr)
                            .copyableRow(label: "Apps Down", value: downStr)
                    }
                    if let ok = summary.backupAppsOk, let total = summary.backupAppsTotal {
                        let backupStr = "\(ok)/\(total)"
                        LabeledContent("Backup Apps OK", value: backupStr)
                            .copyableRow(label: "Backup Apps OK", value: backupStr)
                    }
                }
            }

            if !prevention.indicators.isEmpty {
                Section("Active Indicators") {
                    ForEach(prevention.indicators) { indicator in
                        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                            HStack {
                                Text(indicator.label)
                                    .font(Theme.Typography.captionEmphasis)
                                if let subject = indicator.subject {
                                    Text(subject)
                                        .font(Theme.Typography.caption)
                                        .foregroundStyle(Theme.Colors.secondaryText)
                                }
                                Spacer()
                                StatusBadge(
                                    indicator.severity.capitalized,
                                    status: severityStatus(indicator.severity),
                                    systemImage: indicator.severity == "critical"
                                        ? "xmark.octagon.fill"
                                        : "exclamationmark.triangle.fill"
                                )
                            }
                            Text(indicator.detail)
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.secondaryText)
                        }
                        .contentShape(Rectangle())
                        .copyableValue("\(indicator.label): \(indicator.detail)", label: indicator.label)
                        .accessibilityElement(children: .combine)
                    }
                }
            }

            if !prevention.history.isEmpty {
                Section("Recent Poll History") {
                    // Simple sparkline-ish text trail (newest last)
                    if let cpuTrail = cpuHistoryTrail {
                        LabeledContent("CPU Trail", value: cpuTrail)
                            .copyableRow(label: "CPU Trail", value: cpuTrail)
                    }
                    ForEach(prevention.history.suffix(12).reversed()) { sample in
                        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                            HStack {
                                Text(sample.at)
                                    .font(.system(.caption2, design: .monospaced))
                                    .foregroundStyle(Theme.Colors.secondaryText)
                                Spacer()
                                StatusBadge(
                                    sample.overall?.capitalized ?? "—",
                                    status: overallSampleStatus(sample.overall),
                                    systemImage: "circle.fill"
                                )
                            }
                            Text(historyLine(sample))
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.secondaryText)
                        }
                    }
                }
            }
        }
        .navigationTitle("Host Stats")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var overallLabel: String {
        switch prevention.overall {
        case "critical": return "Critical"
        case "warning": return "Watch"
        default: return "OK"
        }
    }

    private var overallStatus: Theme.SemanticStatus {
        switch prevention.overall {
        case "critical": return .danger
        case "warning": return .warning
        default: return .ok
        }
    }

    private var cpuHistoryTrail: String? {
        let values = prevention.history.compactMap(\.cpuPct)
        guard values.count >= 2 else { return nil }
        return values.suffix(12).map { String(format: "%.0f", $0) }.joined(separator: " → ") + "%"
    }

    private func historyLine(_ sample: ServerMetrics.Prevention.HistorySample) -> String {
        var parts: [String] = []
        if let cpu = sample.cpuPct {
            parts.append(String(format: "CPU %.0f%%", cpu))
        }
        if let disk = sample.diskUsedPct {
            parts.append("disk \(disk)%")
        }
        if let down = sample.appsDown, down > 0 {
            parts.append("\(down) app down")
        }
        if let ids = sample.indicatorIds, !ids.isEmpty {
            parts.append("\(ids.count) flag\(ids.count == 1 ? "" : "s")")
        }
        return parts.isEmpty ? "No samples" : parts.joined(separator: " · ")
    }

    private func severityStatus(_ severity: String) -> Theme.SemanticStatus {
        switch severity {
        case "critical": return .danger
        case "warning": return .warning
        default: return .ok
        }
    }

    private func overallSampleStatus(_ overall: String?) -> Theme.SemanticStatus {
        switch overall {
        case "critical": return .danger
        case "warning": return .warning
        default: return .ok
        }
    }
}
