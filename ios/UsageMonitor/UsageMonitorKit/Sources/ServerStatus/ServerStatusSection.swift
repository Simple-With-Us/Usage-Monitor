import SwiftUI
import AppCore
import DesignSystem
import Models
import Networking

/// A live panel for the public `health`/`ready` probes. Renders even before a
/// token is entered, so a user can tell "my token is wrong" apart from "the
/// server is down". Skeleton on first load, typed error with retry on failure,
/// dependency-check rows on success — including layered backup status.
struct ServerStatusSection: View {
    let store: ServerStatusStore
    let onReload: @Sendable () async -> Void

    var body: some View {
        Section {
            content
        } header: {
            HStack {
                Text("Server Status")
                Spacer()
                if case let .loaded(snapshot) = store.state {
                    StatusBadge(
                        snapshot.overallLabel,
                        status: snapshot.overallStatus,
                        systemImage: snapshot.overallStatus == .ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill"
                    )
                    .textCase(nil)
                }
            }
        } footer: {
            if case let .loaded(snapshot) = store.state {
                Text("Checked \(snapshot.fetchedAt.formatted(.relative(presentation: .named))). Pull to refresh.")
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.state {
        case let .failed(error):
            failure(error)
        default:
            if let snapshot = store.state.value {
                loaded(snapshot)
            } else {
                skeleton
            }
        }
    }

    private var skeleton: some View {
        ForEach(0..<3, id: \.self) { _ in
            HStack {
                SkeletonBlock(width: 90, height: 12)
                Spacer()
                SkeletonBlock(width: 60, height: 12)
            }
        }
    }

    @ViewBuilder
    private func failure(_ error: APIError) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                Image(systemName: "bolt.horizontal.circle.fill")
                    .foregroundStyle(Theme.Colors.warning)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    Text(error.title)
                        .font(Theme.Typography.captionEmphasis)
                        .foregroundStyle(Theme.Colors.primaryText)
                    Text(error.message)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            Button {
                Task { await onReload() }
            } label: {
                Label("Try Again", systemImage: "arrow.clockwise")
                    .font(Theme.Typography.caption.weight(.semibold))
            }
            .buttonStyle(.borderless)
            .tint(Theme.Colors.accent)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Server status unavailable. \(error.message)")
    }

    @ViewBuilder
    private func loaded(_ snapshot: ServerStatusSnapshot) -> some View {
        LabeledContent("Service", value: snapshot.health.service ?? "usage-monitor")

        LabeledContent("App", value: appVersionText)

        if let revision = snapshot.health.commit, !revision.isEmpty {
            LabeledContent("Server") {
                Text(String(revision.prefix(7)))
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }

        if let uptime = snapshot.health.uptimeSeconds {
            LabeledContent("Uptime", value: UptimeFormat.string(fromSeconds: uptime))
        }

        ForEach(snapshot.dependencyChecks) { check in
            checkRow(check)
        }

        if !snapshot.backupLayerChecks.isEmpty {
            // Visual break before backup layers inside the same section.
            Text("Backups")
                .font(Theme.Typography.captionEmphasis)
                .foregroundStyle(Theme.Colors.secondaryText)
                .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 4, trailing: 20))
                .accessibilityAddTraits(.isHeader)

            ForEach(snapshot.backupLayerChecks) { check in
                checkRow(check)
            }
        }
    }

    @ViewBuilder
    private func checkRow(_ check: ServerStatusSnapshot.DependencyCheck) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            LabeledContent(check.name) {
                StatusBadge(
                    dependencyLabel(check),
                    status: dependencyStatus(check),
                    systemImage: check.ok ? "checkmark" : (check.gatesService ? "xmark" : "exclamationmark")
                )
            }
            if let detail = check.detail, !detail.isEmpty {
                Text(detail)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            check.detail.map { "\(check.name): \(dependencyLabel(check)). \($0)" }
                ?? "\(check.name): \(dependencyLabel(check))"
        )
    }

    /// Service-gating checks fail hard ("Down"); observability-only checks
    /// (backup free-tier lag) fail soft ("Lagging") so red backup is not
    /// mistaken for an app outage.
    private func dependencyLabel(_ check: ServerStatusSnapshot.DependencyCheck) -> String {
        if check.ok { return "OK" }
        return check.gatesService ? "Down" : "Lagging"
    }

    private func dependencyStatus(_ check: ServerStatusSnapshot.DependencyCheck) -> Theme.SemanticStatus {
        if check.ok { return .ok }
        return check.gatesService ? .danger : .warning
    }

    /// This device's App Store marketing version + build, never the server's
    /// leftover `package.json` `0.1.0`.
    private var appVersionText: String {
        let version =
            Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
        let build =
            Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "—"
        return "\(version) (\(build))"
    }
}
