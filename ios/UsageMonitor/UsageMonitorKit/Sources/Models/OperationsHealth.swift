import Foundation

/// `GET /api/operations` — the fleet operations aggregator behind the web Ops
/// page: receipt inbox, peer app infrastructure, the Coolify fleet rollup, and
/// Cloudflare R2 free-tier usage.
///
/// Deliberately partial: this declares only the subset the iOS Platforms tab
/// renders.  Following the house convention every field is optional or
/// defaulted, so fields added or reshaped on the server degrade one row rather
/// than failing the decode.
///
/// Per-app backup detail is NOT redeclared here — it already exists as
/// `ServerMetrics.FleetBackups`, which `/api/server-metrics` returns.
public struct OperationsHealth: Codable, Hashable, Sendable {
    public var receiptInbox: ReceiptInbox?
    public var socraticInfrastructure: PeerInfrastructure?
    public var congressInfrastructure: PeerInfrastructure?
    public var coolifyFleet: CoolifyFleet?
    public var r2Fleet: R2Fleet?
    public var fetchedAt: String?

    public init(
        receiptInbox: ReceiptInbox? = nil,
        socraticInfrastructure: PeerInfrastructure? = nil,
        congressInfrastructure: PeerInfrastructure? = nil,
        coolifyFleet: CoolifyFleet? = nil,
        r2Fleet: R2Fleet? = nil,
        fetchedAt: String? = nil
    ) {
        self.receiptInbox = receiptInbox
        self.socraticInfrastructure = socraticInfrastructure
        self.congressInfrastructure = congressInfrastructure
        self.coolifyFleet = coolifyFleet
        self.r2Fleet = r2Fleet
        self.fetchedAt = fetchedAt
    }

    /// Mirrors the server's `OperationalState` union.  Unknown values decode
    /// to `.unavailable` rather than throwing.
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
            self = State(rawValue: raw) ?? .unavailable
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

