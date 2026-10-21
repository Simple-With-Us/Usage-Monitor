import SwiftUI
import DesignSystem
import Models

/// Full per-app, per-location off-site backup status for the shared Hetzner host.
/// Opened from the Server tab so operators can confirm B2 dumps + Litestream
/// for Usage Monitor, Socratic.Trade, and Congress.Trade.
struct FleetBackupDetailView: View {
    let fleet: ServerMetrics.FleetBackups

    var body: some View {
        List {
            Section {
                LabeledContent("Overall") {
                    StatusBadge(
                        overallLabel,
                        status: overallStatus,
                        systemImage: overallStatus == .ok
                            ? "checkmark.circle.fill"
                            : "exclamationmark.triangle.fill"
                    )
                }
                .copyableRow(label: "Overall", value: overallLabel)
                if let configured = fleet.configured {
                    let cfgText = configured ? "Configured" : "Missing"
                    LabeledContent("B2 Monitor", value: cfgText)
                        .copyableRow(label: "B2 Monitor", value: cfgText)
                }
                if let asOf = fleet.asOf {
                    LabeledContent("As Of", value: asOf)
                        .copyableRow(label: "As Of", value: asOf)
                }
            } footer: {
                Text("Locations are independent.  A fresh B2 full dump keeps disaster recovery alive even when continuous Litestream is lagging.")
            }

            ForEach(fleet.apps) { app in
                Section {
                    ForEach(app.locations) { location in
                        locationRow(location)
                    }
                } header: {
                    HStack {
                        Text(app.label)
                        if app.selfApp == true {
                            Text("This App")
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.secondaryText)
                        }
                        Spacer()
                        StatusBadge(
                            app.ok == false ? "Lagging" : "OK",
                            status: app.ok == false ? .warning : .ok,
                            systemImage: app.ok == false ? "exclamationmark" : "checkmark"
                        )
                        .textCase(nil)
                    }
                }
            }

            if let warnings = fleet.warnings, !warnings.isEmpty {
                Section("Warnings") {
                    ForEach(Array(warnings.enumerated()), id: \.offset) { _, warning in
                        Text(warning)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.warning)
                            .copyableValue(warning, label: "Warning")
                    }
                }
            }
        }
        .navigationTitle("Fleet Backups")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var overallLabel: String {
        if fleet.ok == true { return "OK" }
        if fleet.configured == false { return "Unconfigured" }
        return "Lagging"
    }

    private var overallStatus: Theme.SemanticStatus {
        if fleet.ok == true { return .ok }
        if fleet.configured == false { return .warning }
        return .warning
    }

    @ViewBuilder
    private func locationRow(_ location: ServerMetrics.FleetBackups.Location) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            let labelText = locationLabel(location)
            LabeledContent(location.label) {
                StatusBadge(
                    labelText,
                    status: locationStatus(location),
                    // No verdict at all (never probed, or the check was
                    // skipped) is not a failure: an unobserved row must not
                    // wear the failure glyph beside its neutral badge.
                    systemImage: location.unknown == true || location.ok == nil
                        ? "questionmark.circle"
                        : location.ok == true ? "checkmark" : "exclamationmark"
                )
            }
            if let detail = locationDetail(location) {
                Text(detail)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .contentShape(Rectangle())
        .copyableValue(locationDetail(location).map { "\(locationLabel(location)) (\($0))" } ?? locationLabel(location), label: location.label)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(location.label): \(locationLabel(location)). \(locationDetail(location) ?? "")"
        )
    }

    private func locationLabel(_ location: ServerMetrics.FleetBackups.Location) -> String {
        // Never observed is not a failure: no probe result exists at all.
        if location.unknown == true { return "Unknown" }
        if location.ok == true { return "OK" }
        if location.ok == false {
            return location.present == true ? "Lagging" : "Missing"
        }
        if location.present == true { return "Unknown" }
        if location.reason == "not_configured" || location.reason == "b2_unconfigured" {
            return "N/A"
        }
        return "Unknown"
    }

    private func locationStatus(_ location: ServerMetrics.FleetBackups.Location) -> Theme.SemanticStatus {
        if location.unknown == true { return .neutral }
        // A deliberately skipped check observed nothing: an unobserved row is
        // neutral, but a row that was really observed keeps its own state,
        // so the detail view agrees with the web card and the platforms
        // section.
        if fleet.offline == true && location.ok == nil { return .neutral }
        if location.ok == true { return .ok }
        if location.ok == false { return .warning }
        // No probe result at all is unknown, never a failure.
        return .neutral
    }

    private func locationDetail(_ location: ServerMetrics.FleetBackups.Location) -> String? {
        var parts: [String] = []
        if let age = location.latestAgeSeconds {
            parts.append("latest \(UptimeFormat.string(fromSeconds: Int(age))) ago")
        }
        if let count = location.fileCount, count > 0 {
            parts.append(count == 1 ? "1 object" : "\(count) objects")
        }
        if let bytes = location.bytes, bytes > 0 {
            parts.append(DiskFormat.byteString(bytes))
        }
        if let reason = location.reason, location.ok != true {
            parts.append(humanReason(reason))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
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
}
