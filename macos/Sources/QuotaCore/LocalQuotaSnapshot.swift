import Foundation

/// A credential-free handoff for BotFleet on the same Mac.  Only local quota
/// readings are exported; server accounts and authentication never enter it.
public enum LocalQuotaSnapshot {
    public struct Payload: Codable, Sendable {
        public let format: String
        public let version: Int
        public let generatedAt: String
        public let windows: [QuotaWindow]
    }

    public static func destination(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        home.appendingPathComponent("Library/Application Support/Usage Monitor/quota-windows.json")
    }

    public static func write(windows: [QuotaWindow], now: Date = Date(), to url: URL = destination()) throws {
        let manager = FileManager.default
        let directory = url.deletingLastPathComponent()
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let payload = Payload(format: "usage-monitor-local-quotas", version: 1,
                              generatedAt: ISO8601DateFormatter().string(from: now), windows: windows)
        let data = try JSONEncoder().encode(payload)
        guard data.count <= 1_048_576 else { throw CocoaError(.fileWriteOutOfSpace) }
        try data.write(to: url, options: .atomic)
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    public static func remove(at url: URL = destination()) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }
}
