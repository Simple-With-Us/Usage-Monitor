import Foundation

public struct LlmBurnTokenTotals: Codable, Hashable, Sendable {
    public var input: Double
    public var output: Double
    public var cacheRead: Double?
    public var cacheCreation: Double?
    public var unknown: Double?
    public var total: Double

    public init(
        input: Double,
        output: Double,
        cacheRead: Double? = nil,
        cacheCreation: Double? = nil,
        unknown: Double? = nil,
        total: Double
    ) {
        self.input = input
        self.output = output
        self.cacheRead = cacheRead
        self.cacheCreation = cacheCreation
        self.unknown = unknown
        self.total = total
    }
}

public struct LlmBurnWindowReport: Codable, Hashable, Sendable {
    public var hours: Double
    public var tokens: LlmBurnTokenTotals
    public var derivedCostUsd: Double?
    public var reportedCostUsd: Double?
    public var estimateUsd: Double?
    public var eventCount: Int?
    public var tokensPerHour: Double?
    public var usdPerHour: Double?

    public init(
        hours: Double,
        tokens: LlmBurnTokenTotals,
        derivedCostUsd: Double? = nil,
        reportedCostUsd: Double? = nil,
        estimateUsd: Double? = nil,
        eventCount: Int? = nil,
        tokensPerHour: Double? = nil,
        usdPerHour: Double? = nil
    ) {
        self.hours = hours
        self.tokens = tokens
        self.derivedCostUsd = derivedCostUsd
        self.reportedCostUsd = reportedCostUsd
        self.estimateUsd = estimateUsd
        self.eventCount = eventCount
        self.tokensPerHour = tokensPerHour
        self.usdPerHour = usdPerHour
    }
}

public struct LlmBurnBudgetPace: Codable, Hashable, Sendable {
    public var monthlyBudgetUsd: Double?
    public var status: String?
    public var projectedMonthEndUsd: Double?

    public init(
        monthlyBudgetUsd: Double? = nil,
        status: String? = nil,
        projectedMonthEndUsd: Double? = nil
    ) {
        self.monthlyBudgetUsd = monthlyBudgetUsd
        self.status = status
        self.projectedMonthEndUsd = projectedMonthEndUsd
    }
}

public struct LlmBurnProviderReport: Codable, Hashable, Sendable, Identifiable {
    public var provider: String
    public var window: LlmBurnWindowReport
    public var budget: LlmBurnBudgetPace?
    public var id: String { provider }

    public init(
        provider: String,
        window: LlmBurnWindowReport,
        budget: LlmBurnBudgetPace? = nil
    ) {
        self.provider = provider
        self.window = window
        self.budget = budget
    }
}

public struct LlmBurnResponse: Codable, Hashable, Sendable {
    public var ok: Bool
    public var generatedAt: String?
    public var windowHours: Double?
    public var providers: [LlmBurnProviderReport]
    public var quietProviders: [LlmBurnProviderReport]?

    public var hasActivity: Bool {
        !providers.isEmpty || !(quietProviders ?? []).isEmpty
    }

    public init(
        ok: Bool,
        generatedAt: String? = nil,
        windowHours: Double? = nil,
        providers: [LlmBurnProviderReport],
        quietProviders: [LlmBurnProviderReport]? = nil
    ) {
        self.ok = ok
        self.generatedAt = generatedAt
        self.windowHours = windowHours
        self.providers = providers
        self.quietProviders = quietProviders
    }
}
