import Foundation
import Observation
import Models
import AppCore

// ---------------------------------------------------------------------------
// The backend's budget-status response only ever carries the *currently active*
// provider alerts — there is no "resolved" flag in the payload. To give the
// Alerts screen a genuinely useful "Recently resolved" section (a hallmark of a
// polished, mobile-first monitoring app), the Alerts lane tracks resolution
// itself: it remembers which alerts were active on the last successful load and,
// when one disappears from a later load, records it as resolved with a
// timestamp.
//
// The diff is a pure function (`AlertResolutionReconciler`) so it can be unit
// tested without any persistence; `ResolvedAlertTracker` is the thin,
// UserDefaults-backed, observable wrapper the UI reads.
// ---------------------------------------------------------------------------

/// An alert that was active on a previous load but is no longer present — i.e.
/// it has cleared. Carries enough to reconstruct its title/symbol/severity for
/// display without another network call.
public struct ResolvedAlert: Identifiable, Hashable, Codable, Sendable {
    public var providerId: String
    public var providerTitle: String
    public var code: String
    public var severity: AlertSeverity
    public var message: String
    /// When the monitor first observed this alert as gone.
    public var resolvedAt: Date

    public init(
        providerId: String,
        providerTitle: String,
        code: String,
        severity: AlertSeverity,
        message: String,
        resolvedAt: Date
    ) {
        self.providerId = providerId
        self.providerTitle = providerTitle
        self.code = code
        self.severity = severity
        self.message = message
        self.resolvedAt = resolvedAt
    }

    /// Same composite identity used by `ProviderAlertItem`, so an alert that
    /// re-fires can be matched against the live active set.
    public var id: String { "\(providerId)|\(code)|\(message)" }

    /// Rebuild the domain alert so we can reuse its `title` / `symbolName`.
    public var alert: ProviderAlert {
        ProviderAlert(code: code, severity: severity, message: message)
    }
}

/// A snapshot of one active alert, persisted between launches so the next load
/// can tell what has since cleared.
public struct TrackedActiveAlert: Hashable, Codable, Sendable {
    public var providerId: String
    public var providerTitle: String
    public var code: String
    public var severity: AlertSeverity
    public var message: String

    public init(providerId: String, providerTitle: String, code: String, severity: AlertSeverity, message: String) {
        self.providerId = providerId
        self.providerTitle = providerTitle
        self.code = code
        self.severity = severity
        self.message = message
    }

    public var id: String { "\(providerId)|\(code)|\(message)" }

    init(_ item: ProviderAlertItem) {
        self.init(
            providerId: item.provider.id,
            providerTitle: item.provider.title,
            code: item.alert.code,
            severity: item.alert.severity,
            message: item.alert.message
        )
    }
}

/// Pure diff logic: given the current active alerts, the previously-tracked
/// active set, and the existing resolved list, produce the new tracked-active
/// set and the updated resolved list. No I/O, so it is trivially testable.
public enum AlertResolutionReconciler {
    public struct Result: Equatable {
        public var trackedActive: [TrackedActiveAlert]
        public var resolved: [ResolvedAlert]
    }

