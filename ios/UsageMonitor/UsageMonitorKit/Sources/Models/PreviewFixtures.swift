import Foundation

// ---------------------------------------------------------------------------
// Deterministic sample data for SwiftUI previews, gallery entries, and unit
// tests. Every feature/integration target may reference these so previews
// render realistic content without a live network. They are `public` and
// stable — treat them as fixtures, not production data.
// ---------------------------------------------------------------------------

public extension ProviderAlert {
    static let sampleWarning = ProviderAlert(
        code: "budget_warning",
        severity: .warning,
        message: "Anthropic is at 85% of its $250 monthly budget."
    )
    static let sampleCritical = ProviderAlert(
        code: "budget_exceeded",
        severity: .critical,
        message: "OpenRouter has exceeded its $120 monthly budget."
    )
    static let sampleInfo = ProviderAlert(
        code: "billing_sync_incomplete",
        severity: .info,
        message: "Google Cloud Billing export is pending; spend coverage is incomplete."
    )
}

public extension ProviderBudgetStatus {
    static let sampleWarning = ProviderBudgetStatus(
        id: "prov_anthropic",
        name: "anthropic",
        displayName: "Anthropic",
        monthlyBudgetUsd: 250,
        fixedMonthlyCostUsd: 0,
        snapshotCostUsd: 212.40,
        snapshotCostFetchedAt: "2026-07-19T09:15:00.000Z",
        pushedMonthToDateUsd: 212.40,
        receiptCashPaidUsd: 0,
        observedVariableUsageUsd: 212.40,
        estimatedApiEquivalentUsd: 0,
        spendCoverage: .partial,
        subscriptionMonthToDateUsd: 0,
        fixedAccruedUsd: 0,
        forecastedSubscriptionRenewalsUsd: 0,
        spentUsd: 212.40,
        projectedEomUsd: 335.10,
        remainingUsd: 37.60,
        percentUsed: 0.8496,
        status: .warning,
        alerts: [.sampleWarning]
    )

    static let sampleOk = ProviderBudgetStatus(
        id: "prov_openai",
        name: "openai",
        displayName: "OpenAI",
        monthlyBudgetUsd: 200,
        snapshotCostUsd: 96.20,
        snapshotCostFetchedAt: "2026-07-19T09:15:00.000Z",
        pushedMonthToDateUsd: 96.20,
        observedVariableUsageUsd: 96.20,
        spendCoverage: .complete,
        spentUsd: 96.20,
        projectedEomUsd: 151.80,
        remainingUsd: 103.80,
        percentUsed: 0.481,
        status: .ok,
        alerts: []
    )

    static let sampleExceeded = ProviderBudgetStatus(
        id: "prov_openrouter",
        name: "openrouter",
        displayName: "OpenRouter",
        monthlyBudgetUsd: 120,
        snapshotCostUsd: 134.90,
        snapshotCostFetchedAt: "2026-07-19T09:15:00.000Z",
        pushedMonthToDateUsd: 134.90,
        observedVariableUsageUsd: 134.90,
        spendCoverage: .complete,
        spentUsd: 134.90,
        projectedEomUsd: 210.40,
        remainingUsd: -14.90,
        percentUsed: 1.124,
        status: .exceeded,
        alerts: [.sampleCritical]
    )

    static let sampleUnconfigured = ProviderBudgetStatus(
        id: "prov_voyage",
        name: "voyage",
        displayName: "Voyage AI",
        monthlyBudgetUsd: nil,
        pushedMonthToDateUsd: 18.05,
        observedVariableUsageUsd: 18.05,
        spendCoverage: .partial,
        spentUsd: 18.05,
        projectedEomUsd: 28.40,
        status: .unconfigured,
        alerts: [.sampleInfo]
    )

    static let sampleList: [ProviderBudgetStatus] = [
        .sampleExceeded, .sampleWarning, .sampleOk, .sampleUnconfigured,
    ]
}

public extension ProjectBudgetStatus {
    static let sampleTrade = ProjectBudgetStatus(
        id: "proj_socratic",
        name: "Socratic Trade",
        description: "Cost-aware trading feedback loop",
        monthlyBudgetUsd: 400,
        spentUsd: 246.80,
        projectedEomUsd: 388.00,
        spendCoverage: .partial,
        directUsd: 201.30,
        allocatedUsd: 45.50,
        incompleteAllocatedProviderCount: 1,
        remainingUsd: 153.20,
        percentUsed: 0.617,
        status: .warning
    )

