import Foundation
import Observation
import Models
import Networking
import AppCore
import OfflineCache

/// Owns the Computers tab.  Reads `GET /api/health/mac` (bearer or session).
@MainActor
@Observable
final class ComputersStore {
    private(set) var state: LoadState<MacHealthResponse> = .idle

    /// A refresh error that occurred while Mac data was already on screen.
    /// `state` stays `.loaded`; the root shows this as a transient banner.
    private(set) var lastError: APIError?

    private let probe: @Sendable (APIClient) async throws -> MacHealthResponse

    init(probe: @escaping @Sendable (APIClient) async throws -> MacHealthResponse = ComputersStore.liveProbe) {
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
        lastError = nil
    }

    private func fetch(using client: APIClient) async {
        if ProcessInfo.processInfo.arguments.contains("-ScreenshotDemo") {
            state = .loaded(.sample)
            return
        }
        do {
            let health = try await probe(client)
            state = .loaded(health)
            lastError = nil
            WidgetSnapshotStore.updateMac(health)
            WidgetSnapshotStore.reloadWidgetsIfNeeded(force: true)
        } catch let error as APIError {
            handle(error)
        } catch {
            handle(.transport(error.localizedDescription))
        }
    }

    private func handle(_ error: APIError) {
        if state.value == nil {
            state = .failed(error)
        } else {
            lastError = error
        }
    }

    nonisolated static let liveProbe: @Sendable (APIClient) async throws -> MacHealthResponse = { client in
        try await client.macHealth()
    }
}
