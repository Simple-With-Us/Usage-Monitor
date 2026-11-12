import Foundation

/// `GET /api/health/mac` — latest Mac heartbeat (read token or dashboard session).
public struct MacHealthResponse: Codable, Hashable, Sendable {
    public var ok: Bool
    public var status: String
    public var lastHeartbeatAt: String?
    public var secondsSinceHeartbeat: Int?
    public var mac: MacHostTelemetry?

    public init(
        ok: Bool,
        status: String,
        lastHeartbeatAt: String? = nil,
        secondsSinceHeartbeat: Int? = nil,
        mac: MacHostTelemetry? = nil
    ) {
        self.ok = ok
        self.status = status
        self.lastHeartbeatAt = lastHeartbeatAt
        self.secondsSinceHeartbeat = secondsSinceHeartbeat
        self.mac = mac
    }

    public static let sample = MacHealthResponse(
        ok: true,
        status: "ok",
        lastHeartbeatAt: "2026-08-24T05:00:00.000Z",
        secondsSinceHeartbeat: 42,
        mac: MacHostTelemetry(
            hostname: "jays.services",
            username: "jay",
            tailscaleHostname: "macbook.boa-roygbiv.ts.net",
            osVersion: "macOS 15.6.1",
            chipName: "Apple M5",
            arch: "arm64",
            cpuUsagePct: 14.2,
            memoryUsagePct: 59.7,
            diskUsagePct: 87.0,
            uptimeSeconds: 86400 * 5 + 3600 * 4,
            processes: [
                "ag***-s**c": "running",
                "docker": "not_enabled",
                "litestream": "not_enabled",
                "ollama": "not_enabled"
            ],
            agentProcesses: [
                "claude": "running",
                "cursor": "running",
                "grok": "running",
                "codex": "running",
                "antigravity": "running",
                "copilot": "running"
            ],
            pm2Processes: [
                MacPm2Process(name: "ag***-s**c-live", status: "online", pid: 14205, cpu: 0.1, memory: 45000000),
                MacPm2Process(name: "fleet-heartbeat", status: "online", pid: 14206, cpu: 0.0, memory: 32000000)
            ],
            launchdProcesses: [
                MacLaunchdProcess(name: "com.jays.ag***-s**c-poll", status: "running", pid: 1205),
                MacLaunchdProcess(name: "com.jays.mac-watchdog", status: "running", pid: 1206)
            ],
            lastHeartbeatAt: "2026-08-24T05:00:00.000Z"
        )
    )
}

public struct MacPm2Process: Codable, Hashable, Sendable {
    public var name: String
    public var status: String
    public var pid: Int?
    public var cpu: Double?
    public var memory: Int?

    public init(name: String, status: String, pid: Int? = nil, cpu: Double? = nil, memory: Int? = nil) {
        self.name = name
        self.status = status
        self.pid = pid
        self.cpu = cpu
        self.memory = memory
    }
}

public struct MacLaunchdProcess: Codable, Hashable, Sendable {
    public var name: String
    public var status: String
    public var pid: Int?

    public init(name: String, status: String, pid: Int? = nil) {
        self.name = name
        self.status = status
        self.pid = pid
    }
}

public struct MacHostTelemetry: Codable, Hashable, Sendable {
    public var hostname: String
    public var username: String?
    public var tailscaleHostname: String?
    public var osVersion: String?
    public var chipName: String?
    public var arch: String?
    public var cpuUsagePct: Double
    public var memoryUsagePct: Double
    public var diskUsagePct: Double
    public var uptimeSeconds: Int
    public var processes: [String: String]?
    public var agentProcesses: [String: String]?
    public var pm2Processes: [MacPm2Process]?
    public var launchdProcesses: [MacLaunchdProcess]?
    public var lastHeartbeatAt: String?

    public init(
        hostname: String,
        username: String? = nil,
        tailscaleHostname: String? = nil,
        osVersion: String? = nil,
        chipName: String? = nil,
        arch: String? = nil,
        cpuUsagePct: Double,
        memoryUsagePct: Double,
        diskUsagePct: Double,
        uptimeSeconds: Int,
        processes: [String: String]? = nil,
        agentProcesses: [String: String]? = nil,
        pm2Processes: [MacPm2Process]? = nil,
        launchdProcesses: [MacLaunchdProcess]? = nil,
        lastHeartbeatAt: String? = nil
    ) {
        self.hostname = hostname
        self.username = username
        self.tailscaleHostname = tailscaleHostname
        self.osVersion = osVersion
        self.chipName = chipName
        self.arch = arch
        self.cpuUsagePct = cpuUsagePct
        self.memoryUsagePct = memoryUsagePct
        self.diskUsagePct = diskUsagePct
        self.uptimeSeconds = uptimeSeconds
        self.processes = processes
        self.agentProcesses = agentProcesses
        self.pm2Processes = pm2Processes
        self.launchdProcesses = launchdProcesses
        self.lastHeartbeatAt = lastHeartbeatAt
    }

    /// Sorted process rows so the UI does not shuffle on every refresh.
    public var processRows: [(name: String, status: String)] {
        (processes ?? [:]).map { ($0.key, $0.value) }.sorted { $0.name < $1.name }
    }
}
