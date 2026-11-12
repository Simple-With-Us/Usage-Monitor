import XCTest
@testable import Models
@testable import AppCore
import Networking
import DesignSystem
@testable import ProjectBudgets

// NOTE: This file requires the `UsageMonitorKitTests` target to depend on
// `ProjectBudgets` in Package.swift (see integration notes). The ProjectBudgets
// lane cannot edit Package.swift itself.

final class ProjectBudgetsTests: XCTestCase {

    // MARK: - Presentation math

    func testMeterFractionUsesServerPercentWhenPresent() {
        let p = ProjectBudgetPresentation(.sampleTrade) // percentUsed 0.617
        XCTAssertEqual(p.meterFraction, 0.617, accuracy: 0.0001)
    }

    func testMeterFractionComputedWhenPercentMissing() {
        let project = ProjectBudgetStatus(
            id: "p", name: "P", monthlyBudgetUsd: 200, spentUsd: 50,
            percentUsed: nil, status: .ok
        )
        XCTAssertEqual(ProjectBudgetPresentation(project).meterFraction, 0.25, accuracy: 0.0001)
    }

    func testMeterFractionZeroWithoutBudget() {
        let project = ProjectBudgetStatus(id: "p", name: "P", spentUsd: 50, status: .unconfigured)
        XCTAssertEqual(ProjectBudgetPresentation(project).meterFraction, 0)
        XCTAssertFalse(ProjectBudgetPresentation(project).hasBudget)
    }

    func testRemainingDerivedWhenServerValueMissing() {
        let project = ProjectBudgetStatus(
            id: "p", name: "P", monthlyBudgetUsd: 400, spentUsd: 246.80,
            remainingUsd: nil, status: .warning
        )
        XCTAssertEqual(ProjectBudgetPresentation(project).remaining ?? .nan, 153.20, accuracy: 0.0001)
    }

    func testRemainingNilWithoutBudget() {
        let project = ProjectBudgetStatus(id: "p", name: "P", spentUsd: 12, status: .unconfigured)
        XCTAssertNil(ProjectBudgetPresentation(project).remaining)
    }

    func testOverBudgetDetection() {
        let exceeded = ProjectBudgetStatus(
            id: "p", name: "P", monthlyBudgetUsd: 100, spentUsd: 130,
            remainingUsd: -30, status: .exceeded
        )
        XCTAssertTrue(ProjectBudgetPresentation(exceeded).isOverBudget)

        let negativeRemainingOnly = ProjectBudgetStatus(
            id: "q", name: "Q", monthlyBudgetUsd: 100, spentUsd: 110,
            remainingUsd: -10, status: .warning
        )
        XCTAssertTrue(ProjectBudgetPresentation(negativeRemainingOnly).isOverBudget)

        XCTAssertFalse(ProjectBudgetPresentation(.sampleMonitor).isOverBudget)
    }

    // MARK: - Formatting (exact money)

    func testExactCurrencyFormatting() {
        let p = ProjectBudgetPresentation(.sampleTrade)
        XCTAssertEqual(p.spentDisplay, "$246.80")
        XCTAssertEqual(p.budgetDisplay, "$400.00")
        XCTAssertEqual(p.meterDetail, "$246.80 / $400.00")
        XCTAssertEqual(p.remainingDisplay, "$153.20")
    }

    func testMeterDetailWithoutBudget() {
        let project = ProjectBudgetStatus(id: "p", name: "P", spentUsd: 18.05, status: .unconfigured)
        XCTAssertEqual(ProjectBudgetPresentation(project).meterDetail, "$18.05 spent")
        XCTAssertNil(ProjectBudgetPresentation(project).percentDisplay)
    }

    func testPercentDisplay() {
        XCTAssertEqual(ProjectBudgetPresentation(.sampleTrade).percentDisplay, "62%")
    }

    // MARK: - Coverage & status

    func testCoverageCaveat() {
        XCTAssertTrue(ProjectBudgetPresentation(.sampleTrade).showsCoverageCaveat)   // partial
        XCTAssertFalse(ProjectBudgetPresentation(.sampleMonitor).showsCoverageCaveat) // complete
        XCTAssertEqual(ProjectBudgetPresentation(.sampleTrade).coverageStatus, .warning)
    }

    func testIncompleteAllocation() {
        XCTAssertTrue(ProjectBudgetPresentation(.sampleTrade).hasIncompleteAllocation)
        XCTAssertEqual(ProjectBudgetPresentation(.sampleTrade).incompleteAllocatedProviderCount, 1)
        XCTAssertTrue(ProjectBudgetPresentation(.sampleTrade).incompleteAllocationMessage.contains("1 provider"))
        XCTAssertFalse(ProjectBudgetPresentation(.sampleMonitor).hasIncompleteAllocation)
    }

    func testStatusMapping() {
        XCTAssertEqual(ProjectBudgetPresentation(.sampleTrade).status, .warning)
        XCTAssertEqual(ProjectBudgetPresentation(.sampleMonitor).status, .ok)
    }

    // MARK: - Rollup

