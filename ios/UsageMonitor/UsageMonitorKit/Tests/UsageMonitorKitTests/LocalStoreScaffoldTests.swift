import XCTest
@testable import LocalStore
@testable import LocalBudget
@testable import LocalDataPlane
@testable import LocalAdapters
@testable import LocalSecrets

final class LocalStoreScaffoldTests: XCTestCase {
    func testMigrationAppliesSchemaV1() async throws {
        let store = SQLiteLocalStore.inMemory()
        try await store.open()
        let version = await store.schemaVersion
        XCTAssertEqual(version, 1)

        let p = LocalProvider(name: "openrouter", displayName: "OpenRouter", adapterKind: "openrouter")
        try await store.upsertProvider(p)
        let listed = try await store.listProviders()
        XCTAssertEqual(listed.count, 1)
        XCTAssertEqual(listed[0].name, "openrouter")

        try await store.upsertPlan(LocalProviderPlan(providerId: p.id, monthlyBudgetUsd: 50))
        let plan = try await store.getPlan(providerId: p.id)
        XCTAssertEqual(plan?.monthlyBudgetUsd, 50)

        try await store.insertSnapshot(
            LocalUsageSnapshot(
                providerId: p.id,
                totalCost: 12.5,
                costWindowStart: BudgetEngine.utcMonthStart(),
                costScope: "calendar_month_to_date"
            )
        )
        let snaps = try await store.listSnapshots(providerId: p.id)
        XCTAssertEqual(snaps.count, 1)
        XCTAssertEqual(snaps[0].totalCost, 12.5)
    }

    func testWipeClearsRows() async throws {
        let store = SQLiteLocalStore.inMemory()
        try await store.open()
        let p = LocalProvider(name: "x", displayName: "X", adapterKind: "subscription_only")
        try await store.upsertProvider(p)
        try await store.wipeAll()
        let listed = try await store.listProviders()
        XCTAssertTrue(listed.isEmpty)
        let version = await store.schemaVersion
        XCTAssertEqual(version, 1)
    }
}

final class BudgetEngineTests: XCTestCase {
    func testGoldenVectors() {
        let monthStart = BudgetEngine.utcMonthStart()
        let provider = LocalProvider(
            id: "p1",
            name: "or",
            displayName: "OpenRouter",
            adapterKind: "openrouter"
        )
        let plan = LocalProviderPlan(providerId: "p1", fixedMonthlyCostUsd: nil, monthlyBudgetUsd: 100)

        // 1. Prefer calendar_month_to_date
        let cal = LocalUsageSnapshot(
            providerId: "p1",
            fetchedAt: monthStart.addingTimeInterval(86400),
            totalCost: 20,
            fixedCostIncludedUsd: 5,
            costWindowStart: monthStart,
            costScope: "calendar_month_to_date"
        )
        let unk = LocalUsageSnapshot(
            providerId: "p1",
            fetchedAt: monthStart.addingTimeInterval(90000),
            totalCost: 99,
            costScope: "unknown"
        )
        let billing = LocalUsageSnapshot(
            providerId: "p1",
            fetchedAt: monthStart.addingTimeInterval(91000),
            totalCost: 500,
            costScope: "billing_cycle_to_date"
        )

        var summary = BudgetEngine.compute(
            providers: [provider],
            plans: ["p1": plan],
            snapshots: [cal, unk, billing],
            subscriptions: [],
            charges: []
        )
        // poll = 20 - 5 = 15; billing_cycle ignored
        XCTAssertEqual(summary.providers[0].pollVariableUsd, 15, accuracy: 0.001)
        XCTAssertEqual(summary.providers[0].spentUsd, 15, accuracy: 0.001)

        // 2. Unknown only if fetched in month
        let oldUnknown = LocalUsageSnapshot(
            providerId: "p1",
            fetchedAt: monthStart.addingTimeInterval(-86400),
            totalCost: 40,
            costScope: "unknown"
        )
        summary = BudgetEngine.compute(
            providers: [provider],
            plans: ["p1": plan],
            snapshots: [oldUnknown],
            subscriptions: [],
            charges: []
        )
        XCTAssertEqual(summary.providers[0].pollVariableUsd, 0, accuracy: 0.001)

        // 3. Plan fixed suppressed when active subscription
        let planWithFixed = LocalProviderPlan(
            providerId: "p1",
            fixedMonthlyCostUsd: 10,
            monthlyBudgetUsd: 100
        )
        let sub = LocalSubscription(
            providerId: "p1",
            name: "Plan",
            costUsd: 10,
            status: "active"
        )
        let charge = LocalSubscriptionCharge(
            subscriptionId: sub.id,
            providerId: "p1",
            periodStart: monthStart,
            periodEnd: BudgetEngine.nextUtcMonth(after: monthStart),
            costUsd: 10
        )
        summary = BudgetEngine.compute(
            providers: [provider],
            plans: ["p1": planWithFixed],
            snapshots: [],
            subscriptions: [sub],
            charges: [charge]
        )
        XCTAssertEqual(summary.providers[0].planFixedUsd, 0, accuracy: 0.001)
        XCTAssertEqual(summary.providers[0].subscriptionChargesUsd, 10, accuracy: 0.001)
        XCTAssertEqual(summary.providers[0].spentUsd, 10, accuracy: 0.001)

        // 4. Plan fixed alone
        summary = BudgetEngine.compute(
            providers: [provider],
            plans: ["p1": planWithFixed],
            snapshots: [],
            subscriptions: [],
            charges: []
        )
        XCTAssertEqual(summary.providers[0].planFixedUsd, 10, accuracy: 0.001)
        XCTAssertEqual(summary.providers[0].spentUsd, 10, accuracy: 0.001)
    }

