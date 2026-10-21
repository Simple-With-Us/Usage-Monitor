import Foundation

/// `GET /api/health` — public, unauthenticated liveness probe.
public struct ServerHealth: Codable, Hashable, Sendable {
    public var ok: Bool
    public var status: String
    public var uptimeSeconds: Int?
    public var checkedAt: String?
    public var service: String?
    public var version: String?
    public var commit: String?

    public init(
        ok: Bool,
        status: String,
        uptimeSeconds: Int? = nil,
        checkedAt: String? = nil,
        service: String? = nil,
        version: String? = nil,
        commit: String? = nil
    ) {
        self.ok = ok
        self.status = status
        self.uptimeSeconds = uptimeSeconds
        self.checkedAt = checkedAt
        self.service = service
        self.version = version
        self.commit = commit
    }

    /// `/api/health` emits `revision` (Coolify SOURCE_COMMIT).  Accept the
    /// older `commit` key too so fixtures and any leftover encoder stay valid.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decode(Bool.self, forKey: .ok)
        status = try container.decode(String.self, forKey: .status)
        uptimeSeconds = try container.decodeIfPresent(Int.self, forKey: .uptimeSeconds)
        checkedAt = try container.decodeIfPresent(String.self, forKey: .checkedAt)
        service = try container.decodeIfPresent(String.self, forKey: .service)
        version = try container.decodeIfPresent(String.self, forKey: .version)
        if let revision = try container.decodeIfPresent(String.self, forKey: .revision) {
            commit = revision
        } else {
            commit = try container.decodeIfPresent(String.self, forKey: .commit)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(ok, forKey: .ok)
        try container.encode(status, forKey: .status)
        try container.encodeIfPresent(uptimeSeconds, forKey: .uptimeSeconds)
        try container.encodeIfPresent(checkedAt, forKey: .checkedAt)
        try container.encodeIfPresent(service, forKey: .service)
        try container.encodeIfPresent(version, forKey: .version)
        try container.encodeIfPresent(commit, forKey: .revision)
    }

    private enum CodingKeys: String, CodingKey {
        case ok, status, uptimeSeconds, checkedAt, service, version, commit, revision
    }
}

/// `GET /api/ready` — public readiness probe with dependency detail.
public struct ServerReadiness: Codable, Hashable, Sendable {
    public struct Check: Codable, Hashable, Sendable {
        public var ok: Bool
        public var latencyMs: Double?

        public init(ok: Bool, latencyMs: Double? = nil) {
            self.ok = ok
            self.latencyMs = latencyMs
        }
    }

    public struct DiskCheck: Codable, Hashable, Sendable {
        public var ok: Bool
        public var freeBytes: Int64?
        public var totalBytes: Int64?
        public var thresholdBytes: Int64?
        public var reason: String?

        public init(
            ok: Bool,
            freeBytes: Int64? = nil,
            totalBytes: Int64? = nil,
            thresholdBytes: Int64? = nil,
            reason: String? = nil
        ) {
            self.ok = ok
            self.freeBytes = freeBytes
            self.totalBytes = totalBytes
            self.thresholdBytes = thresholdBytes
            self.reason = reason
        }
    }

    /// Layered backup observability (local · B2 primary · R2 historic).
    public struct BackupLayers: Codable, Hashable, Sendable {
        public var local: LocalLayer?
        public var primary: PrimaryLayer?
        public var r2Historic: R2HistoricLayer?

        public init(
            local: LocalLayer? = nil,
            primary: PrimaryLayer? = nil,
            r2Historic: R2HistoricLayer? = nil
        ) {
            self.local = local
            self.primary = primary
            self.r2Historic = r2Historic
        }

        public struct LocalLayer: Codable, Hashable, Sendable {
            public var ok: Bool
            public var present: Bool?
            public var count: Int?
            public var latestAgeSeconds: Double?
            public var latestSizeBytes: Int64?
            public var reason: String?
            public var title: String?
            public var detail: String?

            public init(
                ok: Bool,
                present: Bool? = nil,
                count: Int? = nil,
                latestAgeSeconds: Double? = nil,
                latestSizeBytes: Int64? = nil,
                reason: String? = nil,
                title: String? = nil,
                detail: String? = nil
            ) {
                self.ok = ok
                self.present = present
                self.count = count
                self.latestAgeSeconds = latestAgeSeconds
                self.latestSizeBytes = latestSizeBytes
                self.reason = reason
                self.title = title
                self.detail = detail
            }
        }

        public struct PrimaryLayer: Codable, Hashable, Sendable {
            public var ok: Bool
            public var target: String?
            public var label: String?
            public var required: Bool?
            public var active: Bool?
            public var envOnly: Bool?
            public var replicaOk: Bool?
            public var replicaAgeSeconds: Double?
            public var reason: String?
            public var title: String?
            public var detail: String?

