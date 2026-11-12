import Foundation

/// Shared ISO-8601 encode/decode for the on-device Local store and export.
/// Public so LocalDataPlane (and other Local* modules) can round-trip dates
/// without reimplementing fractional/non-fractional formatter fallbacks.
public enum ISO8601 {
    static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static let formatterNoFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    public static func string(from date: Date) -> String {
        formatter.string(from: date)
    }

    public static func date(from string: String) -> Date? {
        formatter.date(from: string) ?? formatterNoFraction.date(from: string)
    }

    /// First instant of the UTC calendar month containing `date`.
    public static func utcMonthStart(containing date: Date = Date()) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let comps = cal.dateComponents([.year, .month], from: date)
        return cal.date(from: DateComponents(year: comps.year, month: comps.month, day: 1))!
    }

    public static func nextUtcMonthStart(after date: Date = Date()) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let start = utcMonthStart(containing: date)
        return cal.date(byAdding: .month, value: 1, to: start)!
    }

    public static func dayStringUTC(_ date: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        let c = cal.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }
}
