import Foundation
import Observation
import AppCore
import Models
import Networking
import OfflineCache

@MainActor
@Observable
public final class IntelligenceStore {
    public private(set) var burnState: LoadState<LlmBurnResponse> = .idle
    public private(set) var claudeCostState: LoadState<ClaudeCostCheckResponse> = .idle
    public private(set) var keyAttributionState: LoadState<KeyAttributionResponse> = .idle
    public private(set) var requiresSession = false
    public private(set) var lastError: APIError?
    private var didLoadOnce = false

    public init() {}

    public var burn: LlmBurnResponse? { burnState.value }
    public var claudeCost: ClaudeCostCheckResponse? { claudeCostState.value }
    public var keyAttribution: KeyAttributionResponse? { keyAttributionState.value }

    public func reset() {
        burnState = .idle
        claudeCostState = .idle
        keyAttributionState = .idle
        requiresSession = false
        lastError = nil
        didLoadOnce = false
    }

    public func loadIfNeeded(using client: APIClient) async {
        guard !didLoadOnce else { return }
        await refresh(using: client)
    }

    public func refresh(using client: APIClient) async {
        lastError = nil
        requiresSession = false
        if burnState.value == nil { burnState = .loading }
        if claudeCostState.value == nil { claudeCostState = .loading }
        if keyAttributionState.value == nil { keyAttributionState = .loading }

        async let burnTask: Void = fetchBurn(using: client)
        async let claudeTask: Void = fetchClaude(using: client)
        async let keyTask: Void = fetchKeys(using: client)
        _ = await (burnTask, claudeTask, keyTask)
        didLoadOnce = true
    }

    private func fetchBurn(using client: APIClient) async {
        do {
            let response = try await client.llmBurn()
            burnState = .loaded(response)
            WidgetSnapshotStore.updateLlm(response)
        } catch let error as APIError {
            handle(error, on: &burnState)
        } catch {
            handle(.transport(error.localizedDescription), on: &burnState)
        }
    }

    private func fetchClaude(using client: APIClient) async {
        do {
            claudeCostState = .loaded(try await client.claudeCostCheck())
        } catch let error as APIError {
            handle(error, on: &claudeCostState)
        } catch {
            handle(.transport(error.localizedDescription), on: &claudeCostState)
        }
    }

    private func fetchKeys(using client: APIClient) async {
        do {
            keyAttributionState = .loaded(try await client.keyAttribution())
        } catch let error as APIError {
            handle(error, on: &keyAttributionState)
        } catch {
            handle(.transport(error.localizedDescription), on: &keyAttributionState)
        }
    }

    private func handle<T>(_ error: APIError, on state: inout LoadState<T>) {
        if case .unauthorized = error {
            requiresSession = true
            state = .idle
            return
        }
        if state.value == nil {
            state = .failed(error)
        } else {
            lastError = error
        }
    }
}