            public init(
                ok: Bool,
                target: String? = nil,
                label: String? = nil,
                required: Bool? = nil,
                active: Bool? = nil,
                envOnly: Bool? = nil,
                replicaOk: Bool? = nil,
                replicaAgeSeconds: Double? = nil,
                reason: String? = nil,
                title: String? = nil,
                detail: String? = nil
            ) {
                self.ok = ok
                self.target = target
                self.label = label
                self.required = required
                self.active = active
                self.envOnly = envOnly
                self.replicaOk = replicaOk
                self.replicaAgeSeconds = replicaAgeSeconds
                self.reason = reason
                self.title = title
                self.detail = detail
            }
        }

        public struct R2HistoricLayer: Codable, Hashable, Sendable {
            public var ok: Bool
            public var configured: Bool?
            public var litestreamUsesR2: Bool?
            public var autoDisabled: Bool?
            public var role: String?
            public var reason: String?
            public var weeklyArchive: WeeklyArchive?
            public var title: String?
            public var detail: String?

            public init(
                ok: Bool,
                configured: Bool? = nil,
                litestreamUsesR2: Bool? = nil,
                autoDisabled: Bool? = nil,
                role: String? = nil,
                reason: String? = nil,
                weeklyArchive: WeeklyArchive? = nil,
                title: String? = nil,
                detail: String? = nil
            ) {
                self.ok = ok
                self.configured = configured
                self.litestreamUsesR2 = litestreamUsesR2
                self.autoDisabled = autoDisabled
                self.role = role
                self.reason = reason
                self.weeklyArchive = weeklyArchive
                self.title = title
                self.detail = detail
            }

            /// Weekly verified snapshot written by `r2-weekly-archive.mjs`.
            /// Null when the job has never run on the host.
            public struct WeeklyArchive: Codable, Hashable, Sendable {
                public var ok: Bool
                public var ageSeconds: Double?
                public var key: String?
                public var prunedCount: Int?
                public var reason: String?

                public init(
                    ok: Bool,
                    ageSeconds: Double? = nil,
                    key: String? = nil,
                    prunedCount: Int? = nil,
                    reason: String? = nil
                ) {
                    self.ok = ok
                    self.ageSeconds = ageSeconds
                    self.key = key
                    self.prunedCount = prunedCount
                    self.reason = reason
                }
            }
        }
    }

    public struct Checks: Codable, Hashable, Sendable {
        public var database: Check?
        public var scheduler: Check?
        public var backup: Check?
        public var startup: Check?
        public var disk: DiskCheck?
        public var backupLayers: BackupLayers?

        public init(
            database: Check? = nil,
            scheduler: Check? = nil,
            backup: Check? = nil,
            startup: Check? = nil,
            disk: DiskCheck? = nil,
            backupLayers: BackupLayers? = nil
        ) {
            self.database = database
            self.scheduler = scheduler
            self.backup = backup
            self.startup = startup
            self.disk = disk
            self.backupLayers = backupLayers
        }
    }

    public var ok: Bool
    public var status: String
    public var checkedAt: String?
    public var checks: Checks?

    public init(ok: Bool, status: String, checkedAt: String? = nil, checks: Checks? = nil) {
        self.ok = ok
        self.status = status
        self.checkedAt = checkedAt
        self.checks = checks
    }
}

/// `GET /api/server-metrics` — Hetzner host + Coolify app inventory (read-auth).
public struct ServerMetrics: Codable, Hashable, Sendable {
    public var degraded: Bool
    public var stale: Bool
    public var cacheAgeSeconds: Int?
    public var host: HostInfo?
    public var hostUsage: HostUsage?
    public var resources: [Resource]
    public var selfResources: [Resource]
    public var appDisk: AppDisk?
    public var fleetBackups: FleetBackups?
    public var prevention: Prevention?
    public var asOf: String?
    public var error: String?
    public var warnings: [String]?

    public init(
        degraded: Bool = false,
        stale: Bool = false,
        cacheAgeSeconds: Int? = nil,
        host: HostInfo? = nil,
        hostUsage: HostUsage? = nil,
        resources: [Resource] = [],
        selfResources: [Resource] = [],
        appDisk: AppDisk? = nil,
        fleetBackups: FleetBackups? = nil,
        prevention: Prevention? = nil,
        asOf: String? = nil,
        error: String? = nil,
        warnings: [String]? = nil
    ) {
        self.degraded = degraded
        self.stale = stale
        self.cacheAgeSeconds = cacheAgeSeconds
        self.host = host
        self.hostUsage = hostUsage
        self.resources = resources
        self.selfResources = selfResources
        self.appDisk = appDisk
        self.fleetBackups = fleetBackups
        self.prevention = prevention
        self.asOf = asOf
        self.error = error
        self.warnings = warnings
    }

