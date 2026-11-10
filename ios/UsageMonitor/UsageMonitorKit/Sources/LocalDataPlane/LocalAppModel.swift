import Foundation
import Observation
import LocalStore
import LocalSecrets
import LocalAdapters
import LocalBudget

/// Orchestrates Local store, polls, materializer, and BudgetEngine.
@MainActor
@Observable
public final class LocalAppModel {
    public private(set) var isReady = false
    public private(set) var schemaVersion = 0
    public private(set) var summary: BudgetEngine.Summary?
    public private(set) var providers: [LocalProvider] = []
    public private(set) var subscriptions: [LocalSubscription] = []
    public private(set) var projects: [LocalProject] = []
    public private(set) var alerts: [LocalAlertItem] = []
    public private(set) var lastError: String?
    public private(set) var isRefreshing = false
    public private(set) var lastMaterializedCharges = 0

    public let store: SQLiteLocalStore
    public let secrets: ProviderSecretStoring

    public init(
        store: SQLiteLocalStore = .shared,
        secrets: ProviderSecretStoring = ProviderKeychainStore.shared
    ) {
        self.store = store
        self.secrets = secrets
    }

    public func bootstrap() async {
        do {
            // No carry-over from earlier bundle IDs: the pre-rename Local app
            // kept `local.sqlite` in its own sandbox, which a renamed app
            // cannot read, and its Keychain provider keys do not follow either.
            // A renamed install starts fresh (testers re-add providers).  See
            // `docs/rollouts/2026-09-23-usage-identifier-fixes.md`.
            try await store.open()
            schemaVersion = await store.schemaVersion
            // Heal seed-invented catalog-guess fees before materialize.
            _ = try await scrubCatalogGuessCharges(reloadAfter: false)
            // Ensure every catalog service exists as a durable local row (SQLite
            // in app container — survives app updates; never ships secrets).
            _ = try await ensureCatalogProviders(reloadAfter: false)
            // App Store screenshot capture only (`-ScreenshotDemo` launch arg).
            // Never block first paint if demo seed fails.
            if LocalScreenshotDemoSeeder.isEnabled {
                do {
                    try await LocalScreenshotDemoSeeder.seedIfNeeded(store: store)
                } catch {
                    lastError = "Screenshot demo seed: \(error.localizedDescription)"
                }
            }
            lastMaterializedCharges = try await SubscriptionMaterializer.materialize(store: store)
            try await reload()
            isReady = true
        } catch {
            lastError = error.localizedDescription
        }
    }

    public func reload() async throws {
        providers = try await store.listProviders()
        subscriptions = try await store.listSubscriptions()
        projects = try await store.listProjects()
        let plans = try await loadPlans()
        let snaps = try await store.allSnapshots()
        let charges = try await store.allCharges()
        let computed = BudgetEngine.compute(
            providers: providers,
            plans: plans,
            snapshots: snaps,
            subscriptions: subscriptions,
            charges: charges
        )
        summary = computed
        alerts = LocalAlertBuilder.build(
            summary: computed,
            providers: providers,
            projects: projects
        )
        LocalWidgetSnapshotWriter.write(from: computed)
        lastError = nil
    }

    public func importPackage(data: Data, mode: LocalImportMode) async throws -> LocalImportResult {
        let result = try await LocalImportBuilder.importPackage(data: data, store: store, mode: mode)
        _ = try await SubscriptionMaterializer.materialize(store: store)
        try await reload()
        return result
    }

    private func loadPlans() async throws -> [String: LocalProviderPlan] {
        var map: [String: LocalProviderPlan] = [:]
        for p in try await store.listProviders() {
            if let plan = try await store.getPlan(providerId: p.id) {
                map[p.id] = plan
            }
        }
        return map
    }

    // MARK: - CRUD