    func testRollupTotals() {
        let rollup = ProjectBudgetsRollup(projects: ProjectBudgetStatus.sampleList)
        XCTAssertEqual(rollup.totalBudget, 550, accuracy: 0.0001)          // 400 + 150
        XCTAssertEqual(rollup.totalSpent, 287.90, accuracy: 0.0001)         // 246.80 + 41.10
        XCTAssertEqual(rollup.budgetedCount, 2)
        XCTAssertEqual(rollup.unbudgetedCount, 0)
        XCTAssertEqual(rollup.fraction, 287.90 / 550, accuracy: 0.0001)
        XCTAssertEqual(rollup.remaining, 262.10, accuracy: 0.0001)
        XCTAssertEqual(rollup.remainingDisplay, "$262.10")
    }

    func testRollupCountsUnbudgetedAndOver() {
        let over = ProjectBudgetStatus(
            id: "o", name: "Over", monthlyBudgetUsd: 100, spentUsd: 140,
            remainingUsd: -40, status: .exceeded
        )
        let noBudget = ProjectBudgetStatus(id: "n", name: "N", spentUsd: 10, status: .unconfigured)
        let rollup = ProjectBudgetsRollup(projects: [over, noBudget])
        XCTAssertEqual(rollup.budgetedCount, 1)
        XCTAssertEqual(rollup.unbudgetedCount, 1)
        XCTAssertEqual(rollup.overBudgetCount, 1)
        XCTAssertEqual(rollup.status, .danger)
    }

    // MARK: - Currency parsing

    func testCurrencyParserAcceptsCommonForms() {
        XCTAssertEqual(CurrencyInputParser.parse("400"), 400)
        XCTAssertEqual(CurrencyInputParser.parse("$1,234.50"), 1234.50)
        XCTAssertEqual(CurrencyInputParser.parse("  $ 89.99 "), 89.99)
        XCTAssertEqual(CurrencyInputParser.parse("1000000"), 1_000_000)
    }

    func testCurrencyParserRejectsGarbage() {
        XCTAssertNil(CurrencyInputParser.parse(""))
        XCTAssertNil(CurrencyInputParser.parse("abc"))
        XCTAssertNil(CurrencyInputParser.parse("12.3.4"))
        XCTAssertNil(CurrencyInputParser.parse("$"))
    }

    // MARK: - Draft validation

    func testDraftValidBlankBudgetMeansNoCap() throws {
        let draft = ProjectBudgetDraft(name: "Alpha", details: "", monthlyBudgetInput: "  ")
        XCTAssertNil(try draft.validate())
        XCTAssertTrue(draft.isValid)
    }

    func testDraftValidWithBudget() throws {
        let draft = ProjectBudgetDraft(name: "Alpha", monthlyBudgetInput: "$300")
        XCTAssertEqual(try draft.validate() ?? .nan, 300, accuracy: 0.0001)
    }

    func testDraftRejectsEmptyName() {
        let draft = ProjectBudgetDraft(name: "   ", monthlyBudgetInput: "300")
        XCTAssertThrowsError(try draft.validate()) { error in
            XCTAssertEqual(error as? ProjectBudgetDraftError, .nameRequired)
        }
        XCTAssertFalse(draft.isValid)
    }

    func testDraftRejectsNonPositiveBudget() {
        let draft = ProjectBudgetDraft(name: "Alpha", monthlyBudgetInput: "0")
        XCTAssertThrowsError(try draft.validate()) { error in
            XCTAssertEqual(error as? ProjectBudgetDraftError, .budgetNotPositive)
        }
    }

    func testDraftRejectsUnparseableBudget() {
        let draft = ProjectBudgetDraft(name: "Alpha", monthlyBudgetInput: "lots")
        XCTAssertThrowsError(try draft.validate()) { error in
            XCTAssertEqual(error as? ProjectBudgetDraftError, .budgetNotANumber)
        }
    }

    func testDraftSeededFromExistingProject() {
        let draft = ProjectBudgetDraft(editing: .sampleTrade)
        XCTAssertEqual(draft.name, "Socratic Trade")
        XCTAssertEqual(draft.details, "Cost-aware trading feedback loop")
        XCTAssertEqual(draft.monthlyBudgetInput, "400")
    }

    // MARK: - Phase mapping

    func testPhaseLoadingWhenIdleNoData() {
        let phase = ProjectBudgetsListModel.phase(state: .idle, projects: [])
        XCTAssertEqual(phase, .loading)
    }

    func testPhaseFailedWhenErrorNoData() {
        let phase = ProjectBudgetsListModel.phase(state: .failed(.offline), projects: [])
        XCTAssertEqual(phase, .failed(.offline))
    }

    func testPhaseEmptyWhenLoadedNoProjects() {
        let response = BudgetStatusResponse.sampleEmpty
        let phase = ProjectBudgetsListModel.phase(state: .loaded(response), projects: [])
        XCTAssertEqual(phase, .empty)
    }

    func testPhaseLoadedWithProjects() {
        let response = BudgetStatusResponse.sample
        let phase = ProjectBudgetsListModel.phase(state: .loaded(response), projects: ProjectBudgetStatus.sampleList)
        if case .loaded(let items) = phase {
            XCTAssertEqual(items.count, 2)
        } else {
            XCTFail("expected loaded phase")
        }
    }

    func testSortPutsOverBudgetFirst() {
        let sorted = ProjectBudgetsListModel.sorted(ProjectBudgetStatus.sampleList)
        // sampleTrade (warning, not over) vs sampleMonitor (ok). Neither over →
        // higher spend first: Trade ($246.80) before Monitor ($41.10).
        XCTAssertEqual(sorted.first?.id, ProjectBudgetStatus.sampleTrade.id)
    }
}
