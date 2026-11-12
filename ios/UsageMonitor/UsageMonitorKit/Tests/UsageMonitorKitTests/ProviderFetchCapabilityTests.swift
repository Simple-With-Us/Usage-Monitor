import XCTest
@testable import Models

final class ProviderFetchCapabilityTests: XCTestCase {
    func testManualAndPushTypesCannotFetch() {
        XCTAssertFalse(item(name: "openai", type: "generic").canFetch)
        XCTAssertFalse(item(name: "openai", type: "manual_provider").canFetch)
        XCTAssertFalse(item(name: "voyage", type: "push").canFetch)
        XCTAssertFalse(item(name: "voyage", type: "builtin").canFetch)
        XCTAssertFalse(item(name: "robinhood", type: "builtin").canFetch)
    }

    func testPollableBuiltinCanFetch() {
        XCTAssertTrue(item(name: "openai", type: "builtin").canFetch)
        XCTAssertTrue(item(name: "openrouter", type: "builtin").canFetch)
        XCTAssertTrue(item(name: "custom-proxy", type: "custom").canFetch)
    }

    func testManagedAliasCannotFetch() {
        var p = item(name: "openai", type: "builtin")
        p.credentialManagement = .init(
            source: "infisical",
            scope: "prod",
            label: "openai",
            status: "ok",
            alias: true,
            readOnlyFields: []
        )
        XCTAssertFalse(p.canFetch)
        XCTAssertFalse(p.canDelete)
    }

    private func item(name: String, type: String) -> ProviderManagementItem {
        ProviderManagementItem(
            id: UUID().uuidString,
            name: name,
            displayName: name,
            type: type,
            isActive: true,
            refreshIntervalMin: 60,
            createdAt: "2026-08-01T00:00:00.000Z"
        )
    }
}
