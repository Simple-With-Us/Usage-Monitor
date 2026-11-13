import Foundation
import Observation
import Models
import Networking
import AppCore

/// Owns the Agents tab. Reads `GET /api/agents-overview` for a fixed 30-day
/// window (bearer or session). Lookback pills were removed — Coding Agents
/// shows Agent Bar quota windows via `QuotaWindowsStore` instead.
@MainActor
@Observable
final class AgentsStore {
    private(set) var state: LoadState<AgentsOverviewResponse> = .idle
    var window: String = "30d"

    private let probe: @Sendable (APIClient, String) async throws -> AgentsOverviewResponse

    init(probe: @escaping @Sendable (APIClient, String) async throws -> AgentsOverviewResponse = AgentsStore.liveProbe) {
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

    func setWindow(_ newWindow: String, using client: APIClient) async {
        guard window != newWindow else { return }
        window = newWindow
        await load(using: client)
    }

    func reset() {
        state = .idle
    }

    private func fetch(using client: APIClient) async {
        if ProcessInfo.processInfo.arguments.contains("-ScreenshotDemo") {
            state = .loaded(.sample)
            return
        }
        do {
            state = .loaded(try await probe(client, window))
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

    nonisolated static let liveProbe: @Sendable (APIClient, String) async throws -> AgentsOverviewResponse = { client, window in
        try await client.agentsOverview(window: window)
    }
}
