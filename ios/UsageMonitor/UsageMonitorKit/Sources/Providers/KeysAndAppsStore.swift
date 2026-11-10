import AppCore
import Foundation
import Models
import Networking
import Observation

/// Owns the single read behind the **Keys & Apps** screen:
/// `GET /api/key-attribution`.
///
/// Two things make this store different from `HostUsageStore`, and both are
/// deliberate:
///
///  1. The route is **session-only** (`authorization: .session`). With no
///     dashboard session the server answers 401, which arrives here as
///     `APIError.unauthorized`. That is not a failure to show the user as an
///     error screen — it is a missing capability with an obvious next step, so
///     it sets ``requiresSession`` and the screen renders the same
///     "Full Dashboard Access Required → Open Settings" card the Dashboard
///     intelligence section uses (`Dashboard/IntelligenceStore.swift`).
///  2. A *refresh* failure never replaces good data. The operator keeps looking
///     at the last successful attribution snapshot with the error noted, rather
///     than at an empty screen.
///
/// The probe is injectable so tests drive it through the real `APIClient`
/// against a `URLProtocol` stub without any parallel mock of the request path.
@MainActor
@Observable
public final class KeysAndAppsStore {
    public private(set) var state: LoadState<KeyAttributionResponse> = .idle

    /// Set when the server rejected the read for want of a dashboard session.
    /// The screen renders the sign-in affordance, not an error.
    public private(set) var requiresSession = false

    /// A refresh failure that arrived while loaded data was still on screen.
    public private(set) var lastError: APIError?

    private let probe: @Sendable (APIClient) async throws -> KeyAttributionResponse

    /// The `AppEnvironment.accessIdentityRevision` this store's data belongs
    /// to. A host switch or credential change bumps it; see ``adopt(identityRevision:)``.
    private var identityRevision: UInt?

    public init(
        probe: @escaping @Sendable (APIClient) async throws -> KeyAttributionResponse =
            KeysAndAppsStore.liveProbe
    ) {
        self.probe = probe
    }

    // MARK: - Derived reads

    public var payload: KeyAttributionResponse? { state.value }

    public var coverage: KeyAttributionCoverage? { state.value?.coverage }

    /// Registered identities, active ones first, then alphabetical by label.
    /// Matches the web panel's `status asc, provider, alias` ordering without
    /// depending on the server preserving it.
    public var identities: [KeyAttributionIdentityLite] {
        (state.value?.identities ?? []).sorted { left, right in
            if left.isRetired != right.isRetired { return !left.isRetired }
            let leftProvider = left.provider?.title ?? ""
            let rightProvider = right.provider?.title ?? ""
            if leftProvider != rightProvider {
                return leftProvider.localizedCaseInsensitiveCompare(rightProvider) == .orderedAscending
            }
            return left.title.localizedCaseInsensitiveCompare(right.title) == .orderedAscending
        }
    }

    /// Producer references that carried v2 records nothing could be attributed
    /// to, most expensive first (the server already sorts; re-sorting keeps the
    /// screen stable if that ever changes).
    public var unattributedBuckets: [KeyAttributionUnattributedBucket] {
        (coverage?.unattributedBuckets ?? []).sorted { left, right in
            let leftCost = left.costUsd ?? 0
            let rightCost = right.costUsd ?? 0
            if leftCost != rightCost { return leftCost > rightCost }
            return (left.eventCount ?? 0) > (right.eventCount ?? 0)
        }
    }

    /// True once a successful read produced neither an identity nor an
    /// unattributed reference — i.e. there is genuinely nothing mapped yet.
    public var isEmpty: Bool {
        state.value != nil && identities.isEmpty && unattributedBuckets.isEmpty
    }

    /// A server-side unattribution code (`unknown_provider_key`) rendered as
    /// prose ("Unknown provider key").
    public static func humanizedReason(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "Unattributed" }
        let spaced = raw.replacingOccurrences(of: "_", with: " ")
        return spaced.prefix(1).uppercased() + spaced.dropFirst()
    }

    // MARK: - Loading

    public func loadIfNeeded(using client: APIClient) async {
        if case .idle = state { await load(using: client) }
    }

    public func load(using client: APIClient) async {
        // Set synchronously so a second `.task` firing in the same runloop turn
        // sees `.loading` instead of `.idle` and does not double-fetch.
        if state.value == nil { state = .loading }
        await fetch(using: client)
    }

    public func refresh(using client: APIClient) async {
        await fetch(using: client)
    }

    public func reset() {
        state = .idle
        requiresSession = false
        lastError = nil
    }

    /// Drop data that belongs to a previous host or credential.
    ///
    /// The screen calls this from `.task(id: env?.accessIdentityRevision)`,
    /// which also fires on first appearance — so the first adoption must NOT
    /// count as a change, or every appearance would discard a warm cache.
    public func adopt(identityRevision revision: UInt) {
        defer { identityRevision = revision }
        guard let current = identityRevision, current != revision else { return }
        reset()
    }

    private func fetch(using client: APIClient) async {
        do {
            let payload = try await probe(client)
            state = .loaded(payload)
            requiresSession = false
            lastError = nil
        } catch let error as APIError {
            handle(error)
        } catch {
            handle(.transport(error.localizedDescription))
        }
    }

    private func handle(_ error: APIError) {
        // No dashboard session is a capability gap, not a failure: keep the
        // state neutral so the screen offers Settings instead of an error.
        if case .unauthorized = error {
            requiresSession = true
            state = .idle
            lastError = nil
            return
        }
        if state.value == nil {
            state = .failed(error)
        } else {
            lastError = error
        }
    }

    nonisolated public static let liveProbe:
        @Sendable (APIClient) async throws -> KeyAttributionResponse = { client in
            try await client.keyAttribution()
        }
}
