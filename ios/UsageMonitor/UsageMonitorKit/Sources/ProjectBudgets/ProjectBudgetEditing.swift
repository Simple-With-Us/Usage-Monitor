import Foundation
import Models
import DesignSystem

// ---------------------------------------------------------------------------
// Add / edit a project budget — draft model and validation.
//
// Project mutations go through the session-gated monitor API
// (`POST/PUT/DELETE /api/projects`, dashboard-session cookie — the same path
// as the provider/subscription management already in the app). This file owns
// only the client-side draft + validation; persistence lives in
// `ProjectManagementStore`, which calls `APIClient` and then refreshes the
// shared `BudgetStore` so the list re-reads the server's recomputed budgets.
// ---------------------------------------------------------------------------

/// A validated, user-editable draft of a project budget.
public struct ProjectBudgetDraft: Equatable, Sendable {
    public var name: String
    public var details: String
    /// Raw text as typed (e.g. "$1,234.50" or "400"); parsed on validation.
    public var monthlyBudgetInput: String

    public init(name: String = "", details: String = "", monthlyBudgetInput: String = "") {
        self.name = name
        self.details = details
        self.monthlyBudgetInput = monthlyBudgetInput
    }

    /// Seed a draft from an existing project for editing.
    public init(editing project: ProjectBudgetStatus) {
        self.name = project.name
        self.details = project.description ?? ""
        if let budget = project.monthlyBudgetUsd, budget > 0 {
            // Present without a currency symbol so the field stays easy to edit.
            self.monthlyBudgetInput = budget.formatted(.number.precision(.fractionLength(0...2)).grouping(.never))
        } else {
            self.monthlyBudgetInput = ""
        }
    }

    public var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    public var trimmedDetails: String { details.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The parsed budget: `nil` when the field is blank (a project with no
    /// budget cap), a value when it parses, and a thrown error when it is
    /// non-blank but invalid.
    public func parsedBudget() throws -> Double? {
        let raw = monthlyBudgetInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return nil }
        guard let value = CurrencyInputParser.parse(raw) else {
            throw ProjectBudgetDraftError.budgetNotANumber
        }
        guard value > 0 else { throw ProjectBudgetDraftError.budgetNotPositive }
        guard value <= 100_000_000 else { throw ProjectBudgetDraftError.budgetTooLarge }
        return value
    }

    /// Validate the whole draft, returning the parsed budget on success.
    @discardableResult
    public func validate() throws -> Double? {
        guard !trimmedName.isEmpty else { throw ProjectBudgetDraftError.nameRequired }
        guard trimmedName.count <= 80 else { throw ProjectBudgetDraftError.nameTooLong }
        return try parsedBudget()
    }

    /// Cheap check for enabling the Save button without surfacing an error.
    ///
    /// Must catch rather than use `try?`: `validate()` returns `Double?`, and
    /// Swift flattens `try?` on an optional-returning throwing call, so a
    /// successful validation of a blank budget (`nil` = no cap) is
    /// indistinguishable from a thrown error. Using `try?` here disabled Save
    /// for every project without a monthly cap.
    public var isValid: Bool {
        do {
            _ = try validate()
            return true
        } catch {
            return false
        }
    }
}

/// Typed, user-presentable validation failures.
public enum ProjectBudgetDraftError: Error, Equatable, Sendable {
    case nameRequired
    case nameTooLong
    case budgetNotANumber
    case budgetNotPositive
    case budgetTooLarge

    public var message: String {
        switch self {
        case .nameRequired: return "Give the project a name."
        case .nameTooLong: return "Keep the name under 80 characters."
        case .budgetNotANumber: return "Enter the monthly budget as a number, e.g. 400."
        case .budgetNotPositive: return "The budget must be greater than $0. Leave it blank for no cap."
        case .budgetTooLarge: return "That budget looks too large — double-check the amount."
        }
    }
}

/// Parses free-typed currency into an exact `Double`, tolerating a leading
/// symbol, thousands separators, and surrounding whitespace.
public enum CurrencyInputParser {
    public static func parse(_ input: String) -> Double? {
        var cleaned = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return nil }
        // Strip common currency symbols and grouping separators; keep digits,
        // one decimal separator, and a leading minus.
        cleaned = cleaned.replacingOccurrences(of: "$", with: "")
        cleaned = cleaned.replacingOccurrences(of: "\u{00A0}", with: "")
        cleaned = cleaned.replacingOccurrences(of: " ", with: "")
        cleaned = cleaned.replacingOccurrences(of: ",", with: "")
        guard !cleaned.isEmpty else { return nil }
        // Reject anything that isn't a plain decimal number now.
        let allowed = CharacterSet(charactersIn: "0123456789.-")
        guard cleaned.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return nil }
        guard let value = Double(cleaned), value.isFinite else { return nil }
        return value
    }
}
