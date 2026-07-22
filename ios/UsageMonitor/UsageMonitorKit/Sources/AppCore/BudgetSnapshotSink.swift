import Foundation
import Models

/// A seam that lets the `OfflineCache` and `WidgetShared` integrations persist
/// each successful budget response WITHOUT `AppCore` depending on those
/// targets. The app target wires a concrete sink into `BudgetStore`; when none
/// is provided, the store simply skips caching.
///
/// Implementations must be safe to call from the main actor and should never
/// throw into the caller — swallow their own I/O errors.
public protocol BudgetSnapshotSink: Sendable {
    /// Synchronously invalidate identity-bound money state. Implementations
    /// with synchronous stores override this so a host/auth setter has no
    /// termination window before the async ``clear()`` operation runs.
    func invalidate()
    /// Persist the latest successful response (disk cache, widget snapshot, …).
    func store(_ response: BudgetStatusResponse) async
    /// Return the most recently cached response, if any, for offline first paint.
    func loadCached() async -> BudgetStatusResponse?
    /// Drop all persisted money state (sign-out). Default no-op.
    func clear() async
}

public extension BudgetSnapshotSink {
    func invalidate() {}
}

/// A no-op sink used when no caching integration is wired in (previews, tests).
public struct NullBudgetSnapshotSink: BudgetSnapshotSink {
    public init() {}
    public func store(_ response: BudgetStatusResponse) async {}
    public func loadCached() async -> BudgetStatusResponse? { nil }
    public func clear() async {}
}
