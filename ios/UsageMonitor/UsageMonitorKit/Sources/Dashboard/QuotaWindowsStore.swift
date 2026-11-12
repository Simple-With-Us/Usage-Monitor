import Foundation
import Observation
import AppCore
import Models
import Networking
import OfflineCache
import WidgetShared

/// Backs the Overview "Subscription Quotas" card. Same four-phase
/// `LoadState` shape as `IntelligenceStore` / `PortfolioHistoryStore`: a
/// first load populates `state`, later refresh failures over existing data
/// are surfaced via `lastError` without blanking the card.
@MainActor
@Observable
public final class QuotaWindowsStore {
    public private(set) var state: LoadState<QuotaWindowsResponse> = .idle
    public private(set) var requiresSession = false
    public private(set) var lastError: APIError?
    private var didLoadOnce = false
    /// Latest detached mirror task, awaited by the next refresh so older
    /// quota responses cannot be written after a newer one.
    private var mirrorTask: Task<Void, Never>?

    public init() {}

    public var response: QuotaWindowsResponse? { state.value }

    public func reset() {
        state = .idle
        requiresSession = false
        lastError = nil
        didLoadOnce = false
        mirrorTask?.cancel()
        mirrorTask = nil
    }

    public func loadIfNeeded(using client: APIClient) async {
        guard !didLoadOnce else { return }
        await refresh(using: client)
    }

    public func refresh(using client: APIClient) async {
        lastError = nil
        requiresSession = false
        if state.value == nil { state = .loading }

        do {
            let response = try await client.fetchQuotaWindows()
            state = .loaded(response)
            // Mirror into the app group so the Quotas widget topic has data.
            // Previously this response only ever reached the in-app card, so a
            // widget on this data had nothing to read.  SharedStore.update
            // does a synchronous read + JSON decode + encode + atomic write +
            // hardenFile; running that on the main actor every bootstrap,
            // pull-to-refresh, and loadIfNeeded stalls UI for the duration.
            // The snapshot is decoupled from any main-actor state at this
            // point, so hop the write off the actor.
            //
            // Chain onto the previous mirror task so a slow earlier write
            // cannot clobber a faster newer one: SharedStore.update's NSLock
            // serialises the bodies but imposes no ordering, so an unawaited
            // detached task would let the older response land last. Awaiting
            // `previous?.value` preserves fetch-completion order.
            let mirror = response
            mirrorTask = Task { [previous = mirrorTask] in
                await previous?.value
                WidgetSnapshotStore.updateQuotas(mirror)
            }
        } catch let error as APIError {
            handle(error)
        } catch {
            handle(.transport(error.localizedDescription))
        }
        didLoadOnce = true
    }

    private func handle(_ error: APIError) {
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
