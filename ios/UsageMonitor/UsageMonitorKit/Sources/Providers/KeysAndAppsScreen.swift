import AppCore
import DesignSystem
import Models
import Networking
import SwiftUI

/// **Keys & Apps** — the iOS counterpart of the web `/attribution` page.
///
/// Answers one question an operator cannot answer anywhere else in the app:
/// *whose key spent this, and on which project?* It renders three things, all
/// read-only:
///
///   1. **Coverage** — of the proven-additive key cost the monitor recorded this
///      month, how much landed on a registered identity, how much stayed
///      unattributed, and how much is stuck behind a project-authority conflict.
///   2. **Key identities** — each registered provider key identity with its
///      redacted fingerprint and its effective-dated project bindings, marking
///      which binding is in force right now.
///   3. **Unattributed references** — the exact, non-secret producer references
///      that carried records nothing could be tied to.
///
/// Deliberately **read-only**. The route's mutations (`create_identity`,
/// `create_binding`, `close_binding`, `retire_identity`) are money-shaped,
/// effective-dated, and reject overlapping windows server-side; they are not in
/// this pass.
///
/// This screen is **pushed** from an existing stack, so it owns no
/// `NavigationStack` — only its title.
///
/// SECURITY: every key-ish string rendered here is already redacted by the
/// server. `providerKeyFingerprint` is a display digest, `producerKeyRef` is an
/// app-local label. No raw provider credential exists in this payload, and the
/// payload is never logged.
public struct KeysAndAppsScreen: View {
    @Environment(AppEnvironment.self) private var env: AppEnvironment?
    @State private var store = KeysAndAppsStore()

    /// One instant for the whole render pass, so every binding on screen is
    /// judged active/closed against the same "now".
    private let renderedAt = Date()

    public init() {}

    public var body: some View {
        content
            .navigationTitle("Keys & Apps")
            .navigationBarTitleDisplayMode(.inline)
            // Fires on first appearance and again whenever a host switch or
            // credential change rebuilds the API client.
            .task(id: env?.accessIdentityRevision) {
                guard let env else { return }
                store.adopt(identityRevision: env.accessIdentityRevision)
                await store.loadIfNeeded(using: env.apiClient)
            }
    }

    @ViewBuilder
    private var content: some View {
        if store.requiresSession {
            sessionRequiredView
        } else if store.state.value == nil, store.state.isInitialLoading {
            loadingView
        } else if store.state.value == nil, let error = store.state.error {
            errorView(for: error)
        } else {
            loadedView
        }
    }

    // MARK: - Session gate

    /// The required UX for a session-only route with no session: an explanation
    /// and a way to fix it, never a hard error. Mirrors the Dashboard
    /// intelligence section exactly.
    private var sessionRequiredView: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Full Dashboard Access Required")
                .font(Theme.Typography.callout.weight(.semibold))
                .foregroundStyle(Theme.Colors.primaryText)
            Text("Sign in with the dashboard password in Settings to load key identities, project bindings, and cost coverage.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            Button("Open Settings") { env?.selectTab?(.settings) }
                .buttonStyle(.borderedProminent)
                .tint(Theme.Colors.accent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
        .padding(.horizontal, Theme.Spacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.top, Theme.Spacing.lg)
        .background(Theme.Colors.background)
    }

    // MARK: - Load states

    private var loadingView: some View {
        SkeletonList(rows: 5)
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.top, Theme.Spacing.lg)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Theme.Colors.background)
    }

    private func errorView(for error: APIError) -> some View {
        ErrorState(
            title: "Attribution Unavailable",
            message: error.localizedDescription,
            retry: {
                guard let env else { return }
                Task { await store.load(using: env.apiClient) }
            }
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.Colors.background)
    }

    private var loadedView: some View {
        RefreshableScrollView(
            onRefresh: { [store] in
                guard let client = await MainActor.run(body: { env?.apiClient }) else { return }
                await store.refresh(using: client)
            }
        ) {
            if let error = store.lastError {
                // Loaded data is still on screen; say the refresh failed rather
                // than replacing good data with an error.
                staleBanner(error)
            }

            if let coverage = store.coverage {
                KeyCoverageSection(coverage: coverage)
            }

            if store.isEmpty {
                EmptyState(
                    systemImage: "key.horizontal.fill",
                    title: "No Key Identities Yet",
                    message: "Register a provider key identity on the dashboard to attribute usage to a project.  Until then every record stays explicitly unattributed."
                )
            } else {
                KeyIdentitiesSection(
                    identities: store.identities,
                    coverage: store.coverage,
                    asOf: renderedAt
                )
                KeyUnattributedSection(buckets: store.unattributedBuckets)
            }
        }
        .background(Theme.Colors.background)
    }

    private func staleBanner(_ error: APIError) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            StatusBadge("Stale", status: .warning)
            Text("Showing the last loaded attribution.  \(error.localizedDescription)")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/// The current-month cost-coverage rollup.