        public var needsAttention: Bool {
            switch self {
            case .healthy, .receiving, .unconfigured: return false
            case .degraded, .stale, .unavailable, .unreachable: return true
            }
        }
    }

    public struct ReceiptInbox: Codable, Hashable, Sendable {
        public var configured: Bool
        public var state: State
        public var needsReviewCount: Int?
        public var countIsLowerBound: Bool
        public var latestReceivedAt: String?

        public init(
            configured: Bool = false,
            state: State = .unconfigured,
            needsReviewCount: Int? = nil,
            countIsLowerBound: Bool = false,
            latestReceivedAt: String? = nil
        ) {
            self.configured = configured
            self.state = state
            self.needsReviewCount = needsReviewCount
            self.countIsLowerBound = countIsLowerBound
            self.latestReceivedAt = latestReceivedAt
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            configured = (try? container.decode(Bool.self, forKey: .configured)) ?? false
            state = (try? container.decode(State.self, forKey: .state)) ?? .unconfigured
            needsReviewCount = try? container.decodeIfPresent(Int.self, forKey: .needsReviewCount)
            countIsLowerBound =
                (try? container.decode(Bool.self, forKey: .countIsLowerBound)) ?? false
            latestReceivedAt = try? container.decodeIfPresent(
                String.self, forKey: .latestReceivedAt)
        }
    }

    /// A sibling fleet app's public health (Socratic.Trade or Congress.Trade).
    public struct PeerInfrastructure: Codable, Hashable, Sendable {
        public var state: State
        public var releaseSha: String?
        public var processUptimeSeconds: Double?
        public var recentRestart: Bool
        public var database: String?
        public var schedulerStale: Bool
        public var storageDegraded: Bool
        public var litestreamState: String?
        public var litestreamAgeSeconds: Double?

        public init(
            state: State = .unavailable,
            releaseSha: String? = nil,
            processUptimeSeconds: Double? = nil,
            recentRestart: Bool = false,
            database: String? = nil,
            schedulerStale: Bool = false,
            storageDegraded: Bool = false,
            litestreamState: String? = nil,
            litestreamAgeSeconds: Double? = nil
        ) {
            self.state = state
            self.releaseSha = releaseSha
            self.processUptimeSeconds = processUptimeSeconds
            self.recentRestart = recentRestart
            self.database = database
            self.schedulerStale = schedulerStale
            self.storageDegraded = storageDegraded
            self.litestreamState = litestreamState
            self.litestreamAgeSeconds = litestreamAgeSeconds
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            state = (try? container.decode(State.self, forKey: .state)) ?? .unavailable
            releaseSha = try? container.decodeIfPresent(String.self, forKey: .releaseSha)
            processUptimeSeconds = try? container.decodeIfPresent(
                Double.self, forKey: .processUptimeSeconds)
            recentRestart = (try? container.decode(Bool.self, forKey: .recentRestart)) ?? false
            database = try? container.decodeIfPresent(String.self, forKey: .database)
            schedulerStale = (try? container.decode(Bool.self, forKey: .schedulerStale)) ?? false
            storageDegraded = (try? container.decode(Bool.self, forKey: .storageDegraded)) ?? false
            litestreamState = try? container.decodeIfPresent(String.self, forKey: .litestreamState)
            litestreamAgeSeconds = try? container.decodeIfPresent(
                Double.self, forKey: .litestreamAgeSeconds)
        }
    }

    public struct CoolifyFleet: Codable, Hashable, Sendable {
        public var configured: Bool
        public var state: State
        public var applications: [Resource]
        public var appsUp: Int?
        public var appsDown: Int?
        public var appsDegraded: Int?
        public var appsUnknown: Int?

        public init(
            configured: Bool = false,
            state: State = .unconfigured,
            applications: [Resource] = [],
            appsUp: Int? = nil,
            appsDown: Int? = nil,
            appsDegraded: Int? = nil,
            appsUnknown: Int? = nil
        ) {
            self.configured = configured
            self.state = state
            self.applications = applications
            self.appsUp = appsUp
            self.appsDown = appsDown
            self.appsDegraded = appsDegraded
            self.appsUnknown = appsUnknown
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            configured = (try? container.decode(Bool.self, forKey: .configured)) ?? false
            state = (try? container.decode(State.self, forKey: .state)) ?? .unconfigured
            applications = (try? container.decode([Resource].self, forKey: .applications)) ?? []
            appsUp = try? container.decodeIfPresent(Int.self, forKey: .appsUp)
            appsDown = try? container.decodeIfPresent(Int.self, forKey: .appsDown)
            appsDegraded = try? container.decodeIfPresent(Int.self, forKey: .appsDegraded)
            appsUnknown = try? container.decodeIfPresent(Int.self, forKey: .appsUnknown)
        }

        public struct Resource: Codable, Hashable, Sendable, Identifiable {
            public var name: String?
            public var type: String?
            public var status: String?
            public var health: String?
            public var up: Bool?
            public var degraded: Bool
            public var fqdn: String?

            public var id: String { name ?? fqdn ?? UUID().uuidString }

            public init(
                name: String? = nil,
                type: String? = nil,
                status: String? = nil,
                health: String? = nil,
                up: Bool? = nil,
                degraded: Bool = false,
                fqdn: String? = nil
            ) {
                self.name = name
                self.type = type
                self.status = status
                self.health = health
                self.up = up
                self.degraded = degraded
                self.fqdn = fqdn
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                name = try? container.decodeIfPresent(String.self, forKey: .name)
                type = try? container.decodeIfPresent(String.self, forKey: .type)
                status = try? container.decodeIfPresent(String.self, forKey: .status)
                health = try? container.decodeIfPresent(String.self, forKey: .health)
                up = try? container.decodeIfPresent(Bool.self, forKey: .up)
                degraded = (try? container.decode(Bool.self, forKey: .degraded)) ?? false
                fqdn = try? container.decodeIfPresent(String.self, forKey: .fqdn)
            }

            /// True when Coolify reports the app running but cannot say whether
            /// its health check passes.  This is a real, live condition on the
            /// fleet host and deserves its own treatment in the UI — it is
            /// neither "up" nor "down".
            public var healthUnknown: Bool {
                guard up == true else { return false }
                let raw = (status ?? "").lowercased()
                return raw.contains("unknown") || (health ?? "").lowercased() == "unknown"
            }
        }
    }

    /// Cloudflare R2 free-tier usage across the three fleet accounts.
    /// Field names mirror `R2FleetSummary` / `R2FleetAccountSnapshot` in
    /// `src/lib/r2-usage.ts` exactly — a rename there silently blanks this
    /// section here, so the two must be changed together.
    public struct R2Fleet: Codable, Hashable, Sendable {
        public var configured: Bool
        public var accounts: [Account]
        public var anyOnTrackToExceed: Bool
        public var fetchedAt: String?

        public init(
            configured: Bool = false,
            accounts: [Account] = [],
            anyOnTrackToExceed: Bool = false,
            fetchedAt: String? = nil
        ) {
            self.configured = configured
            self.accounts = accounts
            self.anyOnTrackToExceed = anyOnTrackToExceed
            self.fetchedAt = fetchedAt
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            configured = (try? container.decode(Bool.self, forKey: .configured)) ?? false
            accounts = (try? container.decode([Account].self, forKey: .accounts)) ?? []
            anyOnTrackToExceed =
                (try? container.decode(Bool.self, forKey: .anyOnTrackToExceed)) ?? false
            fetchedAt = try? container.decodeIfPresent(String.self, forKey: .fetchedAt)
        }

        /// One metric against its free-tier limit (storage or class A/B ops).
        public struct MetricStatus: Codable, Hashable, Sendable {
            public var actual: Double?
            public var limit: Double?
            public var mtdPct: Double?
            public var projectedPct: Double?
            public var onTrackToExceed: Bool

            public init(
                actual: Double? = nil,
                limit: Double? = nil,
                mtdPct: Double? = nil,
                projectedPct: Double? = nil,
                onTrackToExceed: Bool = false
            ) {
                self.actual = actual
                self.limit = limit
                self.mtdPct = mtdPct
                self.projectedPct = projectedPct
                self.onTrackToExceed = onTrackToExceed
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                actual = try? container.decodeIfPresent(Double.self, forKey: .actual)
                limit = try? container.decodeIfPresent(Double.self, forKey: .limit)
                mtdPct = try? container.decodeIfPresent(Double.self, forKey: .mtdPct)
                projectedPct = try? container.decodeIfPresent(Double.self, forKey: .projectedPct)
                onTrackToExceed =
                    (try? container.decode(Bool.self, forKey: .onTrackToExceed)) ?? false
            }
        }

        public struct Account: Codable, Hashable, Sendable, Identifiable {
            public var id: String
            public var label: String?
            public var configured: Bool
            public var status: String?
            public var storage: MetricStatus?
            public var overallOnTrackToExceed70Pct: Bool
            public var error: String?
            /// Mirror of `R2FleetAccountSnapshot.metricsSource` — Jay Old
            /// ships `r2_not_enabled` so leftover GraphQL storage is ignored.
            public var metricsSource: String?

            public init(
                id: String,
                label: String? = nil,
                configured: Bool = false,
                status: String? = nil,
                storage: MetricStatus? = nil,
                overallOnTrackToExceed70Pct: Bool = false,
                error: String? = nil,
                metricsSource: String? = nil
            ) {
                self.id = id
                self.label = label
                self.configured = configured
                self.status = status
                self.storage = storage
                self.overallOnTrackToExceed70Pct = overallOnTrackToExceed70Pct
                self.error = error
                self.metricsSource = metricsSource
            }

            public init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                id = (try? container.decode(String.self, forKey: .id)) ?? UUID().uuidString
                label = try? container.decodeIfPresent(String.self, forKey: .label)
                configured = (try? container.decode(Bool.self, forKey: .configured)) ?? false
                status = try? container.decodeIfPresent(String.self, forKey: .status)
                storage = try? container.decodeIfPresent(MetricStatus.self, forKey: .storage)
                overallOnTrackToExceed70Pct =
                    (try? container.decode(Bool.self, forKey: .overallOnTrackToExceed70Pct))
                    ?? false
                error = try? container.decodeIfPresent(String.self, forKey: .error)
                metricsSource = try? container.decodeIfPresent(String.self, forKey: .metricsSource)
            }
        }
    }
}
