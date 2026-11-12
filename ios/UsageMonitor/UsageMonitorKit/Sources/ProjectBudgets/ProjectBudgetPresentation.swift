import Foundation
import Models
import DesignSystem
import AppCore

// ---------------------------------------------------------------------------
// Pure, view-agnostic presentation logic for a single project budget. All the
// money math and formatting a screen needs lives here (not in a View) so it is
// unit-testable against fixtures. Money is derived from `Double` USD values and
// formatted with the shared `CurrencyFormat` so every screen renders identical,
// exact figures.
// ---------------------------------------------------------------------------

/// A display-ready wrapper around one ``ProjectBudgetStatus``.
///
/// Backed by the immutable domain value; every property is derived so the
/// struct stays a cheap, `Identifiable` value type suitable for SwiftUI lists.
public struct ProjectBudgetPresentation: Identifiable, Hashable, Sendable {
    public let project: ProjectBudgetStatus

    public init(_ project: ProjectBudgetStatus) {
        self.project = project
    }

    public var id: String { project.id }

    // MARK: Identity

    public var title: String {
        let trimmed = project.name.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? "Untitled project" : trimmed
    }

    public var subtitle: String? {
        guard let description = project.description?.trimmingCharacters(in: .whitespaces),
              !description.isEmpty else { return nil }
        return description
    }

    /// Design-system status for tints/badges, mapped from the domain level.
    public var status: Theme.SemanticStatus { .init(project.status) }

    public var hasBudget: Bool { project.hasBudget }

    // MARK: Core money values (exact `Double` USD)

    public var monthlyBudget: Double? { hasBudget ? project.monthlyBudgetUsd : nil }
    public var spent: Double { project.spentUsd }
    public var projectedEndOfMonth: Double { project.projectedEomUsd }

    /// Direct usage attributed straight to the project (may be absent).
    public var direct: Double? { project.directUsd }
    /// Spend allocated to the project from shared providers/subscriptions.
    public var allocated: Double? { project.allocatedUsd }

    /// Remaining budget. Uses the server-provided figure when present, else
    /// derives `budget − spent` (only meaningful when a budget exists).
    public var remaining: Double? {
        if let remaining = project.remainingUsd { return remaining }
        guard let budget = monthlyBudget else { return nil }
        return budget - spent
    }

    /// Spent ÷ budget as a 0…∞ ratio for the meter. Uses the server percent
    /// when present, otherwise computes it; `0` when there is no budget.
    public var meterFraction: Double {
        if let percent = project.percentUsed { return percent }
        guard let budget = monthlyBudget, budget > 0 else { return 0 }
        return spent / budget
    }

    /// True once spend has passed the configured budget.
    public var isOverBudget: Bool {
        if project.status == .exceeded { return true }
        if let remaining, remaining < 0 { return true }
        return false
    }

    // MARK: Spend-coverage caveat

    public var coverage: CostCoverage { project.spendCoverage }

    /// Whether reported spend should be caveated (anything short of `complete`).
    public var showsCoverageCaveat: Bool { !coverage.isComplete }
    public var coverageStatus: Theme.SemanticStatus { .init(coverage: coverage) }

    /// Number of providers whose allocation into this project is still
    /// incomplete — a data-quality caveat surfaced to the user.
    public var incompleteAllocatedProviderCount: Int {
        max(project.incompleteAllocatedProviderCount ?? 0, 0)
    }
    public var hasIncompleteAllocation: Bool { incompleteAllocatedProviderCount > 0 }

    // MARK: Formatted strings (exact currency / percent)

    public var spentDisplay: String { CurrencyFormat.usd(spent) }
    public var projectedDisplay: String { CurrencyFormat.usd(projectedEndOfMonth) }
    public var budgetDisplay: String? { monthlyBudget.map(CurrencyFormat.usd) }
    public var directDisplay: String? { direct.map(CurrencyFormat.usd) }
    public var allocatedDisplay: String? { allocated.map(CurrencyFormat.usd) }
    public var remainingDisplay: String? { remaining.map(CurrencyFormat.usd) }

    /// `48%` (clamped to a sensible 0…∞ display). Only when a budget exists.
    public var percentDisplay: String? {
        guard hasBudget else { return nil }
        return CurrencyFormat.percent(meterFraction)
    }

    /// The right-hand detail for a `LabeledBudgetMeter` / row:
    /// `$246.80 / $400.00` when budgeted, else `$246.80 spent`.
    public var meterDetail: String {
        if let budgetDisplay {
            return "\(spentDisplay) / \(budgetDisplay)"
        }
        return "\(spentDisplay) spent"
    }

    /// Compact trailing value for a list row.
    public var rowValue: String { spentDisplay }

    /// Compact caption under the row value: percent when budgeted, else spend
    /// coverage; nil when neither applies.
    public var rowCaption: String? {
        if let percentDisplay { return percentDisplay }
        if showsCoverageCaveat { return "\(coverage.label) coverage" }
        return nil
    }

    /// A short one-line status suitable as a row subtitle when no description.
    public var statusSummary: String {
        switch project.status {
        case .exceeded: return "Over Budget"
        case .warning: return "Approaching Budget"
        case .ok: return "On Track"
        case .unconfigured: return hasBudget ? "On Track" : "No Budget Set"
        }
    }

    /// Caveat sentence for the incomplete-allocation warning.
    public var incompleteAllocationMessage: String {
        let count = incompleteAllocatedProviderCount
        let noun = count == 1 ? "provider" : "providers"
        return "\(count) \(noun) still reconciling allocated spend — this total may rise."
    }
}

// MARK: - Aggregate across a project list

/// A project-scoped rollup (distinct from the provider-wide `BudgetSummary`),
/// computed purely from the project list so the Projects screen can show its
/// own header without another network call.
public struct ProjectBudgetsRollup: Equatable, Sendable {
    public let totalBudget: Double
    public let totalSpent: Double
    public let totalProjected: Double
    public let budgetedCount: Int
    public let unbudgetedCount: Int
    public let overBudgetCount: Int

    public init(projects: [ProjectBudgetStatus]) {
        var budget = 0.0, spent = 0.0, projected = 0.0
        var budgeted = 0, unbudgeted = 0, over = 0
        for project in projects {
            spent += project.spentUsd
            projected += project.projectedEomUsd
            if project.hasBudget, let value = project.monthlyBudgetUsd {
                budget += value
                budgeted += 1
            } else {
                unbudgeted += 1
            }
            if ProjectBudgetPresentation(project).isOverBudget { over += 1 }
        }
        self.totalBudget = budget
        self.totalSpent = spent
        self.totalProjected = projected
        self.budgetedCount = budgeted
        self.unbudgetedCount = unbudgeted
        self.overBudgetCount = over
    }

    public var hasBudget: Bool { totalBudget > 0 }

    public var fraction: Double {
        guard totalBudget > 0 else { return 0 }
        return totalSpent / totalBudget
    }

    public var remaining: Double { totalBudget - totalSpent }

    public var status: Theme.SemanticStatus {
        guard hasBudget else { return .neutral }
        if remaining < 0 { return .danger }
        if fraction >= 0.8 { return .warning }
        return .ok
    }

    public var totalSpentDisplay: String { CurrencyFormat.usd(totalSpent) }
    public var totalBudgetDisplay: String { CurrencyFormat.usd(totalBudget) }
    public var totalProjectedDisplay: String { CurrencyFormat.usd(totalProjected) }
    public var remainingDisplay: String { CurrencyFormat.usd(remaining) }
    public var percentDisplay: String? { hasBudget ? CurrencyFormat.percent(fraction) : nil }
}
