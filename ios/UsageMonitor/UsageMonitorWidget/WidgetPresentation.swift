import Foundation
import DesignSystem
import WidgetShared

// MARK: - Row density

/// How many rows a list-style topic shows.  A small family can only legibly fit
/// a couple, and a large one wastes space on three, so this is a real choice
/// rather than a "more is better" default.
///
/// The `AppEnum` conformance (and therefore the Edit Widget picker labels) lives
/// in `BudgetWidgetIntent.swift`: this file is compiled standalone by the widget
/// unit-test target, which has no AppIntents host.
enum WidgetRowCount: String, CaseIterable, Sendable {
    case compact
    case standard
    case full

    var maxMeters: Int {
        switch self {
        case .compact: return 2
        case .standard: return 4
        case .full: return 8
        }
    }
}

// MARK: - Sort order

/// Providers and projects can be ranked two honest ways, and they disagree
/// often enough to be worth a picker: "who is closest to their cap" is a
/// different list from "who has cost the most".
enum WidgetSortOrder: String, CaseIterable, Sendable {
    case utilisation
    case spend
}

/// Which budget the home-screen widget focuses on.
///
/// - `overall` — account-wide provider-scoped totals (default).
/// - `project(id:)` — a single project's budget from the cached snapshot.
enum WidgetBudgetFocus: Equatable, Sendable {
    case overall
    case project(id: String)

    /// Stable id used by App Intents / deep links (`overall` or `project:<id>`).
    var selectionId: String {
        switch self {
        case .overall: return "overall"
        case .project(let id): return "project:\(id)"
        }
    }

    static func parse(selectionId: String?) -> WidgetBudgetFocus {
        guard let selectionId, !selectionId.isEmpty, selectionId != "overall" else {
            return .overall
        }
        if selectionId.hasPrefix("project:") {
            let id = String(selectionId.dropFirst("project:".count))
            return id.isEmpty ? .overall : .project(id: id)
        }
        // Bare project ids from older intent payloads.
        return .project(id: selectionId)
    }
}

/// Resolved numbers + chrome for one widget configuration.
struct WidgetBudgetContent: Equatable, Sendable {
    var focus: WidgetBudgetFocus
    /// Short caption above the hero total ("Overall" / project name).
    var title: String
    var spentUsd: Double
    var budgetUsd: Double
    var projectedEomUsd: Double
    var percentUsed: Double?
    var overBudget: Bool
    var warning: Bool
    /// Medium-family side list (providers when overall; empty for a project).
    var meters: [WidgetSnapshot.Meter]
    var deepLink: URL?
    /// True when a project focus was requested but that project is missing.
    var fellBackToOverall: Bool
}

/// Pure, view-free presentation logic for the budget widget.
///
/// Kept deliberately separate from the SwiftUI views so the status mapping and
/// derivation math are unit-testable without a rendering context. This lane is
/// model- and networking-free by contract, so the raw status *string* carried
/// on `WidgetSnapshot.Meter` is mapped onto `Theme.SemanticStatus` here rather
/// than via AppCore's `Theme.SemanticStatus(_ level:)` bridge (which lives in a
/// layer the widget must not depend on).
enum WidgetPresentation {
    /// Age past which the widget treats cached spend as stale (1 hour). Longer
    /// than the in-app 15-minute threshold because widgets refresh less often.
    static let staleThreshold: TimeInterval = 60 * 60

    /// Resolve the numbers the widget renders for a given focus selection.
    static func content(
        from snapshot: WidgetSnapshot,
        focus: WidgetBudgetFocus,
        maxMeters: Int = 3,
        sortOrder: WidgetSortOrder = .utilisation
    ) -> WidgetBudgetContent {
        switch focus {
        case .overall:
            return overallContent(
                from: snapshot,
                maxMeters: maxMeters,
                fellBack: false,
                sortOrder: sortOrder
            )
        case .project(let id):
            if let project = snapshot.projects.first(where: { $0.id == id }) {
                let budget = project.budgetUsd ?? 0
                let spent = project.spentUsd
                let over = project.status == "exceeded"
                    || (budget > 0 && spent >= budget)
                let warn = over
                    || project.status == "warning"
                    || (budget > 0 && spent / budget >= 0.8)
                return WidgetBudgetContent(
                    focus: .project(id: id),
                    title: project.name,
                    spentUsd: spent,
                    budgetUsd: budget,
                    projectedEomUsd: project.projectedEomUsd ?? 0,
                    percentUsed: project.percentUsed
                        ?? (budget > 0 ? spent / budget : nil),
                    overBudget: over,
                    warning: warn,
                    meters: [],
                    deepLink: URL(string: "usageclientmonitor://projects"),
                    fellBackToOverall: false
                )
            }
            // Project removed or not yet in cache — show overall rather than zeros.
            return overallContent(
                from: snapshot,
                maxMeters: maxMeters,
                fellBack: true,
                sortOrder: sortOrder
            )
        }
    }

    private static func overallContent(
        from snapshot: WidgetSnapshot,
        maxMeters: Int,
        fellBack: Bool,
        sortOrder: WidgetSortOrder = .utilisation
    ) -> WidgetBudgetContent {
        WidgetBudgetContent(
            focus: .overall,
            title: "Overall",
            spentUsd: snapshot.totalSpentUsd,
            budgetUsd: snapshot.totalBudgetUsd,
            projectedEomUsd: snapshot.projectedEomUsd,
            percentUsed: snapshot.percentUsed,
            overBudget: snapshot.overBudget,
            warning: snapshot.warning,
            meters: Array(rank(snapshot.topMeters, by: sortOrder).prefix(maxMeters)),
            deepLink: URL(string: "usageclientmonitor://dashboard"),
            fellBackToOverall: fellBack
        )
    }

