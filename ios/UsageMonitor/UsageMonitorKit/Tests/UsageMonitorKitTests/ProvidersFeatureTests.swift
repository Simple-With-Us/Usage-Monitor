import XCTest
import Foundation
@testable import Models
@testable import Providers
import DesignSystem

/// Providers-lane tests: the pure query (search/filter/sort) transform, the
/// money/percent/status presentation derivations, server `projectedStatus`
/// decoding, and the list view-model. All run against `PreviewFixtures`
/// sample data — no network.
///
/// NOTE FOR ASSEMBLE: the `UsageMonitorKitTests` target must depend on
/// `"Providers"` for `@testable import Providers` to resolve. Add it to that
/// test target's dependencies array in `Package.swift`.
final class ProvidersQueryTests: XCTestCase {
    private let all = ProviderBudgetStatus.sampleList  // [exceeded, warning, ok, unconfigured]

    // MARK: - Search

    func testSearchMatchesTitleAndNameCaseInsensitively() {
        var q = ProvidersQuery()
        q.searchText = "OPEN"
        let titles = q.apply(to: all).map(\.title)
        XCTAssertEqual(Set(titles), ["OpenAI", "OpenRouter"])
    }

    func testSearchByProviderSlug() {
        var q = ProvidersQuery()
        q.searchText = "voyage"
        XCTAssertEqual(q.apply(to: all).map(\.title), ["Voyage AI"])
    }

    func testEmptySearchReturnsEverything() {
        let q = ProvidersQuery()
        XCTAssertEqual(q.apply(to: all).count, all.count)
    }

    // MARK: - Filter

    func testFacetFiltering() {
        XCTAssertEqual(applyFilter(.overBudget).map(\.title), ["OpenRouter"])
        XCTAssertEqual(applyFilter(.attention).map(\.title), ["Anthropic"])
        XCTAssertEqual(applyFilter(.onTrack).map(\.title), ["OpenAI"])
        XCTAssertEqual(applyFilter(.noBudget).map(\.title), ["Voyage AI"])
        XCTAssertEqual(applyFilter(.all).count, 4)
    }

    private func applyFilter(_ f: ProviderFilter) -> [ProviderBudgetStatus] {
        var q = ProvidersQuery()
        q.filter = f
        return q.apply(to: all)
    }

    // MARK: - Sort

    func testStatusSortIsMostSevereFirst() {
        var q = ProvidersQuery(); q.sort = .status
        XCTAssertEqual(q.apply(to: all).map(\.status), [.exceeded, .warning, .ok, .unconfigured])
    }

    func testSpendSortDescending() {
        var q = ProvidersQuery(); q.sort = .spend
        XCTAssertEqual(q.apply(to: all).map(\.title), ["Anthropic", "OpenRouter", "OpenAI", "Voyage AI"])
    }

    func testUtilisationSortPushesUnbudgetedLast() {
        var q = ProvidersQuery(); q.sort = .utilisation
        XCTAssertEqual(q.apply(to: all).map(\.title), ["OpenRouter", "Anthropic", "OpenAI", "Voyage AI"])
    }

    func testNameSortAlphabetical() {
        var q = ProvidersQuery(); q.sort = .name
        XCTAssertEqual(q.apply(to: all).map(\.title), ["Anthropic", "OpenAI", "OpenRouter", "Voyage AI"])
    }

    func testSearchFilterSortCompose() {
        var q = ProvidersQuery()
        q.searchText = "open"
        q.sort = .name
        XCTAssertEqual(q.apply(to: all).map(\.title), ["OpenAI", "OpenRouter"])
    }
}

final class SnapshotHistoryRangeTests: XCTestCase {
    func testWebParityDayWindows() {
        XCTAssertEqual(SnapshotHistoryRange.allCases.map(\.days), [7, 30, 90, 365])
        XCTAssertEqual(SnapshotHistoryRange.default, .thirtyDays)
        XCTAssertEqual(SnapshotHistoryRange.sevenDays.shortLabel, "7d")
        XCTAssertEqual(SnapshotHistoryRange.thirtyDays.displayLabel, "Past 30 days")
        XCTAssertEqual(SnapshotHistoryRange.oneYear.shortLabel, "1y")
        XCTAssertEqual(SnapshotHistoryRange.oneYear.displayLabel, "Past year")
    }
}

final class ProviderPresentationTests: XCTestCase {

