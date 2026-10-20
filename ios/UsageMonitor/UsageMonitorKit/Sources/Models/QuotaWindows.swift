import Foundation

// ---------------------------------------------------------------------------
// `GET /api/quota-windows` — the latest remaining-percent quota windows the
// server tracks per provider (5h / 7d / 24h / monthly cadences). The route
// was originally built for BotFleet skip-model routing; this is the first
// iOS consumer that surfaces it to a human so they can see % remaining or
// used on their subscriptions (Claude, Codex, Antigravity, Grok, MiniMax).
//
// Decoding follows the house rule for server payloads (see
// `PlatformStatus.swift`): every field is optional or defaulted and unknown
// enum values fall back to a safe case, so a server-side shape change
// degrades one row instead of failing the whole card. A parallel server
// change (owner 2026-09-12) is landing Mac collectors for Claude, Codex,
// Grok, and MiniMax that emit this same shape, plus two ADDITIVE fields — a
// human provider label and a `via: "antigravity"` marker on Antigravity's
// internal model-family buckets. Unknown keys are simply ignored by
// `Decodable`; the two new fields below decode as `nil` until the server
// change ships.
// ---------------------------------------------------------------------------

public struct QuotaWindowsResponse: Codable, Hashable, Sendable {
    public var ok: Bool
    public var generatedAt: String?
    public var windows: [QuotaWindow]

    public var generatedAtDate: Date? {
        generatedAt.flatMap { ISO8601DateParser.date(from: $0) }
    }

    public init(ok: Bool = true, generatedAt: String? = nil, windows: [QuotaWindow] = []) {
        self.ok = ok
        self.generatedAt = generatedAt
        self.windows = windows
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = (try? container.decode(Bool.self, forKey: .ok)) ?? true
        generatedAt = try? container.decodeIfPresent(String.self, forKey: .generatedAt)
        windows = (try? container.decode([QuotaWindow].self, forKey: .windows)) ?? []
    }
}

/// Matches the server's `QuotaWindowStatus` union in `src/lib/quota-windows.ts`.
public enum QuotaWindowStatus: String, Codable, Hashable, Sendable {
    case available
    case nearCap = "near_cap"
    case exhausted
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? ""
        self = QuotaWindowStatus(rawValue: raw) ?? .unknown
    }
}

public struct QuotaPlanMetadata: Codable, Hashable, Sendable {
    public var detectedPlanName: String?
    public var userPlanName: String?
    public var userCostUsd: String?
    public var userRenewalDateText: String?
    public var userSubtitle: String?
    public var showCostAndRenewal: Bool?
    public var hasMismatch: Bool

    /// Declaring `init(from:)` suppresses Swift's implicit memberwise initializer,
    /// which would be `internal` here anyway, so without this the public
    /// `QuotaWindow.init(planMetadata:)` cannot be called with a plan from the
    /// app target (previews, fixtures, synthesized rows).
    public init(
        detectedPlanName: String? = nil,
        userPlanName: String? = nil,
        userCostUsd: String? = nil,
        userRenewalDateText: String? = nil,
        userSubtitle: String? = nil,
        showCostAndRenewal: Bool? = nil,
        hasMismatch: Bool = false
    ) {
        self.detectedPlanName = detectedPlanName
        self.userPlanName = userPlanName
        self.userCostUsd = userCostUsd
        self.userRenewalDateText = userRenewalDateText
        self.userSubtitle = userSubtitle
        self.showCostAndRenewal = showCostAndRenewal
        self.hasMismatch = hasMismatch
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        detectedPlanName = try? container.decodeIfPresent(String.self, forKey: .detectedPlanName)
        userPlanName = try? container.decodeIfPresent(String.self, forKey: .userPlanName)
        userCostUsd = try? container.decodeIfPresent(String.self, forKey: .userCostUsd)
        userRenewalDateText = try? container.decodeIfPresent(String.self, forKey: .userRenewalDateText)
        userSubtitle = try? container.decodeIfPresent(String.self, forKey: .userSubtitle)
        showCostAndRenewal = try? container.decodeIfPresent(Bool.self, forKey: .showCostAndRenewal)
        hasMismatch = (try? container.decode(Bool.self, forKey: .hasMismatch)) ?? false
    }
}

