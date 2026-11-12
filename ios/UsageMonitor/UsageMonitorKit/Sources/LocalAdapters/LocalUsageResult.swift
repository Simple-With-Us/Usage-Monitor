import Foundation
import LocalSecrets

public enum LocalCostScope: String, Sendable, Equatable {
    case calendarMonthToDate = "calendar_month_to_date"
    case billingCycleToDate = "billing_cycle_to_date"
    case daily = "daily"
    case unknown = "unknown"
}

public struct LocalCostCoverageCaveat: Sendable, Equatable {
    public var code: String
    public var message: String
    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

/// Bounded adapter result (design §3.1) — no rawData / externalBilling.
public struct LocalUsageResult: Sendable, Equatable {
    public var totalCost: Double?
    public var balance: Double?
    public var fixedCostIncludedUsd: Double?
    public var costWindowStart: Date?
    public var costWindowEnd: Date?
    public var costScope: LocalCostScope
    public var costIncludesUnknownFixed: Bool
    public var totalRequests: Int?
    public var credits: Double?
    public var costCoverageCaveat: LocalCostCoverageCaveat?
    public var fetchedAt: Date
    public var statusNote: String?

    public init(
        totalCost: Double? = nil,
        balance: Double? = nil,
        fixedCostIncludedUsd: Double? = nil,
        costWindowStart: Date? = nil,
        costWindowEnd: Date? = nil,
        costScope: LocalCostScope = .unknown,
        costIncludesUnknownFixed: Bool = false,
        totalRequests: Int? = nil,
        credits: Double? = nil,
        costCoverageCaveat: LocalCostCoverageCaveat? = nil,
        fetchedAt: Date = Date(),
        statusNote: String? = nil
    ) {
        self.totalCost = totalCost
        self.balance = balance
        self.fixedCostIncludedUsd = fixedCostIncludedUsd
        self.costWindowStart = costWindowStart
        self.costWindowEnd = costWindowEnd
        self.costScope = costScope
        self.costIncludesUnknownFixed = costIncludesUnknownFixed
        self.totalRequests = totalRequests
        self.credits = credits
        self.costCoverageCaveat = costCoverageCaveat
        self.fetchedAt = fetchedAt
        self.statusNote = statusNote
    }
}

public enum AdapterRunError: Error, Equatable, Sendable {
    case configuration(String)
    case httpStatus(Int, String?)
    case invalidResponse(String)
    case timeout
    case transport(String)
    case unsupported(String)

    public var message: String {
        switch self {
        case .configuration(let s): return s
        case .httpStatus(let c, let b): return "HTTP \(c)\(b.map { ": \($0)" } ?? "")"
        case .invalidResponse(let s): return s
        case .timeout: return "Request timed out"
        case .transport(let s): return s
        case .unsupported(let s): return s
        }
    }
}

public protocol ProviderAdapter: Sendable {
    var adapterKind: String { get }
    func fetchUsage(credentials: ProviderCredentials) async throws -> LocalUsageResult
}