    func testPeriodAdvanceMonthly() {
        let start = ISO8601DateFormatter().date(from: "2026-01-15T00:00:00Z")!
        let next = SubscriptionPeriodMath.advancePeriod(
            periodStart: start,
            interval: "monthly",
            intervalCount: 1
        )
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0)!
        XCTAssertEqual(cal.component(.month, from: next), 2)
        XCTAssertEqual(cal.component(.day, from: next), 15)
    }
}

@MainActor
final class LocalSeedTruthTests: XCTestCase {
    func testSeedNeverInventspaidSubscriptions() async throws {
        let store = SQLiteLocalStore.inMemory()
        let model = LocalAppModel(store: store, secrets: InMemoryProviderSecrets())
        try await store.open()
        let added = try await model.seedMissingCatalogProviders()
        XCTAssertGreaterThan(added, 10)

        let subs = try await store.listSubscriptions()
        XCTAssertTrue(subs.isEmpty, "Seed must not create subscriptions")
        let charges = try await store.allCharges()
        XCTAssertTrue(charges.isEmpty, "Seed must not materialize charges")

        let providers = try await store.listProviders()
        XCTAssertTrue(providers.allSatisfy { !$0.isActive }, "Seed shells must be inactive")
        XCTAssertNotNil(providers.first { $0.name == "vercel" })
        XCTAssertNotNil(providers.first { $0.name == "cloudflare" })
        XCTAssertNotNil(providers.first { $0.name == "robinhood" })
    }

    func testScrubRemovesSeedGhostChargesOnly() async throws {
        let store = SQLiteLocalStore.inMemory()
        let model = LocalAppModel(store: store, secrets: InMemoryProviderSecrets())
        try await store.open()

        let vercel = LocalProvider(
            name: "vercel",
            displayName: "Vercel",
            adapterKind: "subscription_only",
            isActive: true
        )
        try await store.upsertProvider(vercel)
        let ghost = LocalSubscription(
            providerId: vercel.id,
            name: "Vercel Pro",
            costUsd: 20,
            status: "active"
        )
        try await store.upsertSubscription(ghost)
        let monthStart = BudgetEngine.utcMonthStart()
        try await store.insertCharge(
            LocalSubscriptionCharge(
                subscriptionId: ghost.id,
                providerId: vercel.id,
                periodStart: monthStart,
                periodEnd: BudgetEngine.nextUtcMonth(after: monthStart),
                costUsd: 20
            )
        )

        let cursor = LocalProvider(
            name: "cursor",
            displayName: "Cursor",
            adapterKind: "subscription_only"
        )
        try await store.upsertProvider(cursor)
        let intentional = LocalSubscription(
            providerId: cursor.id,
            name: "Cursor Team",
            costUsd: 40,
            status: "active"
        )
        try await store.upsertSubscription(intentional)
        try await store.insertCharge(
            LocalSubscriptionCharge(
                subscriptionId: intentional.id,
                providerId: cursor.id,
                periodStart: monthStart,
                periodEnd: BudgetEngine.nextUtcMonth(after: monthStart),
                costUsd: 40
            )
        )

        let scrubbed = try await model.scrubCatalogGuessCharges()
        XCTAssertEqual(scrubbed, 1)

        let subs = try await store.listSubscriptions()
        let vercelSub = try XCTUnwrap(subs.first { $0.providerId == vercel.id })
        XCTAssertEqual(vercelSub.status, "canceled")
        let cursorSub = try XCTUnwrap(subs.first { $0.providerId == cursor.id })
        XCTAssertEqual(cursorSub.status, "active")

        let charges = try await store.allCharges()
        XCTAssertEqual(charges.count, 1)
        XCTAssertEqual(charges[0].subscriptionId, intentional.id)
    }