    /// Add from fleet catalog (poll key and/or subscription).
    public func addFromCatalog(
        entry: LocalProviderCatalogEntry,
        displayName: String?,
        apiKey: String?,
        monthlyBudgetUsd: Double?,
        subscriptionCostUsd: Double?,
        subscriptionName: String?,
        teamId: String? = nil,
        accountSid: String? = nil,
        apiKeySid: String? = nil
    ) async throws {
        let name = entry.name
        let existing = try await store.listProviders()
        if var existingProvider = existing.first(where: { $0.name == name }) {
            try await applyCatalogConnection(
                to: &existingProvider,
                entry: entry,
                displayName: displayName,
                apiKey: apiKey,
                monthlyBudgetUsd: monthlyBudgetUsd,
                subscriptionCostUsd: subscriptionCostUsd,
                subscriptionName: subscriptionName,
                teamId: teamId,
                accountSid: accountSid,
                apiKeySid: apiKeySid
            )
            return
        }

        let credentials = try Self.validatedCredentials(
            entry: entry,
            apiKey: apiKey,
            teamId: teamId,
            accountSid: accountSid,
            apiKeySid: apiKeySid
        )
        var keychainAccountId: String?
        if let credentials {
            let accountId = UUID().uuidString
            try secrets.save(accountId: accountId, credentials: credentials)
            keychainAccountId = accountId
        }

        let storeKind = Self.storeAdapterKind(for: entry)

        var p = LocalProvider(
            name: name,
            displayName: (displayName?.isEmpty == false ? displayName! : entry.displayName),
            adapterKind: storeKind,
            category: entry.category,
            keychainAccountId: keychainAccountId,
            nonSecretConfigJSON: Self.connectionProfileJSON(for: entry)
        )
        p.updatedAt = Date()
        try await store.upsertProvider(p)
        var plan = LocalProviderPlan(providerId: p.id, monthlyBudgetUsd: monthlyBudgetUsd)
        plan.updatedAt = Date()
        try await store.upsertPlan(plan)

        // Catalog `suggestedMonthlyUsd` is UI prefill only. Never fall back to it
        // here — seed used to invent fake MTD charges (Vercel Pro $20, Workers $5,
        // Robinhood Gold $5). Only an explicit cost from Add → Save creates a sub.
        if let explicitCost = subscriptionCostUsd {
            try await attachSubscription(
                providerId: p.id,
                name: subscriptionName
                    ?? entry.suggestedSubscriptionName
                    ?? "\(entry.displayName) plan",
                costUsd: max(0, explicitCost)
            )
        }

        try await reload()
    }

    /// Single source of per-adapter credential rules for the Add form and the
    /// key-bundle importer (xai needs teamId, twilio needs Account SID, poll
    /// mode needs a key).  Returns nil when the entry takes no key (fee-only)
    /// or none was provided.  Never includes secret values in errors.
    private static func validatedCredentials(
        entry: LocalProviderCatalogEntry,
        apiKey: String?,
        teamId: String?,
        accountSid: String?,
        apiKeySid: String?
    ) throws -> ProviderCredentials? {
        let trimmedKey = apiKey?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if entry.mode == .poll && trimmedKey.isEmpty {
            throw LocalWriteError.validation("API key required for \(entry.displayName)")
        }
        if entry.adapterKind == "xai", (teamId ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw LocalWriteError.validation("xAI requires Management API team id")
        }
        if entry.adapterKind == "twilio", (accountSid ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw LocalWriteError.validation("Twilio requires Account SID")
        }
        let needsKey = entry.mode == .poll || (entry.mode == .keyPlusSubscription && !trimmedKey.isEmpty)
        guard needsKey, !trimmedKey.isEmpty else { return nil }
        return ProviderCredentials(
            apiKey: trimmedKey,
            teamId: teamId?.trimmingCharacters(in: .whitespacesAndNewlines),
            accountSid: accountSid?.trimmingCharacters(in: .whitespacesAndNewlines),
            apiKeySid: apiKeySid?.trimmingCharacters(in: .whitespacesAndNewlines)
        )
    }

