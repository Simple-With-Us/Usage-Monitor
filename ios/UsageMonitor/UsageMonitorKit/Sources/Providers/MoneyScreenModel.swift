import AppCore
import DesignSystem
import Foundation
import Models
import Networking
import Observation

// ---------------------------------------------------------------------------
// The Money screen's data layer, kept deliberately separate from the view so
// the money math (what counts toward the recurring total, what reads as "not
// budgeted", how a renewal date is worded) is unit-testable without SwiftUI.
//
// TWO sources, because the monitor has two equally valid ways to model a
// recurring fee and a total that reads only one of them is wrong:
//
//   1. `GET /api/subscriptions` — bearer-readable.  Tracked plans, each already
//      carrying its provider reference, monthly-equivalent cost, and next
//      renewal timestamp.
//   2. `GET /api/providers?view=dashboard` — dashboard-session-only.  Carries
//      `ProviderPlan.fixedMonthlyCostUsd`, a recurring fee recorded straight on
//      the provider instead of as a Subscription.  The web Money page reads
//      both for exactly this reason (`src/components/MoneyPageClient.tsx`).
//
// The two loads are INDEPENDENT.  A read-token-only user still gets the whole
// subscription half; the session-only half degrades to the established "Full
// Dashboard Access Required → Open Settings" affordance, and the screen says
// out loud that plan-level fees are missing rather than quietly understating
// the total.
//
// Double-counting is prevented the same way `src/lib/billing-inventory.ts`
// does it: a provider's plan-level fee is a FALLBACK, dropped entirely once
// that provider has an active tracked subscription.
// ---------------------------------------------------------------------------

/// Owns the Money screen's two reads and keeps their failure modes separate.
///
/// Follows `ServerStatus/HostUsageStore` for the bearer half (injectable probe, the
/// client passed per call, a failed *refresh* keeping the previously loaded
/// rows) and `Dashboard/IntelligenceStore` for the session-only half (a 401 is
/// a capability gap that sets ``providersRequireSession``, never an error
/// screen).
@MainActor
@Observable
final class MoneyStore {
    /// The bearer-reachable half.  Its failure is the only one allowed to take
    /// over the whole screen.
    private(set) var state: LoadState<[SubscriptionSummary]> = .idle

    /// The session-only half.  Its failure only ever costs plan-level fees.
    private(set) var providerState: LoadState<[ProviderManagementItem]> = .idle

    /// Set when `/api/providers` was refused for want of a dashboard session.
    private(set) var providersRequireSession = false

    private let probe: @Sendable (APIClient) async throws -> [SubscriptionSummary]
    private let providerProbe: @Sendable (APIClient) async throws -> [ProviderManagementItem]

    init(
        probe: @escaping @Sendable (APIClient) async throws -> [SubscriptionSummary] =
            MoneyStore.liveProbe,
        providerProbe: @escaping @Sendable (APIClient) async throws -> [ProviderManagementItem] =
            MoneyStore.liveProviderProbe
    ) {
        self.probe = probe
        self.providerProbe = providerProbe
    }

    /// How much of the plan-level fee story made it into the total.
    var planFeeCoverage: MoneyViewData.PlanFeeCoverage {
        if providersRequireSession { return .requiresSession }
        if let error = providerState.error { return .unavailable(error) }
        if providerState.value == nil { return .pending }
        return .included
    }

    /// The rendered view data, recomputed from the loaded rows. `nil` until the
    /// first successful *subscription* load, which is what drives skeleton vs.
    /// content — the provider half never gates the money view.
    func viewData(now: Date = Date()) -> MoneyViewData? {
        state.value.map {
            MoneyViewData(
                subscriptions: $0,
                providers: providerState.value ?? [],
                planFeeCoverage: planFeeCoverage,
                now: now
            )
        }
    }

    func loadIfNeeded(using client: APIClient) async {
        if case .idle = state { await load(using: client) }
    }

    func load(using client: APIClient) async {
        if state.value == nil { state = .loading }
        if providerState.value == nil, !providersRequireSession { providerState = .loading }
        await fetch(using: client)
    }

    func refresh(using client: APIClient) async {
        await fetch(using: client)
    }

    func reset() {
        state = .idle
        providerState = .idle
        providersRequireSession = false
    }