    /// Map a raw `WidgetSnapshot.Meter.status` string onto the design system's
    /// semantic status. The raw values mirror the server's `BudgetLevel`:
    /// `"ok" | "warning" | "exceeded" | "unconfigured"`. Anything unexpected
    /// degrades to `.neutral` so a schema drift never crashes or mis-alarms.
    /// Rank a meter list for display.  Utilisation sorts by percent-used (a
    /// row with no budget sorts last rather than as 0%), spend sorts by
    /// month-to-date dollars, and both fall back to name order so equal rows
    /// never reshuffle between refreshes.
    static func rank(
        _ meters: [WidgetSnapshot.Meter],
        by order: WidgetSortOrder
    ) -> [WidgetSnapshot.Meter] {
        meters.sorted { lhs, rhs in
            switch order {
            case .utilisation:
                let l = lhs.percentUsed
                let r = rhs.percentUsed
                switch (l, r) {
                case let (l?, r?):
                    if l != r { return l > r }
                case (nil, .some):
                    return false
                case (.some, nil):
                    return true
                case (nil, nil):
                    break
                }
            case .spend:
                if lhs.spentUsd != rhs.spentUsd { return lhs.spentUsd > rhs.spentUsd }
            }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }

    static func semanticStatus(forRawStatus raw: String) -> Theme.SemanticStatus {
        switch raw {
        case "exceeded": return .danger
        case "warning": return .warning
        case "ok": return .ok
        default: return .neutral // "unconfigured" or anything unrecognised
        }
    }

    /// Overall status for the summary hero, derived from the snapshot's flags.
    static func overallStatus(for snapshot: WidgetSnapshot) -> Theme.SemanticStatus {
        status(overBudget: snapshot.overBudget, warning: snapshot.warning, budgetUsd: snapshot.totalBudgetUsd)
    }

    static func status(for content: WidgetBudgetContent) -> Theme.SemanticStatus {
        status(overBudget: content.overBudget, warning: content.warning, budgetUsd: content.budgetUsd)
    }

    private static func status(overBudget: Bool, warning: Bool, budgetUsd: Double) -> Theme.SemanticStatus {
        if overBudget { return .danger }
        if warning { return .warning }
        return budgetUsd > 0 ? .ok : .neutral
    }

    /// Short badge label for the overall summary, or `nil` when on-track (no
    /// badge shown so the small widget stays calm and uncluttered).
    static func overallLabel(for snapshot: WidgetSnapshot) -> String? {
        label(overBudget: snapshot.overBudget, warning: snapshot.warning)
    }

    static func label(for content: WidgetBudgetContent) -> String? {
        label(overBudget: content.overBudget, warning: content.warning)
    }

    private static func label(overBudget: Bool, warning: Bool) -> String? {
        if overBudget { return "Over budget" }
        if warning { return "Approaching" }
        return nil
    }

    /// SF Symbol paired with `overallLabel`.
    static func overallSymbol(for snapshot: WidgetSnapshot) -> String {
        symbol(overBudget: snapshot.overBudget, warning: snapshot.warning)
    }

    static func symbol(for content: WidgetBudgetContent) -> String {
        symbol(overBudget: content.overBudget, warning: content.warning)
    }

    private static func symbol(overBudget: Bool, warning: Bool) -> String {
        if overBudget { return "exclamationmark.octagon.fill" }
        if warning { return "gauge.with.dots.needle.67percent" }
        return "checkmark.circle.fill"
    }

    /// Fraction spent (spent ÷ budget). Returns `0` when there is no budget so
    /// the meter renders an empty track rather than a divide-by-zero.
    static func fraction(spent: Double, budget: Double?) -> Double {
        guard let budget, budget > 0 else { return 0 }
        return spent / budget
    }

    /// Compact `"$212 / $250"` detail for a meter row; drops the denominator
    /// when the provider has no configured budget.
    static func meterDetail(spent: Double, budget: Double?) -> String {
        if let budget, budget > 0 {
            return "\(CurrencyFormat.compactUSD(spent)) / \(CurrencyFormat.compactUSD(budget))"
        }
        return CurrencyFormat.compactUSD(spent)
    }

    /// `"of $900"` sub-caption under the hero total, or `nil` when unbudgeted.
    static func budgetCaption(for snapshot: WidgetSnapshot) -> String? {
        budgetCaption(budgetUsd: snapshot.totalBudgetUsd)
    }

    static func budgetCaption(for content: WidgetBudgetContent) -> String? {
        budgetCaption(budgetUsd: content.budgetUsd)
    }

    private static func budgetCaption(budgetUsd: Double) -> String? {
        guard budgetUsd > 0 else { return nil }
        return "of \(CurrencyFormat.compactUSD(budgetUsd))"
    }

    /// Public form of `budgetCaption(budgetUsd:)` for topics that aggregate
    /// their own denominator (Projects sums several project budgets) rather
    /// than reading the account total off a snapshot.
    static func budgetCaptionForTotal(_ budgetUsd: Double) -> String? {
        budgetCaption(budgetUsd: budgetUsd)
    }

    static func displayBudgetCaption(for content: WidgetBudgetContent, redacted: Bool) -> String? {
        if redacted { return WidgetPrivacy.lockedLabel }
        return budgetCaption(for: content)
    }

    /// Whether the "updated … ago" staleness caption should render. The empty
    /// snapshot (fresh install / signed-out) carries a sentinel epoch
    /// timestamp that must never surface as a relative age; everything else
    /// shows its real `generatedAt` so days-old data is visibly stale.
    static func showsUpdatedAt(for snapshot: WidgetSnapshot) -> Bool {
        !snapshot.month.isEmpty && snapshot.generatedAt.timeIntervalSince1970 > 0
    }

    /// Whether the snapshot is older than ``staleThreshold``. Empty/placeholder
    /// snapshots without a real timestamp are never treated as stale.
    static func isStale(for snapshot: WidgetSnapshot, asOf now: Date = Date()) -> Bool {
        guard showsUpdatedAt(for: snapshot) else { return false }
        return now.timeIntervalSince(snapshot.generatedAt) >= staleThreshold
    }

    /// Caption under the hero: always "Updated …". Age alone is not "Stale" —
    /// the host app / timeline should refresh; never-pollable spend is Manual.
    /// Returns `nil` for empty snapshots that must not show an age.
    static func updatedCaption(for snapshot: WidgetSnapshot, asOf now: Date = Date()) -> String? {
        guard showsUpdatedAt(for: snapshot) else { return nil }
        let relative = relativeAge(since: snapshot.generatedAt, asOf: now)
        return "Updated \(relative)"
    }

    /// Compact relative age phrase for widget chrome.
    static func relativeAge(since date: Date, asOf now: Date = Date()) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 45 { return "just now" }
        if seconds < 90 { return "1 min ago" }
        if seconds < 3600 {
            let mins = Int((seconds / 60).rounded())
            return "\(mins) min ago"
        }
        if seconds < 90 * 60 { return "1 hr ago" }
        if seconds < 36 * 3600 {
            let hours = Int((seconds / 3600).rounded())
            return "\(hours) hr ago"
        }
        let days = max(1, Int((seconds / 86_400).rounded()))
        return days == 1 ? "1 day ago" : "\(days) days ago"
    }