    /// - Parameters:
    ///   - activeItems: the alerts present in the just-loaded response.
    ///   - previousActive: what was active on the last successful load.
    ///   - existingResolved: the resolved list carried forward.
    ///   - now: injected clock (tests pin this).
    ///   - maxAge: resolved entries older than this are pruned.
    ///   - maxCount: hard cap on retained resolved entries (most recent kept).
    public static func reconcile(
        activeItems: [ProviderAlertItem],
        previousActive: [TrackedActiveAlert],
        existingResolved: [ResolvedAlert],
        now: Date,
        maxAge: TimeInterval = 7 * 24 * 60 * 60,
        maxCount: Int = 30
    ) -> Result {
        let currentIds = Set(activeItems.map(\.id))

        // Anything that re-fired drops out of "resolved" and back into active.
        var resolved = existingResolved.filter { !currentIds.contains($0.id) }
        var resolvedIds = Set(resolved.map(\.id))

        // Newly cleared: previously active, now absent, not already resolved.
        for prev in previousActive where !currentIds.contains(prev.id) && !resolvedIds.contains(prev.id) {
            resolved.append(
                ResolvedAlert(
                    providerId: prev.providerId,
                    providerTitle: prev.providerTitle,
                    code: prev.code,
                    severity: prev.severity,
                    message: prev.message,
                    resolvedAt: now
                )
            )
            resolvedIds.insert(prev.id)
        }

        // Age out, newest first, cap.
        resolved = resolved
            .filter { now.timeIntervalSince($0.resolvedAt) <= maxAge }
            .sorted { $0.resolvedAt > $1.resolvedAt }
        if resolved.count > maxCount {
            resolved = Array(resolved.prefix(maxCount))
        }

        let trackedActive = activeItems.map(TrackedActiveAlert.init)
        return Result(trackedActive: trackedActive, resolved: resolved)
    }
}

/// Observable, persistence-backed store of resolved alerts. The Alerts screen
/// reads ``resolved``; each successful budget load calls ``reconcile(activeItems:)``.
@MainActor
@Observable
public final class ResolvedAlertTracker {
    public private(set) var resolved: [ResolvedAlert] = []
    private var trackedActive: [TrackedActiveAlert] = []

    private let defaults: UserDefaults
    private let maxAge: TimeInterval
    private let maxCount: Int
    private var accountScopeID: String

    private var activeKey: String { "alerts.trackedActive.v2.\(accountScopeID)" }
    private var resolvedKey: String { "alerts.resolved.v2.\(accountScopeID)" }

    public init(
        defaults: UserDefaults = .standard,
        accountScopeID: String = "legacy",
        maxAge: TimeInterval = 7 * 24 * 60 * 60,
        maxCount: Int = 30
    ) {
        self.defaults = defaults
        self.maxAge = maxAge
        self.maxCount = maxCount
        self.accountScopeID = accountScopeID
        self.trackedActive = Self.decode([TrackedActiveAlert].self, from: defaults.data(forKey: activeKey)) ?? []
        self.resolved = Self.decode([ResolvedAlert].self, from: defaults.data(forKey: resolvedKey)) ?? []
    }

    /// Move the observable tracker to another credential/host scope. Each
    /// account retains its own resolved history; no alert state crosses over.
    public func useAccountScope(_ scopeID: String?) {
        let scopeID = scopeID ?? "disconnected"
        guard scopeID != accountScopeID else { return }
        accountScopeID = scopeID
        trackedActive = Self.decode([TrackedActiveAlert].self, from: defaults.data(forKey: activeKey)) ?? []
        resolved = Self.decode([ResolvedAlert].self, from: defaults.data(forKey: resolvedKey)) ?? []
    }

    /// Fold a freshly-loaded active set into the tracker. Only call this once a
    /// real response has loaded — never on a failed/empty initial load, or every
    /// previously-active alert would be reported as spuriously resolved.
    public func reconcile(activeItems: [ProviderAlertItem], now: Date = Date()) {
        let result = AlertResolutionReconciler.reconcile(
            activeItems: activeItems,
            previousActive: trackedActive,
            existingResolved: resolved,
            now: now,
            maxAge: maxAge,
            maxCount: maxCount
        )
        trackedActive = result.trackedActive
        resolved = result.resolved
        persist()
    }

    private func persist() {
        defaults.set(Self.encode(trackedActive), forKey: activeKey)
        defaults.set(Self.encode(resolved), forKey: resolvedKey)
    }

    private static func encode<T: Encodable>(_ value: T) -> Data? {
        try? JSONEncoder().encode(value)
    }

    private static func decode<T: Decodable>(_ type: T.Type, from data: Data?) -> T? {
        guard let data else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    #if DEBUG
    /// Preview/test seam: seed the resolved list without touching persistence.
    func seedForPreview(resolved: [ResolvedAlert]) {
        self.resolved = resolved
    }
    #endif
}