    /// Both reads run concurrently and neither can fail the other: a 401 on the
    /// session-only provider route must not touch the subscription rows a read
    /// token legitimately fetched.
    private func fetch(using client: APIClient) async {
        async let subscriptionTask: Void = fetchSubscriptions(using: client)
        async let providerTask: Void = fetchProviders(using: client)
        _ = await (subscriptionTask, providerTask)
    }

    private func fetchSubscriptions(using client: APIClient) async {
        do {
            state = .loaded(try await probe(client))
        } catch let error as APIError {
            handle(error)
        } catch {
            handle(.transport(error.localizedDescription))
        }
    }

    private func fetchProviders(using client: APIClient) async {
        do {
            providerState = .loaded(try await providerProbe(client))
            providersRequireSession = false
        } catch let error as APIError {
            handleProvider(error)
        } catch {
            handleProvider(.transport(error.localizedDescription))
        }
    }

    /// A refresh failure over already-good data is never allowed to blank the
    /// screen — the operator keeps looking at the last known costs.
    private func handle(_ error: APIError) {
        if state.value == nil {
            state = .failed(error)
        }
    }

    /// No dashboard session is a missing capability with an obvious next step,
    /// not a failure: keep the state neutral so the screen offers Settings.
    private func handleProvider(_ error: APIError) {
        if case .unauthorized = error {
            providersRequireSession = true
            providerState = .idle
            return
        }
        if providerState.value == nil {
            providerState = .failed(error)
        }
    }

    nonisolated static let liveProbe: @Sendable (APIClient) async throws -> [SubscriptionSummary] = {
        client in
        try await client.subscriptions()
    }

    nonisolated static let liveProviderProbe:
        @Sendable (APIClient) async throws -> [ProviderManagementItem] = { client in
            try await client.providerInventory()
        }
}

// ---------------------------------------------------------------------------
// Pure presentation
// ---------------------------------------------------------------------------

/// Everything the Money screen renders, derived once from the subscription
/// list, the provider inventory, and a caller-supplied `now` (injected rather
/// than read from the clock so renewal wording is deterministic in tests).
struct MoneyViewData: Equatable {
    /// How much of the plan-level fee story reached the headline total.
    ///
    /// Anything other than ``included`` means the figure on screen may be low,
    /// and the screen is required to say so — a silently understated recurring
    /// total is the one failure this screen exists to prevent.
    enum PlanFeeCoverage: Equatable {
        /// The provider inventory loaded; plan-level fees are in the total.
        case included
        /// `/api/providers` is still in flight.
        case pending
        /// No dashboard session, so the session-only provider read was refused.
        case requiresSession
        /// The provider read failed for a non-auth reason.
        case unavailable(APIError)
    }

    /// One paid service.
    struct Row: Identifiable, Equatable {
        /// Which of the monitor's two recurring-cost models produced this row.
        /// Both are legitimate; only one of them can ever be counted per
        /// provider (see ``MoneyViewData/init(subscriptions:providers:planFeeCoverage:now:calendar:)``).
        enum Origin: Equatable {
            /// A tracked `Subscription` row.
            case subscription
            /// `ProviderPlan.fixedMonthlyCostUsd` recorded on the provider.
            case providerPlan
        }

        let id: String
        let name: String
        let providerID: String
        let providerTitle: String
        let projectName: String?
        let cadence: String
        let origin: Origin
        /// `true` only when the monitor actually has a recurring price on file.
        /// A row with nothing recorded must never render as "$0" — see
        /// ``monthlyLine``.
        let isBudgeted: Bool
        /// Counted toward the headline USD total (active **and** priced in USD).
        let countsTowardTotal: Bool
        let monthlyEquivalentUsd: Double
        let currency: String
        /// Trailing headline on the row: a money figure, or "Not budgeted".
        let monthlyLine: String
        /// The small line under it — cadence context or the "no cost recorded"
        /// explanation.
        let monthlySecondary: String
        /// Full price at its real cadence, e.g. "$60.00 · every 3 months".
        let priceLine: String
        /// Renewal wording, e.g. "Renews Sep 3 · in 23 days".
        let renewalLine: String
        let statusLabel: String
        let status: Theme.SemanticStatus
        /// Raw server status, kept so bucketing stays a pure function of the row.
        let effectiveStatus: String
        let renewalDate: Date?
        let billingSource: String?

