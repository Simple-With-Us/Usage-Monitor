import XCTest
@testable import Models

/// Decoding coverage for `GET /api/export/daily-rollups`. The fixture mirrors
/// the full shape the server returns (see
/// `src/app/api/export/daily-rollups/route.ts`) — `DailyRollupRow` only
/// decodes `day` / `totalCostUsd`, so this also proves the extra per-row
/// breakdown fields (groupKey, provider, eventCount, ...) are safely ignored
/// rather than causing a decode failure.
final class DailyRollupsResponseDecodingTests: XCTestCase {
    func testDecodesRolledUpRowsAndSumsPerDay() throws {
        let json = """
        {
          "from": "2026-08-14",
          "to": "2026-08-15",
          "rowCount": 3,
          "truncated": false,
          "rows": [
            {
              "day": "2026-08-14",
              "groupKey": "openrouter:api",
              "sourceApp": "usage-collector",
              "environment": null,
              "provider": "OpenRouter",
              "service": null,
              "label": null,
              "keyRef": null,
              "billingMode": "usage",
              "metricType": "cost",
              "unit": null,
              "limitWindow": null,
              "tier": null,
              "confidence": "high",
              "projectId": null,
              "eventCount": 12,
              "pricedEventCount": 12,
              "unpricedEventCount": 0,
              "unclassifiedCostEventCount": 0,
              "totalCostUsd": 4.5,
              "totalRequests": 12,
              "totalQuantity": 12,
              "totalCredits": 0,
              "maxLimit": null,
              "latestOccurredAt": "2026-08-14T22:00:00.000Z"
            },
            {
              "day": "2026-08-14",
              "groupKey": "anthropic:api",
              "sourceApp": "usage-collector",
              "environment": null,
              "provider": "Anthropic",
              "service": null,
              "label": null,
              "keyRef": null,
              "billingMode": "usage",
              "metricType": "cost",
              "unit": null,
              "limitWindow": null,
              "tier": null,
              "confidence": "high",
              "projectId": null,
              "eventCount": 4,
              "pricedEventCount": 4,
              "unpricedEventCount": 0,
              "unclassifiedCostEventCount": 0,
              "totalCostUsd": 1.25,
              "totalRequests": 4,
              "totalQuantity": 4,
              "totalCredits": 0,
              "maxLimit": null,
              "latestOccurredAt": "2026-08-14T23:00:00.000Z"
            },
            {
              "day": "2026-08-15",
              "groupKey": "openrouter:api",
              "sourceApp": "usage-collector",
              "environment": null,
              "provider": "OpenRouter",
              "service": null,
              "label": null,
              "keyRef": null,
              "billingMode": "usage",
              "metricType": "cost",
              "unit": null,
              "limitWindow": null,
              "tier": null,
              "confidence": "high",
              "projectId": null,
              "eventCount": 6,
              "pricedEventCount": 6,
              "unpricedEventCount": 0,
              "unclassifiedCostEventCount": 0,
              "totalCostUsd": 2.0,
              "totalRequests": 6,
              "totalQuantity": 6,
              "totalCredits": 0,
              "maxLimit": null,
              "latestOccurredAt": "2026-08-15T10:00:00.000Z"
            }
          ]
        }
        """.data(using: .utf8)!

        let response = try JSONDecoder().decode(DailyRollupsResponse.self, from: json)
        XCTAssertEqual(response.from, "2026-08-14")
        XCTAssertEqual(response.to, "2026-08-15")
        XCTAssertEqual(response.rowCount, 3)
        XCTAssertEqual(response.truncated, false)
        XCTAssertEqual(response.rows.count, 3)
        XCTAssertEqual(response.rows[0].day, "2026-08-14")
        XCTAssertEqual(response.rows[0].totalCostUsd, 4.5, accuracy: 0.0001)

        // Two rows share 2026-08-14 (one per groupKey) — callers must sum them.
        let dayOneTotal = response.rows
            .filter { $0.day == "2026-08-14" }
            .reduce(0) { $0 + $1.totalCostUsd }
        XCTAssertEqual(dayOneTotal, 5.75, accuracy: 0.0001)
    }

    func testDecodesEmptyRows() throws {
        let json = """
        { "from": "2026-08-01", "to": "2026-08-01", "rowCount": 0, "truncated": false, "rows": [] }
        """.data(using: .utf8)!
        let response = try JSONDecoder().decode(DailyRollupsResponse.self, from: json)
        XCTAssertTrue(response.rows.isEmpty)
    }
}