    static let sampleMonitor = ProjectBudgetStatus(
        id: "proj_monitor",
        name: "Usage Monitor",
        description: "Internal tooling",
        monthlyBudgetUsd: 150,
        spentUsd: 41.10,
        projectedEomUsd: 64.90,
        spendCoverage: .complete,
        directUsd: 41.10,
        allocatedUsd: 0,
        remainingUsd: 108.90,
        percentUsed: 0.274,
        status: .ok
    )

    static let sampleList: [ProjectBudgetStatus] = [.sampleTrade, .sampleMonitor]
}

public extension BudgetSummary {
    static let sample = BudgetSummary(
        totalBudgetUsd: 570,
        budgetedSpentUsd: 443.50,
        unbudgetedSpentUsd: 18.05,
        unassignedSpentUsd: 0,
        totalSpentUsd: 461.55,
        estimatedApiEquivalentUsd: 512.30,
        remainingUsd: 126.50,
        percentUsed: 0.778,
        overBudget: true,
        warning: true
    )
}

public extension BudgetStatusResponse {
    static let sample = BudgetStatusResponse(
        ok: true,
        generatedAt: "2026-07-19T09:15:00.000Z",
        month: "2026-07",
        providers: ProviderBudgetStatus.sampleList,
        projects: ProjectBudgetStatus.sampleList,
        summary: .sample
    )

    /// An all-clear response for empty/first-run previews.
    static let sampleEmpty = BudgetStatusResponse(
        ok: true,
        generatedAt: "2026-07-19T09:15:00.000Z",
        month: "2026-07",
        providers: [],
        projects: [],
        summary: BudgetSummary(
            totalBudgetUsd: 0,
            budgetedSpentUsd: 0,
            unbudgetedSpentUsd: 0,
            totalSpentUsd: 0,
            estimatedApiEquivalentUsd: 0,
            remainingUsd: 0,
            percentUsed: nil,
            overBudget: false,
            warning: false
        )
    )
}

public extension SubscriptionSummary {
    static let sampleClaude = SubscriptionSummary(
        id: "sub_claude_max",
        name: "Claude Max",
        description: "Anthropic Claude Max plan",
        costUsd: 100,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        monthlyEquivalentUsd: 100,
        anchorDay: 7,
        startDate: "2026-01-07T00:00:00.000Z",
        currentPeriodStart: "2026-07-07T00:00:00.000Z",
        nextRenewalAt: "2026-08-07T00:00:00.000Z",
        autoRenew: true,
        status: "active",
        effectiveStatus: "active",
        provider: .init(id: "prov_anthropic", name: "anthropic", displayName: "Anthropic"),
        project: .init(id: "proj_socratic", name: "Socratic Trade")
    )

    static let sampleCursor = SubscriptionSummary(
        id: "sub_cursor",
        name: "Cursor Pro",
        costUsd: 240,
        currency: "USD",
        interval: "yearly",
        intervalCount: 1,
        monthlyEquivalentUsd: 20,
        startDate: "2026-03-01T00:00:00.000Z",
        currentPeriodStart: "2026-03-01T00:00:00.000Z",
        nextRenewalAt: "2027-03-01T00:00:00.000Z",
        autoRenew: true,
        status: "active",
        effectiveStatus: "active",
        provider: .init(id: "prov_cursor", name: "cursor", displayName: "Cursor")
    )

    static let sampleList: [SubscriptionSummary] = [.sampleClaude, .sampleCursor]
}

public extension LlmBurnResponse {
    static let sample = LlmBurnResponse(
        ok: true,
        generatedAt: "2026-07-19T09:15:00.000Z",
        windowHours: 5,
        providers: [
            LlmBurnProviderReport(
                provider: "anthropic",
                window: LlmBurnWindowReport(
                    hours: 5,
                    tokens: LlmBurnTokenTotals(input: 120_000, output: 64_200, total: 184_200),
                    derivedCostUsd: 8.40,
                    reportedCostUsd: 8.10,
                    estimateUsd: 8.40,
                    eventCount: 12,
                    tokensPerHour: 36_840,
                    usdPerHour: 1.68
                ),
                budget: LlmBurnBudgetPace(
                    monthlyBudgetUsd: 250,
                    status: "watch",
                    projectedMonthEndUsd: 280
                )
            )
        ],
        quietProviders: [
            LlmBurnProviderReport(
                provider: "voyage",
                window: LlmBurnWindowReport(
                    hours: 5,
                    tokens: LlmBurnTokenTotals(input: 0, output: 0, total: 0)
                ),
                budget: LlmBurnBudgetPace(monthlyBudgetUsd: 150, status: "no-budget")
            )
        ]
    )
}

public extension ServerHealth {
    static let sample = ServerHealth(
        ok: true,
        status: "live",
        uptimeSeconds: 84_213,
        checkedAt: "2026-07-19T09:15:00.000Z",
        service: "usage-monitor",
        version: "1.0.0",
        commit: "c747e892"
    )
}