    func testCatalogHintsDoNotDefaultBrokerageOrUnusedHosting() {
        XCTAssertNil(LocalProviderCatalog.entry(name: "robinhood")?.suggestedMonthlyUsd)
        XCTAssertNil(LocalProviderCatalog.entry(name: "vercel")?.suggestedMonthlyUsd)
        XCTAssertNil(LocalProviderCatalog.entry(name: "cloudflare")?.suggestedMonthlyUsd)
    }

    func testCatalogNamingAndConnectionAbilities() throws {
        // OpenAI API vs ChatGPT subscription (parity with Claude split).
        XCTAssertEqual(LocalProviderCatalog.entry(name: "openai")?.displayName, "OpenAI (API)")
        XCTAssertEqual(LocalProviderCatalog.entry(name: "openai-chatgpt-sub")?.displayName, "ChatGPT (subscription)")
        XCTAssertEqual(LocalProviderCatalog.entry(name: "anthropic-claude-sub")?.displayName, "Claude (subscription)")
        // xAI is the API product — no "/ Grok" on the label; SuperGrok is separate.
        XCTAssertEqual(LocalProviderCatalog.entry(name: "xai")?.displayName, "xAI")
        XCTAssertFalse(LocalProviderCatalog.entry(name: "xai")!.displayName.contains("Grok"))
        XCTAssertEqual(LocalProviderCatalog.entry(name: "xai-supergrok-sub")?.displayName, "SuperGrok (subscription)")
        XCTAssertEqual(LocalProviderCatalog.entry(name: "custom")?.displayName, "Custom / Other")

        // User-facing summary never exposes internal adapterKind "subscription_only".
        for entry in LocalProviderCatalog.all {
            XCTAssertFalse(
                entry.connectionSummary.lowercased().contains("subscription_only"),
                "\(entry.name) leaked subscription_only into UI"
            )
            XCTAssertFalse(entry.abilities.isEmpty, "\(entry.name) needs abilities")
        }

        // Pollable adapters surface poll ability chips.
        let openrouter = try XCTUnwrap(LocalProviderCatalog.entry(name: "openrouter"))
        XCTAssertTrue(openrouter.abilities.contains(.pollCost))
        XCTAssertTrue(openrouter.isPhonePollable)
    }

    func testEnsureCatalogIsIdempotentAndAddsChatGPT() async throws {
        let store = SQLiteLocalStore.inMemory()
        let model = LocalAppModel(store: store, secrets: InMemoryProviderSecrets())
        try await store.open()
        let first = try await model.ensureCatalogProviders()
        let second = try await model.ensureCatalogProviders()
        XCTAssertGreaterThan(first, 10)
        XCTAssertEqual(second, 0, "Second ensure must not duplicate")
        // Hoisted out of the XCTUnwrap below: its autoclosure is neither async
        // nor actor-isolated, so `try await store.listProviders()` inline could
        // not compile.  Reading once also stops the two assertions below from
        // querying the actor twice for the same snapshot.
        let providers = try await store.listProviders()
        let names = Set(providers.map(\.name))
        XCTAssertTrue(names.contains("openai-chatgpt-sub"))
        XCTAssertTrue(names.contains("xai-supergrok-sub"))
        let xai = try XCTUnwrap(providers.first { $0.name == "xai" })
        XCTAssertEqual(xai.displayName, "xAI")
        XCTAssertEqual(xai.adapterKind, "xai")
    }
}

/// Test double — no Keychain.
private final class InMemoryProviderSecrets: ProviderSecretStoring, @unchecked Sendable {
    private var map: [String: ProviderCredentials] = [:]
    func save(accountId: String, credentials: ProviderCredentials) throws {
        map[accountId] = credentials
    }
    func load(accountId: String) throws -> ProviderCredentials? { map[accountId] }
    func delete(accountId: String) throws { map[accountId] = nil }
}
