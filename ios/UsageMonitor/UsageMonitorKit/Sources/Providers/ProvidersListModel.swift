import Foundation
import Observation
import DesignSystem
import Models

// ---------------------------------------------------------------------------
// The Providers list view-model and its pure query logic.
//
// UI state (search text, sort, status filter) lives in `ProvidersListModel`
// (@Observable). The actual filter/sort transform is a *pure* value type —
// `ProvidersQuery` — so it can be unit-tested without SwiftUI, MainActor, or a
// network. Budget data itself always comes from the shared `BudgetStore`; this
// model never fetches.
// ---------------------------------------------------------------------------

/// How the provider list is ordered.
enum ProviderSort: String, CaseIterable, Identifiable, Hashable {
    /// Most-severe budget status first, then by spend (the default triage view).
    case status
    /// Highest month-to-date spend first.
    case spend
    /// Highest budget utilisation first; providers without a budget sink last.
    case utilisation
    /// Alphabetical by display title.
    case name

    var id: String { rawValue }

    var label: String {
        switch self {
        case .status: return "Status"
        case .spend: return "Spend"
        case .utilisation: return "% Used"
        case .name: return "Name"
        }
    }

    var systemImage: String {
        switch self {
        case .status: return "exclamationmark.triangle"
        case .spend: return "dollarsign.circle"
        case .utilisation: return "gauge.with.dots.needle.67percent"
        case .name: return "textformat.abc"
        }
    }
}

/// A status facet the list can be narrowed to.
enum ProviderFilter: String, CaseIterable, Identifiable, Hashable {
    case all
    case overBudget
    case attention
    case onTrack
    case noBudget

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: return "All"
        case .overBudget: return "Over"
        case .attention: return "Warning"
        case .onTrack: return "On Track"
        case .noBudget: return "No Budget"
        }
    }

    var systemImage: String? {
        switch self {
        case .all: return nil
        case .overBudget: return "exclamationmark.octagon.fill"
        case .attention: return "gauge.with.dots.needle.67percent"
        case .onTrack: return "checkmark.circle.fill"
        case .noBudget: return "minus.circle"
        }
    }

    /// The design-system tint used for this facet's chip when selected.
    var status: Theme.SemanticStatus {
        switch self {
        case .all: return .neutral
        case .overBudget: return .danger
        case .attention: return .warning
        case .onTrack: return .ok
        case .noBudget: return .neutral
        }
    }

    /// Whether a provider belongs to this facet.
    func matches(_ provider: ProviderBudgetStatus) -> Bool {
        switch self {
        case .all: return true
        case .overBudget: return provider.status == .exceeded
        case .attention: return provider.status == .warning
        case .onTrack: return provider.status == .ok
        case .noBudget: return provider.status == .unconfigured || !provider.hasBudget
        }
    }
}

/// A pure, value-type description of "what the list should show". Deterministic
/// and side-effect free so it is trivially unit-testable.
struct ProvidersQuery: Equatable {
    var searchText: String = ""
    var sort: ProviderSort = .status
    var filter: ProviderFilter = .all

    /// Rank used for the `.status` sort — most severe first.
    private static func severityRank(_ level: BudgetLevel) -> Int {
        switch level {
        case .exceeded: return 0
        case .warning: return 1
        case .ok: return 2
        case .unconfigured: return 3
        }
    }

    /// Apply search → filter → sort to a set of providers.
    func apply(to providers: [ProviderBudgetStatus]) -> [ProviderBudgetStatus] {
        let needle = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        let searched: [ProviderBudgetStatus]
        if needle.isEmpty {
            searched = providers
        } else {
            searched = providers.filter { provider in
                provider.title.lowercased().contains(needle)
                    || provider.name.lowercased().contains(needle)
            }
        }

        let filtered = searched.filter { filter.matches($0) }

        return filtered.sorted { lhs, rhs in
            switch sort {
            case .status:
                let l = Self.severityRank(lhs.status)
                let r = Self.severityRank(rhs.status)
                if l != r { return l < r }
                return lhs.spentUsd > rhs.spentUsd
            case .spend:
                if lhs.spentUsd != rhs.spentUsd { return lhs.spentUsd > rhs.spentUsd }
                return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
            case .utilisation:
                // Providers with no budget sort last; among budgeted, higher %
                // first.
                let l = lhs.percentUsed ?? -1
                let r = rhs.percentUsed ?? -1
                if l != r { return l > r }
                return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
            case .name:
                return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
            }
        }
    }
}

/// The list screen's observable UI state. Holds only presentation state; budget
/// data is read from the shared `BudgetStore` at the call site and passed into
/// ``results(from:)``.
@MainActor
@Observable
final class ProvidersListModel {
    var searchText: String = ""
    var sort: ProviderSort = .status
    var filter: ProviderFilter = .all

    var query: ProvidersQuery {
        ProvidersQuery(searchText: searchText, sort: sort, filter: filter)
    }

    /// Whether any narrowing is active (drives the "clear filters" affordance
    /// and the empty-results copy).
    var isFiltering: Bool {
        filter != .all || !searchText.trimmingCharacters(in: .whitespaces).isEmpty
    }

    func results(from providers: [ProviderBudgetStatus]) -> [ProviderBudgetStatus] {
        query.apply(to: providers)
    }

    /// Count of providers matching each facet — powers the numeric badges on the
    /// filter chips (search text is intentionally ignored so the chip counts
    /// reflect the whole dataset).
    func count(for facet: ProviderFilter, in providers: [ProviderBudgetStatus]) -> Int {
        providers.filter { facet.matches($0) }.count
    }

    func reset() {
        searchText = ""
        filter = .all
    }
}