    /// True when the host app mirrored `settings.appLockEnabled` into the
    /// App Group (`WidgetPrivacy` / `AppSettings.mirrorAppLockToSharedDefaults`).
    /// Always-on while lock is enabled (presentation-time redaction only).
    static func shouldRedactAmounts(appGroupDefaults: UserDefaults = AppGroup.defaults) -> Bool {
        WidgetPrivacy.isAppLockEnabled(defaults: appGroupDefaults)
    }

    /// Display string for a USD amount, or a redacted placeholder when privacy
    /// redaction is active.
    static func displayAmount(_ usd: Double, redacted: Bool) -> String {
        redacted ? WidgetPrivacy.redactedAmount : CurrencyFormat.compactUSD(usd)
    }

    /// Budget caption under the hero, or `"Locked"` when redacted so the
    /// ceiling is never leaked on the home screen.
    static func displayBudgetCaption(for snapshot: WidgetSnapshot, redacted: Bool) -> String? {
        if redacted { return WidgetPrivacy.lockedLabel }
        return budgetCaption(for: snapshot)
    }

    static func displayMeterDetail(spent: Double, budget: Double?, redacted: Bool) -> String {
        if redacted { return WidgetPrivacy.redactedAmount }
        return meterDetail(spent: spent, budget: budget)
    }
}

/// Gallery / Edit Widget topic.  One widget kind; users add copies per topic.
enum WidgetTopic: String, Equatable, Sendable {
    case budget
    case llmQuotas
    case quotas
    case servers
    case mac
    case alerts
    case providers
    case projects

    var title: String {
        switch self {
        case .budget: return "Budget"
        case .llmQuotas: return "LLM Burn"
        case .quotas: return "Quotas"
        case .servers: return "Servers"
        case .mac: return "Mac"
        case .alerts: return "Alerts"
        case .providers: return "Providers"
        case .projects: return "Projects"
        }
    }

    static func parse(_ raw: String?) -> WidgetTopic {
        guard let raw else { return .budget }
        return WidgetTopic(rawValue: raw) ?? .budget
    }
}

enum WidgetServerFocus: Equatable, Sendable {
    case service
    case host
    case app(id: String)

    var selectionId: String {
        switch self {
        case .service: return "server:service"
        case .host: return "server:host"
        case .app(let id): return "server:app:\(id)"
        }
    }

    static func parse(selectionId: String?) -> WidgetServerFocus {
        guard let selectionId, !selectionId.isEmpty, selectionId != "server:service" else {
            return .service
        }
        if selectionId == "server:host" { return .host }
        if selectionId.hasPrefix("server:app:") {
            let id = String(selectionId.dropFirst("server:app:".count))
            return id.isEmpty ? .service : .app(id: id)
        }
        if selectionId.hasPrefix("app:") {
            let id = String(selectionId.dropFirst("app:".count))
            return id.isEmpty ? .service : .app(id: id)
        }
        return .service
    }
}

/// Honest empty / missing-cache copy.  Never rewrite a missing metric as $0.
struct WidgetUnavailableContent: Equatable, Sendable {
    var title: String
    var message: String
    var deepLink: URL?

    /// Build an unavailable state, substituting the actionable "app group is
    /// broken" message when that is the real cause.
    ///
    /// Every topic used to hard-code "Open the app to load ...", which is
    /// indistinguishable from advice that does not work — the app loads fine
    /// and the widget says the same thing again. When the shared container is
    /// unavailable, no amount of tapping will ever populate the widget, so say
    /// that instead of sending the owner back into the same loop.
    init(
        title: String,
        message: String,
        deepLink: URL?,
        appGroupUnavailable: Bool = WidgetSnapshotResolver.shared.isAppGroupUnavailable
    ) {
        self.title = title
        self.message = appGroupUnavailable
            ? "Widget storage is unavailable on this install.  Reinstall the app to restore it."
            : message
        self.deepLink = deepLink
    }
}

struct WidgetLlmContent: Equatable, Sendable {
    var provider: WidgetSnapshot.LlmSection.Provider
    var windowHours: Double?
    var peers: [WidgetSnapshot.LlmSection.Provider]
    var generatedAt: Date
    var deepLink: URL?
}

