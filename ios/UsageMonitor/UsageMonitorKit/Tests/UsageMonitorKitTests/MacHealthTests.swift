import XCTest
@testable import Models

final class MacHealthTests: XCTestCase {
    func testDecodesOnlineHeartbeatAndSortsProcesses() throws {
        let json = """
        {
          "ok": true,
          "status": "online",
          "lastHeartbeatAt": "2026-08-16T12:00:00.000Z",
          "secondsSinceHeartbeat": 12,
          "mac": {
            "hostname": "jays-macbook-pro",
            "osVersion": "macOS 26.0",
            "arch": "arm64",
            "cpuUsagePct": 24,
            "memoryUsagePct": 61,
            "diskUsagePct": 47,
            "uptimeSeconds": 100,
            "processes": {
              "com.jay.z-last": "stopped",
              "com.jay.agy-acp": "running"
            },
            "lastHeartbeatAt": "2026-08-16T12:00:00.000Z"
          }
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(MacHealthResponse.self, from: json)
        XCTAssertTrue(decoded.ok)
        XCTAssertEqual(decoded.status, "online")
        XCTAssertEqual(decoded.mac?.hostname, "jays-macbook-pro")
        XCTAssertEqual(decoded.mac?.processRows.map(\.name), [
            "com.jay.agy-acp",
            "com.jay.z-last",
        ])
        XCTAssertEqual(decoded.mac?.processRows.last?.status, "stopped")
    }

    func testDecodesOfflineWithoutTelemetry() throws {
        let json = """
        {
          "ok": false,
          "status": "offline",
          "lastHeartbeatAt": null,
          "secondsSinceHeartbeat": null,
          "mac": null
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(MacHealthResponse.self, from: json)
        XCTAssertFalse(decoded.ok)
        XCTAssertEqual(decoded.status, "offline")
        XCTAssertNil(decoded.mac)
    }
}
