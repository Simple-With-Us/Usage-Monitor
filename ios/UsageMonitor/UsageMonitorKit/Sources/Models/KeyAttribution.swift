import Foundation

// ---------------------------------------------------------------------------
// `GET /api/key-attribution` (session-only).
//
// Mirrors `src/app/api/key-attribution/route.ts`: registered provider key
// identities, each identity's effective-dated project bindings, and the
// current-month cost-coverage rollup that says how much proven-additive key
// cost the monitor could actually attribute.
//
// Every field is optional on purpose. This payload is the widest one the app
// consumes and it evolves server-side; a new or renamed key must degrade to a
// missing row, never to a decoding failure that blanks the screen.
//
// SECURITY: nothing here is a credential. `providerKeyFingerprint` is the
// server-redacted display form of an HMAC digest (`displayProviderKeyFingerprint`)
// and `producerKeyRef` is an app-local, non-secret reference like
// "configured-openai-primary". The raw provider key is never stored server-side
// and never travels in this payload.
// ---------------------------------------------------------------------------

public struct KeyAttributionSummary: Codable, Hashable, Sendable {
    public var matchedIdentities: Int?
    public var unattributedKeys: Int?
    public var monthCostUsd: Double?
    public var coverageDeclared: Double?
}

public struct KeyAttributionResponse: Codable, Hashable, Sendable {
    public var summary: KeyAttributionSummary?
    public var identities: [KeyAttributionIdentityLite]?
    /// Current-month cost coverage over pushed v2 cost events.
    public var coverage: KeyAttributionCoverage?
}

/// A named reference to the provider that issued a key identity.
public struct KeyAttributionProviderRef: Codable, Hashable, Sendable {
    public var name: String?
    public var displayName: String?

    /// Prefer the human display name; fall back to the slug.
    public var title: String? { displayName ?? name }
}

/// A named reference to a project a binding routes cost to.
public struct KeyAttributionProjectRef: Codable, Hashable, Sendable {
    public var id: String?
    public var name: String?
}

/// Where a binding sits relative to a moment in time. The server stores a
/// half-open `[effectiveFrom, effectiveTo)` interval, so a binding can be
/// scheduled to start later, currently effective, or already closed.
public enum KeyAttributionBindingActivity: Hashable, Sendable {
    case active
    case scheduled
    case closed
    /// No parsable `effectiveFrom` — the row exists but its window is unknown.
    case unknown
}

/// One effective-dated mapping from an app-local key reference to a project.
public struct KeyAttributionBinding: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var projectId: String?
    /// The project name captured when the binding was created. The server also
    /// returns the live `project` relation; either may be absent.
    public var projectName: String?
    public var producerId: String?
    public var producerKeyRef: String?
    public var providerConnectionRef: String?
    public var billingAccountRef: String?
    public var effectiveFrom: String?
    public var effectiveTo: String?
    public var project: KeyAttributionProjectRef?

    public var effectiveFromDate: Date? {
        effectiveFrom.flatMap(ISO8601DateParser.date(from:))
    }

    public var effectiveToDate: Date? {
        effectiveTo.flatMap(ISO8601DateParser.date(from:))
    }

    /// The project this binding routes cost to, or nil when it is deliberately
    /// left unattributed (the server treats a missing project as unattributed
    /// rather than guessing).
    public var resolvedProjectName: String? {
        let candidate = projectName ?? project?.name
        guard let candidate, !candidate.isEmpty else { return nil }
        return candidate
    }

    /// `asOf` is injected rather than read from the clock so callers (and
    /// tests) evaluate every binding against one consistent instant.
    public func activity(asOf date: Date) -> KeyAttributionBindingActivity {
        guard let from = effectiveFromDate else { return .unknown }
        if from > date { return .scheduled }
        guard let to = effectiveToDate else { return .active }
        return to > date ? .active : .closed
    }
}

