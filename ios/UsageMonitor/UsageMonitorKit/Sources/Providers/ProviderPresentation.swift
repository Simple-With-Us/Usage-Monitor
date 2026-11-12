import Foundation
import SwiftUI
import DesignSystem
import Models
#if canImport(UIKit)
import UIKit
#endif

// ---------------------------------------------------------------------------
// Pure, reusable presentation derivations for a `ProviderBudgetStatus`. Kept
// separate from the views so the money/percent/status → string logic can be
// unit-tested directly, and so the list row and the detail header stay in sync.
// ---------------------------------------------------------------------------

extension ProviderBudgetStatus {
    /// Design-system status for this provider's budget level.
    var semanticStatus: Theme.SemanticStatus { Theme.SemanticStatus(status) }

    /// The trailing value on a compact list row — month-to-date spend.
    var rowValue: String { CurrencyFormat.usd(spentUsd) }

    /// The small caption under the row value: utilisation for budgeted
    /// providers, otherwise a coverage/"no budget" note. Partial coverage
    /// gets an explicit cue — APIs often omit tax.
    var rowValueCaption: String {
        if hasBudget, let percentUsed {
            let pct = CurrencyFormat.percent(percentUsed)
            if !spendCoverage.isComplete { return "\(pct) · partial" }
            return pct
        }
        if !spendCoverage.isComplete { return "Partial · no budget" }
        return "No budget"
    }

    /// A one-line human status used as the row subtitle.
    var rowSubtitle: String {
        // List subtitles are values → sentence/lower case (not Title Case headings).
        switch status {
        case .exceeded:
            if let remainingUsd, remainingUsd < 0 {
                return "over by \(CurrencyFormat.usd(abs(remainingUsd)))"
            }
            return "over budget"
        case .warning:
            if let remainingUsd {
                return "\(CurrencyFormat.usd(remainingUsd)) left"
            }
            return "approaching budget"
        case .ok:
            if let remainingUsd {
                return "\(CurrencyFormat.usd(remainingUsd)) left"
            }
            return "on track"
        case .unconfigured:
            return "not budgeted · \(CurrencyFormat.usd(spentUsd)) spent"
        }
    }

    /// Short label for the header status badge (chip → Title Case).
    var statusLabel: String {
        switch status {
        case .exceeded: return "Over Budget"
        case .warning: return "Approaching Budget"
        case .ok: return "On Track"
        case .unconfigured: return "No Budget Set"
        }
    }

    var statusSymbol: String {
        switch status {
        case .exceeded: return "exclamationmark.octagon.fill"
        case .warning: return "gauge.with.dots.needle.67percent"
        case .ok: return "checkmark.circle.fill"
        case .unconfigured: return "minus.circle"
        }
    }

    /// Meter fill fraction (spent ÷ budget). Falls back to `percentUsed` and
    /// finally to a computed ratio; `0` when no budget exists.
    var budgetFraction: Double {
        if let percentUsed { return percentUsed }
        guard let budget = monthlyBudgetUsd, budget > 0 else { return 0 }
        return spentUsd / budget
    }

    /// The individual spend components that make up `spentUsd`, largest first,
    /// dropping any that are zero. Used by the composition bar.
    var spendComponents: [SpendComponent] {
        let fixed = max(fixedAccruedUsd, 0) > 0 ? fixedAccruedUsd : fixedMonthlyCostUsd
        let raw: [SpendComponent] = [
            SpendComponent(kind: .variable, amount: observedVariableUsageUsd),
            SpendComponent(kind: .subscription, amount: subscriptionMonthToDateUsd),
            SpendComponent(kind: .fixed, amount: fixed),
        ]
        return raw.filter { $0.amount > 0.005 }.sorted { $0.amount > $1.amount }
    }

    /// Whether projection-part / subscription context is worth surfacing.
    /// Always show when there is any projected EOM so usage-vs-subscription
    /// composition is explicit (even when renewals are currently $0).
    var hasRenewalContext: Bool {
        projectedEomUsd > 0.005
            || subscriptionMonthToDateUsd > 0.005
            || forecastedSubscriptionRenewalsUsd > 0.005
            || fixedAccruedUsd > 0.005
            || fixedMonthlyCostUsd > 0.005
    }
}

/// One slice of a provider's month-to-date spend.
struct SpendComponent: Identifiable, Hashable {
    enum Kind: String {
        case variable, subscription, fixed

        var label: String {
            switch self {
            case .variable: return "Usage"
            case .subscription: return "Subscription"
            case .fixed: return "Fixed"
            }
        }

        var systemImage: String {
            switch self {
            case .variable: return "chart.bar.fill"
            case .subscription: return "arrow.triangle.2.circlepath"
            case .fixed: return "lock.fill"
            }
        }

        /// A stable, legible tint per component (design-system accent family).
        var color: Color {
            switch self {
            case .variable: return Theme.Colors.accent
            case .subscription: return Theme.Colors.warning
            case .fixed: return Theme.Colors.neutral
            }
        }
    }

    let kind: Kind
    let amount: Double

    var id: String { kind.rawValue }
    var label: String { kind.label }
}

// MARK: - Haptics

/// Markers and helpers for the provider list. Moved to DesignSystem Haptics.
