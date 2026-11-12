import AppCore
import Foundation
import Models
import Networking
import Observation

/// Owns the Platforms tab's three independent reads.
///
/// They are deliberately separate `LoadState`s rather than one combined fetch:
/// `/api/platform-status`, `/api/server-metrics` and `/api/operations` fail
/// independently upstream, and an operator looking at this screen during an
/// incident needs whichever ones still answer.  One dead endpoint must never
/// blank the other two.
///
/// Follows `ServerStatus/HostUsageStore` exactly: probes are injectable for tests,
/// the client is passed per call (so switching hosts just passes a new client),
/// and a refresh failure keeps the previously loaded value rather than
/// replacing good data with an error.
@MainActor
@Observable
public final class PlatformsStore {
    public private(set) var platformState: LoadState<PlatformStatusPayload> = .idle
    public private(set) var hostState: LoadState<ServerMetrics> = .idle
    public private(set) var operationsState: LoadState<OperationsHealth> = .idle

    private let platformProbe: @Sendable (APIClient) async throws -> PlatformStatusPayload
    private let hostProbe: @Sendable (APIClient) async throws -> ServerMetrics
    private let operationsProbe: @Sendable (APIClient) async throws -> OperationsHealth

    public init(
        platformProbe: @escaping @Sendable (APIClient) async throws -> PlatformStatusPayload =
            PlatformsStore.livePlatformProbe,
        hostProbe: @escaping @Sendable (APIClient) async throws -> ServerMetrics =
            PlatformsStore.liveHostProbe,
        operationsProbe: @escaping @Sendable (APIClient) async throws -> OperationsHealth =
            PlatformsStore.liveOperationsProbe
    ) {
        self.platformProbe = platformProbe
        self.hostProbe = hostProbe
        self.operationsProbe = operationsProbe
    }

    public func loadIfNeeded(using client: APIClient) async {
        if case .idle = platformState {
            await load(using: client)
        }
    }

    public func load(using client: APIClient) async {
        if platformState.value == nil { platformState = .loading }
        if hostState.value == nil { hostState = .loading }
        if operationsState.value == nil { operationsState = .loading }
        await fetchAll(using: client)
    }

    public func refresh(using client: APIClient) async {
        await fetchAll(using: client)
    }

    public func reset() {
        platformState = .idle
        hostState = .idle
        operationsState = .idle
    }

    /// True while nothing at all has loaded yet — drives the initial skeleton.
    public var isInitialLoad: Bool {
        platformState.value == nil && hostState.value == nil && operationsState.value == nil
    }

    /// Every configured platform plus fleet app currently needing attention.
    /// This is what the tab badge and the top summary line count.
    ///
    /// A fleet app counts when it is anything other than cleanly running —
    /// down ("exited", "stopped", "restarting"), degraded ("running:unhealthy")
    /// or un-verifiable ("running:unknown").  Counting only "unknown" let the
    /// header announce "All Systems Normal" while the Fleet Apps section
    /// directly below it listed a stopped application.
    public var attentionCount: Int {
        let platformIssues = platformState.value?.attentionPlatforms.count ?? 0
        let hostIssues = hostState.value.map { metrics -> Int in
            var count = 0
            if metrics.prevention?.overall == "critical" { count += 1 }
            count += metrics.resources.filter {
                PlatformsStore.resourceNeedsAttention($0.status)
            }.count
            return count
        } ?? 0
        return platformIssues + hostIssues
    }

    /// Whether one Coolify resource status is anything other than cleanly running.
    ///
    /// Coolify reports `"<state>"` or `"<state>:<health>"` — "running:healthy",
    /// "running:unknown", "exited", "restarting:starting".  This splits on the
    /// colon instead of substring-matching, because "running:unhealthy"
    /// *contains* "healthy": substring checks silently score a degraded app as
    /// fine.  A bare "running" (what Coolify databases report, having no
    /// container healthcheck) is accepted; every other shape, including an
    /// unrecognised one, is something a human should look at.
    ///
    /// Mirrors `classifyCoolifyStatus` in
    /// `src/lib/platform-status/probes/hosting.ts` so the tab badge and the web
    /// hosting card agree on what "down" means.
    nonisolated static func resourceNeedsAttention(_ rawStatus: String) -> Bool {
        let parts = rawStatus.lowercased().split(
            separator: ":",
            maxSplits: 1,
            omittingEmptySubsequences: false
        )
        let state = parts.first?.trimmingCharacters(in: .whitespaces) ?? ""
        let health = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : ""
        guard state == "running" else { return true }
        return !(health.isEmpty || health == "healthy")
    }

    private func fetchAll(using client: APIClient) async {
        if ProcessInfo.processInfo.arguments.contains("-ScreenshotDemo") {
            platformState = .loaded(.sample)
            hostState = .loaded(.sample)
            operationsState = .loaded(.sample)
            return
        }
        // Concurrent, independent, and each failure is contained to its own
        // state so a single dead upstream cannot blank the screen.
        async let platforms: Void = fetchPlatforms(using: client)
        async let host: Void = fetchHost(using: client)
        async let operations: Void = fetchOperations(using: client)
        _ = await (platforms, host, operations)
    }

    private func fetchPlatforms(using client: APIClient) async {
        do {
            platformState = .loaded(try await platformProbe(client))
        } catch let error as APIError {
            if platformState.value == nil { platformState = .failed(error) }
        } catch {
            if platformState.value == nil {
                platformState = .failed(.transport(error.localizedDescription))
            }
        }
    }

    private func fetchHost(using client: APIClient) async {
        do {
            hostState = .loaded(try await hostProbe(client))
        } catch let error as APIError {
            if hostState.value == nil { hostState = .failed(error) }
        } catch {
            if hostState.value == nil {
                hostState = .failed(.transport(error.localizedDescription))
            }
        }
    }

    private func fetchOperations(using client: APIClient) async {
        do {
            operationsState = .loaded(try await operationsProbe(client))
        } catch let error as APIError {
            if operationsState.value == nil { operationsState = .failed(error) }
        } catch {
            if operationsState.value == nil {
                operationsState = .failed(.transport(error.localizedDescription))
            }
        }
    }

    nonisolated public static let livePlatformProbe:
        @Sendable (APIClient) async throws -> PlatformStatusPayload = { client in
            try await client.platformStatus()
        }

    nonisolated public static let liveHostProbe:
        @Sendable (APIClient) async throws -> ServerMetrics = { client in
            try await client.serverMetrics()
        }

    nonisolated public static let liveOperationsProbe:
        @Sendable (APIClient) async throws -> OperationsHealth = { client in
            try await client.operations()
        }
}
