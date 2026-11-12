import Foundation

/// One element of `GET /api/subscriptions` (bearer- or session-authorized).
public struct SubscriptionSummary: Codable, Hashable, Sendable, Identifiable {
    public struct ProviderRef: Codable, Hashable, Sendable {
        public var id: String
        public var name: String
        public var displayName: String

        public init(id: String, name: String, displayName: String) {
            self.id = id
            self.name = name
            self.displayName = displayName
        }

        public var title: String {
            let trimmed = displayName.trimmingCharacters(in: .whitespaces)
            return trimmed.isEmpty ? name : trimmed
        }
    }

    public struct ProjectRef: Codable, Hashable, Sendable {
        public var id: String
        public var name: String

        public init(id: String, name: String) {
            self.id = id
            self.name = name
        }
    }

    public var id: String
    public var name: String
    public var description: String?
    public var costUsd: Double
    public var currency: String
    public var interval: String
    public var intervalCount: Int
    public var monthlyEquivalentUsd: Double
    public var anchorDay: Int?
    public var startDate: String
    public var currentPeriodStart: String
    public var nextRenewalAt: String
    public var autoRenew: Bool
    public var status: String
    public var effectiveStatus: String
    public var notes: String?
    public var externalBillingSource: String?
    public var externalBillingId: String?
    /// Present on mutation receipts (the PUT returns the full row) and on the
    /// list DTO once the server emits it; `nil` means "unknown", not `false`.
    /// `true` marks a row auto-managed by external-billing maintenance — any
    /// owner edit (including pause) permanently converts it to owner-managed.
    public var externalBillingManaged: Bool?
    /// Watermark of the most recent charged period; governs whether the
    /// server's `resume` activation mode is available. Absent from the current
    /// list DTO, so usually `nil` (unknown) until a mutation receipt arrives.
    public var lastChargedPeriodStart: String?
    public var knobEnv: [String: String]?
    public var freeTierKnobEnv: [String: String]?
    public var provider: ProviderRef
    public var project: ProjectRef?

    public init(
        id: String,
        name: String,
        description: String? = nil,
        costUsd: Double,
        currency: String = "USD",
        interval: String,
        intervalCount: Int = 1,
        monthlyEquivalentUsd: Double,
        anchorDay: Int? = nil,
        startDate: String,
        currentPeriodStart: String,
        nextRenewalAt: String,
        autoRenew: Bool = true,
        status: String,
        effectiveStatus: String,
        notes: String? = nil,
        externalBillingSource: String? = nil,
        externalBillingId: String? = nil,
        externalBillingManaged: Bool? = nil,
        lastChargedPeriodStart: String? = nil,
        knobEnv: [String: String]? = nil,
        freeTierKnobEnv: [String: String]? = nil,
        provider: ProviderRef,
        project: ProjectRef? = nil
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.costUsd = costUsd
        self.currency = currency
        self.interval = interval
        self.intervalCount = intervalCount
        self.monthlyEquivalentUsd = monthlyEquivalentUsd
        self.anchorDay = anchorDay
        self.startDate = startDate
        self.currentPeriodStart = currentPeriodStart
        self.nextRenewalAt = nextRenewalAt
        self.autoRenew = autoRenew
        self.status = status
        self.effectiveStatus = effectiveStatus
        self.notes = notes
        self.externalBillingSource = externalBillingSource
        self.externalBillingId = externalBillingId
        self.externalBillingManaged = externalBillingManaged
        self.lastChargedPeriodStart = lastChargedPeriodStart
        self.knobEnv = knobEnv
        self.freeTierKnobEnv = freeTierKnobEnv
        self.provider = provider
        self.project = project
    }

    public var nextRenewalDate: Date? { ISO8601DateParser.date(from: nextRenewalAt) }

    /// A subscription counts as "active" for surfacing if its effective status
    /// is active or considering.
    public var isLive: Bool {
        effectiveStatus == "active" || effectiveStatus == "considering"
    }

    /// Linked to a provider external-billing record (owner-linked or
    /// auto-managed). Used to warn that owner edits may relinquish
    /// auto-management even when the managed flag itself is unknown (`nil`).
    public var isExternalBillingLinked: Bool {
        externalBillingSource?.isEmpty == false
    }

    /// Positive evidence the row is auto-managed by external-billing
    /// maintenance. `false` when the flag is absent from the payload.
    public var isExternalBillingManaged: Bool {
        externalBillingManaged ?? false
    }

    /// Whether the server's `resume` activation mode is even plausible: the
    /// row must be paused/canceled with a previously charged term. When the
    /// watermark is unknown (`nil`), resume is offered and the server remains
    /// the validator (it 400s with an explanatory message).
    public var canAttemptResume: Bool {
        guard status == "paused" || status == "canceled" else { return false }
        return lastChargedPeriodStart.map { !$0.isEmpty } ?? true
    }

    /// Human cadence, e.g. "monthly", "every 3 months".
    public var cadenceLabel: String {
        if intervalCount <= 1 { return interval }
        return "every \(intervalCount) \(Self.pluralizedIntervalUnit(interval, count: intervalCount))"
    }

    /// Maps a cadence interval (`weekly | monthly | quarterly | annual`) to a
    /// countable noun with correct pluralization ("month" → "months"), never a
    /// naive "\(interval)s" ("monthlys").
    static func pluralizedIntervalUnit(_ interval: String, count: Int) -> String {
        let singular: String
        switch interval {
        case "weekly": singular = "week"
        case "monthly": singular = "month"
        case "quarterly": singular = "quarter"
        case "annual": singular = "year"
        default: singular = interval
        }
        return count == 1 ? singular : "\(singular)s"
    }
}
