import SwiftUI

/// Per-app colors for Backblaze B2 breakdown charts (storage donut + daily bars).
/// Matches the Usage Monitor Client preview palette in `UsageBreakdownCard`.
public enum B2FleetAppColors {
    public static let unattributedAppId = "unattributed"

    public static let unattributed = Color(red: 0.612, green: 0.643, blue: 0.690)

    public static let overCap = Color(red: 0.937, green: 0.267, blue: 0.267)

    public static let remaining = Color(red: 0.020, green: 0.588, blue: 0.412)

    private static let fallbackPalette: [Color] = [
        Color(red: 0.18, green: 0.78, blue: 0.64),
        Color(red: 0.94, green: 0.35, blue: 0.58),
        Color(red: 0.95, green: 0.68, blue: 0.18),
        Color(red: 0.45, green: 0.55, blue: 0.95),
        Color(red: 0.55, green: 0.75, blue: 0.25),
    ]

    /// Canonical display order for the three primary fleet apps (donut list + daily legend).
    public static let canonicalOrder: [String] = [
        "socratic-trade",
        "congress-trade",
        "usage-monitor",
        "fleet-infra",
    ]

    public static func color(forAppId appId: String, fallbackIndex: Int = 0) -> Color {
        switch appId {
        case "socratic-trade":
            return Theme.Colors.accent
        case "congress-trade":
            return Color(red: 0.20, green: 0.60, blue: 0.95)
        case "usage-monitor":
            return Color(red: 0.62, green: 0.38, blue: 0.95)
        case "fleet-infra":
            return Color(red: 0.18, green: 0.78, blue: 0.64)
        case unattributedAppId:
            return unattributed
        default:
            let index = max(0, fallbackIndex)
            return fallbackPalette[index % fallbackPalette.count]
        }
    }

    /// Merge payload order with any extra ids the daily series mentions.
    public static func orderedAppIds(payloadIds: [String], extraIds: [String]) -> [String] {
        var ordered: [String] = []
        for id in canonicalOrder where payloadIds.contains(id) {
            ordered.append(id)
        }
        for id in payloadIds where !ordered.contains(id) {
            ordered.append(id)
        }
        for id in extraIds.sorted() where !ordered.contains(id) {
            ordered.append(id)
        }
        return ordered
    }
}