    /// Incomplete spend coverage must be called out in the row caption
    /// (#1013): APIs often omit tax, so an uncaveated percent would overstate
    /// confidence. Complete coverage stays uncaveated.
    func testRowValueCaption() {
        // Complete coverage → bare utilisation / bare "No budget".
        XCTAssertEqual(ProviderBudgetStatus.sampleOk.rowValueCaption, "48%")
        XCTAssertEqual(Self.completeCoverageUnbudgeted.rowValueCaption, "No budget")

        // Partial coverage → explicit cue in both the budgeted and the
        // unbudgeted shape.
        XCTAssertEqual(ProviderBudgetStatus.sampleWarning.rowValueCaption, "85% · partial")
        XCTAssertEqual(ProviderBudgetStatus.sampleUnconfigured.rowValueCaption, "Partial · no budget")
    }

    /// Row subtitles are *values*, so they are sentence/lower case rather than
    /// Title Case headings (#1042, `docs/FLEET-UI-COPY.md`). The status chip
    /// (`statusLabel`) is the Title Case one — asserted below so the two casing
    /// registers cannot silently converge.
    func testRowSubtitleReflectsStatus() {
        XCTAssertEqual(ProviderBudgetStatus.sampleExceeded.rowSubtitle, "over by $14.90")
        XCTAssertEqual(ProviderBudgetStatus.sampleWarning.rowSubtitle, "$37.60 left")
        XCTAssertEqual(ProviderBudgetStatus.sampleOk.rowSubtitle, "$103.80 left")
        XCTAssertEqual(ProviderBudgetStatus.sampleUnconfigured.rowSubtitle, "not budgeted · $18.05 spent")
    }

    func testStatusLabelIsTitleCaseForTheChip() {
        XCTAssertEqual(ProviderBudgetStatus.sampleExceeded.statusLabel, "Over Budget")
        XCTAssertEqual(ProviderBudgetStatus.sampleWarning.statusLabel, "Approaching Budget")
        XCTAssertEqual(ProviderBudgetStatus.sampleOk.statusLabel, "On Track")
        XCTAssertEqual(ProviderBudgetStatus.sampleUnconfigured.statusLabel, "No Budget Set")
    }

    /// Same shape as `sampleUnconfigured` but with provably complete spend.
    private static let completeCoverageUnbudgeted = ProviderBudgetStatus(
        id: "prov_complete", name: "complete", displayName: "Complete",
        monthlyBudgetUsd: nil,
        observedVariableUsageUsd: 18.05,
        spendCoverage: .complete,
        spentUsd: 18.05,
        status: .unconfigured
    )

    func testSemanticStatusMapping() {
        XCTAssertEqual(ProviderBudgetStatus.sampleExceeded.semanticStatus, .danger)
        XCTAssertEqual(ProviderBudgetStatus.sampleWarning.semanticStatus, .warning)
        XCTAssertEqual(ProviderBudgetStatus.sampleOk.semanticStatus, .ok)
        XCTAssertEqual(ProviderBudgetStatus.sampleUnconfigured.semanticStatus, .neutral)
    }

    func testBudgetFractionPrefersPercentThenComputesThenZero() {
        // Uses percentUsed directly.
        XCTAssertEqual(ProviderBudgetStatus.sampleOk.budgetFraction, 0.481, accuracy: 0.0001)
        // Computes spent/budget when percentUsed is nil but a budget exists.
        let computed = ProviderBudgetStatus(
            id: "p", name: "p", displayName: "P",
            monthlyBudgetUsd: 100, spentUsd: 50, percentUsed: nil, status: .ok
        )
        XCTAssertEqual(computed.budgetFraction, 0.5, accuracy: 0.0001)
        // Zero without a budget.
        XCTAssertEqual(ProviderBudgetStatus.sampleUnconfigured.budgetFraction, 0, accuracy: 0.0001)
    }

    func testSpendComponentsDropZerosAndSortDescending() {
        let p = ProviderBudgetStatus(
            id: "p", name: "p", displayName: "P",
            fixedMonthlyCostUsd: 0,
            observedVariableUsageUsd: 60,
            subscriptionMonthToDateUsd: 30,
            fixedAccruedUsd: 10,
            spentUsd: 100
        )
        let comps = p.spendComponents
        XCTAssertEqual(comps.map(\.kind), [.variable, .subscription, .fixed])
        XCTAssertEqual(comps.map(\.amount), [60, 30, 10])

        // A provider whose only spend is variable yields a single slice.
        XCTAssertEqual(ProviderBudgetStatus.sampleOk.spendComponents.map(\.kind), [.variable])
    }

