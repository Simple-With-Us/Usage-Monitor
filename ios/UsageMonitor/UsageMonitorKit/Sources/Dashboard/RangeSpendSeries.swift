import Foundation
import Models

// ---------------------------------------------------------------------------
// RangeSpendSeries — daily spend bars for any Chart Range selection other
// than "This month" (which keeps the existing month-to-date `SpendPaceChart`
// with its projection). Built client-side from
// `GET /api/export/daily-rollups`, which only accepts inclusive UTC windows
// up to 92 days — wider selections (180d, 12m, all time, a full calendar
// year) get their trailing 92 days rather than a silent full-window lie;
// `isClamped` tells the caption to say so.
// ---------------------------------------------------------------------------

public struct RangeSpendPoint: Identifiable, Equatable, Sendable {
    public let day: Date
    public let value: Double
    public var id: Date { day }
}

public struct RangeSpendSeries: Equatable, Sendable {
    public let timeframe: TimeframeOption
    public let points: [RangeSpendPoint]
    public let isClamped: Bool

    public init(timeframe: TimeframeOption, points: [RangeSpendPoint], isClamped: Bool) {
        self.timeframe = timeframe
        self.points = points
        self.isClamped = isClamped
    }

    public var totalCostUsd: Double { points.reduce(0) { $0 + $1.value } }
    public var isEmpty: Bool { points.isEmpty }

    /// Chart caption — always the range's own label (a rolling window is
    /// never captioned with a month name that would make it look like an
    /// MTD figure), plus an honest note when the fetched window is narrower
    /// than the full selection.
    public var captionLabel: String {
        isClamped ? "\(timeframe.displayLabel) · last 92 days shown" : timeframe.displayLabel
    }

    public static func build(
        response: DailyRollupsResponse,
        timeframe: TimeframeOption,
        isClamped: Bool
    ) -> RangeSpendSeries {
        var totals: [String: Double] = [:]
        for row in response.rows {
            totals[row.day, default: 0] += row.totalCostUsd
        }
        let points: [RangeSpendPoint] = totals.keys.sorted().compactMap { key in
            guard let date = RangeSpendSeries.dayFormatter.date(from: key) else { return nil }
            return RangeSpendPoint(day: date, value: totals[key] ?? 0)
        }
        return RangeSpendSeries(timeframe: timeframe, points: points, isClamped: isClamped)
    }

    /// UTC, `yyyy-MM-dd` — matches the `day` string the server serializes
    /// (`formatDay` in `src/app/api/export/daily-rollups/route.ts`).
    public static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}

extension TimeframeOption {
    /// Inclusive UTC day window `/api/export/daily-rollups` should be queried
    /// with for this selection, clamped to the route's 92-day maximum.
    /// `isClamped` is true when the real window is wider than what got
    /// fetched (12m, all time, a full calendar year) — callers must say so
    /// rather than imply full coverage.
    public func dailyRollupWindow(referenceDate: Date = Date()) -> (from: Date, to: Date, isClamped: Bool) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let today = calendar.startOfDay(for: referenceDate)

        let rawFrom: Date
        let rawTo: Date
        switch self {
        case .rolling(let days):
            let clampedDays = max(days, 1)
            rawTo = today
            rawFrom = calendar.date(byAdding: .day, value: -(clampedDays - 1), to: today) ?? today

        case .calendarMonth(let year, let month):
            var comps = DateComponents()
            comps.year = year
            comps.month = month
            comps.day = 1
            let first = calendar.date(from: comps) ?? today
            let dayCount = calendar.range(of: .day, in: .month, for: first)?.count ?? 28
            rawFrom = first
            rawTo = calendar.date(byAdding: .day, value: dayCount - 1, to: first) ?? first

        case .calendarYear(let year):
            var startComps = DateComponents()
            startComps.year = year
            startComps.month = 1
            startComps.day = 1
            var endComps = DateComponents()
            endComps.year = year
            endComps.month = 12
            endComps.day = 31
            rawFrom = calendar.date(from: startComps) ?? today
            rawTo = calendar.date(from: endComps) ?? rawFrom
        }

        // A selected calendar year can still be in progress (e.g. picking the
        // current year while mid-year) — never query past "today", or an
        // in-progress year's trailing window would land entirely in the
        // future and come back empty despite real data earlier in the year.
        let boundedTo = min(rawTo, today)

        let maxWindowDays = 92
        let spanDays = (calendar.dateComponents([.day], from: rawFrom, to: boundedTo).day ?? maxWindowDays - 1) + 1
        guard spanDays > maxWindowDays else {
            return (rawFrom, boundedTo, false)
        }
        let clampedFrom = calendar.date(byAdding: .day, value: -(maxWindowDays - 1), to: boundedTo) ?? rawFrom
        return (clampedFrom, boundedTo, true)
    }
}
