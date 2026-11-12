import Foundation

// ---------------------------------------------------------------------------
// Local provider catalog — fleet services with honest phone connection paths.
// User-facing copy never shows "subscription_only"; that is an internal
// adapterKind for fee-only rows. See docs/FLEET-UI-COPY.md for casing.
// ---------------------------------------------------------------------------

/// How money arrives for this service on the phone (internal).
public enum LocalProviderMode: String, Sendable, Codable, CaseIterable {
    /// Phone can poll API cost and/or balance with a key.
    case poll
    /// Recurring fee only (user-entered plan). No phone poll.
    case subscription
    /// Optional key for future connectivity; cost usually via recurring fee.
    case keyPlusSubscription
}

/// What the phone can do for a catalog entry — user-facing connection story.
public enum LocalConnectionAbility: String, Sendable, Codable, CaseIterable, Hashable {
    /// Org/admin API returns month-to-date cash or usage cost.
    case pollCost
    /// Prepaid balance / credits only (not full MTD invoice).
    case pollBalance
    /// Inventory + public price list estimate (not an invoice).
    case pollEstimate
    /// User enters a fixed monthly fee (Claude Max, Cursor, etc.).
    case recurringFee
    /// Optional API key for identity/future use; fee still manual.
    case optionalKey
    /// Console-only on server; phone fee only.
    case serverOnly

    /// Short chip label (Title Case for chips).
    public var chipLabel: String {
        switch self {
        case .pollCost: return "Polls Cost"
        case .pollBalance: return "Polls Balance"
        case .pollEstimate: return "Estimate"
        case .recurringFee: return "Recurring Fee"
        case .optionalKey: return "Optional Key"
        case .serverOnly: return "Fee Only"
        }
    }

    /// Sentence-case detail for list rows / help.
    public var detail: String {
        switch self {
        case .pollCost: return "phone can fetch month-to-date cost with a key"
        case .pollBalance: return "phone can fetch prepaid balance with a key"
        case .pollEstimate: return "phone estimates cost from inventory + public prices"
        case .recurringFee: return "enter a monthly fee — no usage poll on phone"
        case .optionalKey: return "key optional; track spend as a fee if needed"
        case .serverOnly: return "full poll lives on the server app; track fee here"
        }
    }
}

public struct LocalProviderCatalogEntry: Identifiable, Hashable, Sendable {
    public var id: String { name }
    /// Stable slug (unique), used as `LocalProvider.name`.
    public var name: String
    public var displayName: String
    public var category: String
    public var mode: LocalProviderMode
    /// Internal poll adapter id, or `subscription_only` for fee-only rows.
    public var adapterKind: String
    public var keyFieldLabel: String
    public var help: String
    public var suggestedMonthlyUsd: Double?
    public var suggestedSubscriptionName: String?
    /// What the phone can do (drives Add UI chips, not adapterKind strings).
    public var abilities: [LocalConnectionAbility]
    /// Extra credential fields needed beyond the primary key.
    public var requiresTeamId: Bool
    public var requiresAccountSid: Bool

    public init(
        name: String,
        displayName: String,
        category: String,
        mode: LocalProviderMode,
        adapterKind: String,
        keyFieldLabel: String = "API key",
        help: String,
        suggestedMonthlyUsd: Double? = nil,
        suggestedSubscriptionName: String? = nil,
        abilities: [LocalConnectionAbility]? = nil,
        requiresTeamId: Bool = false,
        requiresAccountSid: Bool = false
    ) {
        self.name = name
        self.displayName = displayName
        self.category = category
        self.mode = mode
        self.adapterKind = adapterKind
        self.keyFieldLabel = keyFieldLabel
        self.help = help
        self.suggestedMonthlyUsd = suggestedMonthlyUsd
        self.suggestedSubscriptionName = suggestedSubscriptionName
        self.requiresTeamId = requiresTeamId
        self.requiresAccountSid = requiresAccountSid
        if let abilities {
            self.abilities = abilities
        } else {
            self.abilities = Self.defaultAbilities(mode: mode, adapterKind: adapterKind)
        }
    }