public struct QuotaWindow: Codable, Hashable, Sendable, Identifiable {
    public var planMetadata: QuotaPlanMetadata?
    public var planName: String?
    public var id: String
    public var provider: String
    public var sourceApp: String?
    public var modelId: String?
    public var modelType: String?
    public var label: String
    public var remainingPercent: Double?
    public var remainingUnknown: Bool
    public var isExhausted: Bool
    public var resetAt: String?
    public var window: String?
    public var status: QuotaWindowStatus
    public var occurredAt: String?
    public var source: String?
    /// Additive (owner 2026-09-12): a human-facing provider label, when the
    /// server has one nicer than the raw `provider` slug.
    public var providerLabel: String?
    /// Additive (owner 2026-09-12): set on Antigravity's internal
    /// model-family buckets so the UI can caption them "via Antigravity"
    /// even if they're later reclassified under the model's own provider.
    public var via: String?

    public var resetAtDate: Date? {
        resetAt.flatMap { ISO8601DateParser.date(from: $0) }
    }

    /// The value to render: the reported percent, or 0 when the server marked
    /// this window exhausted/unknown without a number. Never invented.
    public var displayRemainingPercent: Double {
        remainingPercent ?? 0
    }

    public init(
        id: String,
        provider: String,
        sourceApp: String? = nil,
        modelId: String? = nil,
        modelType: String? = nil,
        label: String,
        remainingPercent: Double? = nil,
        remainingUnknown: Bool = false,
        isExhausted: Bool = false,
        resetAt: String? = nil,
        window: String? = nil,
        status: QuotaWindowStatus = .unknown,
        occurredAt: String? = nil,
        source: String? = nil,
        providerLabel: String? = nil,
        via: String? = nil,
        planMetadata: QuotaPlanMetadata? = nil,
        planName: String? = nil
    ) {
        self.planMetadata = planMetadata
        self.planName = planName
        self.id = id
        self.provider = provider
        self.sourceApp = sourceApp
        self.modelId = modelId
        self.modelType = modelType
        self.label = label
        self.remainingPercent = remainingPercent
        self.remainingUnknown = remainingUnknown
        self.isExhausted = isExhausted
        self.resetAt = resetAt
        self.window = window
        self.status = status
        self.occurredAt = occurredAt
        self.source = source
        self.providerLabel = providerLabel
        self.via = via
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        planMetadata = try? container.decodeIfPresent(QuotaPlanMetadata.self, forKey: .planMetadata)
        planName = try? container.decodeIfPresent(String.self, forKey: .planName)
        id = (try? container.decode(String.self, forKey: .id)) ?? UUID().uuidString
        provider = (try? container.decode(String.self, forKey: .provider)) ?? "unknown"
        sourceApp = try? container.decodeIfPresent(String.self, forKey: .sourceApp)
        modelId = try? container.decodeIfPresent(String.self, forKey: .modelId)
        modelType = try? container.decodeIfPresent(String.self, forKey: .modelType)
        label = (try? container.decode(String.self, forKey: .label)) ?? provider
        remainingPercent = try? container.decodeIfPresent(Double.self, forKey: .remainingPercent)
        remainingUnknown = (try? container.decode(Bool.self, forKey: .remainingUnknown)) ?? false
        isExhausted = (try? container.decode(Bool.self, forKey: .isExhausted)) ?? false
        resetAt = try? container.decodeIfPresent(String.self, forKey: .resetAt)
        window = try? container.decodeIfPresent(String.self, forKey: .window)
        status = (try? container.decode(QuotaWindowStatus.self, forKey: .status)) ?? .unknown
        occurredAt = try? container.decodeIfPresent(String.self, forKey: .occurredAt)
        source = try? container.decodeIfPresent(String.self, forKey: .source)
        providerLabel = try? container.decodeIfPresent(String.self, forKey: .providerLabel)
        via = try? container.decodeIfPresent(String.self, forKey: .via)
    }
}

/// The five subscription providers the Overview card always accounts for,
/// even when the server has nothing to say about one of them yet.
public enum SubscriptionQuotaProvider: String, CaseIterable, Hashable, Sendable {
    case claude
    case codex
    case antigravity
    case grok
    case minimax