///
/// These are **not** spend figures and the copy says so: only proven-additive
/// key-scope records count, so the total here is smaller than any provider's
/// billed amount by design.
struct KeyCoverageSection: View {
    let coverage: KeyAttributionCoverage

    private var unattributedStatus: Theme.SemanticStatus {
        (coverage.identityUnattributedCostUsd ?? 0) > 0 ? .warning : .ok
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            SectionHeader(
                "Cost Coverage",
                subtitle: "Current month · proven additive key records only"
            )

            HStack(spacing: Theme.Spacing.md) {
                StatTile(
                    label: "Proven Additive",
                    value: KeysAndAppsFormat.money(coverage.totalCostUsd),
                    secondary: KeysAndAppsFormat.records(coverage.totalEventCount),
                    systemImage: "sum"
                )
                StatTile(
                    label: "Identity Matched",
                    value: KeysAndAppsFormat.money(coverage.identityMatchedCostUsd),
                    secondary: KeysAndAppsFormat.records(coverage.identityMatchedEventCount),
                    systemImage: "checkmark.seal.fill",
                    status: .ok
                )
            }

            HStack(spacing: Theme.Spacing.md) {
                StatTile(
                    label: "Unattributed",
                    value: KeysAndAppsFormat.money(coverage.identityUnattributedCostUsd),
                    secondary: KeysAndAppsFormat.records(coverage.identityUnattributedEventCount),
                    systemImage: "questionmark.circle.fill",
                    status: unattributedStatus
                )
                StatTile(
                    label: "Authority Conflict",
                    value: KeysAndAppsFormat.money(coverage.projectAuthorityConflictCostUsd),
                    secondary: KeysAndAppsFormat.records(coverage.projectAuthorityConflictEventCount),
                    systemImage: "exclamationmark.triangle.fill",
                    status: coverage.hasProjectAuthorityConflict ? .warning : .neutral
                )
            }

            if coverage.hasProjectAuthorityConflict {
                conflictCard
            }

            caveatCard
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var conflictCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("Project Authority Conflict")
                .font(Theme.Typography.captionEmphasis)
                .foregroundStyle(Theme.Colors.warning)
            Text("\(KeysAndAppsFormat.count(coverage.projectAuthorityConflictEventCount)) record(s) name a different project than their binding does.  Identity attribution still holds; project coverage stays unattributed until the binding is corrected on the dashboard.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    private var caveatCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("How This Is Counted")
                .font(Theme.Typography.captionEmphasis)
                .foregroundStyle(Theme.Colors.primaryText)
            Text("\(KeysAndAppsFormat.count(coverage.unclassifiedCostEventCount)) cost record(s) stay unclassified and \(KeysAndAppsFormat.count(coverage.excludedNonKeyScopeEventCount)) non-key record(s) are excluded from these totals.  Provider polling and account-level totals are never counted here, so this is deliberately less than billed spend.")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }
}

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

/// One card per registered provider key identity, each listing its bindings.
struct KeyIdentitiesSection: View {
    let identities: [KeyAttributionIdentityLite]
    let coverage: KeyAttributionCoverage?
    let asOf: Date

    var body: some View {
        if !identities.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionHeader(
                    "Key Identities",
                    subtitle: "\(identities.count) registered"
                )
                ForEach(identities) { identity in
                    KeyIdentityCard(
                        identity: identity,
                        totals: coverage?.totals(forIdentity: identity.id),
                        asOf: asOf
                    )
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct KeyIdentityCard: View {
    let identity: KeyAttributionIdentityLite
    let totals: KeyAttributionTotals?
    let asOf: Date

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    Text(identity.title)
                        .font(Theme.Typography.body)
                        .foregroundStyle(Theme.Colors.primaryText)
                    Text(subtitle)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                Spacer(minLength: Theme.Spacing.sm)
                StatusBadge(
                    identity.isRetired ? "Retired" : "Active",
                    status: identity.isRetired ? .neutral : .ok
                )
            }

            if let description = identity.description, !description.isEmpty {
                Text(description)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text(monthLine)
                .font(Theme.Typography.captionEmphasis)
                .foregroundStyle(Theme.Colors.secondaryText)
                .monospacedDigit()

            let bindings = identity.orderedBindings(asOf: asOf)
            if bindings.isEmpty {
                Text("No project binding.  Records from this key stay unattributed.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    ForEach(bindings) { binding in
                        KeyBindingRow(binding: binding, asOf: asOf)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .dsCard()
    }

    /// Provider plus the server-redacted fingerprint preview. When the identity
    /// was registered without a provider-reported key ID there is nothing to
    /// show, and saying so beats an empty gap.
    private var subtitle: String {
        let provider = identity.provider?.title ?? "Unknown provider"
        guard let fingerprint = identity.providerKeyFingerprint, !fingerprint.isEmpty else {
            return "\(provider) · No provider key ID"
        }
        return "\(provider) · \(fingerprint)"
    }

    /// Never fabricate a figure: an identity with no proven-additive record
    /// this month is reported as having none, not as "$0".
    private var monthLine: String {
        guard let totals, let cost = totals.costUsd else {
            return "No proven additive cost recorded this month"
        }
        return "\(CurrencyFormat.usd(cost)) · \(KeysAndAppsFormat.records(totals.eventCount) ?? "0 records") this month"
    }
}

/// One effective-dated binding: which app key reference maps to which project,
/// over which window, and whether that window is in force right now.
struct KeyBindingRow: View {
    let binding: KeyAttributionBinding
    let asOf: Date

    private var activity: KeyAttributionBindingActivity { binding.activity(asOf: asOf) }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                Text(referenceLine)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.primaryText)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: Theme.Spacing.sm)
                StatusBadge(activityTitle, status: activityStatus)
            }

            Text(windowLine)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Colors.secondaryText)
                .fixedSize(horizontal: false, vertical: true)