/// One registered provider key identity.
///
/// Named `…Lite` for source compatibility with the Dashboard intelligence card
/// that first decoded this route; it now carries the route's full identity
/// shape.
public struct KeyAttributionIdentityLite: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var displayName: String?
    public var projectName: String?
    public var providerId: String?
    public var provider: KeyAttributionProviderRef?
    public var alias: String?
    public var description: String?
    /// Server-redacted fingerprint preview. Never a usable credential.
    public var providerKeyFingerprint: String?
    /// `active` or `retired`.
    public var status: String?
    public var retiredAt: String?
    public var createdAt: String?
    public var bindings: [KeyAttributionBinding]?

    public var isRetired: Bool { status?.lowercased() == "retired" }

    /// The best human label available: the operator's alias, then the legacy
    /// `displayName`, then the opaque row id as a last resort.
    public var title: String {
        for candidate in [alias, displayName] {
            if let candidate, !candidate.isEmpty { return candidate }
        }
        return id
    }

    /// Bindings newest-first, matching the web panel's ordering.
    public func orderedBindings(asOf date: Date) -> [KeyAttributionBinding] {
        (bindings ?? []).sorted { left, right in
            let leftActive = left.activity(asOf: date) == .active
            let rightActive = right.activity(asOf: date) == .active
            if leftActive != rightActive { return leftActive }
            let leftFrom = left.effectiveFromDate ?? .distantPast
            let rightFrom = right.effectiveFromDate ?? .distantPast
            if leftFrom != rightFrom { return leftFrom > rightFrom }
            return left.id < right.id
        }
    }
}

/// Cost + record counts for one identity or one unattribution reason.
public struct KeyAttributionTotals: Codable, Hashable, Sendable {
    public var costUsd: Double?
    public var eventCount: Int?
}

/// An exact, non-secret producer reference that carried v2 records the monitor
/// could not tie to a registered identity.
public struct KeyAttributionUnattributedBucket: Codable, Hashable, Sendable, Identifiable {
    public var providerName: String?
    public var producerId: String?
    public var producerKeyRef: String?
    public var providerConnectionRef: String?
    public var billingAccountRef: String?
    public var reason: String?
    public var costUsd: Double?
    public var eventCount: Int?
    public var unclassifiedCostEventCount: Int?

    /// The server returns these as an unkeyed list; the grouping tuple is the
    /// natural identity (it is exactly what the server grouped on).
    public var id: String {
        [
            providerName, producerId, producerKeyRef,
            providerConnectionRef, billingAccountRef, reason,
        ]
        .map { $0 ?? "" }
        .joined(separator: "|")
    }
}

/// The current-month cost-coverage rollup.
///
/// Only *proven additive* key-scope records are counted: v2 point records and
/// non-spanning window records the producer explicitly marked disjoint. Every
/// other record stays unclassified rather than being split or guessed at, which
/// is why `totalCostUsd` here is intentionally smaller than a provider's
/// billed total and must never be presented as spend.
public struct KeyAttributionCoverage: Codable, Hashable, Sendable {
    public var scope: String?
    public var aggregation: String?
    public var note: String?
    public var totalCostUsd: Double?
    public var identityMatchedCostUsd: Double?
    public var identityUnattributedCostUsd: Double?
    public var projectAttributedCostUsd: Double?
    public var projectUnattributedCostUsd: Double?
    public var projectAuthorityConflictCostUsd: Double?
    public var projectAuthorityConflictEventCount: Int?
    public var totalEventCount: Int?
    public var identityMatchedEventCount: Int?
    public var identityUnattributedEventCount: Int?
    public var unclassifiedCostEventCount: Int?
    public var excludedNonKeyScopeEventCount: Int?
    public var reasons: [String: KeyAttributionTotals]?
    public var byIdentity: [String: KeyAttributionTotals]?
    public var unattributedBuckets: [KeyAttributionUnattributedBucket]?

    /// Per-identity month totals, or nil when this identity produced no proven
    /// additive record at all. Callers must render the nil case as "none
    /// recorded" rather than inventing a $0.00 figure.
    public func totals(forIdentity id: String) -> KeyAttributionTotals? {
        byIdentity?[id]
    }

    /// True when two explicit project authorities disagreed on at least one
    /// record. Identity attribution survives; project coverage stays
    /// fail-closed until an operator corrects the binding.
    public var hasProjectAuthorityConflict: Bool {
        (projectAuthorityConflictEventCount ?? 0) > 0
    }
}