    /// Adapter kind to store for a catalog entry — catalog-resolved poll kind
    /// when the phone can poll; fee-only otherwise.  If no phone poll yet,
    /// still store the product adapter kind when known so future poll ports
    /// activate without re-adding — but never pretend we can fetch.
    private static func storeAdapterKind(for entry: LocalProviderCatalogEntry) -> String {
        if entry.isPhonePollable { return entry.resolvedAdapterKind }
        if entry.mode == .subscription { return "subscription_only" }
        // keyPlus / server-only: keep slug for identity, mark non-pollable kinds as fee-only for fetch gates
        return LocalProviderCatalogEntry.phonePollAdapterKinds.contains(entry.adapterKind)
            ? entry.adapterKind
            : "subscription_only"
    }

    /// Key-bundle import connect path.  Reuses the Add-provider rules
    /// (validation, Keychain write, keychainAccountId linking, adapter-kind
    /// resolution) so imported keys behave exactly like keys typed into the
    /// Add form.  Existing credentials are replaced and the superseded
    /// Keychain account is deleted — never orphaned.  Returns true when an
    /// existing credential was replaced.
    @discardableResult
    public func connectImportedCredentials(
        entry: LocalProviderCatalogEntry,
        apiKey: String,
        teamId: String? = nil,
        accountSid: String? = nil,
        apiKeySid: String? = nil
    ) async throws -> Bool {
        guard var provider = try await store.listProviders().first(where: { $0.name == entry.name }) else {
            try await addFromCatalog(
                entry: entry,
                displayName: nil,
                apiKey: apiKey,
                monthlyBudgetUsd: nil,
                subscriptionCostUsd: nil,
                subscriptionName: nil,
                teamId: teamId,
                accountSid: accountSid,
                apiKeySid: apiKeySid
            )
            return false
        }
        guard let credentials = try Self.validatedCredentials(
            entry: entry,
            apiKey: apiKey,
            teamId: teamId,
            accountSid: accountSid,
            apiKeySid: apiKeySid
        ) else {
            throw LocalWriteError.validation("\(entry.displayName) does not take an API key on this phone")
        }
        let replaced = provider.keychainAccountId != nil
        try await replaceKeychainAccount(
            on: &provider,
            credentials: credentials,
            adapterKind: Self.storeAdapterKind(for: entry),
            activate: true
        )
        try await reload()
        return replaced
    }

    /// Attach or replace a credential on an existing provider card.
    /// Activates fetch so the next refresh can run.
    public func connectCredentials(
        providerId: String,
        apiKey: String,
        teamId: String? = nil,
        accountSid: String? = nil,
        apiKeySid: String? = nil
    ) async throws {
        guard var provider = try await store.getProvider(id: providerId) else {
            throw LocalWriteError.notFound("Provider not found")
        }
        guard let entry = LocalProviderCatalog.entry(name: provider.name) else {
            throw LocalWriteError.validation("Unknown provider — cannot validate a key on this phone")
        }
        guard let credentials = try Self.validatedCredentials(
            entry: entry,
            apiKey: apiKey,
            teamId: teamId,
            accountSid: accountSid,
            apiKeySid: apiKeySid
        ) else {
            throw LocalWriteError.validation("\(entry.displayName) does not take an API key on this phone")
        }
        try await replaceKeychainAccount(
            on: &provider,
            credentials: credentials,
            adapterKind: Self.storeAdapterKind(for: entry),
            activate: true
        )
        try await reload()
    }

    /// Remove the stored key. Deactivates polling so refresh does not fail-loop.
    public func disconnectCredentials(providerId: String) async throws {
        guard var provider = try await store.getProvider(id: providerId) else {
            throw LocalWriteError.notFound("Provider not found")
        }
        if let superseded = provider.keychainAccountId {
            try? secrets.delete(accountId: superseded)
        }
        provider.keychainAccountId = nil
        provider.isActive = false
        provider.updatedAt = Date()
        try await store.upsertProvider(provider)
        try await reload()
    }