public extension ServerReadiness {
    static let sample = ServerReadiness(
        ok: true,
        status: "ready",
        checkedAt: "2026-07-19T09:15:00.000Z",
        checks: ServerReadiness.Checks(
            database: ServerReadiness.Check(ok: true, latencyMs: 3.2),
            scheduler: ServerReadiness.Check(ok: true),
            backup: ServerReadiness.Check(ok: true),
            startup: ServerReadiness.Check(ok: true),
            disk: ServerReadiness.DiskCheck(
                ok: true,
                freeBytes: 30_000_000_000,
                totalBytes: 160_000_000_000
            ),
            backupLayers: ServerReadiness.BackupLayers(
                local: .init(ok: true, present: true, count: 1, latestAgeSeconds: 3_600),
                primary: .init(
                    ok: true,
                    target: "b2",
                    label: "b2",
                    active: true,
                    replicaOk: true,
                    replicaAgeSeconds: 120
                ),
                r2Historic: .init(
                    ok: true,
                    configured: true,
                    role: "historic",
                    weeklyArchive: .init(ok: true, ageSeconds: 7_200)
                )
            )
        )
    )
}

public extension ServerMetrics {
    static let sample = ServerMetrics(
        degraded: false,
        stale: false,
        cacheAgeSeconds: 5,
        host: .init(
            name: "ubuntu-16gb-nbg1-cx43",
            status: "running",
            serverType: "cx43",
            cpus: 8,
            memoryTotalBytes: 16 * 1024 * 1024 * 1024,
            location: "nbg1",
            ip: "192.0.2.1",
            backupWindow: "14-18"
        ),
        hostUsage: .init(
            cpuPct: 18.5,
            networkRxBytesPerSec: 120_000,
            networkTxBytesPerSec: 45_000,
            diskReadBytesPerSec: 2_000_000,
            diskWriteBytesPerSec: 400_000
        ),
        resources: [
            .init(uuid: "um", name: "usage-monitor", type: "application", status: "running:healthy", selfApp: true),
            .init(uuid: "st", name: "socratic-app", type: "application", status: "running:healthy", selfApp: false),
            .init(uuid: "ct", name: "congress-trade", type: "application", status: "running:unknown", selfApp: false),
        ],
        selfResources: [
            .init(uuid: "um", name: "usage-monitor", type: "application", status: "running:healthy", selfApp: true),
        ],
        appDisk: .init(freeBytes: 30_000_000_000, totalBytes: 160_000_000_000, usedPct: 81, ok: true),
        asOf: "2026-08-10T18:00:00.000Z"
    )
}

public extension PlatformStatusPayload {
    static let sample = PlatformStatusPayload(
        platforms: [
            PlatformCard(
                id: "hetzner",
                name: "Hetzner Cloud",
                category: .hosting,
                configured: true,
                state: .healthy,
                headline: "Production CX43 host in nbg1 is running normally.",
                metrics: [
                    Metric(label: "Server", value: "ubuntu-16gb-nbg1-cx43"),
                    Metric(label: "Location", value: "Nuremberg (nbg1)"),
                    Metric(label: "CPUs", value: "8 vCPU · 16 GB RAM")
                ],
                requiredEnv: ["HETZNER_API_TOKEN"]
            ),
            PlatformCard(
                id: "cloudflare_r2",
                name: "Cloudflare R2",
                category: .storage,
                configured: true,
                state: .healthy,
                headline: "Free-tier storage pacing is healthy across all fleet buckets.",
                metrics: [
                    Metric(label: "Storage", value: "2.4 GB", hint: "of 10 GB free cap", usagePct: 24),
                    Metric(label: "Class A Ops", value: "45,120", hint: "of 1M/mo", usagePct: 4.5),
                    Metric(label: "Class B Ops", value: "180,400", hint: "of 10M/mo", usagePct: 1.8)
                ],
                requiredEnv: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_R2_ACCESS_KEY_ID"]
            ),
            PlatformCard(
                id: "slack",
                name: "Slack",
                category: .messaging,
                configured: true,
                state: .healthy,
                headline: "Slack bot token is valid for Jay's Services. Posting as ag***-s**c-realtime.",
                metrics: [
                    Metric(label: "Workspace", value: "Jay's Services"),
                    Metric(label: "Workspace ID", value: "T0824ABCDEF"),
                    Metric(label: "Bot Identity", value: "U0824GHIJKL (ag***-s**c-realtime)")
                ],
                requiredEnv: ["SLACK_BOT_TOKEN"]
            ),
            PlatformCard(
                id: "pushover",
                name: "Pushover",
                category: .messaging,
                configured: true,
                state: .healthy,
                headline: "Pushover accepted 1 application token. Lowest remaining quota is 5,112 calls.",
                metrics: [
                    Metric(label: "Usage Monitor Quota", value: "5,112 / 10,000", usagePct: 48.9),
                    Metric(label: "Quota Resets", value: "in 7 days"),
                    Metric(label: "User Key", value: "u9824...xyz")
                ],
                requiredEnv: ["PUSHOVER_USER_KEY", "PUSHOVER_APP_TOKEN"]
            ),
            PlatformCard(
                id: "stripe",
                name: "Stripe",
                category: .payments,
                configured: true,
                state: .healthy,
                headline: "Live key is working. Charges and payouts are enabled.",
                metrics: [
                    Metric(label: "Key Mode", value: "Live"),
                    Metric(label: "Charges", value: "Enabled"),
                    Metric(label: "Payouts", value: "Enabled"),
                    Metric(label: "Onboarding", value: "Complete"),
                    Metric(label: "Requirements Due", value: "0")
                ],
                requiredEnv: ["STRIPE_SECRET_KEY"]
            ),
            PlatformCard(
                id: "infisical",
                name: "Infisical",
                category: .secrets,
                configured: true,
                state: .healthy,
                headline: "3 of 4 machine identities authenticated. The stored client secret for Shared scope is verified.",
                metrics: [
                    Metric(label: "SocraticTrade.com", value: "Authenticated"),
                    Metric(label: "Congress.Trade", value: "Authenticated"),
                    Metric(label: "Usage-Monitor", value: "Authenticated")
                ],
                requiredEnv: ["INFISICAL_CT_CLIENT_ID", "INFISICAL_CT_CLIENT_SECRET"]
            )
        ],
        summary: .init(total: 6, configured: 6, healthy: 6, degraded: 0, unconfigured: 0),
        degraded: false,
        stale: false,
        fetchedAt: "2026-08-25T09:00:00.000Z"
    )
}

