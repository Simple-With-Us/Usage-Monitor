import Foundation
import Models
import AppCore
import Networking

// ---------------------------------------------------------------------------
// Maps the shared `BudgetStore` load state (+ local edits) into a single,
// testable display phase for the Projects screen. Kept free of SwiftUI so the
// mapping is unit-testable.
// ---------------------------------------------------------------------------

/// The four things the Projects list can be showing.
public enum ProjectBudgetsPhase: Equatable, Sendable {
    case loading
    case failed(APIError)
    case empty
    case loaded([ProjectBudgetPresentation])
}

public enum ProjectBudgetsListModel {
    /// Derive the display phase from the shared budget `LoadState` and the
    /// already-merged project list (fetched ∪ local edits).
    ///
    /// - Full-screen loading only when there is nothing to show yet.
    /// - Full-screen error only when a fetch failed with no data on hand; a
    ///   refresh failure over existing data keeps the list and is surfaced as a
    ///   soft banner by the view (via `BudgetStore.lastError`), not here.
    public static func phase(
        state: LoadState<BudgetStatusResponse>,
        projects: [ProjectBudgetStatus]
    ) -> ProjectBudgetsPhase {
        // Any project to show (fetched or locally created) wins over a spinner
        // or error, so the user never loses sight of their own edits.
        if !projects.isEmpty { return .loaded(projects.map(ProjectBudgetPresentation.init)) }
        if state.value == nil {
            if let error = state.error { return .failed(error) }
            if state.isInitialLoading { return .loading }
        }
        return .empty
    }

    /// Stable ordering for the list: over-budget first, then by spend desc, then
    /// name — so the projects that need attention sit at the top.
    public static func sorted(_ projects: [ProjectBudgetStatus]) -> [ProjectBudgetStatus] {
        projects.sorted { lhs, rhs in
            let lp = ProjectBudgetPresentation(lhs), rp = ProjectBudgetPresentation(rhs)
            if lp.isOverBudget != rp.isOverBudget { return lp.isOverBudget }
            if lhs.spentUsd != rhs.spentUsd { return lhs.spentUsd > rhs.spentUsd }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }
}