    private static func defaultAbilities(
        mode: LocalProviderMode,
        adapterKind: String
    ) -> [LocalConnectionAbility] {
        switch mode {
        case .poll:
            if Self.phonePollAdapterKinds.contains(adapterKind) {
                if ["deepseek"].contains(adapterKind) { return [.pollBalance] }
                if ["hetzner", "backblaze", "stripe", "twilio", "resend", "pushover", "apify", "firecrawl", "twelvedata"].contains(adapterKind) {
                    return [.pollEstimate, .recurringFee]
                }
                return [.pollCost, .recurringFee]
            }
            return [.recurringFee]
        case .subscription:
            return [.recurringFee]
        case .keyPlusSubscription:
            return [.optionalKey, .recurringFee]
        }
    }

    /// Primary list subtitle (never shows "subscription_only").
    public var connectionSummary: String {
        abilities.map(\.chipLabel).joined(separator: " · ")
    }

    /// Resolved adapter kind to store when adding this entry.
    public var resolvedAdapterKind: String {
        if mode == .subscription { return "subscription_only" }
        if Self.phonePollAdapterKinds.contains(adapterKind) {
            return adapterKind
        }
        if mode == .keyPlusSubscription, adapterKind != "subscription_only" {
            return adapterKind
        }
        return adapterKind == "subscription_only" ? "subscription_only" : adapterKind
    }

    public var isPhonePollable: Bool {
        Self.phonePollAdapterKinds.contains(resolvedAdapterKind)
    }

    /// Keep in sync with `LocalProvider.supportedPollAdapterKinds` / registry.
    public static let phonePollAdapterKinds: Set<String> = [
        "openrouter", "openai", "anthropic", "deepseek", "hetzner", "backblaze",
        "apify", "firecrawl", "twelvedata", "pushover", "resend",
        "stripe", "xai", "twilio",
    ]
}

