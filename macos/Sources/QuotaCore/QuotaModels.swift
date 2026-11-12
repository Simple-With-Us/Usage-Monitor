import Foundation

/// The status values emitted by the Usage Monitor API.
public enum QuotaWindowStatus: String, Codable, Sendable {
    case available
    case nearCap = "near_cap"
    case exhausted
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = QuotaWindowStatus(rawValue: value) ?? .unknown
    }
}

public struct SkipModelType: Codable, Equatable, Sendable {
    public var instanceId: String
    public var model: String

    public init(instanceId: String, model: String) {
        self.instanceId = instanceId
        self.model = model
    }
}

/// A wire-compatible quota window.  Dates intentionally remain strings on the
/// wire because the web API uses ISO-8601 strings and older responses can carry
/// an invalid timestamp that must be displayed as stale rather than repaired.
public struct QuotaWindow: Codable, Equatable, Sendable {
    public var id: String
    public var provider: String
    public var providerKey: String?
    public var providerLabel: String?
    public var via: String?
    public var sourceApp: String?
    public var modelId: String?
    public var modelType: String?
    public var label: String
    public var remainingPercent: Double?
    public var absoluteRemaining: Double?
    public var absoluteLimit: Double?
    public var quotaUnit: String?
    public var planName: String?
    public var remainingUnknown: Bool
    public var isExhausted: Bool
    public var resetAt: String?
    public var window: String?
    public var status: QuotaWindowStatus
    public var skip: Bool
    public var skipReason: String?
    public var occurredAt: String
    public var source: String?

    private enum CodingKeys: String, CodingKey {
        case id, provider, providerKey, providerLabel, via, sourceApp, modelId, modelType, label
        case remainingPercent, absoluteRemaining, absoluteLimit, quotaUnit, planName
        case remainingUnknown, isExhausted, resetAt, window, status, skip, skipReason
        case occurredAt, source
    }

    public init(
        id: String,
        provider: String,
        providerKey: String? = nil,
        providerLabel: String? = nil,
        via: String? = nil,
        sourceApp: String? = nil,
        modelId: String? = nil,
        modelType: String? = nil,
        label: String,
        remainingPercent: Double? = nil,
        absoluteRemaining: Double? = nil,
        absoluteLimit: Double? = nil,
        quotaUnit: String? = nil,
        planName: String? = nil,
        remainingUnknown: Bool = false,
        isExhausted: Bool = false,
        resetAt: String? = nil,
        window: String? = nil,
        status: QuotaWindowStatus = .unknown,
        skip: Bool = false,
        skipReason: String? = nil,
        occurredAt: String,
        source: String? = nil
    ) {
        self.id = id
        self.provider = provider
        self.providerKey = providerKey
        self.providerLabel = providerLabel
        self.via = via
        self.sourceApp = sourceApp
        self.modelId = modelId
        self.modelType = modelType
        self.label = label
        self.remainingPercent = remainingPercent
        self.absoluteRemaining = absoluteRemaining
        self.absoluteLimit = absoluteLimit
        self.quotaUnit = quotaUnit
        self.planName = planName
        self.remainingUnknown = remainingUnknown
        self.isExhausted = isExhausted
        self.resetAt = resetAt
        self.window = window
        self.status = status
        self.skip = skip
        self.skipReason = skipReason
        self.occurredAt = occurredAt
        self.source = source
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        provider = try container.decode(String.self, forKey: .provider)
        providerKey = try container.decodeIfPresent(String.self, forKey: .providerKey)
        providerLabel = try container.decodeIfPresent(String.self, forKey: .providerLabel)
        via = try container.decodeIfPresent(String.self, forKey: .via)
        sourceApp = try container.decodeIfPresent(String.self, forKey: .sourceApp)
        modelId = try container.decodeIfPresent(String.self, forKey: .modelId)
        modelType = try container.decodeIfPresent(String.self, forKey: .modelType)
        label = try container.decodeIfPresent(String.self, forKey: .label) ?? provider
        remainingPercent = try container.decodeIfPresent(Double.self, forKey: .remainingPercent)
        absoluteRemaining = try container.decodeIfPresent(Double.self, forKey: .absoluteRemaining)
        absoluteLimit = try container.decodeIfPresent(Double.self, forKey: .absoluteLimit)
        quotaUnit = try container.decodeIfPresent(String.self, forKey: .quotaUnit)
        planName = try container.decodeIfPresent(String.self, forKey: .planName)
        remainingUnknown = try container.decodeIfPresent(Bool.self, forKey: .remainingUnknown) ?? false
        isExhausted = try container.decodeIfPresent(Bool.self, forKey: .isExhausted) ?? false
        resetAt = try container.decodeIfPresent(String.self, forKey: .resetAt)
        window = try container.decodeIfPresent(String.self, forKey: .window)
        status = try container.decodeIfPresent(QuotaWindowStatus.self, forKey: .status) ?? .unknown
        skip = try container.decodeIfPresent(Bool.self, forKey: .skip) ?? false
        skipReason = try container.decodeIfPresent(String.self, forKey: .skipReason)
        occurredAt = try container.decodeIfPresent(String.self, forKey: .occurredAt) ?? ""
        source = try container.decodeIfPresent(String.self, forKey: .source)
    }

