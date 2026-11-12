import Foundation
import Observation
import Models
import Networking
import AppCore
import DesignSystem
import OfflineCache

/// A combined snapshot of the two public health probes — `GET /api/health`
/// (liveness) and `GET /api/ready` (readiness + dependency checks). Readiness
/// is best-effort: liveness alone still produces a useful snapshot.
struct ServerStatusSnapshot: Equatable, Sendable {
    var health: ServerHealth
    var readiness: ServerReadiness?
    var fetchedAt: Date

    /// Roll-up status for the header badge.
    var overallStatus: Theme.SemanticStatus {
        if !health.ok { return .danger }
        if let readiness, !readiness.ok { return .warning }
        return .ok
    }

    var overallLabel: String {
        if !health.ok { return "Offline" }
        if let readiness, !readiness.ok { return "Degraded" }
        return "Operational"
    }

    /// One dependency row for the Settings checklist.
    ///
    /// `gatesService` is false for observability-only checks (off-site backup):
    /// those may be red/amber without meaning the app itself is down, and they
    /// never flip the header badge to offline.
    struct DependencyCheck: Equatable, Sendable, Identifiable {
        var id: String { name }
        var name: String
        var ok: Bool
        /// When false, a failing check is labeled "Lagging" / warning, not "Down" / danger.
        var gatesService: Bool
        /// Optional detail shown under the row (age, free disk, etc.).
        var detail: String?
    }