struct WidgetServerContent: Equatable, Sendable {
    var focus: WidgetServerFocus
    var title: String
    var generatedAt: Date
    var service: WidgetSnapshot.ServerSection.Service?
    var host: WidgetSnapshot.ServerSection.Host?
    var app: WidgetSnapshot.ServerSection.App?
    var apps: [WidgetSnapshot.ServerSection.App]
    var deepLink: URL?
}

struct WidgetMacContent: Equatable, Sendable {
    var section: WidgetSnapshot.MacSection
    var deepLink: URL?
}

struct WidgetAlertsContent: Equatable, Sendable {
    var section: WidgetSnapshot.AlertsSection
    var deepLink: URL?
}

struct WidgetProvidersContent: Equatable, Sendable {
    var title: String
    var spentUsd: Double
    var budgetUsd: Double
    var meters: [WidgetSnapshot.Meter]
    var generatedAt: Date
    var deepLink: URL?
}

/// Subscription plan capacity — how much of a Claude / Codex / Grok / MiniMax
/// window is left.  Deliberately separate from ``WidgetLlmContent``, which is
/// trailing-window *spend*: one answers "what have I burned", this answers "how
/// close am I to being cut off".
struct WidgetQuotaContent: Equatable, Sendable {
    var generatedAt: Date
    var windows: [WidgetSnapshot.QuotaSection.Window]
    var deepLink: URL?
}

/// All project budgets as their own topic, rather than only reachable as a
/// per-project *focus* of the Budget topic.
struct WidgetProjectsContent: Equatable, Sendable {
    var generatedAt: Date
    var projects: [WidgetSnapshot.Meter]
    var totalSpentUsd: Double
    var totalBudgetUsd: Double
    var deepLink: URL?
}

enum WidgetTopicContent: Equatable, Sendable {
    case budget(WidgetBudgetContent)
    case llm(WidgetLlmContent)
    case quota(WidgetQuotaContent)
    case server(WidgetServerContent)
    case mac(WidgetMacContent)
    case alerts(WidgetAlertsContent)
    case providers(WidgetProvidersContent)
    case projects(WidgetProjectsContent)
    case unavailable(WidgetUnavailableContent)
}

enum WidgetTopicPresentation {
    static func topicContent(
        from snapshot: WidgetSnapshot,
        topic: WidgetTopic,
        budgetFocus: WidgetBudgetFocus,
        llmProviderId: String?,
        serverFocus: WidgetServerFocus,
        maxMeters: Int = 3,
        sortOrder: WidgetSortOrder = .utilisation,
        providersSort: WidgetSortOrder = .spend,
        appGroupUnavailable: Bool = WidgetSnapshotResolver.shared.isAppGroupUnavailable
    ) -> WidgetTopicContent {
        switch topic {
        case .budget:
            return .budget(
                WidgetPresentation.content(
                    from: snapshot,
                    focus: budgetFocus,
                    maxMeters: maxMeters,
                    sortOrder: sortOrder
                )
            )
        case .llmQuotas:
            return llmContent(
                from: snapshot,
                providerId: llmProviderId,
                appGroupUnavailable: appGroupUnavailable
            )
        case .quotas:
            return quotaContent(
                from: snapshot,
                maxMeters: maxMeters,
                sortOrder: sortOrder,
                appGroupUnavailable: appGroupUnavailable
            )
        case .servers:
            return serverContent(
                from: snapshot,
                focus: serverFocus,
                appGroupUnavailable: appGroupUnavailable
            )
        case .mac:
            return macContent(
                from: snapshot,
                maxMeters: maxMeters,
                appGroupUnavailable: appGroupUnavailable
            )
        case .alerts:
            return alertsContent(
                from: snapshot,
                maxMeters: maxMeters,
                appGroupUnavailable: appGroupUnavailable
            )
        case .providers:
            // Providers is a spend ranking by definition; the shared sortOrder
            // defaults to .utilisation (which would have been indistinguishable
            // from an explicit "Closest to Budget" pick), so Providers gets its
            // own parameter that defaults to .spend. An explicit Closest to
            // Budget pick on the intent survives via `providersSort`.
            return providersContent(
                from: snapshot,
                maxMeters: max(maxMeters, 6),
                sortOrder: providersSort,
                appGroupUnavailable: appGroupUnavailable
            )
        case .projects:
            return projectsContent(
                from: snapshot,
                maxMeters: maxMeters,
                sortOrder: sortOrder,
                appGroupUnavailable: appGroupUnavailable
            )
        }
    }

    static func quotaContent(
        from snapshot: WidgetSnapshot,
        maxMeters: Int,
        sortOrder: WidgetSortOrder = .utilisation,
        appGroupUnavailable: Bool = WidgetSnapshotResolver.shared.isAppGroupUnavailable
    ) -> WidgetTopicContent {
        guard let section = snapshot.quotas else {
            return .unavailable(
                WidgetUnavailableContent(
                    title: "Quotas",
                    message: "Open the app to load plan quotas.",
                    deepLink: URL(string: "usageclientmonitor://dashboard"),
                    appGroupUnavailable: appGroupUnavailable
                )
            )
        }
        if section.windows.isEmpty {
            return .unavailable(
                WidgetUnavailableContent(
                    title: "Quotas",
                    message: "No quota windows reported yet.",
                    deepLink: URL(string: "usageclientmonitor://dashboard"),
                    appGroupUnavailable: appGroupUnavailable
                )
            )
        }
        let windows: [WidgetSnapshot.QuotaSection.Window]
        switch sortOrder {
        case .utilisation:
            // Most urgent first: `isExhausted` wins outright (a server-flagged
            // exhausted window with no number must not be hidden behind a
            // healthy 100%-remaining one), then lowest remaining fraction, then
            // a label tiebreak so equal rows keep a stable order. The medium
            // hero relies on `windows.first` being the worst window.
            windows = section.windows.sorted { lhs, rhs in
                if lhs.isExhausted != rhs.isExhausted { return lhs.isExhausted }
                let l = lhs.remainingFraction ?? 1
                let r = rhs.remainingFraction ?? 1
                if l != r { return l < r }
                return lhs.providerLabel.localizedCaseInsensitiveCompare(rhs.providerLabel) == .orderedAscending
            }
        case .spend:
            windows = section.windows.sorted { lhs, rhs in
                lhs.providerLabel.localizedCaseInsensitiveCompare(rhs.providerLabel) == .orderedAscending
            }
        }
        return .quota(
            WidgetQuotaContent(
                generatedAt: section.generatedAt,
                windows: Array(windows.prefix(maxMeters)),
                deepLink: URL(string: "usageclientmonitor://dashboard")
            )
        )
    }