public enum LocalProviderCatalog {
    public static let all: [LocalProviderCatalogEntry] = [
        // —— LLM / AI ——
        // API org vs consumer chat are separate products (see billing research).
        .init(
            name: "openrouter",
            displayName: "OpenRouter",
            category: "LLM",
            mode: .poll,
            adapterKind: "openrouter",
            keyFieldLabel: "Management API key",
            help: "Management key for month-to-date spend. Inference-only keys connect but may report $0.",
            abilities: [.pollCost]
        ),
        .init(
            name: "openai",
            displayName: "OpenAI (API)",
            category: "LLM",
            mode: .poll,
            adapterKind: "openai",
            keyFieldLabel: "Org Admin API key",
            help: "Organization Admin key for the Costs API (API usage cash). ChatGPT Plus/Pro is a separate product — add ChatGPT (subscription).",
            abilities: [.pollCost, .recurringFee]
        ),
        .init(
            name: "openai-chatgpt-sub",
            displayName: "ChatGPT (subscription)",
            category: "LLM",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "ChatGPT Plus, Pro, Business, or Team — billed separately from the OpenAI API. No public subscription-invoice API; enter the monthly fee you pay.",
            suggestedMonthlyUsd: 20,
            suggestedSubscriptionName: "ChatGPT plan",
            abilities: [.recurringFee]
        ),
        .init(
            name: "anthropic",
            displayName: "Anthropic (API)",
            category: "LLM",
            mode: .poll,
            adapterKind: "anthropic",
            keyFieldLabel: "Admin API key (sk-ant-admin…)",
            help: "Organization Admin cost report for API usage. Claude Max/Pro/Team on claude.ai is separate — add Claude (subscription).",
            abilities: [.pollCost, .recurringFee]
        ),
        .init(
            name: "anthropic-claude-sub",
            displayName: "Claude (subscription)",
            category: "LLM",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Claude Pro, Max, or Team (claude.ai / App Store). No personal usage poll — enter the plan fee.",
            suggestedMonthlyUsd: 200,
            suggestedSubscriptionName: "Claude plan",
            abilities: [.recurringFee]
        ),
        .init(
            name: "deepseek",
            displayName: "DeepSeek",
            category: "LLM",
            mode: .poll,
            adapterKind: "deepseek",
            help: "Polls prepaid account balance. No full invoice history API on phone.",
            abilities: [.pollBalance, .recurringFee]
        ),
        .init(
            name: "xai",
            displayName: "xAI",
            category: "LLM",
            mode: .poll,
            adapterKind: "xai",
            keyFieldLabel: "Management API key",
            help: "Management key + team id for prepaid balance and invoice preview (API credits). SuperGrok / X Premium is separate — add SuperGrok (subscription).",
            abilities: [.pollBalance, .pollCost, .recurringFee],
            requiresTeamId: true
        ),
        .init(
            name: "xai-supergrok-sub",
            displayName: "SuperGrok (subscription)",
            category: "LLM",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "SuperGrok / consumer Grok subscription on X — not the same as xAI API credits. Enter the monthly fee.",
            suggestedMonthlyUsd: 30,
            suggestedSubscriptionName: "SuperGrok",
            abilities: [.recurringFee]
        ),
        .init(
            name: "mistral",
            displayName: "Mistral",
            category: "LLM",
            mode: .keyPlusSubscription,
            adapterKind: "mistral",
            help: "Admin spend APIs are limited on phone. Optional key for later; track Le Chat Pro or API plan as a fee.",
            suggestedSubscriptionName: "Mistral plan",
            abilities: [.optionalKey, .recurringFee]
        ),
        .init(
            name: "google-ai",
            displayName: "Google AI / Gemini",
            category: "LLM",
            mode: .keyPlusSubscription,
            adapterKind: "google-ai",
            help: "Authoritative cash is Google Cloud Billing (server app). On phone: optional key + track AI Studio / Gemini plan fee.",
            suggestedSubscriptionName: "Gemini / Google AI",
            abilities: [.optionalKey, .recurringFee, .serverOnly]
        ),
        .init(
            name: "voyage",
            displayName: "Voyage AI",
            category: "LLM",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "No public usage/billing poll (same on the server). Track prepaid credits or plan fee here.",
            suggestedSubscriptionName: "Voyage",
            abilities: [.recurringFee]
        ),
        .init(
            name: "llamaindex",
            displayName: "LlamaIndex Cloud",
            category: "LLM",
            mode: .keyPlusSubscription,
            adapterKind: "llamaindex",
            help: "Track cloud plan fee; optional key for identity.",
            suggestedSubscriptionName: "LlamaIndex",
            abilities: [.optionalKey, .recurringFee]
        ),

        // —— Hosting / cloud ——
        .init(
            name: "cloudflare",
            displayName: "Cloudflare",
            category: "Hosting",
            mode: .keyPlusSubscription,
            adapterKind: "cloudflare",
            help: "Workers Paid and other plan fees — leave $0 for free tier. Optional API token on server for usage; phone tracks the fee.",
            abilities: [.optionalKey, .recurringFee, .serverOnly]
        ),
        .init(
            name: "render",
            displayName: "Render",
            category: "Hosting",
            mode: .keyPlusSubscription,
            adapterKind: "render",
            help: "Server polls Render; on phone track instance plan fees. Optional API key for later.",
            suggestedSubscriptionName: "Render services",
            abilities: [.optionalKey, .recurringFee, .serverOnly]
        ),
        .init(
            name: "vercel",
            displayName: "Vercel",
            category: "Hosting",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Billing export is server-side. Only set a fee if you pay Pro/Enterprise — free hobby stays $0.",
            abilities: [.recurringFee, .serverOnly]
        ),
        .init(
            name: "hetzner",
            displayName: "Hetzner Cloud",
            category: "Hosting",
            mode: .poll,
            adapterKind: "hetzner",
            keyFieldLabel: "Project API token",
            help: "Polls inventory + public pricing; pro-rates an estimated MTD (not an invoice). One token per Hetzner project.",
            abilities: [.pollEstimate]
        ),
        .init(
            name: "backblaze",
            displayName: "Backblaze B2",
            category: "Hosting",
            mode: .poll,
            adapterKind: "backblaze",
            keyFieldLabel: "keyId:applicationKey",
            help: "Polls bucket inventory; estimates storage from public prices. Prefer a read-only key.",
            abilities: [.pollEstimate]
        ),
        .init(
            name: "oracle",
            displayName: "Oracle Cloud",
            category: "Hosting",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Live OCI cost needs RSA signing (remote Usage Monitor). On phone: track paid add-ons; Always Free stays $0.",
            suggestedSubscriptionName: "OCI",
            abilities: [.recurringFee, .serverOnly]
        ),
        .init(
            name: "coolify",
            displayName: "Coolify",
            category: "Hosting",
            mode: .keyPlusSubscription,
            adapterKind: "coolify",
            help: "Self-hosted control plane. Track host cost as a fee; optional API token for fleet tooling.",
            suggestedSubscriptionName: "Coolify host",
            abilities: [.optionalKey, .recurringFee]
        ),
        .init(
            name: "deno",
            displayName: "Deno Deploy",
            category: "Hosting",
            mode: .keyPlusSubscription,
            adapterKind: "deno",
            help: "Retired.  Jay no longer hosts apps on Deno Deploy.  Congress.Trade now runs on Coolify.  Keep this row only for historical cost.",
            suggestedSubscriptionName: "Deno Deploy",
            abilities: [.optionalKey, .recurringFee, .serverOnly]
        ),
        .init(
            name: "github",
            displayName: "GitHub",
            category: "Dev tools",
            mode: .keyPlusSubscription,
            adapterKind: "github",
            help: "Copilot / org billing is server-side. Track Copilot or Teams seats as a fee.",
            suggestedMonthlyUsd: 10,
            suggestedSubscriptionName: "GitHub Copilot",
            abilities: [.optionalKey, .recurringFee, .serverOnly]
        ),
        .init(
            name: "cursor",
            displayName: "Cursor",
            category: "Dev tools",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "IDE subscription (common fleet cost). Enter Pro/Business fee.",
            suggestedMonthlyUsd: 20,
            suggestedSubscriptionName: "Cursor Pro",
            abilities: [.recurringFee]
        ),

        // —— Data / market ——
        .init(
            name: "fmp",
            displayName: "Financial Modeling Prep",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "No dollar poll API. Track the paid tier you use as a fee.",
            abilities: [.recurringFee]
        ),
        .init(
            name: "tiingo",
            displayName: "Tiingo",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Track paid tier if any.",
            abilities: [.recurringFee]
        ),
        .init(
            name: "finnhub",
            displayName: "Finnhub",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Free tier is rate-limited; track paid plan if used.",
            abilities: [.recurringFee]
        ),
        .init(
            name: "alphavantage",
            displayName: "Alpha Vantage",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Track premium if any.",
            abilities: [.recurringFee]
        ),
        .init(
            name: "twelvedata",
            displayName: "Twelve Data",
            category: "Market data",
            mode: .poll,
            adapterKind: "twelvedata",
            help: "Phone can poll usage-ish metrics; track paid credits as a fee too.",
            abilities: [.pollEstimate, .recurringFee]
        ),
        .init(
            name: "marketstack",
            displayName: "Marketstack",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Track paid tier.",
            abilities: [.recurringFee]
        ),
        .init(
            name: "massive",
            displayName: "Massive",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Track paid tier.",
            abilities: [.recurringFee]
        ),
        .init(
            name: "fred",
            displayName: "FRED",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Free API; only set a fee if you pay for something related.",
            abilities: [.recurringFee]
        ),
        .init(
            name: "quiver-quant",
            displayName: "Quiver Quant",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Track subscription plan.",
            abilities: [.recurringFee]
        ),
        .init(
            name: "roic",
            displayName: "ROIC.ai",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "No usage poll. Track plan as a fee.",
            abilities: [.recurringFee]
        ),
        .init(
            name: "intrinio",
            displayName: "Intrinio",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Track paid plan if used.",
            abilities: [.recurringFee]
        ),
        .init(
            name: "fintech-studios",
            displayName: "FinTech Studios",
            category: "Market data",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Track plan/credits if used.",
            abilities: [.recurringFee]
        ),
        .init(
            name: "unusual-whales",
            displayName: "Unusual Whales",
            category: "Market data",
            mode: .keyPlusSubscription,
            adapterKind: "unusual-whales",
            help: "Track paid plan; server has a usage adapter.",
            abilities: [.optionalKey, .recurringFee, .serverOnly]
        ),
        .init(
            name: "tradier",
            displayName: "Tradier",
            category: "Brokerage",
            mode: .keyPlusSubscription,
            adapterKind: "tradier",
            help: "Brokerage equity is not API spend — track account fees if needed.",
            abilities: [.optionalKey, .recurringFee]
        ),
        .init(
            name: "alpaca",
            displayName: "Alpaca",
            category: "Brokerage",
            mode: .keyPlusSubscription,
            adapterKind: "alpaca",
            help: "Track market data subscriptions if paid.",
            abilities: [.optionalKey, .recurringFee]
        ),
        .init(
            name: "robinhood",
            displayName: "Robinhood",
            category: "Brokerage",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Account balance is not a usage cost. Only add a fee if you pay Gold (or similar).",
            abilities: [.recurringFee]
        ),

        // —— Infra / observability ——
        .init(
            name: "pinecone",
            displayName: "Pinecone",
            category: "Infra",
            mode: .keyPlusSubscription,
            adapterKind: "pinecone",
            help: "Server inventories indexes; track Standard/Enterprise plan fee on phone.",
            abilities: [.optionalKey, .recurringFee, .serverOnly]
        ),
        .init(
            name: "sentry",
            displayName: "Sentry",
            category: "Observability",
            mode: .keyPlusSubscription,
            adapterKind: "sentry",
            help: "Track Team/Business plan fee.",
            abilities: [.optionalKey, .recurringFee, .serverOnly]
        ),
        .init(
            name: "langfuse",
            displayName: "Langfuse",
            category: "Observability",
            mode: .keyPlusSubscription,
            adapterKind: "langfuse",
            help: "Track cloud plan if used.",
            abilities: [.optionalKey, .recurringFee]
        ),
        .init(
            name: "stripe",
            displayName: "Stripe",
            category: "Payments",
            mode: .poll,
            adapterKind: "stripe",
            help: "Fees are % of volume — phone can help estimate; add a fixed ops fee if useful.",
            abilities: [.pollEstimate, .recurringFee]
        ),
        .init(
            name: "twilio",
            displayName: "Twilio",
            category: "Comms",
            mode: .poll,
            adapterKind: "twilio",
            help: "Polls usage-related metrics; track estimated monthly SMS/voice spend as a fee if needed.",
            abilities: [.pollEstimate, .recurringFee],
            requiresAccountSid: true
        ),
        .init(
            name: "resend",
            displayName: "Resend",
            category: "Comms",
            mode: .poll,
            adapterKind: "resend",
            help: "Track email plan; phone can poll where supported.",
            abilities: [.pollEstimate, .recurringFee]
        ),
        .init(
            name: "pushover",
            displayName: "Pushover",
            category: "Comms",
            mode: .poll,
            adapterKind: "pushover",
            help: "One-time license or multi-app; track if renewing.",
            abilities: [.pollEstimate, .recurringFee]
        ),
        .init(
            name: "apify",
            displayName: "Apify",
            category: "Data",
            mode: .poll,
            adapterKind: "apify",
            help: "Track platform plan; phone can poll usage where supported.",
            abilities: [.pollEstimate, .recurringFee]
        ),
        .init(
            name: "firecrawl",
            displayName: "Firecrawl",
            category: "Data",
            mode: .poll,
            adapterKind: "firecrawl",
            help: "Track credits plan.",
            abilities: [.pollEstimate, .recurringFee]
        ),
        .init(
            name: "simple-tools-relay",
            displayName: "Simple Tools Relay",
            category: "Fleet",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Built-in fleet relay — usually $0.",
            suggestedMonthlyUsd: 0,
            abilities: [.recurringFee]
        ),
        .init(
            name: "custom",
            displayName: "Custom / Other",
            category: "Other",
            mode: .subscription,
            adapterKind: "subscription_only",
            help: "Any other recurring tool cost not listed above.",
            suggestedSubscriptionName: "Custom subscription",
            abilities: [.recurringFee]
        ),
    ]

    public static var categories: [String] {
        Array(Set(all.map(\.category))).sorted()
    }

    public static func entry(name: String) -> LocalProviderCatalogEntry? {
        all.first { $0.name == name }
    }

    public static func filtered(search: String) -> [LocalProviderCatalogEntry] {
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return all }
        return all.filter {
            $0.displayName.lowercased().contains(q)
                || $0.name.contains(q)
                || $0.category.lowercased().contains(q)
                || $0.connectionSummary.lowercased().contains(q)
                || $0.help.lowercased().contains(q)
        }
    }

    /// Adapter kind that should be stored for a catalog slug (never blank).
    public static func preferredAdapterKind(forName name: String) -> String {
        entry(name: name)?.resolvedAdapterKind ?? "subscription_only"
    }

    /// Display name from catalog (for healing after renames).
    public static func preferredDisplayName(forName name: String) -> String? {
        entry(name: name)?.displayName
    }
}
