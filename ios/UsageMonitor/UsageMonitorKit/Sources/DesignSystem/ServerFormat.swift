import Foundation

/// Format a server uptime (seconds) into a compact "3d 4h" / "5m" string.
/// Shared by the Settings host-usage rows and the Server Status tab.
public enum UptimeFormat {
    public static func string(fromSeconds seconds: Int) -> String {
        guard seconds > 0 else { return "just started" }
        let days = seconds / 86_400
        let hours = (seconds % 86_400) / 3_600
        let minutes = (seconds % 3_600) / 60

        if days > 0 { return "\(days)d \(hours)h" }
        if hours > 0 { return "\(hours)h \(minutes)m" }
        if minutes > 0 { return "\(minutes)m" }
        return "\(seconds)s"
    }
}

/// Compact free/total disk for dependency detail lines.
/// Shared by the Settings host-usage rows and the Server Status tab.
public enum DiskFormat {
    public static func summary(free: Int64?, total: Int64?) -> String? {
        guard let free, let total, total > 0 else { return nil }
        return "\(byteString(free)) free of \(byteString(total))"
    }

    public static func byteString(_ bytes: Int64) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useGB, .useMB, .useTB]
        formatter.countStyle = .file
        formatter.includesUnit = true
        formatter.isAdaptive = true
        return formatter.string(fromByteCount: bytes)
    }

    public static func rateString(_ bytesPerSec: Double?) -> String? {
        guard let bytesPerSec, bytesPerSec >= 0, bytesPerSec.isFinite else { return nil }
        return "\(byteString(Int64(bytesPerSec)))/s"
    }

    public static func cpuString(_ pct: Double?) -> String? {
        guard let pct, pct.isFinite else { return nil }
        return String(format: "%.0f%%", min(100, max(0, pct)))
    }
}