    static func projectsContent(
        from snapshot: WidgetSnapshot,
        maxMeters: Int,
        sortOrder: WidgetSortOrder = .utilisation,
        appGroupUnavailable: Bool = WidgetSnapshotResolver.shared.isAppGroupUnavailable
    ) -> WidgetTopicContent {
        guard !snapshot.projects.isEmpty else {
            return .unavailable(
                WidgetUnavailableContent(
                    title: "Projects",
                    message: "Open the app to load project budgets.",
                    deepLink: URL(string: "usageclientmonitor://projects"),
                    appGroupUnavailable: appGroupUnavailable
                )
            )
        }
        let rows = Array(WidgetPresentation.rank(snapshot.projects, by: sortOrder).prefix(maxMeters))
        return .projects(
            WidgetProjectsContent(
                generatedAt: snapshot.generatedAt,
                projects: rows,
                // Hero figures are project totals: reduce over the full
                // snapshot list, not the row-truncated one, or the headline
                // silently becomes a subtotal of the visible rows.
                totalSpentUsd: snapshot.projects.reduce(0) { $0 + $1.spentUsd },
                totalBudgetUsd: snapshot.projects.reduce(0) { $0 + ($1.budgetUsd ?? 0) },
                deepLink: URL(string: "usageclientmonitor://projects")
            )
        )
    }

    static func llmContent(
        from snapshot: WidgetSnapshot,
        providerId: String?,
        appGroupUnavailable: Bool = WidgetSnapshotResolver.shared.isAppGroupUnavailable
    ) -> WidgetTopicContent {
        guard let section = snapshot.llm else {
            return .unavailable(
                WidgetUnavailableContent(
                    title: "LLM Quotas",
                    message: "Open the app to load LLM quotas.",
                    deepLink: URL(string: "usageclientmonitor://dashboard"),
                    appGroupUnavailable: appGroupUnavailable
                )
            )
        }
        if section.providers.isEmpty {
            return .unavailable(
                WidgetUnavailableContent(
                    title: "LLM Quotas",
                    message: "No LLM activity in the latest window.",
                    deepLink: URL(string: "usageclientmonitor://dashboard"),
                    appGroupUnavailable: appGroupUnavailable
                )
            )
        }
        let selected: WidgetSnapshot.LlmSection.Provider?
        if let providerId, !providerId.isEmpty {
            selected = section.providers.first { $0.id.caseInsensitiveCompare(providerId) == .orderedSame }
            if selected == nil {
                return .unavailable(
                    WidgetUnavailableContent(
                        title: "LLM Quotas",
                        message: "That provider is not in the latest cache.",
                        deepLink: URL(string: "usageclientmonitor://dashboard"),
                        appGroupUnavailable: appGroupUnavailable
                    )
                )
            }
        } else {
            selected = section.providers.first { !$0.quiet } ?? section.providers.first
        }
        guard let provider = selected else {
            return .unavailable(
                WidgetUnavailableContent(
                    title: "LLM Quotas",
                    message: "No LLM activity in the latest window.",
                    deepLink: URL(string: "usageclientmonitor://dashboard"),
                    appGroupUnavailable: appGroupUnavailable
                )
            )
        }
        return .llm(
            WidgetLlmContent(
                provider: provider,
                windowHours: section.windowHours,
                peers: section.providers.filter { $0.id != provider.id },
                generatedAt: section.generatedAt,
                deepLink: URL(string: "usageclientmonitor://dashboard")
            )
        )
    }

    static func serverContent(
        from snapshot: WidgetSnapshot,
        focus: WidgetServerFocus,
        appGroupUnavailable: Bool = WidgetSnapshotResolver.shared.isAppGroupUnavailable
    ) -> WidgetTopicContent {
        let section = snapshot.servers
        switch focus {
        case .service:
            guard let service = section?.service else {
                return .unavailable(
                    WidgetUnavailableContent(
                        title: "Servers",
                        message: "Open the app to load server status.",
                        deepLink: URL(string: "usageclientmonitor://serverStatus"),
                        appGroupUnavailable: appGroupUnavailable
                    )
                )
            }
            return .server(
                WidgetServerContent(
                    focus: .service,
                    title: service.name,
                    generatedAt: service.generatedAt,
                    service: service,
                    host: section?.host,
                    apps: section?.apps ?? [],
                    deepLink: URL(string: "usageclientmonitor://serverStatus")
                )
            )
        case .host:
            guard let host = section?.host else {
                return .unavailable(
                    WidgetUnavailableContent(
                        title: "Host",
                        message: "Host metrics are not in the latest cache.",
                        deepLink: URL(string: "usageclientmonitor://serverStatus"),
                        appGroupUnavailable: appGroupUnavailable
                    )
                )
            }
            return .server(
                WidgetServerContent(
                    focus: .host,
                    title: host.name ?? "Host",
                    generatedAt: host.generatedAt,
                    host: host,
                    apps: section?.apps ?? [],
                    deepLink: URL(string: "usageclientmonitor://serverStatus")
                )
            )
        case .app(let id):
            guard let app = section?.apps.first(where: { $0.id == id }) else {
                return .unavailable(
                    WidgetUnavailableContent(
                        title: "Servers",
                        message: "That app is not in the latest cache.",
                        deepLink: URL(string: "usageclientmonitor://serverStatus"),
                        appGroupUnavailable: appGroupUnavailable
                    )
                )
            }
            return .server(
                WidgetServerContent(
                    focus: .app(id: id),
                    title: app.name,
                    generatedAt: section?.host?.generatedAt ?? section?.service?.generatedAt ?? snapshot.generatedAt,
                    app: app,
                    apps: section?.apps ?? [],
                    deepLink: URL(string: "usageclientmonitor://serverStatus")
                )
            )
        }
    }