    /// Core service-gating checks (database, scheduler, startup) plus disk.
    /// Backup layers are rendered separately so Local / B2 / R2 stay distinct.
    var dependencyChecks: [DependencyCheck] {
        guard let checks = readiness?.checks else { return [] }
        var rows: [DependencyCheck] = []
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
                detail: DiskFormat.summary(free: d.freeBytes, total: d.totalBytes)
            ))
        }
        return rows
    }

    /// Explicit backup layers when the server reports them; otherwise a single
    /// legacy "Backup (off-site)" row from `checks.backup`.
    var backupLayerChecks: [DependencyCheck] {
        guard let checks = readiness?.checks else { return [] }
        if let layers = checks.backupLayers {
            var rows: [DependencyCheck] = []
            if let local = layers.local {
                rows.append(.init(
                    name: trimmedOrNil(local.title) ?? "Local Backup",
                    ok: local.ok,
                    gatesService: false,
                    detail: trimmedOrNil(local.detail) ?? localDetail(local)
                ))
            }
            if let primary = layers.primary {
                rows.append(.init(
                    name: trimmedOrNil(primary.title) ?? primaryBackupName(primary),
                    ok: primary.ok,
                    gatesService: false,
                    detail: trimmedOrNil(primary.detail) ?? primaryDetail(primary)
                ))
            }
            if let r2 = layers.r2Historic {
                rows.append(.init(
                    name: trimmedOrNil(r2.title) ?? "R2 Weekly Archive",
                    ok: r2HistoricRowOk(r2),
                    gatesService: false,
                    detail: trimmedOrNil(r2.detail) ?? r2Detail(r2)
                ))
            }
            if !rows.isEmpty { return rows }
        }
        // Pre-layers servers: single off-site row.
        if let c = checks.backup {
            return [.init(name: "Backup (Off-Site)", ok: c.ok, gatesService: false)]
        }
        return []
    }

    private func primaryBackupName(_ primary: ServerReadiness.BackupLayers.PrimaryLayer) -> String {
        switch (primary.label ?? primary.target)?.lowercased() {
        case "b2": return "B2 Backup"
        case "r2": return "R2 Backup"
        default: return "Off-Site Backup"
        }
    }

    private func localDetail(_ local: ServerReadiness.BackupLayers.LocalLayer) -> String? {
        var parts: [String] = []
        if let count = local.count {
            parts.append(count == 1 ? "1 snapshot" : "\(count) snapshots")
        }
        if let age = local.latestAgeSeconds {
            parts.append("latest \(UptimeFormat.string(fromSeconds: Int(age))) ago")
        }
        if let reason = local.reason, !local.ok {
            parts.append(humanReason(reason))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func primaryDetail(_ primary: ServerReadiness.BackupLayers.PrimaryLayer) -> String? {
        var parts: [String] = []
        if primary.active == false {
            parts.append("inactive")
        } else if let age = primary.replicaAgeSeconds {
            parts.append("replica \(UptimeFormat.string(fromSeconds: Int(age))) ago")
        } else if primary.envOnly == true {
            parts.append("env only")
        }
        if let reason = primary.reason, !primary.ok {
            parts.append(humanReason(reason))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Historic R2 is only OK when the weekly verified archive is fresh.
    /// Older servers may still report `ok: true` with a missing archive —
    /// treat that as lagging so the row never shows a green check for a
    /// freeze that has never been refreshed.
    private func r2HistoricRowOk(_ r2: ServerReadiness.BackupLayers.R2HistoricLayer) -> Bool {
        guard r2.role?.lowercased() == "historic" else { return r2.ok }
        if let archive = r2.weeklyArchive {
            return r2.ok && archive.ok
        }
        return false
    }

    private func r2Detail(_ r2: ServerReadiness.BackupLayers.R2HistoricLayer) -> String? {
        var parts: [String] = []
        switch r2.role?.lowercased() {
        case "historic":
            if let archive = r2.weeklyArchive {
                if archive.ok {
                    if let age = archive.ageSeconds {
                        parts.append("latest \(UptimeFormat.string(fromSeconds: Int(age))) ago")
                    } else {
                        parts.append("verified this week")
                    }
                } else if let reason = archive.reason, !reason.isEmpty {
                    parts.append(humanReason(reason))
                } else {
                    parts.append("lagging")
                }
            } else {
                parts.append("not run this week")
            }
        case "active": parts.append("still primary")
        case "unconfigured": parts.append("not monitored")
        default: break
        }
        // The free-tier kill-switch flag only pauses writes while R2 is the
        // live litestream target (role "active" — see runtime-health.ts's
        // R2HistoricBackupStatus.autoDisabled doc: "only meaningful when
        // litestreamUsesR2"). In "historic" role R2 already isn't being
        // written to by design (docs/rollouts/2026-08-06-backup-steady-state-policy.md),
        // so the flag is inert there; showing "writes paused" anyway reads
        // as an outage next to a healthy badge.
        if r2.autoDisabled == true && r2.role?.lowercased() == "active" {
            parts.append("writes paused")
        }
        if let reason = r2.reason, !r2HistoricRowOk(r2) {
            let human = humanReason(reason)
            if !parts.contains(human) {
                parts.append(human)
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func trimmedOrNil(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func humanReason(_ reason: String) -> String {
        reason
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "r2 ", with: "R2 ")
            .replacingOccurrences(of: "b2 ", with: "B2 ")
    }
}

/// Owns the Settings server-status panel's load lifecycle. Independent of the
/// budget `BudgetStore` because it hits the **public** health endpoints (no
/// token required) — the status card renders even before a token is entered,
/// which helps the user tell "wrong token" apart from "server down".
@MainActor
@Observable
final class ServerStatusStore {
    private(set) var state: LoadState<ServerStatusSnapshot> = .idle

    private let probe: @Sendable (APIClient) async throws -> ServerStatusSnapshot

    init(probe: @escaping @Sendable (APIClient) async throws -> ServerStatusSnapshot = ServerStatusStore.liveProbe) {
        self.probe = probe
    }

    /// Snapshots older than this refresh automatically on the next
    /// `loadIfNeeded`.  Deploy restarts produce 5-10 minute readiness blips
    /// (three in the last week per UptimeRobot); without an age cap the tab
    /// showed a mid-deploy "Database — Down" snapshot indefinitely because
    /// tab views stay mounted and `.task` never re-fires.
    static let autoRefreshAge: TimeInterval = 180

    func loadIfNeeded(using client: APIClient) async {
        if case .idle = state {
            await load(using: client)
            return
        }
        if let snapshot = state.value,
           Date().timeIntervalSince(snapshot.fetchedAt) > Self.autoRefreshAge {
            await fetch(using: client)
        }
    }

    func load(using client: APIClient) async {
        if state.value == nil { state = .loading }
        await fetch(using: client)
    }

    func refresh(using client: APIClient) async {
        await fetch(using: client)
    }

    private func fetch(using client: APIClient) async {
        do {
            let snapshot = try await probe(client)
            state = .loaded(snapshot)
            WidgetSnapshotStore.updateServerService(
                health: snapshot.health,
                readiness: snapshot.readiness
            )
        } catch let error as APIError {
            handle(error)
        } catch {
            handle(.transport(error.localizedDescription))
        }
    }

    private func handle(_ error: APIError) {
        // Keep a prior good snapshot on transient refresh failures.
        if state.value == nil {
            state = .failed(error)
        }
    }

    /// The real probe: liveness is required, readiness is best-effort.
    nonisolated static let liveProbe: @Sendable (APIClient) async throws -> ServerStatusSnapshot = { client in
        let health = try await client.health()
        let readiness = try? await client.readiness()
        return ServerStatusSnapshot(health: health, readiness: readiness, fetchedAt: Date())
    }
}

// DiskFormat / UptimeFormat live in DesignSystem (shared with Settings).