    /// Prevention indicators + short poll history (OOM / disk / backup lag).
    public struct Prevention: Codable, Hashable, Sendable {
        public var overall: String?
        public var summary: Summary?
        public var indicators: [Indicator]
        public var history: [HistorySample]
        public var historyNote: String?

        public init(
            overall: String? = nil,
            summary: Summary? = nil,
            indicators: [Indicator] = [],
            history: [HistorySample] = [],
            historyNote: String? = nil
        ) {
            self.overall = overall
            self.summary = summary
            self.indicators = indicators
            self.history = history
            self.historyNote = historyNote
        }

        public struct Summary: Codable, Hashable, Sendable {
            public var cpuPeakPct: Double?
            public var cpuAvgPct: Double?
            public var cpuLatestPct: Double?
            public var cpuSampleCount: Int?
            public var diskUsedPct: Int?
            public var diskFreeBytes: Int64?
            public var diskTotalBytes: Int64?
            public var appsHealthy: Int?
            public var appsDown: Int?
            public var appsDegraded: Int?
            public var appsUnknown: Int?
            public var appsTotal: Int?
            public var backupAppsOk: Int?
            public var backupAppsTotal: Int?
            public var backupConfigured: Bool?

            public init(
                cpuPeakPct: Double? = nil,
                cpuAvgPct: Double? = nil,
                cpuLatestPct: Double? = nil,
                cpuSampleCount: Int? = nil,
                diskUsedPct: Int? = nil,
                diskFreeBytes: Int64? = nil,
                diskTotalBytes: Int64? = nil,
                appsHealthy: Int? = nil,
                appsDown: Int? = nil,
                appsDegraded: Int? = nil,
                appsUnknown: Int? = nil,
                appsTotal: Int? = nil,
                backupAppsOk: Int? = nil,
                backupAppsTotal: Int? = nil,
                backupConfigured: Bool? = nil
            ) {
                self.cpuPeakPct = cpuPeakPct
                self.cpuAvgPct = cpuAvgPct
                self.cpuLatestPct = cpuLatestPct
                self.cpuSampleCount = cpuSampleCount
                self.diskUsedPct = diskUsedPct
                self.diskFreeBytes = diskFreeBytes
                self.diskTotalBytes = diskTotalBytes
                self.appsHealthy = appsHealthy
                self.appsDown = appsDown
                self.appsDegraded = appsDegraded
                self.appsUnknown = appsUnknown
                self.appsTotal = appsTotal
                self.backupAppsOk = backupAppsOk
                self.backupAppsTotal = backupAppsTotal
                self.backupConfigured = backupConfigured
            }
        }

        public struct Indicator: Codable, Hashable, Sendable, Identifiable {
            public var id: String
            public var severity: String
            public var label: String
            public var detail: String
            public var subject: String?

            public init(
                id: String,
                severity: String,
                label: String,
                detail: String,
                subject: String? = nil
            ) {
                self.id = id
                self.severity = severity
                self.label = label
                self.detail = detail
                self.subject = subject
            }
        }

        public struct HistorySample: Codable, Hashable, Sendable, Identifiable {
            public var at: String
            public var cpuPct: Double?
            public var diskUsedPct: Int?
            public var appsDown: Int?
            public var appsDegraded: Int?
            public var indicatorIds: [String]?
            public var overall: String?

            public var id: String { at }

            public init(
                at: String,
                cpuPct: Double? = nil,
                diskUsedPct: Int? = nil,
                appsDown: Int? = nil,
                appsDegraded: Int? = nil,
                indicatorIds: [String]? = nil,
                overall: String? = nil
            ) {
                self.at = at
                self.cpuPct = cpuPct
                self.diskUsedPct = diskUsedPct
                self.appsDown = appsDown
                self.appsDegraded = appsDegraded
                self.indicatorIds = indicatorIds
                self.overall = overall
            }
        }
    }

    public struct HostInfo: Codable, Hashable, Sendable {
        public var name: String?
        public var status: String?
        public var serverType: String?
        public var cpus: Int?
        public var memoryTotalBytes: Int64?
        public var location: String?
        public var ip: String?
        public var backupWindow: String?

        public init(
            name: String? = nil,
            status: String? = nil,
            serverType: String? = nil,
            cpus: Int? = nil,
            memoryTotalBytes: Int64? = nil,
            location: String? = nil,
            ip: String? = nil,
            backupWindow: String? = nil
        ) {
            self.name = name
            self.status = status
            self.serverType = serverType
            self.cpus = cpus
            self.memoryTotalBytes = memoryTotalBytes
            self.location = location
            self.ip = ip
            self.backupWindow = backupWindow
        }
    }