    public var occurredDate: Date? { ISO8601Date.parse(occurredAt) }
    public var resetDate: Date? { resetAt.flatMap(ISO8601Date.parse) }

    /// The canonical key used by native grouping and display.
    public var canonicalProviderKey: String {
        QuotaProviders.canonicalKey(provider: provider, providerKey: providerKey, via: via)
    }

    /// Video allowances are supplementary to MiniMax's coding subscription.
    public var isSupplementaryVideoQuota: Bool {
        guard canonicalProviderKey == "minimax" else { return false }
        let identity = [modelId, modelType, label].compactMap { $0 }.joined(separator: " ").lowercased()
        return identity.contains("video") || identity.contains("hailuo")
    }

    /// A bounded value suitable for display.  NaN and infinities are unknown.
    public var boundedRemainingPercent: Double? {
        guard !remainingUnknown, let value = remainingPercent, value.isFinite else { return nil }
        return min(100, max(0, value))
    }
}

public struct QuotaProviderGroup: Codable, Equatable, Sendable {
    public var provider: String
    public var providerLabel: String
    public var via: String?
    public var expected: Bool
    public var windows: [QuotaWindow]

    private enum CodingKeys: String, CodingKey {
        case provider, providerLabel, via, expected, windows
    }

    public init(
        provider: String,
        providerLabel: String,
        via: String? = nil,
        expected: Bool = false,
        windows: [QuotaWindow] = []
    ) {
        self.provider = provider
        self.providerLabel = providerLabel
        self.via = via
        self.expected = expected
        self.windows = windows
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = try container.decode(String.self, forKey: .provider)
        providerLabel = try container.decodeIfPresent(String.self, forKey: .providerLabel) ?? provider
        via = try container.decodeIfPresent(String.self, forKey: .via)
        expected = try container.decodeIfPresent(Bool.self, forKey: .expected) ?? false
        windows = try container.decodeIfPresent([QuotaWindow].self, forKey: .windows) ?? []
    }
}

/// Response from GET /api/quota-windows.  `providerGroups` is additive and is
/// optional on decode so this remains compatible with the original response.
public struct QuotaResponse: Codable, Equatable, Sendable {
    public var generatedAt: String
    public var windows: [QuotaWindow]
    public var skipModelTypes: [SkipModelType]
    public var providerGroups: [QuotaProviderGroup]

    public init(
        generatedAt: String,
        windows: [QuotaWindow] = [],
        skipModelTypes: [SkipModelType] = [],
        providerGroups: [QuotaProviderGroup] = []
    ) {
        self.generatedAt = generatedAt
        self.windows = windows
        self.skipModelTypes = skipModelTypes
        self.providerGroups = providerGroups
    }

    private enum CodingKeys: String, CodingKey {
        case generatedAt, windows, skipModelTypes, providerGroups
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        generatedAt = try container.decode(String.self, forKey: .generatedAt)
        windows = try container.decode([QuotaWindow].self, forKey: .windows)
        skipModelTypes = try container.decodeIfPresent([SkipModelType].self, forKey: .skipModelTypes) ?? []
        providerGroups = try container.decodeIfPresent([QuotaProviderGroup].self, forKey: .providerGroups) ?? []
    }
}

public enum QuotaFreshness: String, Sendable {
    case fresh
    case stale
    case awaitingRefresh
}

/// A window evaluated against a particular clock.  Freshness is never cached;
/// call `snapshot(now:)` again when the UI timer advances.
public struct QuotaWindowSnapshot: Equatable, Sendable {
    public let window: QuotaWindow
    public let remainingPercent: Double?
    public let status: QuotaWindowStatus
    public let freshness: QuotaFreshness
    public let observedAt: Date?
    public let resetAt: Date?

    public var isFresh: Bool { freshness == .fresh }
    public var isStale: Bool { freshness == .stale }
    public var isAwaitingRefresh: Bool { freshness == .awaitingRefresh }
    public var isUnknown: Bool { remainingPercent == nil }

