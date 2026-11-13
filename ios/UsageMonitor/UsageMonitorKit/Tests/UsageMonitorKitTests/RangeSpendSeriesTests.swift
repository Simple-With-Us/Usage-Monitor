import XCTest
@testable import Dashboard
@testable import Models

/// Pure tests for the chart-range fix: `RangeSpendSeries.build` (the daily
/// bars behind any non-"This month" selection) and
/// `TimeframeOption.dailyRollupWindow` (the 92-day server clamp).
final class RangeSpendSeriesTests: XCTestCase {

    private var utcCalendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal
    }

    private func response(_ rows: [(day: String, cost: Double)]) -> DailyRollupsResponse {
        DailyRollupsResponse(
            from: rows.first?.day ?? "2026-08-01",
            to: rows.last?.day ?? "2026-08-01",
            rowCount: rows.count,
            truncated: false,
            rows: rows.map { DailyRollupRow(day: $0.day, totalCostUsd: $0.cost) }
        )
    }

    // MARK: - (b) Range series building differs for two windows

    func testBuildDiffersBetweenTwoWindows() {
        let sevenDayResponse = response([
            ("2026-08-01", 3.0),
            ("2026-08-02", 4.0),
        ])
        let thirtyDayResponse = response([
            ("2026-07-15", 1.0),
            ("2026-08-01", 3.0),
            ("2026-08-02", 4.0),
            ("2026-08-10", 20.0),
        ])

        let sevenDaySeries = RangeSpendSeries.build(
            response: sevenDayResponse, timeframe: .rolling(days: 7), isClamped: false
        )
        let thirtyDaySeries = RangeSpendSeries.build(
            response: thirtyDayResponse, timeframe: .rolling(days: 30), isClamped: false
        )

        XCTAssertNotEqual(sevenDaySeries.points.count, thirtyDaySeries.points.count)
        XCTAssertTrue(abs(sevenDaySeries.totalCostUsd - thirtyDaySeries.totalCostUsd) > 0.0001)
        XCTAssertEqual(sevenDaySeries.totalCostUsd, 7.0, accuracy: 0.0001)
        XCTAssertEqual(thirtyDaySeries.totalCostUsd, 28.0, accuracy: 0.0001)
    }

    func testBuildSumsMultipleRowsPerDay() throws {
        // Two groupKey rows for the same day (one per provider) must be
        // summed into a single daily bar, not kept as separate points.
        let multiGroupResponse = response([
            ("2026-08-14", 4.5),
            ("2026-08-14", 1.25),
        ])
        let series = RangeSpendSeries.build(
            response: multiGroupResponse, timeframe: .rolling(days: 7), isClamped: false
        )
        XCTAssertEqual(series.points.count, 1)
        let firstValue = try XCTUnwrap(series.points.first?.value)
        XCTAssertEqual(firstValue, 5.75, accuracy: 0.0001)
    }

    func testBuildIsEmptyWithNoRows() {
        let series = RangeSpendSeries.build(
            response: response([]), timeframe: .rolling(days: 7), isClamped: false
        )
        XCTAssertTrue(series.isEmpty)
        XCTAssertEqual(series.totalCostUsd, 0)
    }

    // MARK: - (c) Non-current-month ranges never produce a month-name label
    //             or a projection value.

    func testRollingRangeCaptionsNeverContainAMonthName() {
        let sevenDay = RangeSpendSeries.build(
            response: response([("2026-08-01", 3.0)]), timeframe: .rolling(days: 7), isClamped: false
        )
        let thirtyDay = RangeSpendSeries.build(
            response: response([("2026-08-01", 3.0)]), timeframe: .rolling(days: 30), isClamped: false
        )

        XCTAssertEqual(sevenDay.captionLabel, "Past 7 days")
        XCTAssertEqual(thirtyDay.captionLabel, "Past 30 days")

        // None of the twelve month names ever leak into a rolling caption —
        // the exact bug this fix addresses: a rolling window's chart must
        // never look like it is labeling MTD (which is always a month name).
        let monthNames = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December",
        ]
        for name in monthNames {
            XCTAssertFalse(sevenDay.captionLabel.contains(name))
            XCTAssertFalse(thirtyDay.captionLabel.contains(name))
        }
    }

    func testClampedCaptionIsHonestNotSilent() {
        let series = RangeSpendSeries.build(
            response: response([("2026-08-01", 3.0)]), timeframe: .rolling(days: 365), isClamped: true
        )
        XCTAssertEqual(series.captionLabel, "Past 12 months · last 92 days shown")
    }

    /// `RangeSpendSeries` has no projection field at all (unlike `SpendPace`,
    /// which carries `.projection`) — a range chart literally cannot render
    /// one. This locks that shape in.
    func testRangeSpendPointHasNoProjectionConcept() {
        let point = RangeSpendPoint(day: Date(), value: 10)
        // Only `day` and `value` exist — there is nothing "projected" to read.
        XCTAssertEqual(point.value, 10)
    }

    // MARK: - TimeframeOption.dailyRollupWindow (92-day server clamp)

    func testDailyRollupWindowRollingUnclamped() {
        let reference = ISO8601DateParser.date(from: "2026-08-15T12:00:00.000Z")!
        let window = TimeframeOption.rolling(days: 7).dailyRollupWindow(referenceDate: reference)
        XCTAssertFalse(window.isClamped)
        XCTAssertEqual(RangeSpendSeries.dayFormatter.string(from: window.to), "2026-08-15")
        XCTAssertEqual(RangeSpendSeries.dayFormatter.string(from: window.from), "2026-08-09")
    }

    func testDailyRollupWindowRollingClampedPast92Days() {
        let reference = ISO8601DateParser.date(from: "2026-08-15T12:00:00.000Z")!
        let window = TimeframeOption.rolling(days: 365).dailyRollupWindow(referenceDate: reference)
        XCTAssertTrue(window.isClamped)
        let spanDays = utcCalendar.dateComponents([.day], from: window.from, to: window.to).day ?? -1
        XCTAssertEqual(spanDays, 91) // 92 inclusive days
    }

    func testDailyRollupWindowCalendarMonthNeverClamped() {
        let window = TimeframeOption.calendarMonth(year: 2026, month: 8).dailyRollupWindow()
        XCTAssertFalse(window.isClamped)
        XCTAssertEqual(RangeSpendSeries.dayFormatter.string(from: window.from), "2026-08-01")
        XCTAssertEqual(RangeSpendSeries.dayFormatter.string(from: window.to), "2026-08-31")
    }

    func testDailyRollupWindowPastCalendarYearIsClampedToItsOwnTrailingDays() {
        // A fully past year clamps to its own last 92 days, unaffected by "today".
        let reference = ISO8601DateParser.date(from: "2026-08-15T12:00:00.000Z")!
        let window = TimeframeOption.calendarYear(year: 2025).dailyRollupWindow(referenceDate: reference)
        XCTAssertTrue(window.isClamped)
        XCTAssertEqual(RangeSpendSeries.dayFormatter.string(from: window.to), "2025-12-31")
    }

    func testDailyRollupWindowInProgressCalendarYearNeverQueriesPastToday() {
        // Selecting the CURRENT (in-progress) year must not clamp to
        // Dec 31 of a year that hasn't happened yet — that would query only
        // future dates and come back empty despite real spend earlier in
        // the year. It must bound "to" at today instead.
        let reference = ISO8601DateParser.date(from: "2026-08-15T12:00:00.000Z")!
        let window = TimeframeOption.calendarYear(year: 2026).dailyRollupWindow(referenceDate: reference)
        XCTAssertTrue(window.isClamped)
        XCTAssertEqual(RangeSpendSeries.dayFormatter.string(from: window.to), "2026-08-15")
    }
}