    public struct HostUsage: Codable, Hashable, Sendable {
        public var cpuPct: Double?
        public var networkRxBytesPerSec: Double?
        public var networkTxBytesPerSec: Double?
        public var diskReadBytesPerSec: Double?
        public var diskWriteBytesPerSec: Double?

        public init(
            cpuPct: Double? = nil,
            networkRxBytesPerSec: Double? = nil,
            networkTxBytesPerSec: Double? = nil,
            diskReadBytesPerSec: Double? = nil,
            diskWriteBytesPerSec: Double? = nil
        ) {
            self.cpuPct = cpuPct
            self.networkRxBytesPerSec = networkRxBytesPerSec
            self.networkTxBytesPerSec = networkTxBytesPerSec
            self.diskReadBytesPerSec = diskReadBytesPerSec
            self.diskWriteBytesPerSec = diskWriteBytesPerSec
        }
    }

    public struct Resource: Codable, Hashable, Sendable, Identifiable {
        public var uuid: String
        public var name: String
        public var type: String
        public var status: String
        public var selfApp: Bool
        public var fleetAppId: String?
        public var fleetLabel: String?

        public var id: String { uuid }

        enum CodingKeys: String, CodingKey {
            case uuid, name, type, status
            case selfApp = "self"
            case fleetAppId, fleetLabel
        }

        public init(
            uuid: String,
            name: String,
            type: String,
            status: String,
            selfApp: Bool,
            fleetAppId: String? = nil,
            fleetLabel: String? = nil
        ) {
            self.uuid = uuid
            self.name = name
            self.type = type
            self.status = status
            self.selfApp = selfApp
            self.fleetAppId = fleetAppId
            self.fleetLabel = fleetLabel
        }
    }

    public struct AppDisk: Codable, Hashable, Sendable {
        public var freeBytes: Int64?
        public var totalBytes: Int64?
        public var usedPct: Int?
        public var ok: Bool?

        public init(
            freeBytes: Int64? = nil,
            totalBytes: Int64? = nil,
            usedPct: Int? = nil,
            ok: Bool? = nil
        ) {
            self.freeBytes = freeBytes
            self.totalBytes = totalBytes
            self.usedPct = usedPct
            self.ok = ok
        }
    }

    /// Off-site + local backup status for fleet apps on the shared host.
    public struct FleetBackups: Codable, Hashable, Sendable {
        public var configured: Bool?
        public var ok: Bool?
        /// True when the check was deliberately skipped (offline e2e run):
        /// nothing was observed, so `ok == false` here means "not checked",
        /// never "backups failing".
        public var offline: Bool?
        public var asOf: String?
        public var cacheAgeSeconds: Int?
        public var apps: [App]
        public var warnings: [String]?

        public init(
            configured: Bool? = nil,
            ok: Bool? = nil,
            offline: Bool? = nil,
            asOf: String? = nil,
            cacheAgeSeconds: Int? = nil,
            apps: [App] = [],
            warnings: [String]? = nil
        ) {
            self.configured = configured
            self.ok = ok
            self.offline = offline
            self.asOf = asOf
            self.cacheAgeSeconds = cacheAgeSeconds
            self.apps = apps
            self.warnings = warnings
        }

        public struct App: Codable, Hashable, Sendable, Identifiable {
            public var id: String
            public var label: String
            public var selfApp: Bool?
            public var ok: Bool?
            public var locations: [Location]

            enum CodingKeys: String, CodingKey {
                case id, label, ok, locations
                case selfApp = "self"
            }

            public init(
                id: String,
                label: String,
                selfApp: Bool? = nil,
                ok: Bool? = nil,
                locations: [Location] = []
            ) {
                self.id = id
                self.label = label
                self.selfApp = selfApp
                self.ok = ok
                self.locations = locations
            }
        }

        public struct Location: Codable, Hashable, Sendable, Identifiable {
            public var id: String
            public var label: String
            public var ok: Bool?
            public var present: Bool?
            /// True when the location was never observed (peer not probed,
            /// check skipped offline): neither presence nor absence is known,
            /// so the row must read neutral, never failed.
            public var unknown: Bool?
            public var latestAgeSeconds: Double?
            public var bytes: Int64?
            public var fileCount: Int?
            public var reason: String?

            public init(
                id: String,
                label: String,
                ok: Bool? = nil,
                present: Bool? = nil,
                unknown: Bool? = nil,
                latestAgeSeconds: Double? = nil,
                bytes: Int64? = nil,
                fileCount: Int? = nil,
                reason: String? = nil
            ) {
                self.id = id
                self.label = label
                self.ok = ok
                self.present = present
                self.unknown = unknown
                self.latestAgeSeconds = latestAgeSeconds
                self.bytes = bytes
                self.fileCount = fileCount
                self.reason = reason
            }
        }
    }
}