public extension OperationsHealth {
    static let sample = OperationsHealth(
        receiptInbox: .init(
            configured: true,
            state: .healthy,
            needsReviewCount: 0,
            countIsLowerBound: false,
            latestReceivedAt: "2026-08-25T08:30:00.000Z"
        ),
        socraticInfrastructure: .init(
            state: .healthy,
            releaseSha: "a1b2c3d4e5f6",
            processUptimeSeconds: 84_200
        ),
        congressInfrastructure: .init(
            state: .healthy,
            releaseSha: "f6e5d4c3b2a1",
            processUptimeSeconds: 92_400
        ),
        r2Fleet: .init(
            configured: true,
            accounts: [
                .init(id: "primary", label: "Jay Production", configured: true, status: "ok", storage: .init(actual: 2_400_000_000, limit: 10_000_000_000, mtdPct: 24.0)),
                .init(id: "archive", label: "Backups Archive", configured: true, status: "ok", storage: .init(actual: 5_100_000_000, limit: 10_000_000_000, mtdPct: 51.0))
            ]
        ),
        fetchedAt: "2026-08-25T09:00:00.000Z"
    )
}

public extension QuotaWindowsResponse {
    /// Illustrates every rendering branch of the Subscription Quotas card:
    /// a near-cap Claude window, an exhausted Codex window, an Antigravity
    /// window carrying the `via` caption, a healthy Grok window, and MiniMax
    /// deliberately absent to exercise the "No quota report yet" row.
    static let sample = QuotaWindowsResponse(
        ok: true,
        generatedAt: "2026-09-12T18:00:00.000Z",
        windows: [
            QuotaWindow(
                id: "claude-5h",
                provider: "claude",
                label: "5h window",
                remainingPercent: 18,
                resetAt: "2026-09-12T21:30:00.000Z",
                window: "5h",
                status: .nearCap
            ),
            QuotaWindow(
                id: "codex-7d",
                provider: "codex",
                label: "7d window",
                remainingPercent: 0,
                isExhausted: true,
                resetAt: "2026-09-15T00:00:00.000Z",
                window: "7d",
                status: .exhausted
            ),
            QuotaWindow(
                id: "antigravity-claude-opus",
                provider: "google-antigravity",
                label: "Claude Opus 4.6 (Thinking)",
                remainingPercent: 62,
                resetAt: "2026-09-13T04:00:00.000Z",
                window: "24h",
                status: .available,
                via: "antigravity"
            ),
            QuotaWindow(
                id: "grok-monthly",
                provider: "grok",
                label: "Monthly window",
                remainingPercent: 91,
                resetAt: "2026-10-01T00:00:00.000Z",
                window: "monthly",
                status: .available
            ),
        ]
    )
}
