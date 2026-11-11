import DesignSystem
import Models
import SwiftUI

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

enum PlatformFormat {
    static func bytes(_ value: Int64?) -> String {
        guard let value else { return "—" }
        let units = ["B", "KB", "MB", "GB", "TB", "PB"]
        var amount = Double(max(0, value))
        var unit = 0
        while amount >= 1024, unit < units.count - 1 {
            amount /= 1024
            unit += 1
        }
        return String(format: unit >= 3 ? "%.1f %@" : "%.0f %@", amount, units[unit])
    }

    /// Like `bytes` but drops a trailing `.0` so 10 GiB reads "10 GB".
    static func bytesCompact(_ value: Int64?) -> String {
        bytes(value).replacingOccurrences(of: ".0 ", with: " ")
    }

    /// Color the R2 fill bar by closeness to the 10 GB cap (70% is the guard).
    static func usageBarStatus(_ pct: Double) -> Theme.SemanticStatus {
        if pct >= 70 { return .danger }
        if pct >= 50 { return .warning }
        return .ok
    }

    static func percent(_ value: Double?) -> String {
        guard let value else { return "—" }
        return String(format: "%.0f%%", value)
    }

    static func age(_ seconds: Double?) -> String {
        guard let seconds, seconds.isFinite else { return "Never" }
        if seconds < 60 { return "\(Int(seconds))s ago" }
        if seconds < 3_600 { return "\(Int(seconds / 60))m ago" }
        if seconds < 86_400 { return "\(Int(seconds / 3_600))h ago" }
        return "\(Int(seconds / 86_400))d ago"
    }
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/// The Hetzner box itself: size, CPU pressure, disk headroom, and whatever the
/// prevention panel is currently worried about.
struct FleetHostSection: View {
    let metrics: ServerMetrics

    private var cpuStatus: Theme.SemanticStatus {
        guard let peak = metrics.prevention?.summary?.cpuPeakPct else { return .neutral }
        if peak >= 90 { return .danger }
        if peak >= 70 { return .warning }
        return .ok
    }

    private var diskStatus: Theme.SemanticStatus {
        guard let used = metrics.appDisk?.usedPct else { return .neutral }
        if used >= 90 { return .danger }
        if used >= 75 { return .warning }
        return .ok
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Host", subtitle: hostSubtitle)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: Theme.Spacing.md) {
                    cpuTile
                    diskTile
                }
                VStack(spacing: Theme.Spacing.md) {
                    cpuTile
                    diskTile
                }
            }

