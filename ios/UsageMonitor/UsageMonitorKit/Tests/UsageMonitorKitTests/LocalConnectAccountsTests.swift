import XCTest
@testable import LocalDataPlane
@testable import LocalStore
@testable import LocalSecrets
@testable import LocalAdapters
@testable import LocalBudget

@MainActor
final class LocalConnectAccountsTests: XCTestCase {
    func testAddFromCatalogOnExistingShellAttachesKeyAndActivates() async throws {
        let store = SQLiteLocalStore.inMemory()
        let secrets = InMemoryProviderSecrets()
        let model = LocalAppModel(store: store, secrets: secrets)
        try await store.open()
        _ = try await model.ensureCatalogProviders()

        let openrouter = try XCTUnwrap(LocalProviderCatalog.entry(name: "openrouter"))
        let storedProviders = try await store.listProviders()
        let before = try XCTUnwrap(storedProviders.first { $0.name == "openrouter" })
        XCTAssertTrue(before.needsKey)
        XCTAssertFalse(before.isActive)

        try await model.addFromCatalog(
            entry: openrouter,
            displayName: nil,
            apiKey: "sk-or-test",
            monthlyBudgetUsd: 25,
            subscriptionCostUsd: nil,
            subscriptionName: nil
        )

        let after = try XCTUnwrap(model.providers.first { $0.name == "openrouter" })
        XCTAssertFalse(after.needsKey)
        XCTAssertTrue(after.canFetch)
        XCTAssertTrue(after.isActive)
        XCTAssertEqual(after.id, before.id)
        let creds = try XCTUnwrap(try secrets.load(accountId: try XCTUnwrap(after.keychainAccountId)))
        XCTAssertEqual(creds.apiKey, "sk-or-test")
    }

    func testConnectAndDisconnectCredentials() async throws {
        let store = SQLiteLocalStore.inMemory()
        let secrets = InMemoryProviderSecrets()
        let model = LocalAppModel(store: store, secrets: secrets)
        try await store.open()
        _ = try await model.ensureCatalogProviders()
        let provider = try XCTUnwrap(model.providers.first { $0.name == "openai" })
        XCTAssertTrue(model.pollableProvidersNeedingKey.contains { $0.id == provider.id })

        try await model.connectCredentials(providerId: provider.id, apiKey: "sk-openai-test")
        let connected = try XCTUnwrap(model.providers.first { $0.id == provider.id })
        XCTAssertTrue(connected.canFetch)
        XCTAssertTrue(connected.isActive)
        XCTAssertTrue(model.pollableProvidersNeedingKey.allSatisfy { $0.id != provider.id })

        try await model.disconnectCredentials(providerId: provider.id)
        let disconnected = try XCTUnwrap(model.providers.first { $0.id == provider.id })
        XCTAssertTrue(disconnected.needsKey)
        XCTAssertFalse(disconnected.isActive)
        XCTAssertNil(disconnected.keychainAccountId)
    }

    func testAddFromCatalogExistingWithoutKeyDoesNotConflict() async throws {
        let store = SQLiteLocalStore.inMemory()
        let model = LocalAppModel(store: store, secrets: InMemoryProviderSecrets())
        try await store.open()
        _ = try await model.ensureCatalogProviders()
        let vercel = try XCTUnwrap(LocalProviderCatalog.entry(name: "vercel"))

        try await model.addFromCatalog(
            entry: vercel,
            displayName: "Vercel Prod",
            apiKey: nil,
            monthlyBudgetUsd: 20,
            subscriptionCostUsd: 20,
            subscriptionName: "Vercel Pro"
        )

        let row = try XCTUnwrap(model.providers.first { $0.name == "vercel" })
        XCTAssertEqual(row.displayName, "Vercel Prod")
        XCTAssertTrue(row.isActive)
        XCTAssertEqual(model.subscriptions.first { $0.providerId == row.id }?.costUsd, 20)
    }

    func testNeedsKeyAlertSummarizesManyShells() {
        let shells = (0..<4).map { i in
            LocalProvider(
                name: "p\(i)",
                displayName: "Provider \(i)",
                adapterKind: "openai",
                isActive: false
            )
        }
        let items = LocalAlertBuilder.build(
            summary: .empty,
            providers: shells,
            projects: []
        )
        XCTAssertEqual(items.filter { $0.id == "needs-key-many" }.count, 1)
        XCTAssertTrue(items.contains { $0.message.contains("Connect Account") })
        XCTAssertFalse(items.contains { $0.message.contains("Active toggle") })
    }

    func testEmptyCatalogShellsCannotFetchUntilConnected() async throws {
        let store = SQLiteLocalStore.inMemory()
        let model = LocalAppModel(store: store, secrets: InMemoryProviderSecrets())
        try await store.open()
        _ = try await model.ensureCatalogProviders()

        let pollable = model.providers.filter(\.isPollable)
        XCTAssertFalse(pollable.isEmpty)
        XCTAssertTrue(pollable.allSatisfy { $0.needsKey })
        XCTAssertTrue(pollable.allSatisfy { !$0.canFetch })
        XCTAssertTrue(pollable.allSatisfy { !$0.isActive })
    }
}

private extension BudgetEngine.Summary {
    static var empty: BudgetEngine.Summary {
        BudgetEngine.compute(
            providers: [],
            plans: [:],
            snapshots: [],
            subscriptions: [],
            charges: []
        )
    }
}

private final class InMemoryProviderSecrets: ProviderSecretStoring, @unchecked Sendable {
    private var map: [String: ProviderCredentials] = [:]
    func save(accountId: String, credentials: ProviderCredentials) throws {
        map[accountId] = credentials
    }
    func load(accountId: String) throws -> ProviderCredentials? { map[accountId] }
    func delete(accountId: String) throws { map[accountId] = nil }
}
