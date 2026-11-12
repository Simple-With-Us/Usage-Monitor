import Foundation

/// Tolerant ISO-8601 parsing for the timestamps the API emits. The backend
/// uses `Date.prototype.toISOString()` (always UTC, fractional seconds), but
/// some fields flow through other paths, so we accept both fractional and
/// whole-second forms.
public enum ISO8601DateParser {
    private static let withFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    public static func date(from string: String) -> Date? {
        withFractional.date(from: string) ?? plain.date(from: string)
    }
}
