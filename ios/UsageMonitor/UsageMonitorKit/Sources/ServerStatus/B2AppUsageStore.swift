import Foundation
import Observation
import Models
import Networking
import AppCore

@MainActor
@Observable
final class B2AppUsageStore {
    private(set) var state: LoadState<B2AppUsageBreakdown> = .idle

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
            let payload = try await client.b2AppUsage()
            state = .loaded(payload)
        } catch let error as APIError {
            if state.value == nil {
                state = .failed(error)
            }
        } catch {
            if state.value == nil {
                state = .failed(.transport(error.localizedDescription))
            }
        }
    }
}
