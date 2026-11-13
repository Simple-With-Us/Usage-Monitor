import XCTest
@testable import LocalDataPlane
@testable import LocalStore

final class LocalImportTests: XCTestCase {
    /// Shape produced by GET /api/workspace/export (website Download For Local).
    private func websitePackageJSON() throws -> Data {
        let payload: [String: Any] = [
            "format": "usage-monitor-local-export",
            "formatVersion": 1,
            "source": "usage-monitor-remote",
            "note": "No API keys or secrets.  There is no bundle key for this file.",
            "copyInstructions": "Settings → Import Package.  There is no bundle key.",
            "projects": [
                ["id": "proj-1", "name": "DealDex", "monthlyBudgetUsd": 10.0],
            ],
            "providers": [
                [
                    "id": "prov-1",
                    "name": "openrouter",
                    "displayName": "OpenRouter",
                    "type": "builtin",
                    "adapterKind": "openrouter",
                    "isActive": false,
                ],
            ],
            "plans": [
                ["providerId": "prov-1", "monthlyBudgetUsd": 20.0],
            ],
            "subscriptions": [],
            "charges": [],
            "snapshots": [],
        ]
        return try JSONSerialization.data(withJSONObject: payload)
    }

    func testWebsiteExportShapeImportsWithoutKeys() async throws {
        let store = SQLiteLocalStore.inMemory()
        let result = try await LocalImportBuilder.importPackage(
            data: try websitePackageJSON(),
            store: store,
            mode: .merge
        )
        XCTAssertEqual(result.providers, 1)
        XCTAssertEqual(result.plans, 1)
        XCTAssertEqual(result.projects, 1)
        XCTAssertEqual(result.skipped, 0)

        let providers = try await store.listProviders()
        XCTAssertEqual(providers.count, 1)
        XCTAssertEqual(providers[0].name, "openrouter")
        XCTAssertFalse(providers[0].isActive)
        XCTAssertNil(providers[0].keychainAccountId)
    }

    func testMergeSkipsExistingProvider() async throws {
        let store = SQLiteLocalStore.inMemory()
        let data = try websitePackageJSON()
        _ = try await LocalImportBuilder.importPackage(data: data, store: store, mode: .merge)
        let second = try await LocalImportBuilder.importPackage(data: data, store: store, mode: .merge)
        XCTAssertEqual(second.providers, 0)
        XCTAssertGreaterThanOrEqual(second.skipped, 1)
        let providers = try await store.listProviders()
        XCTAssertEqual(providers.count, 1)
    }

    func testRejectsNonPackageJSON() async throws {
        let data = try JSONSerialization.data(withJSONObject: ["hello": "world"])
        let store = SQLiteLocalStore.inMemory()
        do {
            _ = try await LocalImportBuilder.importPackage(data: data, store: store, mode: .merge)
            XCTFail("expected validation error")
        } catch LocalWriteError.validation(let message) {
            XCTAssertEqual(message, "Unrecognized export format")
        }
    }

    func testResultLineSaysKeysAreMissing() {
        let result = LocalImportResult(
            providers: 2,
            plans: 1,
            subscriptions: 0,
            charges: 0,
            projects: 1,
            snapshots: 0,
            skipped: 0
        )
        XCTAssertTrue(result.summaryLine.contains("Imported 2 providers"))
        XCTAssertTrue(result.summaryLine.contains("Re-enter API keys"))
        XCTAssertTrue(result.summaryLine.contains("not in this file"))
    }
}