        /// Provider (and project) context for the row subtitle. The provider is
        /// repeated here even though rows are grouped by provider, because
        /// VoiceOver reads rows out of their group heading.
        var subtitleLine: String {
            var parts = [providerTitle, cadence]
            if let projectName, !projectName.isEmpty { parts.append(projectName) }
            return parts.joined(separator: " · ")
        }

        var accessibilityLabel: String {
            let base = "\(name), \(providerTitle), \(monthlyLine) \(monthlySecondary), \(renewalLine)"
            return origin == .providerPlan ? "\(base), provider plan fee" : base
        }

        /// Shown under a plan-fee row so it can never be mistaken for a tracked
        /// subscription — they are edited in different places.
        var originNote: String? {
            origin == .providerPlan ? "From the provider's plan settings" : nil
        }
    }

    /// Every service belonging to one provider, plus that provider's share of
    /// the recurring total.
    struct ProviderGroup: Identifiable, Equatable {
        let providerID: String
        let providerTitle: String
        let monthlyTotalUsd: Double
        let hasBudgetedRow: Bool
        let rows: [Row]

        var id: String { providerID }

        /// The group's trailing figure. Providers whose services all lack a
        /// recorded price read as "Not budgeted", never "$0".
        var totalLine: String {
            hasBudgetedRow ? CurrencyFormat.usd(monthlyTotalUsd) : "Not budgeted"
        }

        var subtitle: String {
            rows.count == 1 ? "1 service" : "\(rows.count) services"
        }
    }

    /// Active services grouped by provider, biggest recurring cost first.
    let billingGroups: [ProviderGroup]
    /// Rows the owner is still evaluating (`considering`) — real plans, but not
    /// charging yet, so they are listed and excluded from the total.
    let considering: [Row]
    /// Paused / canceled / expired rows: shown so nothing silently disappears,
    /// never counted.
    let inactive: [Row]

    /// Sum of the monthly-equivalent cost of every active USD service.
    let monthlyTotalUsd: Double
    let activeCount: Int
    let providerCount: Int
    /// Active rows priced in a non-USD currency. Excluded from the USD total
    /// exactly as the server's budget math excludes them.
    let nonUsdActiveCount: Int
    /// Whether any active row has a recorded price at all.
    let hasBudgetedActive: Bool
    /// The soonest upcoming renewal among active rows.
    let nextRenewal: Row?
    /// Whether plan-level provider fees made it into the numbers above.
    let planFeeCoverage: PlanFeeCoverage

    var isEmpty: Bool {
        billingGroups.isEmpty && considering.isEmpty && inactive.isEmpty
    }

    /// The hero figure. With nothing priced there is no honest number to show,
    /// so it reads "Not budgeted" rather than a fabricated "$0.00".
    var monthlyTotalLine: String {
        hasBudgetedActive ? CurrencyFormat.usd(monthlyTotalUsd) : "Not budgeted"
    }

    /// Caption under the hero: scope first, then the USD-only caveat when it
    /// actually applies.
    var summaryLine: String {
        var parts: [String] = [
            activeCount == 1 ? "1 active service" : "\(activeCount) active services",
            providerCount == 1 ? "1 provider" : "\(providerCount) providers",
        ]
        if nonUsdActiveCount > 0 {
            parts.append("\(nonUsdActiveCount) not in USD")
        }
        return parts.joined(separator: " · ")
    }

    /// The plain statement that the headline figure is incomplete, `nil` when
    /// it is not.  Never softened: an understated recurring total that does not
    /// admit it is worse than no total at all.
    var planFeeCaveat: String? {
        switch planFeeCoverage {
        case .included:
            return nil
        case .pending:
            return "Checking provider plans for fixed monthly fees…"
        case .requiresSession:
            return "Plan-level provider fees are not included without a dashboard session, so this total may be low."
        case .unavailable:
            return "Provider plans could not be loaded, so any plan-level fee is missing from this total."
        }
    }

    /// Whether the screen should offer the dashboard sign-in affordance.
    var needsDashboardSessionForPlanFees: Bool {
        planFeeCoverage == .requiresSession
    }

