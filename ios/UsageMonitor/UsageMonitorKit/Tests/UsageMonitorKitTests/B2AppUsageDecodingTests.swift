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
    }
}