    /// Recorded-wins display cost: estimate, else derived, else reported.
    /// Returns `nil` when the cache has no cost so the widget cannot show $0 as live.
    static func llmDisplayCostUsd(for provider: WidgetSnapshot.LlmSection.Provider) -> Double? {
        provider.estimateUsd ?? provider.derivedCostUsd ?? provider.reportedCostUsd
    }

    static func llmCostCaption(for provider: WidgetSnapshot.LlmSection.Provider, redacted: Bool) -> String? {
        guard let usd = llmDisplayCostUsd(for: provider) else { return nil }
        return WidgetPresentation.displayAmount(usd, redacted: redacted)
    }

    static func llmTokenCaption(for provider: WidgetSnapshot.LlmSection.Provider) -> String {
        "\(compactCount(provider.tokensTotal)) tok"
    }

    static func llmWindowCaption(hours: Double?) -> String? {
        guard let hours, hours > 0 else { return nil }
        if hours == 1 { return "Last 1 hour" }
        if hours == floor(hours) {
            return "Last \(Int(hours)) hours"
        }
        return "Last \(hours) hours"
    }

    static func llmBudgetStatus(_ raw: String?) -> Theme.SemanticStatus {
        switch raw {
        case "over-pace": return .danger
        case "watch": return .warning
        case "on-pace": return .ok
        default: return .neutral
        }
    }

    static func llmBudgetLabel(_ raw: String?) -> String? {
        switch raw {
        case "over-pace": return "Over pace"
        case "watch": return "Watch"
        case "on-pace": return "On pace"
        case "no-budget": return nil
        default: return nil
        }
    }

    static func serverOverallLabel(for service: WidgetSnapshot.ServerSection.Service) -> String {
        if !service.ok { return "Offline" }
        if let ready = service.readyOk, !ready { return "Degraded" }
        return "Operational"
    }

    static func serverOverallStatus(for service: WidgetSnapshot.ServerSection.Service) -> Theme.SemanticStatus {
        if !service.ok { return .danger }
        if let ready = service.readyOk, !ready { return .warning }
        return .ok
    }

    static func serverCheckLabel(_ check: WidgetSnapshot.ServerSection.Check) -> String {
        if check.ok { return "OK" }
        return check.gatesService ? "Down" : "Lagging"
    }

    static func serverCheckStatus(_ check: WidgetSnapshot.ServerSection.Check) -> Theme.SemanticStatus {
        if check.ok { return .ok }
        return check.gatesService ? .danger : .warning
    }

    static func serverCheckDetail(_ check: WidgetSnapshot.ServerSection.Check) -> String? {
        if let detail = check.detail, !detail.isEmpty { return detail }
        return DiskFormat.summary(free: check.freeBytes, total: check.totalBytes)
    }

    static func hostStatus(_ host: WidgetSnapshot.ServerSection.Host) -> Theme.SemanticStatus {
        if host.stale || host.degraded { return .warning }
        switch host.preventionOverall {
        case "critical": return .danger
        case "warning": return .warning
        default: return .ok
        }
    }

    static func hostLabel(_ host: WidgetSnapshot.ServerSection.Host) -> String {
        if host.stale { return "Stale" }
        if host.degraded { return "Degraded" }
        switch host.preventionOverall {
        case "critical": return "Critical"
        case "warning": return "Watch"
        case "ok": return "Live"
        default:
            return host.status?.capitalized ?? "Host"
        }
    }

    static func appLabel(_ status: String) -> String {
        let lower = status.lowercased()
        if lower.hasPrefix("exited") || lower.hasPrefix("stopped") { return "Stopped" }
        if lower.contains("unhealthy") { return "Unhealthy" }
        if lower.contains("healthy") || lower == "running" { return "Healthy" }
        if lower.contains("unknown") { return "Unknown" }
        if lower.contains("degraded") { return "Degraded" }
        return status
    }

    static func appStatus(_ status: String) -> Theme.SemanticStatus {
        let lower = status.lowercased()
        if lower.hasPrefix("exited") || lower.hasPrefix("stopped") { return .danger }
        if lower.contains("unhealthy") { return .danger }
        if lower.contains("healthy") || lower == "running" { return .ok }
        if lower.contains("unknown") { return .warning }
        if lower.contains("degraded") { return .warning }
        return .warning
    }

    static func showsUpdatedAt(generatedAt: Date) -> Bool {
        generatedAt.timeIntervalSince1970 > 0
    }