            if let indicators = metrics.prevention?.indicators, !indicators.isEmpty {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    ForEach(indicators) { indicator in
                        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                            StatusBadge(
                                indicator.label,
                                status: indicator.severity == "critical" ? .danger : .warning
                            )
                            Text(indicator.detail)
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Colors.secondaryText)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    private var cpuTile: some View {
        StatTile(
            label: "CPU Now",
            value: PlatformFormat.percent(metrics.hostUsage?.cpuPct),
            secondary: metrics.prevention?.summary?.cpuPeakPct
                .map { "Peak \(PlatformFormat.percent($0))" },
            systemImage: "cpu",
            status: cpuStatus
        )
    }

    private var diskTile: some View {
        StatTile(
            label: "Disk Used",
            value: metrics.appDisk?.usedPct.map { "\($0)%" } ?? "—",
            secondary: "\(PlatformFormat.bytes(metrics.appDisk?.freeBytes)) free",
            systemImage: "internaldrive",
            status: diskStatus
        )
    }

    private var hostSubtitle: String? {
        guard let host = metrics.host else { return nil }
        let parts = [host.name, host.serverType, host.location].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

// ---------------------------------------------------------------------------
// Fleet apps
// ---------------------------------------------------------------------------

/// How one Coolify application reads in the fleet list.
///
/// Coolify's status is a composite `"<state>"` or `"<state>:<health>"` string —
/// "running", "running:healthy", "running:unhealthy", "running:unknown",
/// "exited:unhealthy".  It must be parsed into its two parts rather than
/// substring-matched: "unhealthy" literally *contains* "healthy", so a
/// `contains("healthy")` test paints a down application green.  The parse
/// mirrors `classifyCoolifyStatus` in `src/lib/platform-status/probes/hosting.ts`
/// so iOS and the web Ops page agree about what is up.
enum FleetAppStatus: Equatable, Sendable {
    /// Running and the health check passes.
    case healthy
    /// The health check is failing, whatever the container state claims.
    case unhealthy
    /// Not serving: exited, stopped, dead.
    case down
    /// Running, but this monitor cannot say whether it serves traffic.
    case unknown
    /// Coolify has no status for this application — never deployed.
    case notDeployed

    /// Container states that mean the application is not serving traffic.
    private static let downStates: Set<String> = [
        "exited", "stopped", "dead", "removing", "killed",
    ]

    /// Container states that mean the application is up.
    private static let upStates: Set<String> = ["running", "healthy"]

    static func parse(_ raw: String) -> FleetAppStatus {
        let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else { return .notDeployed }

        let parts = normalized.split(
            separator: ":",
            maxSplits: 1,
            omittingEmptySubsequences: false
        )
        let state = String(parts[0]).trimmingCharacters(in: .whitespaces)
        let health =
            parts.count > 1 ? String(parts[1]).trimmingCharacters(in: .whitespaces) : ""
        guard !state.isEmpty || !health.isEmpty else { return .notDeployed }

        // Most severe interpretation first.  A failing health check and a
        // stopped container both outrank anything that merely looks healthy.
        if downStates.contains(state) { return .down }
        if health == "unhealthy" || state == "unhealthy" { return .unhealthy }
        if upStates.contains(state) {
            // Only an explicit pass — or a bare "running" with no health check
            // configured at all — counts as healthy.  "running:unknown" does not.
            return health.isEmpty || health == "healthy" ? .healthy : .unknown
        }
        // restarting, paused, created, or a state Coolify has not shipped yet.
        return .unknown
    }

    var title: String {
        switch self {
        case .healthy: return "Healthy"
        case .unhealthy: return "Unhealthy"
        case .down: return "Down"
        case .unknown: return "Unknown"
        case .notDeployed: return "Not Deployed"
        }
    }

    var semantic: Theme.SemanticStatus {
        switch self {
        case .healthy: return .ok
        case .unhealthy, .down: return .danger
        case .unknown: return .warning
        case .notDeployed: return .neutral
        }
    }
}

/// Every Coolify application on the host, for all fleet apps — not just this
/// one.  An app Coolify reports as running but cannot health-check shows as
/// "Unknown" rather than being quietly counted as healthy, and one reporting
/// "running:unhealthy" shows as down rather than green.
struct FleetAppsSection: View {
    let metrics: ServerMetrics

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Fleet Apps", subtitle: "\(metrics.resources.count) on this host")

            ForEach(metrics.resources) { resource in
                let status = FleetAppStatus.parse(resource.status)
                let title = resource.fleetLabel ?? resource.name
                HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                        Text(title)
                            .font(Theme.Typography.body)
                            .foregroundStyle(Theme.Colors.primaryText)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(resource.status)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                            .lineLimit(2)
                    }
                    .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                    StatusBadge(status.title, status: status.semantic)
                }
                .contentShape(Rectangle())
                .copyableValue(resource.status, label: title)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

/// Per-app, per-location backup coverage across the whole fleet.
struct FleetBackupsSection: View {
    let metrics: ServerMetrics

    var body: some View {
        if let backups = metrics.fleetBackups, !backups.apps.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionHeader("Backups", subtitle: "Off-site and local coverage")

                ForEach(backups.apps) { app in
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        Text(app.label)
                            .font(Theme.Typography.captionEmphasis)
                            .foregroundStyle(Theme.Colors.primaryText)
                        ForEach(app.locations) { location in
                            HStack(spacing: Theme.Spacing.sm) {
                                Text(location.label)
                                    .font(Theme.Typography.caption)
                                    .foregroundStyle(Theme.Colors.secondaryText)
                                Spacer(minLength: Theme.Spacing.sm)
                                Text(locationDetail(location))
                                    .font(Theme.Typography.caption)
                                    .foregroundStyle(Theme.Colors.secondaryText)
                                StatusBadge(
                                    locationTitle(location),
                                    status: locationStatus(location)
                                )
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .dsCard()
        }
    }

    private func locationDetail(_ location: ServerMetrics.FleetBackups.Location) -> String {
        if location.present == false { return "" }
        return PlatformFormat.age(location.latestAgeSeconds)
    }

    private func locationTitle(_ location: ServerMetrics.FleetBackups.Location) -> String {
        if location.unknown == true { return "Unknown" }
        if location.ok == true { return "OK" }
        if location.ok == false {
            return location.present == true ? "Lagging" : "Missing"
        }
        if location.reason == "not_configured" || location.reason == "b2_unconfigured" {
            return "Not Configured"
        }
        if location.present == false { return "Unknown" }
        return "Unknown"
    }

    private func locationStatus(
        _ location: ServerMetrics.FleetBackups.Location
    ) -> Theme.SemanticStatus {
        if location.unknown == true { return .neutral }
        if location.present == false { return .neutral }
        if location.ok == true { return .ok }
        if location.ok == false { return .warning }
        return .neutral
    }
}

// ---------------------------------------------------------------------------
// Operations rollup
// ---------------------------------------------------------------------------

/// How one R2 fleet account reads.
///
/// Availability is decided *before* usage.  `overallOnTrackToExceed70Pct`
/// defaults to `false`, and a failed read ships `storage: emptyMetric()` with
/// `mtdPct: 0` (see `fetchR2FleetSummary` in `src/lib/r2-usage.ts`) — so keying
/// the badge off that flag alone paints a broken account green beside a
/// meaningless 0%.  An account that is unconfigured, errored, or reporting a
/// status this build does not recognise shows its unavailability instead, and
/// its usage figure is suppressed.
enum R2AccountHealth: Equatable, Sendable {
    /// No credentials for this account — nothing to read.
    case unconfigured
    /// Cloudflare account exists, but R2 is not turned on (Jay Old leftovers).
    case notEnabled
    /// Configured, but the usage read failed; the numbers cannot be trusted.
    case unavailable
    /// Read succeeded and the account is on track to exceed the free tier.
    case watch
    /// Read succeeded and the account is inside the free tier.
    case ok

    static func evaluate(_ account: OperationsHealth.R2Fleet.Account) -> R2AccountHealth {
        let status = (account.status ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let error = (account.error ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let source = (account.metricsSource ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()

        if !account.configured || status == "unconfigured" { return .unconfigured }
        if source == "r2_not_enabled" { return .notEnabled }
        // Jay Old without the metricsSource field still has no live R2 —
        // do not paint leftover-null storage as a failed read.
        if account.id == "old", account.storage?.mtdPct == nil, error.isEmpty {
            return .notEnabled
        }
        if status == "error" || !error.isEmpty { return .unavailable }
        // Fail closed on a status this build has never seen rather than
        // assuming it means "fine".
        if !status.isEmpty, status != "ok" { return .unavailable }
        // A configured, error-free account with no usage figure still has
        // nothing to report — do not fall back to 0%.
        guard account.storage?.mtdPct != nil else { return .unavailable }

        return account.overallOnTrackToExceed70Pct ? .watch : .ok
    }

    /// Usage percentages are only meaningful when the read actually succeeded.
    var showsUsage: Bool {
        switch self {
        case .watch, .ok: return true
        case .unconfigured, .notEnabled, .unavailable: return false
        }
    }

    var title: String {
        switch self {
        case .unconfigured: return "Not Configured"
        case .notEnabled: return "R2 Not Enabled"
        case .unavailable: return "Unavailable"
        case .watch: return "Watch"
        case .ok: return "OK"
        }
    }

    var semantic: Theme.SemanticStatus {
        switch self {
        case .unconfigured, .notEnabled: return .neutral
        case .unavailable, .watch: return .warning
        case .ok: return .ok
        }
    }

    /// The reason line under the row, when there is one worth showing.
    func detail(for account: OperationsHealth.R2Fleet.Account) -> String? {
        switch self {
        case .notEnabled:
            return "R2 is not enabled on this account.  GraphQL leftovers are ignored."
        case .unavailable:
            let error = (account.error ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return error.isEmpty ? "Metrics unavailable" : error
        case .unconfigured, .watch, .ok:
            return nil
        }
    }
}

/// The `/api/operations` half of the web Ops page: peer app health, R2 free
/// tier, receipt inbox.  Previously unreachable from iOS at all.
struct FleetOperationsSection: View {
    let operations: OperationsHealth

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader("Operations")

            if let peer = operations.socraticInfrastructure {
                let sha = peer.releaseSha.map { String($0.prefix(8)) } ?? "—"
                row(
                    title: "Socratic.Trade",
                    detail: sha,
                    state: peer.state
                )
                .copyableRow(label: "Socratic.Trade", value: sha)
            }

            if let congress = operations.congressInfrastructure {
                let sha = congress.releaseSha.map { String($0.prefix(8)) } ?? "—"
                row(
                    title: "Congress.Trade",
                    detail: sha,
                    state: congress.state
                )
                .copyableRow(label: "Congress.Trade", value: sha)
            }

            if let inbox = operations.receiptInbox {
                let countStr = inbox.needsReviewCount.map { "\($0) to review" } ?? "—"
                row(
                    title: "Receipt Inbox",
                    detail: countStr,
                    state: inbox.state
                )
                .copyableRow(label: "Receipt Inbox", value: countStr)
            }

            if let r2 = operations.r2Fleet, r2.configured {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    ForEach(r2.accounts) { account in
                        r2Row(account)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    @ViewBuilder
    private func r2Row(_ account: OperationsHealth.R2Fleet.Account) -> some View {
        let health = R2AccountHealth.evaluate(account)
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            HStack(alignment: .center, spacing: Theme.Spacing.sm) {
                Text(account.label ?? account.id)
                    .font(Theme.Typography.body)
                    .foregroundStyle(
                        health == .unconfigured || health == .notEnabled
                            ? Theme.Colors.secondaryText : Theme.Colors.primaryText
                    )
                Spacer(minLength: Theme.Spacing.sm)
                if health.showsUsage {
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(r2UsageLabel(account))
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                        if let pct = account.storage?.mtdPct {
                            BudgetMeter(
                                fraction: pct / 100,
                                status: PlatformFormat.usageBarStatus(pct),
                                height: 6
                            )
                            .accessibilityLabel("Free-tier storage used")
                        }
                    }
                    // Bounded, compressible width — .fixedSize here pushed the
                    // badge/meter off the card's right edge on narrow phones.
                    .frame(maxWidth: 150, alignment: .trailing)
                }
                StatusBadge(health.title, status: health.semantic)
                    .layoutPriority(1)
            }

            if let detail = health.detail(for: account) {
                Text(detail)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func r2UsageLabel(_ account: OperationsHealth.R2Fleet.Account) -> String {
        let used = account.storage?.actual.map { PlatformFormat.bytes(Int64($0.rounded())) } ?? "—"
        let limit = account.storage?.limit.map { PlatformFormat.bytesCompact(Int64($0.rounded())) }
            ?? "10 GB"
        return "\(used) / \(limit) Free Tier"
    }

    @ViewBuilder
    private func row(title: String, detail: String, state: OperationsHealth.State) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text(title)
                .font(Theme.Typography.body)
                .foregroundStyle(Theme.Colors.primaryText)
            Spacer(minLength: Theme.Spacing.sm)
            Text(detail)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
            StatusBadge(state.title, status: semantic(state))
        }
    }

    private func semantic(_ state: OperationsHealth.State) -> Theme.SemanticStatus {
        switch state {
        case .healthy, .receiving: return .ok
        case .degraded, .stale: return .warning
        case .unavailable, .unreachable: return .danger
        case .unconfigured: return .neutral
        }
    }
}

// ---------------------------------------------------------------------------
// Platform cards
// ---------------------------------------------------------------------------

/// One card per external platform, grouped by category in the server's order.
struct PlatformCardsSection: View {
    let payload: PlatformStatusPayload

    var body: some View {
        ForEach(payload.groupedByCategory, id: \.category) { group in
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionHeader(group.category.title)
                ForEach(group.platforms) { platform in
                    PlatformCardRow(platform: platform)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .dsCard()
        }
    }
}

struct PlatformCardRow: View {
    let platform: PlatformStatusPayload.PlatformCard
    @State private var showingDetailSheet = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Button {
                showingDetailSheet = true
            } label: {
                HStack(spacing: Theme.Spacing.sm) {
                    Text(platform.name)
                        .font(Theme.Typography.body.weight(.medium))
                        .foregroundStyle(
                            platform.configured
                                ? Theme.Colors.primaryText : Theme.Colors.secondaryText
                        )
                    Spacer(minLength: Theme.Spacing.sm)
                    StatusBadge(platform.state.title, status: semantic(platform.state))
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.Colors.tertiaryText)
                }
            }
            .buttonStyle(.plain)

            if let headline = platform.headline, !headline.isEmpty {
                Text(headline)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if platform.configured, !platform.metrics.isEmpty {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    ForEach(platform.metrics) { entry in
                        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                            Text(entry.label)
                                .font(Theme.Typography.caption.weight(.medium))
                                .foregroundStyle(Theme.Colors.primaryText)
                                .frame(minWidth: 70, alignment: .leading)
                            Spacer(minLength: Theme.Spacing.xs)
                            VStack(alignment: .trailing, spacing: 4) {
                                let formattedValue = entry.hint.map { "\(entry.value) \($0)" } ?? entry.value
                                Text(formattedValue)
                                    .font(Theme.Typography.caption)
                                    .foregroundStyle(Theme.Colors.secondaryText)
                                    .multilineTextAlignment(.trailing)
                                    .fixedSize(horizontal: false, vertical: true)
                                if let pct = entry.usagePct {
                                    BudgetMeter(
                                        fraction: pct / 100,
                                        status: PlatformFormat.usageBarStatus(pct),
                                        height: 6
                                    )
                                    .frame(maxWidth: .infinity)
                                    .accessibilityLabel("Free-tier storage used")
                                }
                            }
                            .frame(minWidth: 0, maxWidth: .infinity, alignment: .trailing)
                        }
                    }
                }
                .padding(.top, Theme.Spacing.xxs)
            }

            if !platform.configured, let first = platform.requiredEnv.first {
                Text("Set \(first) to enable.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
            }
        }
        .sheet(isPresented: $showingDetailSheet) {
            PlatformDetailSheet(platform: platform)
        }
    }

    private func semantic(_ state: PlatformStatusPayload.State) -> Theme.SemanticStatus {
        switch state {
        case .healthy, .receiving: return .ok
        case .degraded, .stale: return .warning
        case .unavailable, .unreachable: return .danger
        case .unconfigured: return .neutral
        }
    }
}

/// Full detail modal for a platform showing complete uncropped descriptions,
/// metrics, and configuration keys with copy actions.
struct PlatformDetailSheet: View {
    let platform: PlatformStatusPayload.PlatformCard
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Status") {
                        StatusBadge(platform.state.title, status: semantic(platform.state))
                    }
                    .copyableRow(label: "Status", value: platform.state.title)
                    LabeledContent("Platform", value: platform.name)
                        .copyableRow(label: "Platform", value: platform.name)
                    LabeledContent("Category", value: platform.category.title)
                        .copyableRow(label: "Category", value: platform.category.title)
                    if let consoleUrl = platform.consoleUrl, let url = URL(string: consoleUrl) {
                        Link(destination: url) {
                            HStack {
                                Text("Open Console")
                                    .foregroundStyle(Theme.Colors.accent)
                                Spacer()
                                Image(systemName: "arrow.up.right.square")
                                    .foregroundStyle(Theme.Colors.accent)
                            }
                        }
                    }
                } header: {
                    Text("Overview")
                }

                if let error = platform.error, !error.isEmpty {
                    Section {
                        Text(error)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.danger)
                            .fixedSize(horizontal: false, vertical: true)
                            .copyableValue(error, label: "Error")
                    } header: {
                        Text("Error Details")
                    }
                }

                if let headline = platform.headline, !headline.isEmpty {
                    Section {
                        Text(headline)
                            .font(Theme.Typography.body)
                            .foregroundStyle(Theme.Colors.primaryText)
                            .fixedSize(horizontal: false, vertical: true)
                            .copyableValue(headline, label: "Description")
                    } header: {
                        Text("Status Description")
                    }
                }

                if !platform.metrics.isEmpty {
                    Section {
                        ForEach(platform.metrics) { entry in
                            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                                HStack(alignment: .top) {
                                    Text(entry.label)
                                        .font(Theme.Typography.captionEmphasis)
                                        .foregroundStyle(Theme.Colors.primaryText)
                                    Spacer()
                                    Text(entry.value)
                                        .font(Theme.Typography.caption)
                                        .foregroundStyle(Theme.Colors.secondaryText)
                                        .multilineTextAlignment(.trailing)
                                }
                                if let hint = entry.hint {
                                    Text(hint)
                                        .font(Theme.Typography.caption)
                                        .foregroundStyle(Theme.Colors.tertiaryText)
                                }
                                if let pct = entry.usagePct {
                                    BudgetMeter(
                                        fraction: pct / 100,
                                        status: PlatformFormat.usageBarStatus(pct),
                                        height: 8
                                    )
                                    .padding(.top, 2)
                                }
                            }
                            .padding(.vertical, 2)
                            .contentShape(Rectangle())
                            .copyableValue(entry.value, label: entry.label)
                        }
                    } header: {
                        Text("Metrics & Attributes")
                    }
                }

                if !platform.requiredEnv.isEmpty {
                    Section {
                        ForEach(platform.requiredEnv, id: \.self) { envVar in
                            HStack {
                                Text(envVar)
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(Theme.Colors.primaryText)
                                Spacer()
                                Button {
                                    #if canImport(UIKit)
                                    UIPasteboard.general.string = envVar
                                    #endif
                                } label: {
                                    Image(systemName: "doc.on.doc")
                                        .font(.system(size: 13))
                                        .foregroundStyle(Theme.Colors.accent)
                                }
                                .buttonStyle(.borderless)
                            }
                        }
                    } header: {
                        Text("Configuration Keys")
                    } footer: {
                        Text("Environment variable keys used by this integration.")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(platform.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
    }

    private func semantic(_ state: PlatformStatusPayload.State) -> Theme.SemanticStatus {
        switch state {
        case .healthy, .receiving: return .ok
        case .degraded, .stale: return .warning
        case .unavailable, .unreachable: return .danger
        case .unconfigured: return .neutral
        }
    }
}
