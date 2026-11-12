import Foundation

/// A compact, self-contained projection that the WidgetKit extension can
/// render without pulling in the app's full model/networking stack. The app
/// derives and persists this after every successful refresh.
///
/// Budget fields are the original payload.  LLM, server, Mac, and alerts
/// sections are optional so older app-group files still decode.  Missing
/// sections are absent data, not zeros.
public struct WidgetSnapshot: Codable, Equatable, Sendable {
    public struct Meter: Codable, Equatable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var spentUsd: Double
        public var budgetUsd: Double?
        public var percentUsed: Double?
        /// Raw status string: "ok" | "warning" | "exceeded" | "unconfigured".
        public var status: String
        /// Projected end-of-month spend when known (projects / overall).
        public var projectedEomUsd: Double?

        public init(
            id: String,
            name: String,
            spentUsd: Double,
            budgetUsd: Double?,
            percentUsed: Double?,
            status: String,
            projectedEomUsd: Double? = nil
        ) {
            self.id = id
            self.name = name
            self.spentUsd = spentUsd
            self.budgetUsd = budgetUsd
            self.percentUsed = percentUsed
            self.status = status
            self.projectedEomUsd = projectedEomUsd
        }

        private enum CodingKeys: String, CodingKey {
            case id, name, spentUsd, budgetUsd, percentUsed, status, projectedEomUsd
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            name = try c.decode(String.self, forKey: .name)
            spentUsd = try c.decode(Double.self, forKey: .spentUsd)
            budgetUsd = try c.decodeIfPresent(Double.self, forKey: .budgetUsd)
            percentUsed = try c.decodeIfPresent(Double.self, forKey: .percentUsed)
            status = try c.decode(String.self, forKey: .status)
            projectedEomUsd = try c.decodeIfPresent(Double.self, forKey: .projectedEomUsd)
        }
    }

    /// Trailing-window LLM burn copied from `LlmBurnResponse`.  Cost fields
    /// stay optional so a missing estimate is not written as `$0`.
    public struct LlmSection: Codable, Equatable, Sendable {
        public var generatedAt: Date
        public var windowHours: Double?
        public var providers: [Provider]

        public init(generatedAt: Date, windowHours: Double?, providers: [Provider]) {
            self.generatedAt = generatedAt
            self.windowHours = windowHours
            self.providers = providers
        }

        public struct Provider: Codable, Equatable, Sendable, Identifiable {
            public var id: String
            public var name: String
            public var quiet: Bool
            public var tokensTotal: Double
            public var tokensInput: Double
            public var tokensOutput: Double
            public var derivedCostUsd: Double?
            public var reportedCostUsd: Double?
            public var estimateUsd: Double?
            public var tokensPerHour: Double?
            public var usdPerHour: Double?
            public var monthlyBudgetUsd: Double?
            public var budgetStatus: String?
            public var projectedMonthEndUsd: Double?

            public init(
                id: String,
                name: String,
                quiet: Bool,
                tokensTotal: Double,
                tokensInput: Double,
                tokensOutput: Double,
                derivedCostUsd: Double? = nil,
                reportedCostUsd: Double? = nil,
                estimateUsd: Double? = nil,
                tokensPerHour: Double? = nil,
                usdPerHour: Double? = nil,
                monthlyBudgetUsd: Double? = nil,
                budgetStatus: String? = nil,
                projectedMonthEndUsd: Double? = nil
            ) {
                self.id = id
                self.name = name
                self.quiet = quiet
                self.tokensTotal = tokensTotal
                self.tokensInput = tokensInput
                self.tokensOutput = tokensOutput
                self.derivedCostUsd = derivedCostUsd
                self.reportedCostUsd = reportedCostUsd
                self.estimateUsd = estimateUsd
                self.tokensPerHour = tokensPerHour
                self.usdPerHour = usdPerHour
                self.monthlyBudgetUsd = monthlyBudgetUsd
                self.budgetStatus = budgetStatus
                self.projectedMonthEndUsd = projectedMonthEndUsd
            }
        }
    }

    /// Service probe + host/app inventory copied from `ServerHealth`,
    /// `ServerReadiness`, and `ServerMetrics`.  Each subsection has its own
    /// timestamp so a loaded service probe never pretends host metrics exist.
    public struct ServerSection: Codable, Equatable, Sendable {
        public var service: Service?
        public var host: Host?
        public var apps: [App]

        public init(service: Service? = nil, host: Host? = nil, apps: [App] = []) {
            self.service = service
            self.host = host
            self.apps = apps
        }

        public struct Check: Codable, Equatable, Sendable, Identifiable {
            public var name: String
            public var ok: Bool
            public var gatesService: Bool
            public var detail: String?
            public var freeBytes: Int64?
            public var totalBytes: Int64?

            public var id: String { name }

            public init(
                name: String,
                ok: Bool,
                gatesService: Bool,
                detail: String? = nil,
                freeBytes: Int64? = nil,
                totalBytes: Int64? = nil
            ) {
                self.name = name
                self.ok = ok
                self.gatesService = gatesService
                self.detail = detail
                self.freeBytes = freeBytes
                self.totalBytes = totalBytes
            }
        }

        public struct Service: Codable, Equatable, Sendable {
            public var generatedAt: Date
            public var name: String
            public var ok: Bool
            public var status: String
            public var uptimeSeconds: Int?
            public var readyOk: Bool?
            public var checks: [Check]

            public init(
                generatedAt: Date,
                name: String,
                ok: Bool,
                status: String,
                uptimeSeconds: Int? = nil,
                readyOk: Bool? = nil,
                checks: [Check] = []
            ) {
                self.generatedAt = generatedAt
                self.name = name
                self.ok = ok
                self.status = status
                self.uptimeSeconds = uptimeSeconds
                self.readyOk = readyOk
                self.checks = checks
            }
        }

        public struct Host: Codable, Equatable, Sendable {
            public var generatedAt: Date
            public var name: String?
            public var status: String?
            public var cpuPct: Double?
            public var memoryTotalBytes: Int64?
            public var diskUsedPct: Int?
            public var diskFreeBytes: Int64?
            public var diskTotalBytes: Int64?
            public var degraded: Bool
            public var stale: Bool
            public var preventionOverall: String?
            public var appsHealthy: Int?
            public var appsDown: Int?
            public var appsTotal: Int?

            public init(
                generatedAt: Date,
                name: String? = nil,
                status: String? = nil,
                cpuPct: Double? = nil,
                memoryTotalBytes: Int64? = nil,
                diskUsedPct: Int? = nil,
                diskFreeBytes: Int64? = nil,
                diskTotalBytes: Int64? = nil,
                degraded: Bool = false,
                stale: Bool = false,
                preventionOverall: String? = nil,
                appsHealthy: Int? = nil,
                appsDown: Int? = nil,
                appsTotal: Int? = nil
            ) {
                self.generatedAt = generatedAt
                self.name = name
                self.status = status
                self.cpuPct = cpuPct
                self.memoryTotalBytes = memoryTotalBytes
                self.diskUsedPct = diskUsedPct
                self.diskFreeBytes = diskFreeBytes
                self.diskTotalBytes = diskTotalBytes
                self.degraded = degraded
                self.stale = stale
                self.preventionOverall = preventionOverall
                self.appsHealthy = appsHealthy
                self.appsDown = appsDown
                self.appsTotal = appsTotal
            }
        }

        public struct App: Codable, Equatable, Sendable, Identifiable {
            public var id: String
            public var name: String
            public var status: String
            public var selfApp: Bool

            public init(id: String, name: String, status: String, selfApp: Bool) {
                self.id = id
                self.name = name
                self.status = status
                self.selfApp = selfApp
            }
        }
    }

    /// Latest Mac heartbeat from Computers (`GET /api/health/mac`).  Distinct
    /// from the Coolify host under Servers.  `nil` means the app has never
    /// cached a Mac response.  `reported == false` means the monitor answered
    /// but this Mac has not checked in.
    public struct MacSection: Codable, Equatable, Sendable {
        public var generatedAt: Date
        public var ok: Bool
        public var status: String
        public var reported: Bool
        public var hostname: String?
        public var osVersion: String?
        public var arch: String?
        public var cpuUsagePct: Double?
        public var memoryUsagePct: Double?
        public var diskUsagePct: Double?
        public var uptimeSeconds: Int?
        public var lastHeartbeatAt: Date?
        public var secondsSinceHeartbeat: Int?
        public var flags: [String]
        public var processes: [Process]

        public init(
            generatedAt: Date,
            ok: Bool,
            status: String,
            reported: Bool,
            hostname: String? = nil,
            osVersion: String? = nil,
            arch: String? = nil,
            cpuUsagePct: Double? = nil,
            memoryUsagePct: Double? = nil,
            diskUsagePct: Double? = nil,
            uptimeSeconds: Int? = nil,
            lastHeartbeatAt: Date? = nil,
            secondsSinceHeartbeat: Int? = nil,
            flags: [String] = [],
            processes: [Process] = []
        ) {
            self.generatedAt = generatedAt
            self.ok = ok
            self.status = status
            self.reported = reported
            self.hostname = hostname
            self.osVersion = osVersion
            self.arch = arch
            self.cpuUsagePct = cpuUsagePct
            self.memoryUsagePct = memoryUsagePct
            self.diskUsagePct = diskUsagePct
            self.uptimeSeconds = uptimeSeconds
            self.lastHeartbeatAt = lastHeartbeatAt
            self.secondsSinceHeartbeat = secondsSinceHeartbeat
            self.flags = flags
            self.processes = processes
        }

        public struct Process: Codable, Equatable, Sendable, Identifiable {
            public var name: String
            public var status: String
            public var id: String { name }

            public init(name: String, status: String) {
                self.name = name
                self.status = status
            }
        }
    }

    /// Active provider alerts copied from the budget snapshot.  `nil` means
    /// the app has never cached budget-status.  A loaded section with
    /// `openCount == 0` is an honest all-clear.
    public struct AlertsSection: Codable, Equatable, Sendable {
        public var generatedAt: Date
        public var openCount: Int
        public var needsAttentionCount: Int
        public var latestTitle: String?
        public var latestProvider: String?
        public var latestSeverity: String?
        public var items: [Item]

        public init(
            generatedAt: Date,
            openCount: Int,
            needsAttentionCount: Int,
            latestTitle: String? = nil,
            latestProvider: String? = nil,
            latestSeverity: String? = nil,
            items: [Item] = []
        ) {
            self.generatedAt = generatedAt
            self.openCount = openCount
            self.needsAttentionCount = needsAttentionCount
            self.latestTitle = latestTitle
            self.latestProvider = latestProvider
            self.latestSeverity = latestSeverity
            self.items = items
        }

        public struct Item: Codable, Equatable, Sendable, Identifiable {
            public var id: String
            public var title: String
            public var providerName: String
            public var severity: String

            public init(id: String, title: String, providerName: String, severity: String) {
                self.id = id
                self.title = title
                self.providerName = providerName
                self.severity = severity
            }
        }
    }

    /// Subscription quota windows from `GET /api/quota-windows` — the
    /// remaining-percent view of Claude / Codex / Grok / MiniMax plan capacity.
    /// `nil` means the app has never cached quota windows.  Distinct from
    /// ``LlmSection``: that is *spend in a trailing window*, this is *how much
    /// plan is left before a rate limit bites*.
    public struct QuotaSection: Codable, Equatable, Sendable {
        public var generatedAt: Date
        public var windows: [Window]

        public init(generatedAt: Date, windows: [Window]) {
            self.generatedAt = generatedAt
            self.windows = windows
        }

        public struct Window: Codable, Equatable, Sendable, Identifiable {
            public var id: String
            public var providerId: String
            public var providerLabel: String
            public var label: String
            /// 0...1 fraction **remaining**, `nil` when the server reported the
            /// window without a number. Never invented from `isExhausted`.
            public var remainingFraction: Double?
            public var isExhausted: Bool
            public var isNearCap: Bool
            public var resetAt: Date?
            /// Human window cadence ("5h", "7d", "monthly") when the server
            /// supplies one.
            public var window: String?
            public var via: String?

            public init(
                id: String,
                providerId: String,
                providerLabel: String,
                label: String,
                remainingFraction: Double? = nil,
                isExhausted: Bool = false,
                isNearCap: Bool = false,
                resetAt: Date? = nil,
                window: String? = nil,
                via: String? = nil
            ) {
                self.id = id
                self.providerId = providerId
                self.providerLabel = providerLabel
                self.label = label
                self.remainingFraction = remainingFraction
                self.isExhausted = isExhausted
                self.isNearCap = isNearCap
                self.resetAt = resetAt
                self.window = window
                self.via = via
            }
        }
    }

    public var generatedAt: Date
    public var month: String
    /// Account-wide (provider-scoped) month-to-date totals.
    public var totalSpentUsd: Double
    public var totalBudgetUsd: Double
    public var projectedEomUsd: Double
    public var percentUsed: Double?
    public var overBudget: Bool
    public var warning: Bool
    /// Highest-utilisation **provider** budget meters for the overall view.
    public var topMeters: [Meter]
    /// Project budget rows the widget can focus on (may include unbudgeted).
    public var projects: [Meter]
    /// Trailing-window LLM burn.  `nil` means the app has never cached it.
    public var llm: LlmSection?
    /// Service / host / app rows.  `nil` means the app has never cached them.
    public var servers: ServerSection?
    /// Top spenders by month-to-date spend (not utilisation).  Empty when the
    /// latest budget snapshot has no positive spend.
    public var spenders: [Meter]
    /// Mac heartbeat.  `nil` means Computers has never written a cache.
    public var mac: MacSection?
    /// Active alerts.  `nil` means budget-status has never been cached.
    public var alerts: AlertsSection?
    /// Subscription plan capacity.  `nil` means quota windows have never been
    /// cached.
    public var quotas: QuotaSection?

    public init(
        generatedAt: Date,
        month: String,
        totalSpentUsd: Double,
        totalBudgetUsd: Double,
        projectedEomUsd: Double,
        percentUsed: Double?,
        overBudget: Bool,
        warning: Bool,
        topMeters: [Meter],
        projects: [Meter] = [],
        llm: LlmSection? = nil,
        servers: ServerSection? = nil,
        spenders: [Meter] = [],
        mac: MacSection? = nil,
        alerts: AlertsSection? = nil,
        quotas: QuotaSection? = nil
    ) {
        self.generatedAt = generatedAt
        self.month = month
        self.totalSpentUsd = totalSpentUsd
        self.totalBudgetUsd = totalBudgetUsd
        self.projectedEomUsd = projectedEomUsd
        self.percentUsed = percentUsed
        self.overBudget = overBudget
        self.warning = warning
        self.topMeters = topMeters
        self.projects = projects
        self.llm = llm
        self.servers = servers
        self.spenders = spenders
        self.mac = mac
        self.alerts = alerts
        self.quotas = quotas
    }

    private enum CodingKeys: String, CodingKey {
        case generatedAt, month, totalSpentUsd, totalBudgetUsd, projectedEomUsd
        case percentUsed, overBudget, warning, topMeters, projects, llm, servers
        case spenders, mac, alerts, quotas
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try c.decode(Date.self, forKey: .generatedAt)
        month = try c.decode(String.self, forKey: .month)
        totalSpentUsd = try c.decode(Double.self, forKey: .totalSpentUsd)
        totalBudgetUsd = try c.decode(Double.self, forKey: .totalBudgetUsd)
        projectedEomUsd = try c.decode(Double.self, forKey: .projectedEomUsd)
        percentUsed = try c.decodeIfPresent(Double.self, forKey: .percentUsed)
        overBudget = try c.decode(Bool.self, forKey: .overBudget)
        warning = try c.decode(Bool.self, forKey: .warning)
        topMeters = try c.decode([Meter].self, forKey: .topMeters)
        // Backward-compatible: older snapshots omit projects / llm / servers /
        // spenders / mac / alerts / quotas.
        projects = try c.decodeIfPresent([Meter].self, forKey: .projects) ?? []
        llm = try c.decodeIfPresent(LlmSection.self, forKey: .llm)
        servers = try c.decodeIfPresent(ServerSection.self, forKey: .servers)
        spenders = try c.decodeIfPresent([Meter].self, forKey: .spenders) ?? []
        mac = try c.decodeIfPresent(MacSection.self, forKey: .mac)
        alerts = try c.decodeIfPresent(AlertsSection.self, forKey: .alerts)
        quotas = try c.decodeIfPresent(QuotaSection.self, forKey: .quotas)
    }

    /// Keep LLM / server / Mac / quota cache when a budget-only write lands.
    public func mergingPreservedSections(from existing: WidgetSnapshot) -> WidgetSnapshot {
        var next = self
        if next.llm == nil { next.llm = existing.llm }
        if next.servers == nil { next.servers = existing.servers }
        if next.mac == nil { next.mac = existing.mac }
        if next.alerts == nil { next.alerts = existing.alerts }
        if next.quotas == nil { next.quotas = existing.quotas }
        return next
    }

    public func replacingLlm(_ llm: LlmSection?) -> WidgetSnapshot {
        var next = self
        next.llm = llm
        return next
    }

    public func replacingServerService(_ service: ServerSection.Service?) -> WidgetSnapshot {
        var next = self
        var section = next.servers ?? ServerSection()
        section.service = service
        next.servers = section
        return next
    }

    public func replacingServerHost(_ host: ServerSection.Host?, apps: [ServerSection.App]) -> WidgetSnapshot {
        var next = self
        var section = next.servers ?? ServerSection()
        section.host = host
        section.apps = apps
        next.servers = section
        return next
    }

    public func replacingMac(_ mac: MacSection?) -> WidgetSnapshot {
        var next = self
        next.mac = mac
        return next
    }

    public func replacingQuotas(_ quotas: QuotaSection?) -> WidgetSnapshot {
        var next = self
        next.quotas = quotas
        return next
    }

    /// Deterministic **gallery/preview** sample (never used as a live empty state).
    public static let placeholder = WidgetSnapshot(
        generatedAt: Date(timeIntervalSince1970: 1_720_000_000),
        month: "2026-07",
        totalSpentUsd: 428.16,
        totalBudgetUsd: 900,
        projectedEomUsd: 690.40,
        percentUsed: 0.4757,
        overBudget: false,
        warning: true,
        topMeters: [
            Meter(id: "anthropic", name: "Anthropic", spentUsd: 212.4, budgetUsd: 250, percentUsed: 0.85, status: "warning", projectedEomUsd: 280),
            Meter(id: "openai", name: "OpenAI", spentUsd: 96.2, budgetUsd: 200, percentUsed: 0.48, status: "ok", projectedEomUsd: 140),
            Meter(id: "voyage", name: "Voyage", spentUsd: 61.0, budgetUsd: 150, percentUsed: 0.41, status: "ok", projectedEomUsd: 90)
        ],
        projects: [
            Meter(id: "proj-ct", name: "Congress.Trade", spentUsd: 180, budgetUsd: 400, percentUsed: 0.45, status: "ok", projectedEomUsd: 260),
            Meter(id: "proj-st", name: "Socratic.Trade", spentUsd: 95, budgetUsd: 200, percentUsed: 0.475, status: "ok", projectedEomUsd: 140)
        ],
        llm: LlmSection(
            generatedAt: Date(timeIntervalSince1970: 1_720_000_000),
            windowHours: 5,
            providers: [
                LlmSection.Provider(
                    id: "anthropic",
                    name: "anthropic",
                    quiet: false,
                    tokensTotal: 184_200,
                    tokensInput: 120_000,
                    tokensOutput: 64_200,
                    derivedCostUsd: 8.40,
                    reportedCostUsd: 8.10,
                    estimateUsd: 8.40,
                    tokensPerHour: 36_840,
                    usdPerHour: 1.68,
                    monthlyBudgetUsd: 250,
                    budgetStatus: "watch",
                    projectedMonthEndUsd: 280
                ),
                LlmSection.Provider(
                    id: "openai",
                    name: "openai",
                    quiet: false,
                    tokensTotal: 42_000,
                    tokensInput: 30_000,
                    tokensOutput: 12_000,
                    estimateUsd: 2.10,
                    tokensPerHour: 8_400,
                    usdPerHour: 0.42,
                    monthlyBudgetUsd: 200,
                    budgetStatus: "on-pace",
                    projectedMonthEndUsd: 140
                ),
                LlmSection.Provider(
                    id: "voyage",
                    name: "voyage",
                    quiet: true,
                    tokensTotal: 0,
                    tokensInput: 0,
                    tokensOutput: 0,
                    monthlyBudgetUsd: 150,
                    budgetStatus: "no-budget"
                )
            ]
        ),
        servers: ServerSection(
            service: ServerSection.Service(
                generatedAt: Date(timeIntervalSince1970: 1_720_000_000),
                name: "usage-monitor",
                ok: true,
                status: "live",
                uptimeSeconds: 84_213,
                readyOk: true,
                checks: [
                    ServerSection.Check(name: "Database", ok: true, gatesService: true),
                    ServerSection.Check(name: "Scheduler", ok: true, gatesService: true),
                    ServerSection.Check(
                        name: "Disk",
                        ok: true,
                        gatesService: false,
                        freeBytes: 30_000_000_000,
                        totalBytes: 160_000_000_000
                    )
                ]
            ),
            host: ServerSection.Host(
                generatedAt: Date(timeIntervalSince1970: 1_720_000_000),
                name: "ubuntu-16gb-nbg1-cx43",
                status: "running",
                cpuPct: 18.5,
                memoryTotalBytes: 16 * 1024 * 1024 * 1024,
                diskUsedPct: 81,
                diskFreeBytes: 30_000_000_000,
                diskTotalBytes: 160_000_000_000,
                degraded: false,
                stale: false,
                preventionOverall: "ok",
                appsHealthy: 2,
                appsDown: 0,
                appsTotal: 3
            ),
            apps: [
                ServerSection.App(id: "um", name: "usage-monitor", status: "running:healthy", selfApp: true),
                ServerSection.App(id: "st", name: "socratic-app", status: "running:healthy", selfApp: false),
                ServerSection.App(id: "ct", name: "congress-trade", status: "running:unknown", selfApp: false)
            ]
        ),
        spenders: [
            Meter(id: "anthropic", name: "Anthropic", spentUsd: 212.4, budgetUsd: 250, percentUsed: 0.85, status: "warning", projectedEomUsd: 280),
            Meter(id: "openai", name: "OpenAI", spentUsd: 96.2, budgetUsd: 200, percentUsed: 0.48, status: "ok", projectedEomUsd: 140),
            Meter(id: "voyage", name: "Voyage", spentUsd: 61.0, budgetUsd: 150, percentUsed: 0.41, status: "ok", projectedEomUsd: 90)
        ],
        mac: MacSection(
            generatedAt: Date(timeIntervalSince1970: 1_720_000_000),
            ok: true,
            status: "online",
            reported: true,
            hostname: "jays-macbook-pro",
            osVersion: "macOS 26.0",
            arch: "arm64",
            cpuUsagePct: 24,
            memoryUsagePct: 61,
            diskUsagePct: 47,
            uptimeSeconds: 86_400,
            lastHeartbeatAt: Date(timeIntervalSince1970: 1_720_000_000),
            secondsSinceHeartbeat: 12,
            flags: ["z-last is stopped."],
            processes: [
                MacSection.Process(name: "com.jay.agy-acp", status: "running"),
                MacSection.Process(name: "com.jay.z-last", status: "stopped")
            ]
        ),
        alerts: AlertsSection(
            generatedAt: Date(timeIntervalSince1970: 1_720_000_000),
            openCount: 2,
            needsAttentionCount: 2,
            latestTitle: "Budget exceeded",
            latestProvider: "OpenRouter",
            latestSeverity: "critical",
            items: [
                AlertsSection.Item(
                    id: "openrouter|budget_exceeded",
                    title: "Budget exceeded",
                    providerName: "OpenRouter",
                    severity: "critical"
                ),
                AlertsSection.Item(
                    id: "anthropic|budget_warning",
                    title: "Approaching budget",
                    providerName: "Anthropic",
                    severity: "warning"
                )
            ]
        )
    )

    /// Live empty state when no snapshot has been written (signed-out / fresh install).
    /// Zeros only — never fabricated spend that looks like real money.
    /// Optional sections stay `nil` so those topics cannot show fake live zeros.
    public static let empty = WidgetSnapshot(
        generatedAt: Date(timeIntervalSince1970: 0),
        month: "",
        totalSpentUsd: 0,
        totalBudgetUsd: 0,
        projectedEomUsd: 0,
        percentUsed: nil,
        overBudget: false,
        warning: false,
        topMeters: [],
        projects: [],
        llm: nil,
        servers: nil,
        spenders: [],
        mac: nil,
        alerts: nil
    )
}