    public init(window: QuotaWindow, now: Date = Date()) {
        self.window = window
        self.observedAt = window.occurredDate
        self.resetAt = window.resetDate
        self.remainingPercent = window.boundedRemainingPercent

        let observedIsFresh: Bool
        if let observedAt {
            let age = now.timeIntervalSince(observedAt)
            observedIsFresh = age < QuotaPolicy.staleAfter && age >= -QuotaPolicy.maximumFutureSkew
        } else {
            observedIsFresh = false
        }

        if let resetAt, resetAt <= now {
            freshness = .awaitingRefresh
        } else if observedIsFresh {
            freshness = .fresh
        } else {
            freshness = .stale
        }

        if remainingPercent == nil {
            status = .unknown
        } else if window.isExhausted || remainingPercent == 0 {
            status = .exhausted
        } else if remainingPercent ?? 0 < 20 {
            status = .nearCap
        } else {
            status = .available
        }
    }
}

public struct QuotaPlatformSection: Equatable, Sendable {
    public let providerKey: String
    public let providerLabel: String
    public let via: String?
    public let expected: Bool
    public let windows: [QuotaWindowSnapshot]

    public var isMissing: Bool { expected && windows.isEmpty }
    public var hasFreshReport: Bool {
        windows.contains { $0.isFresh && $0.remainingPercent != nil }
    }

    public init(
        providerKey: String,
        providerLabel: String,
        via: String? = nil,
        expected: Bool,
        windows: [QuotaWindowSnapshot]
    ) {
        self.providerKey = providerKey
        self.providerLabel = providerLabel
        self.via = via
        self.expected = expected
        self.windows = windows
    }
}

public extension QuotaResponse {
    /// Recomputes all timestamps and bounded percentages using `now`.
    func normalized(now: Date = Date()) -> QuotaResponse {
        var copy = self
        copy.windows = windows.map { $0.normalized() }
        copy.providerGroups = providerGroups.map { group in
            var groupCopy = group
            groupCopy.windows = group.windows.map { $0.normalized() }
            return groupCopy
        }
        return copy
    }

    /// Returns the stable native dashboard order, followed by future provider
    /// keys supplied by the server.  Missing expected providers are explicit.
    func platformSections(now: Date = Date()) -> [QuotaPlatformSection] {
        let normalizedWindows = windows.map { $0.normalized() }
        var grouped = Dictionary<String, [QuotaWindow]>(minimumCapacity: normalizedWindows.count)
        for window in normalizedWindows {
            grouped[window.canonicalProviderKey, default: []].append(window)
        }

        // Older responses may not have top-level windows but do have the
        // additive provider groups.  Fill only absent IDs to avoid duplicates.
        var seen = Set(normalizedWindows.map { "\($0.canonicalProviderKey):\($0.id)" })
        for group in providerGroups {
            for window in group.windows.map({ $0.normalized() }) where seen.insert("\(window.canonicalProviderKey):\(window.id)").inserted {
                grouped[window.canonicalProviderKey, default: []].append(window)
            }
        }

        var sections: [QuotaPlatformSection] = []
        for provider in QuotaProviders.expected {
            sections.append(makeSection(key: provider.key, label: provider.label, via: provider.via, expected: true, grouped: grouped, now: now))
        }

        let futureKeys = grouped.keys.filter { key in !QuotaProviders.hidden.contains(key) && !QuotaProviders.expected.contains(where: { $0.key == key }) }.sorted()
        for key in futureKeys {
            let group = providerGroups.first { QuotaProviders.canonicalKey(provider: $0.provider, providerKey: nil, via: $0.via) == key }
            let groupLabel = group?.providerLabel.trimmingCharacters(in: .whitespacesAndNewlines)
            sections.append(makeSection(key: key, label: groupLabel?.isEmpty == false ? groupLabel! : QuotaProviders.label(for: key), via: group?.via, expected: false, grouped: grouped, now: now))
        }
        return sections
    }

    private func makeSection(
        key: String,
        label: String,
        via: String?,
        expected: Bool,
        grouped: [String: [QuotaWindow]],
        now: Date
    ) -> QuotaPlatformSection {
        let reports = key == "google-antigravity"
            ? AntigravityQuotaGroups.normalize(grouped[key] ?? [], includeMissing: true)
            : grouped[key] ?? []
        let snapshots = reports.map { QuotaWindowSnapshot(window: $0, now: now) }
            .sorted { left, right in
                if key == "google-antigravity" { return left.window.id < right.window.id }
                // Fresh low remaining values are actionable.  Stale and
                // awaiting-refresh values stay after fresh values and do not
                // compete with a real percentage.
                if left.isFresh != right.isFresh { return left.isFresh }
                if left.isFresh, left.remainingPercent != right.remainingPercent {
                    switch (left.remainingPercent, right.remainingPercent) {
                    case let (l?, r?): return l < r
                    case (_?, nil): return true
                    case (nil, _?): return false
                    default: break
                    }
                }
                return left.window.label.localizedCaseInsensitiveCompare(right.window.label) == .orderedAscending
            }
        return QuotaPlatformSection(providerKey: key, providerLabel: label, via: via, expected: expected, windows: snapshots)
    }
}

