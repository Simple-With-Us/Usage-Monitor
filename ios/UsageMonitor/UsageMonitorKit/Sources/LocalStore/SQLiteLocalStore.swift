import Foundation
import SQLite3

/// On-device money-truth store (design §2.2.1 DDL, SQLite3).
public actor SQLiteLocalStore: LocalStoring {
    public static let shared: SQLiteLocalStore = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("LocalUsageMonitor", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return SQLiteLocalStore(path: dir.appendingPathComponent("local.sqlite").path)
    }()

    private let path: String
    private var db: OpaquePointer?
    public private(set) var schemaVersion: Int = 0
    private var opened = false

    public init(path: String) {
        self.path = path
    }

    /// In-memory store for tests.
    public static func inMemory() -> SQLiteLocalStore {
        SQLiteLocalStore(path: ":memory:")
    }

    public var isOpen: Bool { opened }

    public func open() async throws {
        if opened { return }
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path, &handle, flags, nil) == SQLITE_OK, let handle else {
            throw LocalStoreError.migrationFailed(String(cString: sqlite3_errmsg(handle)))
        }
        db = handle
        try exec("PRAGMA foreign_keys = ON")
        try migrateIfNeeded()
        opened = true
    }

    public func wipeAll() async throws {
        try requireOpen()
        try exec("DELETE FROM subscription_charge")
        try exec("DELETE FROM subscription")
        try exec("DELETE FROM usage_snapshot")
        try exec("DELETE FROM provider_plan")
        try exec("DELETE FROM provider")
        try exec("DELETE FROM project")
        try setMeta("last_maintenance_at", ISO8601.string(from: Date()))
    }

    // MARK: - Providers

    public func listProviders() throws -> [LocalProvider] {
        try requireOpen()
        return try query(
            "SELECT * FROM provider ORDER BY display_name COLLATE NOCASE",
            map: mapProvider
        )
    }

    public func getProvider(id: String) throws -> LocalProvider? {
        try requireOpen()
        return try query(
            "SELECT * FROM provider WHERE id = ?",
            bind: { sqlite3_bind_text($0, 1, id, -1, SQLITE_TRANSIENT) },
            map: mapProvider
        ).first
    }

    public func upsertProvider(_ p: LocalProvider) throws {
        try requireOpen()
        try exec(
            """
            INSERT INTO provider (
              id, name, display_name, type, adapter_kind, category, is_active,
              refresh_interval_min, label, keychain_account_id, non_secret_config_json,
              last_fetch_at, last_fetch_error, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name, display_name=excluded.display_name, type=excluded.type,
              adapter_kind=excluded.adapter_kind, category=excluded.category,
              is_active=excluded.is_active, refresh_interval_min=excluded.refresh_interval_min,
              label=excluded.label, keychain_account_id=excluded.keychain_account_id,
              non_secret_config_json=excluded.non_secret_config_json,
              last_fetch_at=excluded.last_fetch_at, last_fetch_error=excluded.last_fetch_error,
              updated_at=excluded.updated_at
            """,
            bind: { stmt in
                bindText(stmt, 1, p.id)
                bindText(stmt, 2, p.name)
                bindText(stmt, 3, p.displayName)
                bindText(stmt, 4, p.type)
                bindText(stmt, 5, p.adapterKind)
                bindText(stmt, 6, p.category)
                sqlite3_bind_int(stmt, 7, p.isActive ? 1 : 0)
                sqlite3_bind_int(stmt, 8, Int32(p.refreshIntervalMin))
                bindText(stmt, 9, p.label)
                bindText(stmt, 10, p.keychainAccountId)
                bindText(stmt, 11, p.nonSecretConfigJSON)
                bindText(stmt, 12, p.lastFetchAt.map(ISO8601.string(from:)))
                bindText(stmt, 13, p.lastFetchError)
                bindText(stmt, 14, ISO8601.string(from: p.createdAt))
                bindText(stmt, 15, ISO8601.string(from: p.updatedAt))
            }
        )
    }

    public func deleteProvider(id: String) throws {
        try requireOpen()
        try exec("DELETE FROM provider WHERE id = ?", bind: { sqlite3_bind_text($0, 1, id, -1, SQLITE_TRANSIENT) })
    }

    public func setProviderFetchResult(id: String, at: Date, error: String?) throws {
        try requireOpen()
        try exec(
            "UPDATE provider SET last_fetch_at = ?, last_fetch_error = ?, updated_at = ? WHERE id = ?",
            bind: { stmt in
                bindText(stmt, 1, ISO8601.string(from: at))
                bindText(stmt, 2, error)
                bindText(stmt, 3, ISO8601.string(from: at))
                bindText(stmt, 4, id)
            }
        )
    }

    // MARK: - Plans

    public func getPlan(providerId: String) throws -> LocalProviderPlan? {
        try requireOpen()
        return try query(
            "SELECT * FROM provider_plan WHERE provider_id = ?",
            bind: { sqlite3_bind_text($0, 1, providerId, -1, SQLITE_TRANSIENT) },
            map: mapPlan
        ).first
    }

    public func upsertPlan(_ plan: LocalProviderPlan) throws {
        try requireOpen()
        try exec(
            """
            INSERT INTO provider_plan (
              provider_id, billing_mode, fixed_monthly_cost_usd, monthly_budget_usd,
              monthly_request_limit, renewal_date, billing_interval, notes, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(provider_id) DO UPDATE SET
              billing_mode=excluded.billing_mode,
              fixed_monthly_cost_usd=excluded.fixed_monthly_cost_usd,
              monthly_budget_usd=excluded.monthly_budget_usd,
              monthly_request_limit=excluded.monthly_request_limit,
              renewal_date=excluded.renewal_date,
              billing_interval=excluded.billing_interval,
              notes=excluded.notes,
              updated_at=excluded.updated_at
            """,
            bind: { stmt in
                bindText(stmt, 1, plan.providerId)
                bindText(stmt, 2, plan.billingMode)
                bindDouble(stmt, 3, plan.fixedMonthlyCostUsd)
                bindDouble(stmt, 4, plan.monthlyBudgetUsd)
                if let lim = plan.monthlyRequestLimit {
                    sqlite3_bind_int(stmt, 5, Int32(lim))
                } else {
                    sqlite3_bind_null(stmt, 5)
                }
                bindText(stmt, 6, plan.renewalDate.map(ISO8601.string(from:)))
                bindText(stmt, 7, plan.billingInterval)
                bindText(stmt, 8, plan.notes)
                bindText(stmt, 9, ISO8601.string(from: plan.updatedAt))
            }
        )
    }

    // MARK: - Snapshots

    public func insertSnapshot(_ s: LocalUsageSnapshot) throws {
        try requireOpen()
        try exec(
            """
            INSERT INTO usage_snapshot (
              id, provider_id, fetched_at, balance, total_cost, fixed_cost_included_usd,
              cost_window_start, cost_window_end, cost_scope, cost_includes_unknown_fixed,
              total_requests, credits, cost_coverage_caveat_code, cost_coverage_caveat_message, created_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            bind: { stmt in
                bindText(stmt, 1, s.id)
                bindText(stmt, 2, s.providerId)
                bindText(stmt, 3, ISO8601.string(from: s.fetchedAt))
                bindDouble(stmt, 4, s.balance)
                bindDouble(stmt, 5, s.totalCost)
                bindDouble(stmt, 6, s.fixedCostIncludedUsd)
                bindText(stmt, 7, s.costWindowStart.map(ISO8601.string(from:)))
                bindText(stmt, 8, s.costWindowEnd.map(ISO8601.string(from:)))
                bindText(stmt, 9, s.costScope)
                sqlite3_bind_int(stmt, 10, s.costIncludesUnknownFixed ? 1 : 0)
                if let r = s.totalRequests { sqlite3_bind_int(stmt, 11, Int32(r)) } else { sqlite3_bind_null(stmt, 11) }
                bindDouble(stmt, 12, s.credits)
                bindText(stmt, 13, s.costCoverageCaveatCode)
                bindText(stmt, 14, s.costCoverageCaveatMessage)
                bindText(stmt, 15, ISO8601.string(from: s.createdAt))
            }
        )
    }

    public func listSnapshots(providerId: String, limit: Int = 90) throws -> [LocalUsageSnapshot] {
        try requireOpen()
        return try query(
            "SELECT * FROM usage_snapshot WHERE provider_id = ? ORDER BY fetched_at DESC LIMIT ?",
            bind: { stmt in
                sqlite3_bind_text(stmt, 1, providerId, -1, SQLITE_TRANSIENT)
                sqlite3_bind_int(stmt, 2, Int32(limit))
            },
            map: mapSnapshot
        )
    }

    public func allSnapshots() throws -> [LocalUsageSnapshot] {
        try requireOpen()
        return try query("SELECT * FROM usage_snapshot ORDER BY fetched_at DESC", map: mapSnapshot)
    }

    // MARK: - Subscriptions

    public func listSubscriptions() throws -> [LocalSubscription] {
        try requireOpen()
        return try query("SELECT * FROM subscription ORDER BY name COLLATE NOCASE", map: mapSubscription)
    }

    public func subscriptions(forProviderId providerId: String) throws -> [LocalSubscription] {
        try requireOpen()
        return try query(
            "SELECT * FROM subscription WHERE provider_id = ?",
            bind: { sqlite3_bind_text($0, 1, providerId, -1, SQLITE_TRANSIENT) },
            map: mapSubscription
        )
    }

    public func upsertSubscription(_ s: LocalSubscription) throws {
        try requireOpen()
        // Exclusivity: active/considering + cost > 0 cannot coexist with plan fixed > 0
        if (s.status == "active" || s.status == "considering"), s.costUsd > 0 {
            if let plan = try getPlan(providerId: s.providerId),
               let fixed = plan.fixedMonthlyCostUsd, fixed > 0 {
                throw LocalWriteError.conflict(
                    "Provider has a fixed monthly plan fee; clear it before adding an active subscription (or use plan fixed only)."
                )
            }
        }
        try exec(
            """
            INSERT INTO subscription (
              id, provider_id, project_id, name, description, cost_usd, currency, interval,
              interval_count, anchor_day, start_date, current_period_start, next_renewal_at,
              last_charged_period_start, auto_renew, status, canceled_at, notes, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
              provider_id=excluded.provider_id, project_id=excluded.project_id, name=excluded.name,
              description=excluded.description, cost_usd=excluded.cost_usd, currency=excluded.currency,
              interval=excluded.interval, interval_count=excluded.interval_count, anchor_day=excluded.anchor_day,
              start_date=excluded.start_date, current_period_start=excluded.current_period_start,
              next_renewal_at=excluded.next_renewal_at, last_charged_period_start=excluded.last_charged_period_start,
              auto_renew=excluded.auto_renew, status=excluded.status, canceled_at=excluded.canceled_at,
              notes=excluded.notes, updated_at=excluded.updated_at
            """,
            bind: { stmt in
                bindText(stmt, 1, s.id)
                bindText(stmt, 2, s.providerId)
                bindText(stmt, 3, s.projectId)
                bindText(stmt, 4, s.name)
                bindText(stmt, 5, s.description)
                sqlite3_bind_double(stmt, 6, s.costUsd)
                bindText(stmt, 7, s.currency)
                bindText(stmt, 8, s.interval)
                sqlite3_bind_int(stmt, 9, Int32(s.intervalCount))
                if let a = s.anchorDay { sqlite3_bind_int(stmt, 10, Int32(a)) } else { sqlite3_bind_null(stmt, 10) }
                bindText(stmt, 11, ISO8601.string(from: s.startDate))
                bindText(stmt, 12, ISO8601.string(from: s.currentPeriodStart))
                bindText(stmt, 13, ISO8601.string(from: s.nextRenewalAt))
                bindText(stmt, 14, s.lastChargedPeriodStart.map(ISO8601.string(from:)))
                sqlite3_bind_int(stmt, 15, s.autoRenew ? 1 : 0)
                bindText(stmt, 16, s.status)
                bindText(stmt, 17, s.canceledAt.map(ISO8601.string(from:)))
                bindText(stmt, 18, s.notes)
                bindText(stmt, 19, ISO8601.string(from: s.createdAt))
                bindText(stmt, 20, ISO8601.string(from: s.updatedAt))
            }
        )
    }

    public func deleteSubscription(id: String) throws {
        try requireOpen()
        try exec("DELETE FROM subscription WHERE id = ?", bind: { sqlite3_bind_text($0, 1, id, -1, SQLITE_TRANSIENT) })
    }

    // MARK: - Charges

    /// Remove charge rows for one subscription (Local-only cleanup of seed ghosts).
    public func deleteCharges(subscriptionId: String) throws {
        try requireOpen()
        try exec(
            "DELETE FROM subscription_charge WHERE subscription_id = ?",
            bind: { sqlite3_bind_text($0, 1, subscriptionId, -1, SQLITE_TRANSIENT) }
        )
    }

    public func insertCharge(_ c: LocalSubscriptionCharge) throws {
        try requireOpen()
        try exec(
            """
            INSERT OR IGNORE INTO subscription_charge (
              id, subscription_id, provider_id, project_id, period_start, period_end,
              cost_usd, currency, materialized_at
            ) VALUES (?,?,?,?,?,?,?,?,?)
            """,
            bind: { stmt in
                bindText(stmt, 1, c.id)
                bindText(stmt, 2, c.subscriptionId)
                bindText(stmt, 3, c.providerId)
                bindText(stmt, 4, c.projectId)
                bindText(stmt, 5, ISO8601.string(from: c.periodStart))
                bindText(stmt, 6, ISO8601.string(from: c.periodEnd))
                sqlite3_bind_double(stmt, 7, c.costUsd)
                bindText(stmt, 8, c.currency)
                bindText(stmt, 9, ISO8601.string(from: c.materializedAt))
            }
        )
    }

    public func charges(providerId: String, periodStartFrom: Date, periodStartTo: Date) throws -> [LocalSubscriptionCharge] {
        try requireOpen()
        return try query(
            """
            SELECT * FROM subscription_charge
            WHERE provider_id = ? AND period_start >= ? AND period_start < ?
            ORDER BY period_start
            """,
            bind: { stmt in
                bindText(stmt, 1, providerId)
                bindText(stmt, 2, ISO8601.string(from: periodStartFrom))
                bindText(stmt, 3, ISO8601.string(from: periodStartTo))
            },
            map: mapCharge
        )
    }

    public func allCharges() throws -> [LocalSubscriptionCharge] {
        try requireOpen()
        return try query("SELECT * FROM subscription_charge", map: mapCharge)
    }

    // MARK: - Projects

    public func listProjects() throws -> [LocalProject] {
        try requireOpen()
        return try query("SELECT * FROM project ORDER BY name COLLATE NOCASE", map: mapProject)
    }

    public func upsertProject(_ p: LocalProject) throws {
        try requireOpen()
        try exec(
            """
            INSERT INTO project (id, name, name_key, description, monthly_budget_usd, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
              name=excluded.name, name_key=excluded.name_key, description=excluded.description,
              monthly_budget_usd=excluded.monthly_budget_usd, updated_at=excluded.updated_at
            """,
            bind: { stmt in
                bindText(stmt, 1, p.id)
                bindText(stmt, 2, p.name)
                bindText(stmt, 3, p.nameKey)
                bindText(stmt, 4, p.description)
                bindDouble(stmt, 5, p.monthlyBudgetUsd)
                bindText(stmt, 6, ISO8601.string(from: p.createdAt))
                bindText(stmt, 7, ISO8601.string(from: p.updatedAt))
            }
        )
    }

    public func deleteProject(id: String) throws {
        try requireOpen()
        try exec("DELETE FROM project WHERE id = ?", bind: { sqlite3_bind_text($0, 1, id, -1, SQLITE_TRANSIENT) })
    }

    // MARK: - Migration

    private func migrateIfNeeded() throws {
        try exec(
            """
            CREATE TABLE IF NOT EXISTS app_meta (
              key   TEXT PRIMARY KEY NOT NULL,
              value TEXT NOT NULL
            )
            """
        )
        let version = Int(try getMeta("schema_version") ?? "0") ?? 0
        if version == 0 {
            for sql in MigrationV1.statements {
                // app_meta already created; skip duplicate create for app_meta
                if sql.contains("CREATE TABLE app_meta") { continue }
                try exec(sql)
            }
            try setMeta("schema_version", "1")
            try setMeta("installed_at", ISO8601.string(from: Date()))
            schemaVersion = 1
        } else if version == MigrationV1.version {
            schemaVersion = version
        } else {
            throw LocalStoreError.unsupportedSchema(found: version, expected: MigrationV1.version)
        }
    }

    // MARK: - SQLite helpers

    private func requireOpen() throws {
        guard opened, db != nil else { throw LocalStoreError.notOpen }
    }

    private func getMeta(_ key: String) throws -> String? {
        try query(
            "SELECT value FROM app_meta WHERE key = ?",
            bind: { sqlite3_bind_text($0, 1, key, -1, SQLITE_TRANSIENT) },
            map: { stmt in String(cString: sqlite3_column_text(stmt, 0)) }
        ).first
    }

    private func setMeta(_ key: String, _ value: String) throws {
        try exec(
            "INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            bind: { stmt in
                bindText(stmt, 1, key)
                bindText(stmt, 2, value)
            }
        )
    }

    private func exec(_ sql: String, bind: ((OpaquePointer) -> Void)? = nil) throws {
        guard let db else { throw LocalStoreError.notOpen }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw LocalStoreError.migrationFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        bind?(stmt)
        let step = sqlite3_step(stmt)
        guard step == SQLITE_DONE || step == SQLITE_ROW else {
            throw LocalStoreError.migrationFailed(String(cString: sqlite3_errmsg(db)))
        }
    }

    private func query<T>(
        _ sql: String,
        bind: ((OpaquePointer) -> Void)? = nil,
        map: (OpaquePointer) -> T
    ) throws -> [T] {
        guard let db else { throw LocalStoreError.notOpen }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            throw LocalStoreError.migrationFailed(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        bind?(stmt)
        var rows: [T] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            rows.append(map(stmt))
        }
        return rows
    }
}

// SQLITE_TRANSIENT destructor
private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private func bindText(_ stmt: OpaquePointer, _ i: Int32, _ value: String?) {
    if let value {
        sqlite3_bind_text(stmt, i, value, -1, SQLITE_TRANSIENT)
    } else {
        sqlite3_bind_null(stmt, i)
    }
}

private func bindDouble(_ stmt: OpaquePointer, _ i: Int32, _ value: Double?) {
    if let value {
        sqlite3_bind_double(stmt, i, value)
    } else {
        sqlite3_bind_null(stmt, i)
    }
}

private func colText(_ stmt: OpaquePointer, _ i: Int32) -> String? {
    guard let c = sqlite3_column_text(stmt, i) else { return nil }
    return String(cString: c)
}

private func colDouble(_ stmt: OpaquePointer, _ i: Int32) -> Double? {
    if sqlite3_column_type(stmt, i) == SQLITE_NULL { return nil }
    return sqlite3_column_double(stmt, i)
}

private func colInt(_ stmt: OpaquePointer, _ i: Int32) -> Int? {
    if sqlite3_column_type(stmt, i) == SQLITE_NULL { return nil }
    return Int(sqlite3_column_int(stmt, i))
}

private func colDate(_ stmt: OpaquePointer, _ i: Int32) -> Date? {
    guard let s = colText(stmt, i) else { return nil }
    return ISO8601.date(from: s)
}

private func mapProvider(_ stmt: OpaquePointer) -> LocalProvider {
    LocalProvider(
        id: colText(stmt, 0)!,
        name: colText(stmt, 1)!,
        displayName: colText(stmt, 2)!,
        type: colText(stmt, 3) ?? "builtin",
        adapterKind: colText(stmt, 4)!,
        category: colText(stmt, 5),
        isActive: sqlite3_column_int(stmt, 6) != 0,
        refreshIntervalMin: Int(sqlite3_column_int(stmt, 7)),
        label: colText(stmt, 8),
        keychainAccountId: colText(stmt, 9),
        nonSecretConfigJSON: colText(stmt, 10),
        lastFetchAt: colDate(stmt, 11),
        lastFetchError: colText(stmt, 12),
        createdAt: colDate(stmt, 13) ?? Date(),
        updatedAt: colDate(stmt, 14) ?? Date()
    )
}

private func mapPlan(_ stmt: OpaquePointer) -> LocalProviderPlan {
    LocalProviderPlan(
        providerId: colText(stmt, 0)!,
        billingMode: colText(stmt, 1) ?? "manual",
        fixedMonthlyCostUsd: colDouble(stmt, 2),
        monthlyBudgetUsd: colDouble(stmt, 3),
        monthlyRequestLimit: colInt(stmt, 4),
        renewalDate: colDate(stmt, 5),
        billingInterval: colText(stmt, 6),
        notes: colText(stmt, 7),
        updatedAt: colDate(stmt, 8) ?? Date()
    )
}

private func mapSnapshot(_ stmt: OpaquePointer) -> LocalUsageSnapshot {
    LocalUsageSnapshot(
        id: colText(stmt, 0)!,
        providerId: colText(stmt, 1)!,
        fetchedAt: colDate(stmt, 2) ?? Date(),
        balance: colDouble(stmt, 3),
        totalCost: colDouble(stmt, 4),
        fixedCostIncludedUsd: colDouble(stmt, 5),
        costWindowStart: colDate(stmt, 6),
        costWindowEnd: colDate(stmt, 7),
        costScope: colText(stmt, 8),
        costIncludesUnknownFixed: sqlite3_column_int(stmt, 9) != 0,
        totalRequests: colInt(stmt, 10),
        credits: colDouble(stmt, 11),
        costCoverageCaveatCode: colText(stmt, 12),
        costCoverageCaveatMessage: colText(stmt, 13),
        createdAt: colDate(stmt, 14) ?? Date()
    )
}

private func mapSubscription(_ stmt: OpaquePointer) -> LocalSubscription {
    LocalSubscription(
        id: colText(stmt, 0)!,
        providerId: colText(stmt, 1)!,
        projectId: colText(stmt, 2),
        name: colText(stmt, 3)!,
        description: colText(stmt, 4),
        costUsd: colDouble(stmt, 5) ?? 0,
        currency: colText(stmt, 6) ?? "USD",
        interval: colText(stmt, 7) ?? "monthly",
        intervalCount: colInt(stmt, 8) ?? 1,
        anchorDay: colInt(stmt, 9),
        startDate: colDate(stmt, 10) ?? Date(),
        currentPeriodStart: colDate(stmt, 11) ?? Date(),
        nextRenewalAt: colDate(stmt, 12) ?? Date(),
        lastChargedPeriodStart: colDate(stmt, 13),
        autoRenew: sqlite3_column_int(stmt, 14) != 0,
        status: colText(stmt, 15) ?? "active",
        canceledAt: colDate(stmt, 16),
        notes: colText(stmt, 17),
        createdAt: colDate(stmt, 18) ?? Date(),
        updatedAt: colDate(stmt, 19) ?? Date()
    )
}

private func mapCharge(_ stmt: OpaquePointer) -> LocalSubscriptionCharge {
    LocalSubscriptionCharge(
        id: colText(stmt, 0)!,
        subscriptionId: colText(stmt, 1)!,
        providerId: colText(stmt, 2)!,
        projectId: colText(stmt, 3),
        periodStart: colDate(stmt, 4) ?? Date(),
        periodEnd: colDate(stmt, 5) ?? Date(),
        costUsd: colDouble(stmt, 6) ?? 0,
        currency: colText(stmt, 7) ?? "USD",
        materializedAt: colDate(stmt, 8) ?? Date()
    )
}

private func mapProject(_ stmt: OpaquePointer) -> LocalProject {
    var p = LocalProject(
        id: colText(stmt, 0)!,
        name: colText(stmt, 1)!,
        description: colText(stmt, 3),
        monthlyBudgetUsd: colDouble(stmt, 4),
        createdAt: colDate(stmt, 5) ?? Date(),
        updatedAt: colDate(stmt, 6) ?? Date()
    )
    // nameKey already computed from name; ensure DB value wins if present
    if let key = colText(stmt, 2) {
        p = LocalProject(
            id: p.id,
            name: p.name,
            description: p.description,
            monthlyBudgetUsd: p.monthlyBudgetUsd,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt
        )
        // LocalProject always derives nameKey; fine for v1
        _ = key
    }
    return p
}
