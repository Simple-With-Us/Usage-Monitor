import Foundation
import Observation
import AppCore
import Models
import Networking

/// Owns the Overview **Chart range** load: session-gated
/// `GET /api/usage-events` filtered by `TimeframeOption`.
///
/// Month-to-date budget figures never use this store — only the portfolio
/// history card below the hero.
@MainActor
@Observable
public final class PortfolioHistoryStore {
    /// Default chart range for a cold launch.  Owner preference 2026-09-04:
    /// "Past 30 days" is the new web + iOS default; "This month" is preserved
    /// for budget math (which this store does NOT touch).
    public static let defaultTimeframe: TimeframeOption = .rolling(days: 30)

    public private(set) var state: LoadState<UsageEventsSummary> = .idle
    public private(set) var timeframe: TimeframeOption = PortfolioHistoryStore.defaultTimeframe
    /// The timeframe that `state`'s currently-visible summary actually belongs
    /// to.  Kept distinct from `timeframe` (which flips the instant a chip is
    /// tapped, so the chip row highlights immediately) so the caption never
    /// claims numbers for a range that hasn't loaded yet — see
    /// `summaryTimeframe` usage in `PortfolioHistorySection`.
    public private(set) var summaryTimeframe: TimeframeOption = PortfolioHistoryStore.defaultTimeframe
    public private(set) var requiresSession = false
    public private(set) var lastError: APIError?
    public private(set) var isReloading = false
    /// Daily spend series backing `RangeSpendChart` for any selection other
    /// than "This month" (which shows the month-to-date `SpendPaceChart`
    /// instead — that chart never reads this store). `nil` while the current
    /// month is selected, or before the first successful range fetch lands.
    public private(set) var rangeSeries: RangeSpendSeries?

    // `fetch()` is called from unstructured `Task { await store... }` sites
    // (chip taps in DashboardRootView) that are never cancelled, so two
    // fetches can be in flight together — e.g. a fast double chip-tap, or a
    // reset() (sign-out / account switch) firing mid-fetch.  Without a
    // guard, whichever network call happens to complete LAST wins, which can
    // be the stale one, clobbering `state`/`summaryTimeframe` with old data
    // after something newer already landed.  `fetchGeneration` makes each
    // `fetch()` call check, right before every mutation, that it is still
    // the most recent one; a superseded call is a no-op from that point on.
    private var fetchGeneration = 0

    public init() {}

    public var summary: UsageEventsSummary? { state.value }

    public func reset() {
        fetchGeneration += 1
        state = .idle
        timeframe = PortfolioHistoryStore.defaultTimeframe
        summaryTimeframe = PortfolioHistoryStore.defaultTimeframe
        requiresSession = false
        lastError = nil
        isReloading = false
        rangeSeries = nil
    }

    public func loadIfNeeded(using client: APIClient) async {
        if case .idle = state {
            await refresh(using: client)
        }
    }

    public func refresh(using client: APIClient) async {
        await fetch(using: client)
    }

    public func selectTimeframe(_ option: TimeframeOption, using client: APIClient?) async {
        guard option != timeframe else { return }
        timeframe = option
        guard let client else { return }
        await fetch(using: client)
    }

    private func fetch(using client: APIClient) async {
        // Range changes (and the first load) KEEP the prior summary on screen
        // so the user always sees what they were just looking at, dimmed with
        // a small spinner, instead of a blank skeleton.  Owner 2026-09-04:
        // "change the time period seems to do nothing" — the skeleton was
        // making the change feel like no progress was happening.
        //
        // `timeframe` may already point at the NEW range by the time this
        // runs (selectTimeframe flips it synchronously so the chip highlights
        // right away), so capture the range this particular fetch is actually
        // for and only stamp it onto `summaryTimeframe` once its data lands.
        // Otherwise the caption would show the new range's label next to the
        // old range's numbers until the fetch completes.
        let requestedTimeframe = timeframe
        let previous = state.value
        fetchGeneration += 1
        let generation = fetchGeneration
        if previous != nil {
            isReloading = true
        } else {
            state = .loading
        }
        // Only the fetch that is STILL the most recent one when it finishes
        // may clear the spinner — an already-superseded fetch's completion
        // must not stomp on the newer fetch's `isReloading = true`.
        defer {
            if generation == fetchGeneration {
                isReloading = false
            }
        }

        var summarySucceeded = false
        do {
            let summary = try await client.usageEventsSummary(
                queryItems: requestedTimeframe.usageEventsQueryItems
            )
            guard generation == fetchGeneration else { return }
            state = .loaded(summary)
            summaryTimeframe = requestedTimeframe
            requiresSession = false
            lastError = nil
            summarySucceeded = true
        } catch let error as APIError {
            guard generation == fetchGeneration else { return }
            if case .unauthorized = error {
                requiresSession = true
                state = .idle
                lastError = nil
                rangeSeries = nil
                return
            }
            if let previous {
                // Still showing `previous`, which belongs to the range already
                // recorded in `summaryTimeframe` — leave it untouched so the
                // caption keeps matching what's on screen.
                state = .loaded(previous)
                lastError = error
            } else {
                state = .failed(error)
            }
        } catch {
            guard generation == fetchGeneration else { return }
            let transport = APIError.transport(error.localizedDescription)
            if let previous {
                state = .loaded(previous)
                lastError = transport
            } else {
                state = .failed(transport)
            }
        }

        // The month-pace chart (`SpendPaceChart`, driven by `BudgetStore`)
        // already covers "This month" — only load a daily range series for
        // any OTHER selection, and only once the summary call above proved
        // the session still works.
        guard requestedTimeframe != .currentMonth else {
            rangeSeries = nil
            return
        }
        guard summarySucceeded else { return }

        do {
            let window = requestedTimeframe.dailyRollupWindow()
            let response = try await client.dailyRollups(
                from: RangeSpendSeries.dayFormatter.string(from: window.from),
                to: RangeSpendSeries.dayFormatter.string(from: window.to)
            )
            guard generation == fetchGeneration else { return }
            rangeSeries = RangeSpendSeries.build(
                response: response,
                timeframe: requestedTimeframe,
                isClamped: window.isClamped
            )
        } catch {
            // Keep whatever range chart was already on screen rather than
            // blanking it over a transient failure — the total above already
            // updated successfully.
        }
    }
}