private extension QuotaWindow {
    func normalized() -> QuotaWindow {
        var copy = self
        copy.providerKey = canonicalProviderKey
        copy.providerLabel = providerLabel ?? QuotaProviders.label(for: copy.providerKey ?? copy.provider)
        copy.remainingPercent = boundedRemainingPercent
        copy.remainingUnknown = copy.remainingPercent == nil
        return copy
    }
}

private enum QuotaPolicy {
    static let staleAfter: TimeInterval = 30 * 60
    static let maximumFutureSkew: TimeInterval = 5 * 60
}

private enum ISO8601Date {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let standard: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func parse(_ value: String) -> Date? {
        fractional.date(from: value) ?? standard.date(from: value)
    }
}

private enum QuotaProviders {
    struct Expected {
        let key: String
        let label: String
        let via: String?
    }

    static let hidden: Set<String> = ["kimi", "gemini-cli", "github-copilot", "windsurf"]

    static let expected: [Expected] = [
        Expected(key: "anthropic", label: "Claude", via: nil),
        Expected(key: "openai", label: "Codex", via: nil),
        Expected(key: "google-antigravity", label: "Antigravity", via: "antigravity"),
        Expected(key: "cursor", label: "Cursor", via: nil),
        Expected(key: "xai", label: "Grok CLI", via: nil),
        Expected(key: "grok-bot", label: "Grok Bot", via: "cursor"),
        Expected(key: "minimax", label: "MiniMax", via: nil),
        Expected(key: "deepseek", label: "DeepSeek", via: nil),
    ]

    static func canonicalKey(provider: String, providerKey: String?, via: String?) -> String {
        if via?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "antigravity" {
            return "google-antigravity"
        }
        let raw = (providerKey?.isEmpty == false ? providerKey! : provider)
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let aliases: [String: String] = [
            "anthropic": "anthropic", "claude": "anthropic", "claude-code": "anthropic", "claude.ai": "anthropic",
            "openai": "openai", "openai-codex": "openai", "codex": "openai",
            "google": "google-antigravity", "google-antigravity": "google-antigravity", "antigravity": "google-antigravity", "antigravity-cli": "google-antigravity",
            "cursor": "cursor",
            "xai": "xai", "grok": "xai", "grok-build": "xai",
            "grok-bot": "grok-bot", "grok bot": "grok-bot", "grokbot": "grok-bot",
            "minimax": "minimax", "minimax-code": "minimax",
            "kimi": "kimi", "moonshot": "kimi", "moonshot-ai": "kimi",
            "gemini": "gemini-cli", "gemini-cli": "gemini-cli",
            "copilot": "github-copilot", "github-copilot": "github-copilot", "github_copilot": "github-copilot",
            "windsurf": "windsurf", "codeium": "windsurf",
            "deepseek": "deepseek",
        ]
        return aliases[raw] ?? raw
    }

    static func label(for key: String) -> String {
        expected.first(where: { $0.key == key })?.label ?? key
    }
}

/// Public aliases mirror the web quota projection helpers while retaining the
/// optional additive provider identity fields used by the native client.
public let expectedQuotaProviderKeys: [String] = QuotaProviders.expected.map(\.key)
public let EXPECTED_QUOTA_PROVIDERS: [String] = expectedQuotaProviderKeys

public func quotaProviderKey(_ provider: String, providerKey: String? = nil, via: String? = nil) -> String {
    QuotaProviders.canonicalKey(provider: provider, providerKey: providerKey, via: via)
}

public func quotaProviderLabel(_ provider: String, providerKey: String? = nil, via: String? = nil) -> String {
    QuotaProviders.label(for: quotaProviderKey(provider, providerKey: providerKey, via: via))
}

public func quotaProviderVia(_ provider: String, providerKey: String? = nil, via: String? = nil) -> String? {
    if let via, !via.isEmpty { return via }
    return quotaProviderKey(provider, providerKey: providerKey, via: via) == "google-antigravity" ? "antigravity" : nil
}