    /// - Parameters:
    ///   - subscriptions: `GET /api/subscriptions` (bearer-reachable).
    ///   - providers: `GET /api/providers?view=dashboard` (session-only), empty
    ///     when that read was refused or has not landed yet.
    ///   - planFeeCoverage: what happened to the provider read, so the total can
    ///     admit when it is incomplete.
    init(
        subscriptions: [SubscriptionSummary],
        providers: [ProviderManagementItem] = [],
        planFeeCoverage: PlanFeeCoverage = .included,
        now: Date = Date(),
        calendar: Calendar = .current
    ) {
        self.planFeeCoverage = planFeeCoverage
        let subscriptionRows = subscriptions.map { Row(subscription: $0, now: now, calendar: calendar) }

        // Double-count guard, mirroring `buildBillingInventory` in
        // `src/lib/billing-inventory.ts` (and `planFixedInCashUsd` in
        // `src/lib/budget-status.ts`): a provider's plan-level fee is a
        // FALLBACK.  Once that provider bills through an active tracked
        // subscription, the plan fee is the same money modelled twice and is
        // dropped outright — not halved, not listed separately.  Non-active
        // subscriptions (considering / paused / canceled / expired) are not
        // billing, so they do not suppress it.
        let providersBilledBySubscription = Set(
            subscriptionRows.filter { $0.effectiveStatus == "active" }.map(\.providerID)
        )
        let planRows = providers.compactMap { provider -> Row? in
            guard !providersBilledBySubscription.contains(provider.id) else { return nil }
            return Row(providerPlan: provider, now: now, calendar: calendar)
        }

        let rows = subscriptionRows + planRows
        let byBucket = Dictionary(grouping: rows) { MoneyViewData.bucket(for: $0) }
        let activeRows = byBucket[.active] ?? []

        // Group active services by provider, so a plan-level fee lands in the
        // same card as that provider's other services.
        var grouped: [String: [Row]] = [:]
        for row in activeRows { grouped[row.providerID, default: []].append(row) }

        billingGroups = grouped
            .map { providerID, rows in
                let ordered = rows.sorted(by: MoneyViewData.rowOrder)
                return ProviderGroup(
                    providerID: providerID,
                    providerTitle: ordered.first?.providerTitle ?? providerID,
                    monthlyTotalUsd: ordered
                        .filter(\.countsTowardTotal)
                        .reduce(0) { $0 + $1.monthlyEquivalentUsd },
                    hasBudgetedRow: ordered.contains { $0.isBudgeted && $0.countsTowardTotal },
                    rows: ordered
                )
            }
            .sorted { left, right in
                if left.monthlyTotalUsd != right.monthlyTotalUsd {
                    return left.monthlyTotalUsd > right.monthlyTotalUsd
                }
                return left.providerTitle.localizedCaseInsensitiveCompare(right.providerTitle)
                    == .orderedAscending
            }

        considering = (byBucket[.considering] ?? []).sorted(by: MoneyViewData.rowOrder)
        inactive = (byBucket[.inactive] ?? []).sorted(by: MoneyViewData.rowOrder)

        monthlyTotalUsd = activeRows
            .filter(\.countsTowardTotal)
            .reduce(0) { $0 + $1.monthlyEquivalentUsd }
        activeCount = activeRows.count
        providerCount = Set(activeRows.map(\.providerID)).count
        nonUsdActiveCount = activeRows.filter { !$0.countsTowardTotal }.count
        hasBudgetedActive = activeRows.contains { $0.isBudgeted && $0.countsTowardTotal }
        nextRenewal = activeRows
            .filter { ($0.renewalDate ?? .distantPast) >= now }
            .min { left, right in
                (left.renewalDate ?? .distantFuture) < (right.renewalDate ?? .distantFuture)
            }
    }

    // MARK: - Bucketing

    private enum Bucket: Hashable {
        case active
        case considering
        case inactive
    }

    private static func bucket(for row: Row) -> Bucket {
        switch row.effectiveStatus {
        case "active": return .active
        case "considering": return .considering
        default: return .inactive
        }
    }

    /// Most expensive first, then alphabetical — the order an owner scans when
    /// looking for what to cut.
    private static func rowOrder(_ left: Row, _ right: Row) -> Bool {
        if left.monthlyEquivalentUsd != right.monthlyEquivalentUsd {
            return left.monthlyEquivalentUsd > right.monthlyEquivalentUsd
        }
        return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
    }
}

