import Foundation

/// Turns a cache timestamp into age strings for footers and accessibility.
///
/// Age alone is never labeled "Stale" in the UI — if data is old the store
/// should refresh quietly. Use ``isStale`` only to decide when to refresh.
public struct BudgetStaleness: Equatable, Sendable {
    /// When the on-screen data was last successfully cached.
    public let cachedAt: Date
    /// Age past which a quiet background refresh should run. Default 30 minutes.
    public let threshold: TimeInterval

    /// Quiet refresh window: 30 minutes (within the 30–60m product expectation).
    public static let defaultThreshold: TimeInterval = 30 * 60

    public init(cachedAt: Date, threshold: TimeInterval = BudgetStaleness.defaultThreshold) {
        self.cachedAt = cachedAt
        self.threshold = threshold
    }

    /// Seconds since the data was cached.
    public func age(asOf now: Date = Date()) -> TimeInterval {
        max(0, now.timeIntervalSince(cachedAt))
    }

    /// Whether the cached data is older than ``threshold`` (refresh trigger only).
    public func isStale(asOf now: Date = Date()) -> Bool {
        age(asOf: now) >= threshold
    }

    /// A relative age phrase, e.g. "5 minutes ago", "just now".
    public func relativeDescription(asOf now: Date = Date()) -> String {
        if age(asOf: now) < 45 { return "just now" }
        return Self.relativeFormatter.localizedString(for: cachedAt, relativeTo: now)
    }

    /// An absolute clock/day time, e.g. "9:15 AM" (today) using the user locale.
    public func absoluteDescription() -> String {
        Self.timeFormatter.string(from: cachedAt)
    }

    /// Accessibility long form: always "Updated …", never "Stale".
    public func staleLabel(asOf now: Date = Date()) -> String {
        "Updated \(absoluteDescription()) · \(relativeDescription(asOf: now))"
    }

    /// Compact caption: always "Updated …" — never shame the operator with "Stale".
    public func shortLabel(asOf now: Date = Date()) -> String {
        "Updated \(relativeDescription(asOf: now))"
    }

    // MARK: - Formatters (cached; thread-safe for read-only use)

    private nonisolated(unsafe) static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter
    }()

    private nonisolated static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter
    }()
}