            if let scope = scopeLine {
                Text(scope)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Colors.tertiaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.Spacing.sm)
        .background(
            Theme.Colors.surfaceElevated,
            in: RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
        )
    }

    private var referenceLine: String {
        let producer = binding.producerId ?? "Unknown app"
        let reference = binding.producerKeyRef ?? "no key reference"
        let project = binding.resolvedProjectName ?? "Project unattributed"
        return "\(producer) / \(reference) → \(project)"
    }

    private var windowLine: String {
        let from = KeysAndAppsFormat.timestamp(binding.effectiveFromDate) ?? "Unknown start"
        let to = KeysAndAppsFormat.timestamp(binding.effectiveToDate) ?? "Open"
        return "Effective \(from) → \(to)"
    }

    /// The optional exact-match constraints. A blank one is a wildcard on the
    /// server, which is worth naming: it widens what this binding can claim.
    private var scopeLine: String? {
        var parts: [String] = []
        if let connection = binding.providerConnectionRef, !connection.isEmpty {
            parts.append("Connection \(connection)")
        }
        if let account = binding.billingAccountRef, !account.isEmpty {
            parts.append("Account \(account)")
        }
        if parts.isEmpty { return nil }
        return parts.joined(separator: " · ")
    }

    private var activityTitle: String {
        switch activity {
        case .active: return "In Force"
        case .scheduled: return "Scheduled"
        case .closed: return "Closed"
        case .unknown: return "Unknown"
        }
    }

    private var activityStatus: Theme.SemanticStatus {
        switch activity {
        case .active: return .ok
        case .scheduled: return .warning
        case .closed: return .neutral
        case .unknown: return .neutral
        }
    }
}

// ---------------------------------------------------------------------------
// Unattributed references
// ---------------------------------------------------------------------------

/// Exact, non-secret producer references that carried v2 records the monitor
/// could not tie to any registered identity. This is the operator's to-do list
/// — mapping happens on the dashboard, not here.
struct KeyUnattributedSection: View {
    let buckets: [KeyAttributionUnattributedBucket]

    var body: some View {
        if !buckets.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                SectionHeader(
                    "Unattributed References",
                    subtitle: "\(buckets.count) needing a mapping"
                )
                ForEach(buckets) { bucket in
                    VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                        Text(title(for: bucket))
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.primaryText)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(detail(for: bucket))
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Colors.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .dsCard()
        }
    }

    private func title(for bucket: KeyAttributionUnattributedBucket) -> String {
        let provider = bucket.providerName ?? "Unknown provider"
        let producer = bucket.producerId ?? "Unknown app"
        let reference = bucket.producerKeyRef ?? "no key reference"
        return "\(provider) · \(producer) / \(reference)"
    }

    private func detail(for bucket: KeyAttributionUnattributedBucket) -> String {
        var parts = [
            KeysAndAppsStore.humanizedReason(bucket.reason),
            KeysAndAppsFormat.records(bucket.eventCount) ?? "0 records",
        ]
        if let cost = bucket.costUsd, cost > 0 {
            parts.append("\(CurrencyFormat.usd(cost)) proven additive")
        }
        return parts.joined(separator: " · ")
    }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

enum KeysAndAppsFormat {
    /// Money the server actually reported. A missing figure renders as an
    /// em dash — never as a fabricated "$0".
    static func money(_ value: Double?) -> String {
        guard let value else { return "—" }
        return CurrencyFormat.usd(value)
    }

    static func records(_ count: Int?) -> String? {
        guard let count else { return nil }
        return count == 1 ? "1 record" : "\(count) records"
    }

    static func count(_ value: Int?) -> String {
        guard let value else { return "0" }
        return "\(value)"
    }

    static func timestamp(_ date: Date?) -> String? {
        guard let date else { return nil }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