// MARK: - Row derivation

extension MoneyViewData.Row {
    init(subscription: SubscriptionSummary, now: Date, calendar: Calendar) {
        let currencyCode = MoneyFormat.normalizedCurrency(subscription.currency)
        let isUsd = currencyCode == "USD"
        // The monitor stores cost as a non-optional number, so "nothing
        // recorded" arrives as a zero rather than a null. Treating that zero as
        // a real price would print "$0" for a plan whose cost is simply unknown,
        // which is worse than saying so.
        let budgeted = subscription.costUsd > 0.005 || subscription.monthlyEquivalentUsd > 0.005
        let active = subscription.effectiveStatus == "active"

        id = subscription.id
        name = subscription.name
        providerID = subscription.provider.id
        providerTitle = subscription.provider.title
        projectName = subscription.project?.name
        cadence = subscription.cadenceLabel
        origin = .subscription
        isBudgeted = budgeted
        countsTowardTotal = active && isUsd
        monthlyEquivalentUsd = isUsd ? subscription.monthlyEquivalentUsd : 0
        currency = currencyCode

        if !budgeted {
            monthlyLine = "Not budgeted"
            monthlySecondary = "no recurring cost recorded"
            priceLine = "No price on file · \(subscription.cadenceLabel)"
        } else {
            monthlyLine = MoneyFormat.money(subscription.monthlyEquivalentUsd, currency: currencyCode)
            monthlySecondary = isUsd ? "per month" : "per month · not in the USD total"
            priceLine = "\(MoneyFormat.money(subscription.costUsd, currency: currencyCode)) · \(subscription.cadenceLabel)"
        }

        let date = subscription.nextRenewalDate
        renewalDate = date
        renewalLine = MoneyFormat.renewalLine(
            date: date,
            autoRenew: subscription.autoRenew,
            effectiveStatus: subscription.effectiveStatus,
            now: now,
            calendar: calendar
        )
        statusLabel = MoneyFormat.statusLabel(subscription.effectiveStatus)
        status = MoneyFormat.status(subscription.effectiveStatus)
        effectiveStatus = subscription.effectiveStatus
        billingSource = subscription.externalBillingSource.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// A recurring fee recorded as `ProviderPlan.fixedMonthlyCostUsd` instead of
    /// as a Subscription.  The field is a *monthly* figure by definition, so it
    /// needs no cadence conversion — the web fallback item sets exactly the same
    /// `monthlyEquivalentUsd` (`src/lib/billing-inventory.ts`).
    ///
    /// Returns `nil` when the provider records neither a fee nor a renewal date:
    /// there is no money story to tell, and listing every connected provider
    /// would bury the ones that actually charge.
    init?(providerPlan provider: ProviderManagementItem, now: Date, calendar: Calendar) {
        let fee = provider.plan?.fixedMonthlyCostUsd
        let renewal = provider.plan?.renewalDate.flatMap(MoneyFormat.planRenewalDate)
        guard fee != nil || renewal != nil else { return nil }

        // Same honesty rule as a subscription: a plan carrying a renewal date
        // but no recorded price is unbudgeted, never "$0".
        let budgeted = (fee ?? 0) > 0.005
        // An inactive provider is not billing, so it buckets out of the total
        // exactly as the web fallback item's "inactive" status does.
        let planStatus = provider.isActive ? "active" : "inactive"

        id = "provider-plan:\(provider.id)"
        name = MoneyFormat.planRowName(for: provider)
        providerID = provider.id
        providerTitle = provider.title
        projectName = nil
        cadence = budgeted ? "monthly" : "plan renewal"
        origin = .providerPlan
        isBudgeted = budgeted
        // `fixedMonthlyCostUsd` is USD by definition, so the USD-only test the
        // subscription rows apply is already satisfied.
        countsTowardTotal = provider.isActive
        monthlyEquivalentUsd = budgeted ? (fee ?? 0) : 0
        currency = "USD"

        if budgeted {
            monthlyLine = CurrencyFormat.usd(fee ?? 0)
            monthlySecondary = "per month"
            priceLine = "\(CurrencyFormat.usd(fee ?? 0)) · monthly plan fee"
        } else {
            monthlyLine = "Not budgeted"
            monthlySecondary = "no plan fee recorded"
            priceLine = "No plan fee on file"
        }

        renewalDate = renewal
        renewalLine = MoneyFormat.renewalLine(
            date: renewal,
            autoRenew: renewal != nil,
            effectiveStatus: planStatus,
            now: now,
            calendar: calendar
        )
        statusLabel = MoneyFormat.statusLabel(planStatus)
        status = MoneyFormat.status(planStatus)
        effectiveStatus = planStatus
        billingSource = nil
    }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/// Money-screen wording. Separate from `CurrencyFormat` because these rules are
/// about *this* screen's honesty contract (never fabricate a figure) rather
/// than about number formatting.
enum MoneyFormat {
    static func normalizedCurrency(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        return trimmed.isEmpty ? "USD" : trimmed
    }

    /// USD goes through the shared formatter so this screen renders money the
    /// same way every other surface does; other currencies keep their own code
    /// so a €-priced plan is never silently relabelled as dollars.
    static func money(_ amount: Double, currency: String) -> String {
        let code = normalizedCurrency(currency)
        if code == "USD" { return CurrencyFormat.usd(amount) }
        return amount.formatted(.currency(code: code).precision(.fractionLength(2)))
    }

    /// "Renews Sep 3 · in 23 days" / "Term ends Sep 3" / "Renewal date not
    /// reported".  Paused and canceled rows are not renewing at all, so they
    /// describe when the paid term runs out instead.
    static func renewalLine(
        date: Date?,
        autoRenew: Bool,
        effectiveStatus: String,
        now: Date,
        calendar: Calendar
    ) -> String {
        guard let date else { return "Renewal date not reported" }
        let day = date.formatted(date: .abbreviated, time: .omitted)
        let relative = relativeDayText(from: now, to: date, calendar: calendar)
        let lead: String
        switch effectiveStatus {
        case "active": lead = autoRenew ? "Renews \(day)" : "Term ends \(day)"
        case "considering": lead = "Would renew \(day)"
        // Only a deactivated provider's plan row reaches this: the date is on
        // file but the monitor is not billing it, so it claims no charge.
        case "inactive": lead = "Plan renewal \(day)"
        default: lead = "Paid through \(day)"
        }
        return "\(lead) · \(relative)"
    }

    /// Day-granularity relative wording against an injected `now`, so tests
    /// never depend on the wall clock.
    static func relativeDayText(from now: Date, to date: Date, calendar: Calendar) -> String {
        let start = calendar.startOfDay(for: now)
        let target = calendar.startOfDay(for: date)
        guard let days = calendar.dateComponents([.day], from: start, to: target).day else {
            return "date unavailable"
        }
        switch days {
        case 0: return "today"
        case 1: return "tomorrow"
        case -1: return "yesterday"
        case let ahead where ahead > 1: return "in \(ahead) days"
        default: return "\(abs(days)) days ago"
        }
    }

    /// A provider plan's row name.  The account label wins when the owner set
    /// one (two Anthropic connections must not both read "Anthropic plan"),
    /// mirroring the web fallback item's `provider.label || "<display> plan"`.
    static func planRowName(for provider: ProviderManagementItem) -> String {
        let label = provider.label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return label.isEmpty ? "\(provider.title) plan" : label
    }

    /// Provider plan renewal dates arrive either as a full ISO timestamp or as
    /// a bare `yyyy-MM-dd` calendar day — the native plan editor submits the
    /// latter (`Settings/ProviderManagementInventory.swift`).
    static func planRenewalDate(_ raw: String) -> Date? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return ISO8601DateParser.date(from: trimmed) ?? planDayFormatter.date(from: trimmed)
    }

    private static let planDayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// Chip text → Title Case.
    static func statusLabel(_ effectiveStatus: String) -> String {
        switch effectiveStatus {
        case "active": return "Active"
        case "considering": return "Considering"
        case "paused": return "Paused"
        case "canceled": return "Canceled"
        case "expired": return "Expired"
        default: return effectiveStatus.capitalized
        }
    }

    static func status(_ effectiveStatus: String) -> Theme.SemanticStatus {
        switch effectiveStatus {
        case "active": return .ok
        case "considering", "paused": return .warning
        case "expired": return .danger
        default: return .neutral
        }
    }
}