    /// Pollable catalog rows that still have no Keychain credential.
    public var pollableProvidersNeedingKey: [LocalProvider] {
        providers.filter(\.needsKey).sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
    }

    /// Update an existing catalog shell (after restore / Add Missing Providers)
    /// instead of rejecting the Add form as a conflict.
    private func applyCatalogConnection(
        to provider: inout LocalProvider,
        entry: LocalProviderCatalogEntry,
        displayName: String?,
        apiKey: String?,
        monthlyBudgetUsd: Double?,
        subscriptionCostUsd: Double?,
        subscriptionName: String?,
        teamId: String?,
        accountSid: String?,
        apiKeySid: String?
    ) async throws {
        if let displayName, !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            provider.displayName = displayName
        }
        let typedKey = apiKey?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !typedKey.isEmpty {
            guard let credentials = try Self.validatedCredentials(
                entry: entry,
                apiKey: apiKey,
                teamId: teamId,
                accountSid: accountSid,
                apiKeySid: apiKeySid
            ) else {
                throw LocalWriteError.validation("\(entry.displayName) does not take an API key on this phone")
            }
            try await replaceKeychainAccount(
                on: &provider,
                credentials: credentials,
                adapterKind: Self.storeAdapterKind(for: entry),
                activate: true
            )
        } else {
            provider.adapterKind = Self.storeAdapterKind(for: entry)
            provider.updatedAt = Date()
            try await store.upsertProvider(provider)
        }
        if let monthlyBudgetUsd {
            var plan = try await store.getPlan(providerId: provider.id) ?? LocalProviderPlan(providerId: provider.id)
            plan.monthlyBudgetUsd = monthlyBudgetUsd
            plan.updatedAt = Date()
            try await store.upsertPlan(plan)
        }
        if let explicitCost = subscriptionCostUsd {
            try await setRecurringFee(
                providerId: provider.id,
                name: subscriptionName
                    ?? entry.suggestedSubscriptionName
                    ?? "\(entry.displayName) plan",
                costUsd: max(0, explicitCost)
            )
            if explicitCost > 0 {
                try await setActive(providerId: provider.id, isActive: true)
            }
        }
        try await reload()
    }

    private func replaceKeychainAccount(
        on provider: inout LocalProvider,
        credentials: ProviderCredentials,
        adapterKind: String,
        activate: Bool
    ) async throws {
        let superseded = provider.keychainAccountId
        let accountId = UUID().uuidString
        try secrets.save(accountId: accountId, credentials: credentials)
        provider.keychainAccountId = accountId
        provider.adapterKind = adapterKind
        if activate { provider.isActive = true }
        provider.updatedAt = Date()
        try await store.upsertProvider(provider)
        if let superseded {
            try? secrets.delete(accountId: superseded)
        }
    }

    /// Insert every catalog provider not already present as **inactive $0 shells**,
    /// and heal display names / connection profiles for existing catalog rows.
    /// Never attaches subscriptions or invents spend — catalog price hints are
    /// for the Add form only. Data lives in on-device SQLite (survives app updates;
    /// not App Store–shared; no API keys).
    @discardableResult
    public func ensureCatalogProviders(reloadAfter: Bool = true) async throws -> Int {
        let existing = try await store.listProviders()
        let byName = Dictionary(uniqueKeysWithValues: existing.map { ($0.name, $0) })
        var added = 0
        for entry in LocalProviderCatalog.all {
            if var p = byName[entry.name] {
                // Heal catalog renames (e.g. "xAI / Grok" → "xAI") and connection profile.
                var changed = false
                // Heal known catalog renames without clobbering truly custom names.
                let healNames: Set<String> = [
                    "xAI / Grok", "xAI/Grok", "Custom / other", "OpenAI",
                    "Anthropic (API / Admin)", "Anthropic", "Oracle Cloud Infrastructure",
                ]
                if p.displayName != entry.displayName,
                   healNames.contains(p.displayName)
                    || p.displayName == LocalProviderCatalog.preferredDisplayName(forName: entry.name)
                {
                    p.displayName = entry.displayName
                    changed = true
                }
                // Upgrade adapter kind when phone gained a poll adapter and row is fee-only shell.
                let preferred = entry.isPhonePollable ? entry.resolvedAdapterKind : "subscription_only"
                if p.adapterKind == "subscription_only", entry.isPhonePollable, p.keychainAccountId == nil {
                    p.adapterKind = preferred
                    changed = true
                }
                if p.nonSecretConfigJSON != Self.connectionProfileJSON(for: entry) {
                    p.nonSecretConfigJSON = Self.connectionProfileJSON(for: entry)
                    changed = true
                }
                if p.category != entry.category {
                    p.category = entry.category
                    changed = true
                }
                if changed {
                    p.updatedAt = Date()
                    try await store.upsertProvider(p)
                }
                continue
            }
            var p = LocalProvider(
                name: entry.name,
                displayName: entry.displayName,
                adapterKind: entry.isPhonePollable ? entry.resolvedAdapterKind : "subscription_only",
                category: entry.category,
                isActive: false,
                nonSecretConfigJSON: Self.connectionProfileJSON(for: entry)
            )
            p.updatedAt = Date()
            try await store.upsertProvider(p)
            try await store.upsertPlan(LocalProviderPlan(providerId: p.id))
            added += 1
        }
        if reloadAfter { try await reload() }
        return added
    }

    /// Alias kept for older call sites / buttons.
    @discardableResult
    public func seedMissingCatalogProviders() async throws -> Int {
        try await ensureCatalogProviders(reloadAfter: true)
    }

    private static func connectionProfileJSON(for entry: LocalProviderCatalogEntry) -> String {
        let abilities = entry.abilities.map(\.rawValue)
        let payload: [String: Any] = [
            "catalogName": entry.name,
            "mode": entry.mode.rawValue,
            "abilities": abilities,
            "connectionSummary": entry.connectionSummary,
            "isPhonePollable": entry.isPhonePollable,
            "help": entry.help,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              let s = String(data: data, encoding: .utf8)
        else { return "{}" }
        return s
    }

    /// Historical seed ghosts only (pre-fix catalog auto-charged these).
    private static let seedGhostSignatures: [(providerName: String, costUsd: Double, subNames: Set<String>)] = [
        ("cloudflare", 5, ["Workers Paid"]),
        ("vercel", 20, ["Vercel Pro"]),
        ("robinhood", 5, ["Robinhood Gold"]),
    ]

    /// Cancel known seed-invented subscriptions and delete their charges so
    /// Overview MTD stops counting fees the owner never paid.
    @discardableResult
    public func scrubCatalogGuessCharges(reloadAfter: Bool = true) async throws -> Int {
        let providers = try await store.listProviders()
        let byProviderName = Dictionary(uniqueKeysWithValues: providers.map { ($0.name, $0) })
        var scrubbed = 0
        for ghost in Self.seedGhostSignatures {
            guard let p = byProviderName[ghost.providerName] else { continue }
            let subs = try await store.listSubscriptions().filter { $0.providerId == p.id }
            for var sub in subs {
                guard sub.status == "active",
                      abs(sub.costUsd - ghost.costUsd) < 0.005,
                      ghost.subNames.contains(sub.name)
                else { continue }
                sub.status = "canceled"
                sub.updatedAt = Date()
                try await store.upsertSubscription(sub)
                try await store.deleteCharges(subscriptionId: sub.id)
                scrubbed += 1
            }
        }
        if reloadAfter { try await reload() }
        return scrubbed
    }

    public func addOpenRouterProvider(
        name: String,
        displayName: String,
        apiKey: String,
        monthlyBudgetUsd: Double?
    ) async throws {
        guard let entry = LocalProviderCatalog.entry(name: "openrouter") else { return }
        try await addFromCatalog(
            entry: entry,
            displayName: displayName,
            apiKey: apiKey,
            monthlyBudgetUsd: monthlyBudgetUsd,
            subscriptionCostUsd: nil,
            subscriptionName: nil
        )
    }

    public func addSubscriptionOnlyProvider(
        name: String,
        displayName: String,
        subscriptionName: String,
        costUsd: Double
    ) async throws {
        let entry = LocalProviderCatalogEntry(
            name: name,
            displayName: displayName,
            category: "Other",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "",
            suggestedMonthlyUsd: costUsd,
            suggestedSubscriptionName: subscriptionName
        )
        try await addFromCatalog(
            entry: entry,
            displayName: displayName,
            apiKey: nil,
            monthlyBudgetUsd: nil,
            subscriptionCostUsd: costUsd,
            subscriptionName: subscriptionName
        )
    }

    private func attachSubscription(providerId: String, name: String, costUsd: Double) async throws {
        let periodStart = BudgetEngine.utcMonthStart()
        let next = SubscriptionPeriodMath.advancePeriod(
            periodStart: periodStart,
            interval: "monthly",
            intervalCount: 1
        )
        let sub = LocalSubscription(
            providerId: providerId,
            name: name,
            costUsd: costUsd,
            startDate: periodStart,
            currentPeriodStart: periodStart,
            nextRenewalAt: next,
            status: costUsd > 0 ? "active" : "considering"
        )
        try await store.upsertSubscription(sub)
        if costUsd > 0 {
            _ = try await SubscriptionMaterializer.materialize(store: store)
        }
    }

    public func setBudget(providerId: String, monthlyBudgetUsd: Double?) async throws {
        var plan = try await store.getPlan(providerId: providerId) ?? LocalProviderPlan(providerId: providerId)
        plan.monthlyBudgetUsd = monthlyBudgetUsd
        plan.updatedAt = Date()
        try await store.upsertPlan(plan)
        try await reload()
    }

    public func setActive(providerId: String, isActive: Bool) async throws {
        guard var p = try await store.getProvider(id: providerId) else { return }
        p.isActive = isActive
        p.updatedAt = Date()
        try await store.upsertProvider(p)
        try await reload()
    }

    /// Create or update the first active/considering/paused subscription for a provider.
    public func setRecurringFee(providerId: String, name: String, costUsd: Double) async throws {
        let existing = try await store.listSubscriptions().filter { $0.providerId == providerId }
        if var sub = existing.first(where: {
            $0.status == "active" || $0.status == "considering" || $0.status == "paused"
        }) {
            sub.name = name
            sub.costUsd = max(0, costUsd)
            sub.status = costUsd > 0 ? "active" : "considering"
            sub.updatedAt = Date()
            try await store.upsertSubscription(sub)
            if costUsd > 0 {
                _ = try await SubscriptionMaterializer.materialize(store: store)
            }
        } else {
            try await attachSubscription(providerId: providerId, name: name, costUsd: max(0, costUsd))
        }
        try await reload()
    }

    public func cancelRecurringFees(providerId: String) async throws {
        let subs = try await store.listSubscriptions().filter { $0.providerId == providerId }
        for var sub in subs where sub.status == "active" || sub.status == "considering" {
            sub.status = "canceled"
            sub.updatedAt = Date()
            try await store.upsertSubscription(sub)
        }
        try await reload()
    }

    // MARK: - Projects

    public func upsertProject(name: String, description: String?, monthlyBudgetUsd: Double?, id: String? = nil) async throws {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw LocalWriteError.validation("Project name required") }
        let now = Date()
        if let id, var existing = projects.first(where: { $0.id == id }) {
            existing.name = trimmed
            existing.nameKey = trimmed.lowercased()
            existing.description = description
            existing.monthlyBudgetUsd = monthlyBudgetUsd
            existing.updatedAt = now
            try await store.upsertProject(existing)
        } else {
            var p = LocalProject(name: trimmed, description: description, monthlyBudgetUsd: monthlyBudgetUsd)
            p.updatedAt = now
            try await store.upsertProject(p)
        }
        try await reload()
    }

    public func deleteProject(id: String) async throws {
        try await store.deleteProject(id: id)
        try await reload()
    }

    /// Direct spend attributed to a project (subscription charges with projectId).
    public func projectSpentUsd(projectId: String) async throws -> Double {
        let charges = try await store.allCharges().filter { $0.projectId == projectId }
        let monthStart = BudgetEngine.utcMonthStart()
        return charges
            .filter { $0.periodStart >= monthStart }
            .reduce(0) { $0 + $1.costUsd }
    }

    // MARK: - Snapshots

    public func snapshots(for providerId: String, limit: Int = 60) async throws -> [LocalUsageSnapshot] {
        try await store.listSnapshots(providerId: providerId, limit: limit)
    }

    // MARK: - Export (no secrets)

    public func exportPackageJSON() async throws -> Data {
        try await LocalExportBuilder.build(store: store)
    }

    public func deleteProvider(id: String) async throws {
        if let p = try await store.getProvider(id: id), let acc = p.keychainAccountId {
            try secrets.delete(accountId: acc)
        }
        try await store.deleteProvider(id: id)
        try await reload()
    }

    public func wipeAll() async throws {
        for p in try await store.listProviders() {
            if let acc = p.keychainAccountId {
                try? secrets.delete(accountId: acc)
            }
        }
        try await store.wipeAll()
        try await reload()
    }

    // MARK: - Poll

    public func refreshAllDue(force: Bool = false) async {
        isRefreshing = true
        lastError = nil
        defer { isRefreshing = false }
        do {
            _ = try await SubscriptionMaterializer.materialize(store: store)
            let list = try await store.listProviders().filter { $0.isActive && $0.isPollable }
            for p in list {
                if !force, let last = p.lastFetchAt {
                    let due = last.addingTimeInterval(Double(p.refreshIntervalMin) * 60)
                    if due > Date() { continue }
                }
                await poll(provider: p)
            }
            try await reload()
        } catch {
            lastError = error.localizedDescription
        }
    }

    public func poll(providerId: String) async {
        isRefreshing = true
        defer { isRefreshing = false }
        guard let p = try? await store.getProvider(id: providerId) else { return }
        await poll(provider: p)
        try? await reload()
    }

    private func poll(provider: LocalProvider) async {
        guard provider.isPollable else { return }
        guard let accountId = provider.keychainAccountId,
              let creds = try? secrets.load(accountId: accountId) else {
            try? await store.setProviderFetchResult(
                id: provider.id,
                at: Date(),
                error: "No API key saved on this phone."
            )
            return
        }
        do {
            let adapter = adapter(for: provider.adapterKind)
            let result = try await adapter.fetchUsage(credentials: creds)
            let snap = LocalUsageSnapshot(
                providerId: provider.id,
                fetchedAt: result.fetchedAt,
                balance: result.balance,
                totalCost: result.totalCost,
                fixedCostIncludedUsd: result.fixedCostIncludedUsd,
                costWindowStart: result.costWindowStart,
                costWindowEnd: result.costWindowEnd,
                costScope: result.costScope.rawValue,
                costIncludesUnknownFixed: result.costIncludesUnknownFixed,
                totalRequests: result.totalRequests,
                credits: result.credits,
                costCoverageCaveatCode: result.costCoverageCaveat?.code,
                costCoverageCaveatMessage: result.costCoverageCaveat?.message
            )
            try await store.insertSnapshot(snap)
            try await store.setProviderFetchResult(
                id: provider.id,
                at: result.fetchedAt,
                error: result.statusNote
            )
        } catch let e as AdapterRunError {
            try? await store.setProviderFetchResult(id: provider.id, at: Date(), error: e.message)
        } catch {
            try? await store.setProviderFetchResult(
                id: provider.id,
                at: Date(),
                error: error.localizedDescription
            )
        }
    }

    private func adapter(for kind: String) -> any ProviderAdapter {
        LocalAdapterRegistry.adapter(for: kind)
    }
}
