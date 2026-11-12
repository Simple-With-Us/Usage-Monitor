import Foundation

/// `GET /api/platform-status` — one status card per external platform the
/// fleet runs on (hosting, edge, storage, observability, developer, messaging,
/// payments, secrets).
///
/// Companion to `ServerMetrics`, which is host-centric (one Hetzner box and
/// its Coolify apps).  This payload is breadth-first across every platform.
///
/// Decoding follows the house rule for server payloads: every field is
/// optional or defaulted and unknown enum values fall back to a safe case, so
/// a server-side shape change degrades one row instead of failing the whole
/// screen.
public struct PlatformStatusPayload: Codable, Hashable, Sendable {
    public var platforms: [PlatformCard]
    public var summary: Summary?
    public var degraded: Bool
    public var stale: Bool
    public var cacheAgeSeconds: Int?
    public var fetchedAt: String?
    public var warnings: [String]?

    public init(
        platforms: [PlatformCard] = [],
        summary: Summary? = nil,
        degraded: Bool = false,
        stale: Bool = false,
        cacheAgeSeconds: Int? = nil,
        fetchedAt: String? = nil,
        warnings: [String]? = nil
    ) {
        self.platforms = platforms
        self.summary = summary
        self.degraded = degraded
        self.stale = stale
        self.cacheAgeSeconds = cacheAgeSeconds
        self.fetchedAt = fetchedAt
        self.warnings = warnings
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        platforms = (try? container.decode([PlatformCard].self, forKey: .platforms)) ?? []
        summary = try? container.decodeIfPresent(Summary.self, forKey: .summary)
        degraded = (try? container.decode(Bool.self, forKey: .degraded)) ?? false
        stale = (try? container.decode(Bool.self, forKey: .stale)) ?? false
        cacheAgeSeconds = try? container.decodeIfPresent(Int.self, forKey: .cacheAgeSeconds)
        fetchedAt = try? container.decodeIfPresent(String.self, forKey: .fetchedAt)
        warnings = try? container.decodeIfPresent([String].self, forKey: .warnings)
    }

    public struct Summary: Codable, Hashable, Sendable {
        public var total: Int?
        public var configured: Int?
        public var healthy: Int?
        public var degraded: Int?
        public var unconfigured: Int?

        public init(
            total: Int? = nil,
            configured: Int? = nil,
            healthy: Int? = nil,
            degraded: Int? = nil,
            unconfigured: Int? = nil
        ) {
            self.total = total
            self.configured = configured
            self.healthy = healthy
            self.degraded = degraded
            self.unconfigured = unconfigured
        }
    }

    /// Matches the server's `PlatformCategory` union.  Unknown values decode to
    /// `.other` so a new server-side category never breaks the screen.
    public enum Category: String, Codable, Hashable, Sendable, CaseIterable {
        case hosting
        case edge
        case storage
        case observability
        case developer
        case messaging
        case payments
        case secrets
        case other

        public init(from decoder: Decoder) throws {
            let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? ""
            self = Category(rawValue: raw) ?? .other
        }

        /// Section heading.  Title Case, matching the web page.
        public var title: String {
            switch self {
            case .hosting: return "Hosting & Compute"
            case .edge: return "Edge & Network"
            case .storage: return "Storage & Backups"
            case .observability: return "Observability"
            case .developer: return "Developer & Release"
            case .messaging: return "Messaging & Delivery"
            case .payments: return "Payments"
            case .secrets: return "Secrets"
            case .other: return "Other"
            }
        }
    }

    /// Matches the server's `OperationalState` union.
    public enum State: String, Codable, Hashable, Sendable {
        case healthy
        case receiving
        case degraded
        case stale
        case unavailable
        case unreachable
        case unconfigured

        public init(from decoder: Decoder) throws {
            let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? ""
            self = State(rawValue: raw) ?? .unconfigured
        }

        public var title: String {
            switch self {
            case .healthy: return "Healthy"
            case .receiving: return "Receiving"
            case .degraded: return "Degraded"
            case .stale: return "Stale"
            case .unavailable: return "Unavailable"
            case .unreachable: return "Unreachable"
            case .unconfigured: return "Not Configured"
            }
        }

        /// True when this state should draw the operator's attention.
        public var needsAttention: Bool {
            switch self {
            case .healthy, .receiving, .unconfigured: return false
            case .degraded, .stale, .unavailable, .unreachable: return true
            }
        }
    }

    public struct Metric: Codable, Hashable, Sendable, Identifiable {
        public var label: String
        public var value: String
        public var hint: String?
        /// Optional 0–100 fill for a usage bar.  Clients never print this as %.
        public var usagePct: Double?

        public var id: String { label }

        public init(label: String, value: String, hint: String? = nil, usagePct: Double? = nil) {
            self.label = label
            self.value = value
            self.hint = hint
            self.usagePct = usagePct
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            label = (try? container.decode(String.self, forKey: .label)) ?? ""
            value = (try? container.decode(String.self, forKey: .value)) ?? ""
            hint = try? container.decodeIfPresent(String.self, forKey: .hint)
            usagePct = try? container.decodeIfPresent(Double.self, forKey: .usagePct)
        }
    }

    public struct PlatformCard: Codable, Hashable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var category: Category
        public var configured: Bool
        public var state: State
        public var headline: String?
        public var metrics: [Metric]
        public var requiredEnv: [String]
        public var consoleUrl: String?
        public var fetchedAt: String?
        public var error: String?

        public init(
            id: String,
            name: String,
            category: Category = .other,
            configured: Bool = false,
            state: State = .unconfigured,
            headline: String? = nil,
            metrics: [Metric] = [],
            requiredEnv: [String] = [],
            consoleUrl: String? = nil,
            fetchedAt: String? = nil,
            error: String? = nil
        ) {
            self.id = id
            self.name = name
            self.category = category
            self.configured = configured
            self.state = state
            self.headline = headline
            self.metrics = metrics
            self.requiredEnv = requiredEnv
            self.consoleUrl = consoleUrl
            self.fetchedAt = fetchedAt
            self.error = error
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = (try? container.decode(String.self, forKey: .id)) ?? UUID().uuidString
            name = (try? container.decode(String.self, forKey: .name)) ?? id
            category = (try? container.decode(Category.self, forKey: .category)) ?? .other
            configured = (try? container.decode(Bool.self, forKey: .configured)) ?? false
            state = (try? container.decode(State.self, forKey: .state)) ?? .unconfigured
            headline = try? container.decodeIfPresent(String.self, forKey: .headline)
            metrics = (try? container.decode([Metric].self, forKey: .metrics)) ?? []
            requiredEnv = (try? container.decode([String].self, forKey: .requiredEnv)) ?? []
            consoleUrl = try? container.decodeIfPresent(String.self, forKey: .consoleUrl)
            fetchedAt = try? container.decodeIfPresent(String.self, forKey: .fetchedAt)
            error = try? container.decodeIfPresent(String.self, forKey: .error)
        }
    }

    /// Cards grouped for sectioned rendering, in the server's own order.
    public var groupedByCategory: [(category: Category, platforms: [PlatformCard])] {
        var order: [Category] = []
        var buckets: [Category: [PlatformCard]] = [:]
        for platform in platforms {
            if buckets[platform.category] == nil {
                order.append(platform.category)
                buckets[platform.category] = []
            }
            buckets[platform.category]?.append(platform)
        }
        return order.map { ($0, buckets[$0] ?? []) }
    }

    /// Configured platforms that currently need attention, worst first.
    public var attentionPlatforms: [PlatformCard] {
        platforms.filter { $0.configured && $0.state.needsAttention }
    }
}