    static func isStale(generatedAt: Date, asOf now: Date = Date()) -> Bool {
        guard showsUpdatedAt(generatedAt: generatedAt) else { return false }
        return now.timeIntervalSince(generatedAt) >= WidgetPresentation.staleThreshold
    }

    static func updatedCaption(generatedAt: Date, asOf now: Date = Date()) -> String? {
        guard showsUpdatedAt(generatedAt: generatedAt) else { return nil }
        return "Updated \(WidgetPresentation.relativeAge(since: generatedAt, asOf: now))"
    }

    static func generatedAt(for content: WidgetTopicContent, snapshot: WidgetSnapshot) -> Date? {
        switch content {
        case .budget:
            return WidgetPresentation.showsUpdatedAt(for: snapshot) ? snapshot.generatedAt : nil
        case .llm(let llm):
            return showsUpdatedAt(generatedAt: llm.generatedAt) ? llm.generatedAt : nil
        case .quota(let quota):
            return showsUpdatedAt(generatedAt: quota.generatedAt) ? quota.generatedAt : nil
        case .server(let server):
            return showsUpdatedAt(generatedAt: server.generatedAt) ? server.generatedAt : nil
        case .mac(let mac):
            return showsUpdatedAt(generatedAt: mac.section.generatedAt) ? mac.section.generatedAt : nil
        case .alerts(let alerts):
            return showsUpdatedAt(generatedAt: alerts.section.generatedAt) ? alerts.section.generatedAt : nil
        case .providers(let providers):
            return showsUpdatedAt(generatedAt: providers.generatedAt) ? providers.generatedAt : nil
        case .projects(let projects):
            return showsUpdatedAt(generatedAt: projects.generatedAt) ? projects.generatedAt : nil
        case .unavailable:
            return nil
        }
    }

    // MARK: - Quotas

    /// Severity for one quota window. Exhausted wins over near-cap, and a
    /// window with no number is `neutral` rather than a fabricated 0%.
    static func quotaStatus(_ window: WidgetSnapshot.QuotaSection.Window) -> Theme.SemanticStatus {
        if window.isExhausted { return .danger }
        if window.isNearCap { return .warning }
        guard let remaining = window.remainingFraction else { return .neutral }
        if remaining <= 0 { return .danger }
        if remaining <= 0.2 { return .warning }
        return .ok
    }

    /// `"12% left"` / `"Exhausted"` / `"Unknown"`. Never renders a percent the
    /// server did not send.
    static func quotaRemainingCaption(_ window: WidgetSnapshot.QuotaSection.Window) -> String {
        if window.isExhausted { return "Exhausted" }
        guard let remaining = window.remainingFraction else { return "Unknown" }
        return "\(Int((remaining * 100).rounded()))% left"
    }

    /// Fraction **used**, for the meter fill. `nil` renders an empty track.
    static func quotaFractionUsed(_ window: WidgetSnapshot.QuotaSection.Window) -> Double {
        guard let remaining = window.remainingFraction else { return 0 }
        return max(0, min(1, 1 - remaining))
    }

    static func quotaLabel(_ window: WidgetSnapshot.QuotaSection.Window) -> String? {
        if window.isExhausted { return "Exhausted" }
        if window.isNearCap { return "Near cap" }
        return nil
    }

    static func quotaSymbol(_ window: WidgetSnapshot.QuotaSection.Window) -> String {
        if window.isExhausted { return "exclamationmark.octagon.fill" }
        if window.isNearCap { return "gauge.with.dots.needle.67percent" }
        return "gauge.with.dots.needle.50percent"
    }

    /// `"5h"` / `"7d"` / `"Resets in 2 hr"` caption under a quota row.
    ///
    /// The reset window is always a *future* target, so the duration is
    /// computed directly against `now` rather than fed through the past-tense
    /// ``WidgetPresentation/relativeAge(since:asOf:)`` helper — `relativeAge`
    /// clamps to zero for any future date and would have read "Resets in just
    /// now" for a positive countdown and "Resets in 3 hr ago" for an elapsed
    /// reset. An already-elapsed reset returns `nil` so the row never claims
    /// the window is about to refresh.
    static func quotaWindowCaption(_ window: WidgetSnapshot.QuotaSection.Window, asOf now: Date = Date()) -> String? {
        if let reset = window.resetAt {
            let seconds = reset.timeIntervalSince(now)
            guard seconds > 0 else { return nil }
            if seconds < 3600 {
                let mins = max(1, Int((seconds / 60).rounded()))
                return "Resets in \(mins) min"
            }
            if seconds < 36 * 3600 {
                let hours = max(1, Int((seconds / 3600).rounded()))
                return "Resets in \(hours) hr"
            }
            let days = max(1, Int((seconds / 86_400).rounded()))
            return "Resets in \(days) days"
        }
        guard let cadence = window.window, !cadence.isEmpty else { return nil }
        return cadence
    }

    static func macContent(
        from snapshot: WidgetSnapshot,
        maxMeters: Int = 8,
        appGroupUnavailable: Bool = WidgetSnapshotResolver.shared.isAppGroupUnavailable
    ) -> WidgetTopicContent {
        guard let section = snapshot.mac else {
            return .unavailable(
                WidgetUnavailableContent(
                    title: "Mac",
                    message: "Open the app to load Mac stats.",
                    deepLink: URL(string: "usageclientmonitor://computers"),
                    appGroupUnavailable: appGroupUnavailable
                )
            )
        }
        if !section.reported {
            return .unavailable(
                WidgetUnavailableContent(
                    title: "Mac",
                    message: "The Mac has not reported yet.",
                    deepLink: URL(string: "usageclientmonitor://computers"),
                    appGroupUnavailable: appGroupUnavailable
                )
            )
        }
        // `maxMeters` caps the process rows in the Large family. The Mac
        // section's three live percents (CPU/Memory/Disk) are fixed, so the
        // cap only narrows `processes`. Keep the original `section` intact
        // for the hero copy and trim just the list.
        let trimmed: WidgetSnapshot.MacSection
        if maxMeters > 0 && section.processes.count > maxMeters {
            var copy = section
            copy.processes = Array(section.processes.prefix(maxMeters))
            trimmed = copy
        } else {
            trimmed = section
        }
        return .mac(
            WidgetMacContent(
                section: trimmed,
                deepLink: URL(string: "usageclientmonitor://computers")
            )
        )
    }