    func testHasRenewalContext() {
        let sub = ProviderBudgetStatus(
            id: "p", name: "p", displayName: "P",
            subscriptionMonthToDateUsd: 30, spentUsd: 30, projectedEomUsd: 30
        )
        XCTAssertTrue(sub.hasRenewalContext)
        // Any non-zero projected EOM surfaces the usage+subscription parts card.
        XCTAssertTrue(ProviderBudgetStatus.sampleOk.hasRenewalContext)
        let empty = ProviderBudgetStatus(
            id: "z", name: "z", displayName: "Z", spentUsd: 0, projectedEomUsd: 0
        )
        XCTAssertFalse(empty.hasRenewalContext)
    }
}

final class ProjectedStatusPreferenceTests: XCTestCase {
    /// Every field `src/lib/budget-status.ts` declares non-nullable on
    /// `ProviderBudgetStatus`, and that `ProviderBudgetStatus` therefore
    /// decodes as required. `projectedStatus` is deliberately absent — each
    /// test layers it (or not) on top.
    private static func payload(
        merging overrides: [String: Any] = [:]
    ) -> [String: Any] {
        var json: [String: Any] = [
            "id": "p1", "name": "openai", "displayName": "OpenAI",
            "fixedMonthlyCostUsd": 0,
            "pushedMonthToDateUsd": 40,
            "receiptCashPaidUsd": 0,
            "observedVariableUsageUsd": 40,
            "estimatedApiEquivalentUsd": 0,
            "spendCoverage": "complete",
            "subscriptionMonthToDateUsd": 0,
            "fixedAccruedUsd": 0,
            "forecastedSubscriptionRenewalsUsd": 0,
            "spentUsd": 40, "projectedEomUsd": 95,
            "status": "ok", "alerts": [],
        ]
        for (key, value) in overrides { json[key] = value }
        return json
    }

    /// The budget-detail projection badge must prefer the server's
    /// `projectedStatus` over locally recomputed thresholds (L5), so the two
    /// UIs can never disagree on the same payload.
    func testServerProjectedStatusDecodes() throws {
        let json = Self.payload(merging: [
            "monthlyBudgetUsd": 100,
            "projectedStatus": "warning",
        ])
        let provider = try JSONDecoder().decode(
            ProviderBudgetStatus.self,
            from: JSONSerialization.data(withJSONObject: json)
        )
        XCTAssertEqual(provider.projectedStatus, .warning)
        // The server's runway verdict must not be conflated with the
        // month-to-date status it ships alongside.
        XCTAssertEqual(provider.status, .ok)
    }

    /// Payloads written before `projectedStatus` shipped (and cached snapshots
    /// on disk) must still decode, with callers falling back to local math.
    func testMissingProjectedStatusDecodesToNil() throws {
        let provider = try JSONDecoder().decode(
            ProviderBudgetStatus.self,
            from: JSONSerialization.data(withJSONObject: Self.payload())
        )
        XCTAssertNil(provider.projectedStatus)
        XCTAssertEqual(provider.status, .ok)
    }
}

@MainActor
final class ProvidersListModelTests: XCTestCase {
    func testResultsReflectSearchAndFilter() {
        let model = ProvidersListModel()
        model.filter = .overBudget
        XCTAssertEqual(model.results(from: ProviderBudgetStatus.sampleList).map(\.title), ["OpenRouter"])
        XCTAssertTrue(model.isFiltering)
    }

    func testFacetCountsIgnoreSearchText() {
        let model = ProvidersListModel()
        model.searchText = "nonsense-that-matches-nothing"
        XCTAssertEqual(model.count(for: .overBudget, in: ProviderBudgetStatus.sampleList), 1)
        XCTAssertEqual(model.count(for: .all, in: ProviderBudgetStatus.sampleList), 4)
    }

    func testResetClearsSearchAndFilter() {
        let model = ProvidersListModel()
        model.searchText = "open"
        model.filter = .attention
        model.reset()
        XCTAssertEqual(model.searchText, "")
        XCTAssertEqual(model.filter, .all)
        XCTAssertFalse(model.isFiltering)
    }
}
