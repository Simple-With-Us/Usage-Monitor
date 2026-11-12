import Foundation

// ---------------------------------------------------------------------------
// TimeframeOption — mirrors the web's TimeframeOption union type.
//
// Three kinds:
//   .rolling(days:)             — trailing window (1, 7, 30, 90, 180, or 3650
//                                 for "all time")
//   .calendarMonth(year:month:) — specific UTC calendar month
//   .calendarYear(year:)        — specific UTC calendar year
//
// Only the portfolio telemetry panel (/api/usage-events) respects this filter.
// The hero / budget-status endpoint is always current-calendar-month.
// ---------------------------------------------------------------------------

public enum TimeframeOption: Hashable, Sendable {
    case rolling(days: Int)
    case calendarMonth(year: Int, month: Int)
    case calendarYear(year: Int)

    // MARK: - Display

    /// Picker label shown to the user.
    public var displayLabel: String {
        switch self {
        case .rolling(let d) where d == 1:   return "Past 24 hours"
        case .rolling(let d) where d == 7:   return "Past 7 days"
        case .rolling(let d) where d == 30:  return "Past 30 days"
        case .rolling(let d) where d == 90:  return "Past 90 days"
        case .rolling(let d) where d == 180: return "Past 180 days"
        case .rolling(let d) where d == 365: return "Past 12 months"
        case .rolling:                        return "All time"
        case .calendarMonth(let y, let m):
            if self == .currentMonth { return "This month" }
            return TimeframeOption.monthName(year: y, month: m)
        case .calendarYear(let y):
            return String(y)
        }
    }

    /// MTD budget surfaces only.
    public var mtdSpendLabel: String { TimeframeOption.currentMonthName }

    /// @deprecated Prefer mtdSpendLabel / displayLabel.
    public var periodLabel: String {
        switch self {
        case .calendarMonth(let y, let m):
            return TimeframeOption.monthName(year: y, month: m)
        case .calendarYear, .rolling:
            return TimeframeOption.currentMonthName
        }
    }

    // MARK: - URL query items for /api/usage-events

    /// Query items to append to the `/api/usage-events` request URL.
    public var usageEventsQueryItems: [URLQueryItem] {
        switch self {
        case .rolling(let d):
            if d >= 3650 { return [URLQueryItem(name: "days", value: "all")] }
            return [URLQueryItem(name: "days", value: String(d))]

        case .calendarMonth(let y, let m):
            let mo = String(format: "%02d", m)
            let from = "\(y)-\(mo)-01"
            let lastDay = TimeframeOption.lastDayOfMonth(year: y, month: m)
            let to = "\(y)-\(mo)-\(String(format: "%02d", lastDay))"
            return [
                URLQueryItem(name: "from", value: from),
                URLQueryItem(name: "to",   value: to),
            ]

        case .calendarYear(let y):
            return [
                URLQueryItem(name: "from", value: "\(y)-01-01"),
                URLQueryItem(name: "to",   value: "\(y)-12-31"),
            ]
        }
    }

    // MARK: - Factory helpers

    /// The current UTC calendar month.
    public static var currentMonth: TimeframeOption {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let comps = cal.dateComponents([.year, .month], from: Date())
        return .calendarMonth(year: comps.year!, month: comps.month!)
    }

    /// The most recent `count` calendar months, newest first (index 0 = current month).
    public static func recentMonths(count: Int = 13) -> [TimeframeOption] {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let now = Date()
        return (0 ..< count).compactMap { i -> TimeframeOption? in
            guard let date = cal.date(byAdding: .month, value: -i, to: now) else { return nil }
            let comps = cal.dateComponents([.year, .month], from: date)
            guard let y = comps.year, let m = comps.month else { return nil }
            return .calendarMonth(year: y, month: m)
        }
    }

    /// The most recent `count` calendar years, newest first.
    public static func recentYears(count: Int = 3) -> [TimeframeOption] {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let currentYear = cal.component(.year, from: Date())
        return (0 ..< count).map { .calendarYear(year: currentYear - $0) }
    }

    // MARK: - Internal helpers

    private static func monthName(year: Int, month: Int) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        var comps = DateComponents()
        comps.year = year
        comps.month = month
        comps.day = 1
        guard let date = cal.date(from: comps) else { return "\(year)-\(month)" }
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US")
        fmt.timeZone = TimeZone(identifier: "UTC")
        fmt.dateFormat = "MMMM yyyy"
        return fmt.string(from: date)
    }

    private static var currentMonthName: String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let comps = cal.dateComponents([.year, .month], from: Date())
        return monthName(year: comps.year!, month: comps.month!)
    }

    private static func lastDayOfMonth(year: Int, month: Int) -> Int {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        var comps = DateComponents()
        comps.year = year
        comps.month = month + 1  // next month
        comps.day = 0            // day 0 = last day of previous month
        guard let date = cal.date(from: comps) else { return 31 }
        return cal.component(.day, from: date)
    }
}
