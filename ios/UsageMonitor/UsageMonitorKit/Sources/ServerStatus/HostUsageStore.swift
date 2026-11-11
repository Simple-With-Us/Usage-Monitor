import Foundation
import Observation
import Models
import Networking
import AppCore
import OfflineCache

/// Owns the Server-tab host-usage panel. Requires a read token
/// (`GET /api/server-metrics`).
@MainActor
@Observable
final class HostUsageStore {
    private(set) var state: LoadState<ServerMetrics> = .idle

    private let probe: @Sendable (APIClient) async throws -> ServerMetrics

    init(probe: @escaping @Sendable (APIClient) async throws -> ServerMetrics = HostUsageStore.liveProbe) {
        self.probe = probe
    }

    func loadIfNeeded(using client: APIClient) async {
        if case .idle = state { await load(using: client) }
    }

    func load(using client: APIClient) async {
        if state.value == nil { state = .loading }
        await fetch(using: client)
    }

    func refresh(using client: APIClient) async {
        await fetch(using: client)
    }

    func reset() {
        state = .idle
    }

    private func fetch(using client: APIClient) async {
        do {
            let metrics = try await probe(client)
            state = .loaded(metrics)
            WidgetSnapshotStore.updateServerHost(metrics)
        } catch let error as APIError {
            handle(error)
        } catch {
            handle(.transport(error.localizedDescription))
        }
    }

    private func handle(_ error: APIError) {
        if state.value == nil {
            state = .failed(error)
        }
    }

    nonisolated static let liveProbe: @Sendable (APIClient) async throws -> ServerMetrics = { client in
        try await client.serverMetrics()
    }
}
