import Foundation
import XCTest
@testable import QuotaCore

final class LocalQuotaSnapshotTests: XCTestCase {
    func testWritesVersionedPrivateSnapshotAndRemovesWhenDisabled() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("quota-windows.json")
        let window = QuotaWindow(id: "a", provider: "openai", label: "5h", remainingPercent: 0, occurredAt: "2026-09-13T08:00:00Z")
        try LocalQuotaSnapshot.write(windows: [window], to: url)
        let payload = try JSONDecoder().decode(LocalQuotaSnapshot.Payload.self, from: Data(contentsOf: url))
        XCTAssertEqual(payload.format, "usage-monitor-local-quotas")
        XCTAssertEqual(payload.version, 1)
        XCTAssertEqual(payload.windows, [window])
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        try LocalQuotaSnapshot.remove(at: url)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
}
