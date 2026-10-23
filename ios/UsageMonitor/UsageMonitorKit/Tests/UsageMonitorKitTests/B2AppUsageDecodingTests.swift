import XCTest
@testable import Models

final class B2AppUsageDecodingTests: XCTestCase {
    func testDecodesMinimalPayload() throws {
        let json = """
        {
          "configured": true,
          "asOf": "2026-08-24T00:00:00.000Z",
          "cacheAgeSeconds": 0,
          "reportDate": "2026-08-23",
          "storageSource": "external_billing",
          "reportSource": "usage_csv",
          "warnings": [],
          "caps": { "classCDailyFree": 2500, "downloadGbDailyFree": 1 },
          "alerts": { "classCNearCap": false, "downloadNearCap": false, "classCSpike": false },
          "apps": [
            {
              "id": "socratic-trade",
              "label": "Socratic.Trade",
              "bucketNames": ["jays-socratic-trade-eu"],
              "storageGb": 150,
              "latestDay": {
                "date": "2026-08-23",
                "storedGb": 150,
                "downloadedGb": 2.5,
                "classCTransactions": 1200,
                "classBTransactions": 40
              }
            }
          ],
          "dailySeries": []
        }
        """.data(using: .utf8)!

        let payload = try JSONDecoder().decode(B2AppUsageBreakdown.self, from: json)
        XCTAssertEqual(payload.apps.count, 1)
        XCTAssertEqual(payload.apps[0].label, "Socratic.Trade")
        XCTAssertEqual(payload.apps[0].storageGb, 150)
        XCTAssertTrue(payload.dailySeries.isEmpty)
    }

    func testDecodesDailySeriesSplitByApp() throws {
        let json = """
        {
          "configured": true,
          "asOf": "2026-10-22T00:00:00.000Z",
          "cacheAgeSeconds": 0,
          "reportDate": "2026-10-21",
          "storageSource": "external_billing",
          "reportSource": "usage_csv",
          "warnings": [],
          "caps": { "classCDailyFree": 2500, "downloadGbDailyFree": 1 },
          "alerts": { "classCNearCap": false, "downloadNearCap": false, "classCSpike": false },
          "apps": [
            {
              "id": "socratic-trade",
              "label": "Socratic.Trade",
              "bucketNames": ["jays-socratic-trade-eu"],
              "storageGb": 150,
              "latestDay": null
            }
          ],
          "dailySeries": [
            {
              "date": "2026-10-21",
              "accountDownloadedGb": 1.0,
              "accountClassCTotal": 1200,
              "byApp": {
                "socratic-trade": { "downloadedGb": 0.6, "classCTransactions": 900 },
                "usage-monitor": { "downloadedGb": 0.4, "classCTransactions": 300 }
              }
            },
            {
              "date": "2026-10-20",
              "accountDownloadedGb": 0.5,
              "accountClassCTotal": 800,
              "byApp": {
                "socratic-trade": { "downloadedGb": 0.5, "classCTransactions": 800 }
              }
            }
          ]
        }
        """.data(using: .utf8)!

        let payload = try JSONDecoder().decode(B2AppUsageBreakdown.self, from: json)
        XCTAssertEqual(payload.dailySeries.count, 2)

        let newest = payload.dailySeries[0]
        XCTAssertEqual(newest.date, "2026-10-21")
        XCTAssertEqual(newest.id, "2026-10-21")
        XCTAssertEqual(newest.accountDownloadedGb, 1.0)
        XCTAssertEqual(newest.accountClassCTotal, 1200)
        XCTAssertEqual(newest.byApp.count, 2)
        XCTAssertEqual(newest.byApp["socratic-trade"]?.downloadedGb, 0.6)
        XCTAssertEqual(newest.byApp["socratic-trade"]?.classCTransactions, 900)
        XCTAssertEqual(newest.byApp["usage-monitor"]?.downloadedGb, 0.4)
        XCTAssertEqual(newest.byApp["usage-monitor"]?.classCTransactions, 300)

        let older = payload.dailySeries[1]
        XCTAssertEqual(older.date, "2026-10-20")
        XCTAssertEqual(older.byApp.count, 1)
        XCTAssertEqual(older.byApp["socratic-trade"]?.classCTransactions, 800)
    }

    func testMissingDailySeriesDecodesAsEmpty() throws {
        let json = """
        {
          "configured": true,
          "asOf": "2026-08-24T00:00:00.000Z",
          "cacheAgeSeconds": 0,
          "reportDate": "2026-08-23",
          "storageSource": "external_billing",
          "reportSource": "usage_csv",
          "warnings": [],
          "caps": { "classCDailyFree": 2500, "downloadGbDailyFree": 1 },
          "alerts": { "classCNearCap": false, "downloadNearCap": false, "classCSpike": false },
          "apps": []
        }
        """.data(using: .utf8)!

        let payload = try JSONDecoder().decode(B2AppUsageBreakdown.self, from: json)
        XCTAssertTrue(payload.dailySeries.isEmpty)
    }

    func testDailySeriesToleratesFractionalAndMissingFields() throws {
        let json = """
        {
          "configured": true,
          "asOf": "2026-10-22T00:00:00.000Z",
          "cacheAgeSeconds": 0,
          "reportDate": "2026-10-21",
          "storageSource": "external_billing",
          "reportSource": "usage_csv",
          "warnings": [],
          "caps": { "classCDailyFree": 2500, "downloadGbDailyFree": 1 },
          "alerts": { "classCNearCap": false, "downloadNearCap": false, "classCSpike": false },
          "apps": [],
          "dailySeries": [
            {
              "date": "2026-10-21",
              "accountClassCTotal": 1200.6,
              "byApp": {
                "socratic-trade": { "downloadedGb": 0.6, "classCTransactions": 900.4 },
                "usage-monitor": {}
              }
            }
          ]
        }
        """.data(using: .utf8)!

        let payload = try JSONDecoder().decode(B2AppUsageBreakdown.self, from: json)
        XCTAssertEqual(payload.dailySeries.count, 1)
        let day = payload.dailySeries[0]
        XCTAssertEqual(day.accountClassCTotal, 1201)
        XCTAssertEqual(day.accountDownloadedGb, 0)
        XCTAssertEqual(day.byApp["socratic-trade"]?.classCTransactions, 900)
        XCTAssertEqual(day.byApp["usage-monitor"]?.downloadedGb, 0)
        XCTAssertEqual(day.byApp["usage-monitor"]?.classCTransactions, 0)
    }
}