    static func alertsContent(
        from snapshot: WidgetSnapshot,
        maxMeters: Int = 8,
        appGroupUnavailable: Bool = WidgetSnapshotResolver.shared.isAppGroupUnavailable
    ) -> WidgetTopicContent {
        guard let section = snapshot.alerts else {
            return .unavailable(
                WidgetUnavailableContent(
                    title: "Alerts",
                    message: "Open the app to load alerts.",
                    deepLink: URL(string: "usageclientmonitor://alerts"),
                    appGroupUnavailable: appGroupUnavailable
                )
            )
        }
        // `maxMeters` caps the open-alert rows so the Rows picker the owner
        // asked for actually changes what is rendered, rather than silently
        // no-oping on this tile.
        let trimmed: WidgetSnapshot.AlertsSection
        if maxMeters > 0 && section.items.count > maxMeters {
            var copy = section
            copy.items = Array(section.items.prefix(maxMeters))
            trimmed = copy
        } else {
            trimmed = section
        }
        return .alerts(
            WidgetAlertsContent(
                section: trimmed,
                deepLink: URL(string: "usageclientmonitor://alerts")
            )
        )
    }

    static func providersContent(
        from snapshot: WidgetSnapshot,
        maxMeters: Int = 6,
        sortOrder: WidgetSortOrder = .spend,
        appGroupUnavailable: Bool = WidgetSnapshotResolver.shared.isAppGroupUnavailable
    ) -> WidgetTopicContent {
        if snapshot.month.isEmpty {
            return .unavailable(
                WidgetUnavailableContent(
                    title: "Providers",
                    message: "Open the app to load providers.",
                    deepLink: URL(string: "usageclientmonitor://providers"),
                    appGroupUnavailable: appGroupUnavailable
                )
            )
        }
        // Providers is a *spend* ranking by definition — it lists top spenders
        // — so the source list is re-ranked only when the owner explicitly asks
        // for budget utilisation instead.
        let source = snapshot.spenders.isEmpty ? snapshot.topMeters : snapshot.spenders
        let meters = Array(WidgetPresentation.rank(source, by: sortOrder).prefix(maxMeters))
        if meters.isEmpty {
            return .unavailable(
                WidgetUnavailableContent(
                    title: "Providers",
                    message: "No provider spend in the latest cache.",
                    deepLink: URL(string: "usageclientmonitor://providers"),
                    appGroupUnavailable: appGroupUnavailable
                )
            )
        }
        return .providers(
            WidgetProvidersContent(
                title: "Providers",
                spentUsd: snapshot.totalSpentUsd,
                budgetUsd: snapshot.totalBudgetUsd,
                meters: meters,
                generatedAt: snapshot.generatedAt,
                deepLink: URL(string: "usageclientmonitor://providers")
            )
        )
    }

    static func macStatus(_ section: WidgetSnapshot.MacSection) -> Theme.SemanticStatus {
        switch section.status {
        case "online": return .ok
        case "degraded": return .warning
        default: return .danger
        }
    }

    static func macLabel(_ section: WidgetSnapshot.MacSection) -> String {
        switch section.status {
        case "online": return "Online"
        case "degraded": return "High Load"
        case "offline": return "Offline"
        default: return section.status.capitalized
        }
    }

    static func macIsStale(
        _ section: WidgetSnapshot.MacSection,
        asOf now: Date = Date()
    ) -> Bool {
        if section.status == "offline" { return true }
        if let seconds = section.secondsSinceHeartbeat, seconds >= Int(WidgetPresentation.staleThreshold) {
            return true
        }
        return isStale(generatedAt: section.generatedAt, asOf: now)
    }

    static func macPercentLabel(_ value: Double?) -> String? {
        DiskFormat.cpuString(value)
    }

    static func macProcessName(_ name: String) -> String {
        name.replacingOccurrences(of: "com.jay.", with: "")
    }

    static func macProcessLabel(_ status: String) -> String {
        switch status {
        case "running": return "Running"
        case "degraded": return "Degraded"
        case "stopped": return "Stopped"
        default: return status.capitalized
        }
    }

    static func macProcessStatus(_ status: String) -> Theme.SemanticStatus {
        switch status {
        case "running": return .ok
        case "degraded": return .warning
        default: return .danger
        }
    }

    static func alertsHeadline(openCount: Int) -> String {
        if openCount == 0 { return "All Clear" }
        if openCount == 1 { return "1 Open" }
        return "\(openCount) Open"
    }

    static func alertsNeedsAttentionLabel(count: Int) -> String? {
        guard count > 0 else { return nil }
        return "Needs Attention"
    }

    static func alertsSeverityStatus(_ raw: String?) -> Theme.SemanticStatus {
        switch raw {
        case "critical": return .danger
        case "warning": return .warning
        case "info": return .ok
        default: return .neutral
        }
    }

    static func alertsSeverityLabel(_ raw: String?) -> String {
        switch raw {
        case "critical": return "Critical"
        case "warning": return "Warning"
        case "info": return "Info"
        default: return "Alert"
        }
    }

    static func compactCount(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 0
        return formatter.string(from: NSNumber(value: value)) ?? "0"
    }
}

