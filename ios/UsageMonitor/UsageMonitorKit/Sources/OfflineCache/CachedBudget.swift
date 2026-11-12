import Foundation
import Models

/// A timestamped envelope around the last-good `BudgetStatusResponse`.
///
/// The server's `generatedAt` tells you when the *data* was produced; `cachedAt`
/// tells you when this device last *successfully persisted* it. The two differ
/// when a fetch returns an unchanged (or slightly aged) server snapshot, and the
/// UI's "stale as of …" indicator keys off `cachedAt` — the moment we last
/// confirmed connectivity — via ``BudgetStaleness``.
///
/// Owned by the **OfflineCache** lane. `Models`-only; no `AppCore` dependency.
public struct CachedBudget: Codable, Equatable, Sendable {
    /// The last successfully-fetched budget payload.
    public var response: BudgetStatusResponse
    /// When this device wrote the payload to disk (wall-clock of the fetch).
    public var cachedAt: Date

    public init(response: BudgetStatusResponse, cachedAt: Date = Date()) {
        self.response = response
        self.cachedAt = cachedAt
    }

    /// Staleness descriptor for this entry (see ``BudgetStaleness``).
    public func staleness(threshold: TimeInterval = BudgetStaleness.defaultThreshold) -> BudgetStaleness {
        BudgetStaleness(cachedAt: cachedAt, threshold: threshold)
    }
}