    public var displayName: String {
        switch self {
        case .claude: return "Claude"
        case .codex: return "Codex"
        case .antigravity: return "Antigravity"
        case .grok: return "Grok"
        case .minimax: return "MiniMax"
        }
    }

    /// Classify a raw server `provider` slug (e.g. `"google-antigravity"`)
    /// into one of the five expected subscription providers. Keyword-based
    /// rather than exact-match: the Mac collectors for Claude/Codex/Grok/
    /// MiniMax are landing in a parallel change and may emit a slightly
    /// different slug than assumed here. A provider that matches nothing
    /// is simply not shown — never invented as one of the five.
    public static func classify(_ raw: String) -> SubscriptionQuotaProvider? {
        let slug = raw.lowercased()
        if slug.contains("antigrav") { return .antigravity }
        if slug.contains("codex") { return .codex }
        if slug.contains("claude") || slug.contains("anthropic") { return .claude }
        if slug.contains("grok") || slug.contains("xai") { return .grok }
        if slug.contains("minimax") || slug.contains("mmx") { return .minimax }
        return nil
    }
}

/// "Resets in 3h 24m" style countdown, shared by the card and its tests.
public enum QuotaCountdownFormat {
    public static func label(resetAt: Date?, now: Date = Date()) -> String {
        guard let resetAt else { return "Reset time unknown" }
        let seconds = resetAt.timeIntervalSince(now)
        if seconds <= 0 { return "Resetting now" }
        let totalMinutes = Int(seconds / 60)
        let days = totalMinutes / 1_440
        let hours = (totalMinutes % 1_440) / 60
        let minutes = totalMinutes % 60

        if days > 0 { return "Resets in \(days)d \(hours)h" }
        if hours > 0 { return "Resets in \(hours)h \(minutes)m" }
        if minutes > 0 { return "Resets in \(minutes)m" }
        return "Resets in <1m"
    }
}

/// One provider's slot in the Subscription Quotas card. Always present for
/// all five `SubscriptionQuotaProvider` cases — `windows` is empty rather
/// than the section being omitted, so the card can show an honest "No quota
/// report yet" row per the house rule against inventing data.
public struct SubscriptionQuotaSection: Identifiable, Hashable, Sendable {
    public var provider: SubscriptionQuotaProvider
    /// Sorted lowest-remaining-first, then by label.
    public var windows: [QuotaWindow]

    public var id: SubscriptionQuotaProvider { provider }

    /// `nil` when this provider has no windows yet — sorts after every
    /// provider that does have data.
    public var minRemainingPercent: Double? {
        windows.map(\.displayRemainingPercent).min()
    }

    public init(provider: SubscriptionQuotaProvider, windows: [QuotaWindow]) {
        self.provider = provider
        self.windows = windows
    }
}

public extension QuotaWindowsResponse {
    /// Groups `windows` into one section per expected subscription provider,
    /// ordered by lowest remaining percent first (most urgent on top), then
    /// by provider name. Providers the server hasn't reported yet still
    /// appear, with an empty `windows` array, so the card renders an honest
    /// empty row instead of silently dropping a provider the owner expects
    /// to see (Claude, Codex, Antigravity, Grok, MiniMax).
    var subscriptionSections: [SubscriptionQuotaSection] {
        var buckets: [SubscriptionQuotaProvider: [QuotaWindow]] = [:]
        for window in windows {
            guard let provider = SubscriptionQuotaProvider.classify(window.provider) else { continue }
            buckets[provider, default: []].append(window)
        }

        let sections = SubscriptionQuotaProvider.allCases.map { provider -> SubscriptionQuotaSection in
            let sortedWindows = (buckets[provider] ?? []).sorted { lhs, rhs in
                if lhs.displayRemainingPercent != rhs.displayRemainingPercent {
                    return lhs.displayRemainingPercent < rhs.displayRemainingPercent
                }
                return lhs.label < rhs.label
            }
            return SubscriptionQuotaSection(provider: provider, windows: sortedWindows)
        }

        return sections.sorted { lhs, rhs in
            let lhsKey = lhs.minRemainingPercent ?? .infinity
            let rhsKey = rhs.minRemainingPercent ?? .infinity
            if lhsKey != rhsKey { return lhsKey < rhsKey }
            return lhs.provider.displayName < rhs.provider.displayName
        }
    }
}
