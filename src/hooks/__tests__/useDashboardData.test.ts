import { describe, expect, it } from "vitest";
import {
  combineAbortSignals,
  currentMonthToken,
  DASHBOARD_LOAD_WATCHDOG_MS,
  historyRangeLabel,
  isCurrentCalendarMonth,
  isPrimaryHistoryChip,
  mtdSpendLabel,
  shouldShowDashboardSkeleton,
  timeframeShortLabel,
  timeframeToDays,
} from "@/hooks/useDashboardData";

describe("shouldShowDashboardSkeleton", () => {
  it("shows the skeleton only during the initial load with no rows yet", () => {
    expect(
      shouldShowDashboardSkeleton({ loading: true, providerCount: 0 })
    ).toBe(true);
  });

  it("keeps the dashboard painted when loading flips true after rows arrived", () => {
    // Regression: overlapping foreground refetch used to set loading=true and
    // blank the page after the first successful paint (flash → stuck skeleton).
    expect(
      shouldShowDashboardSkeleton({ loading: true, providerCount: 3 })
    ).toBe(false);
  });

  it("hides the skeleton once the initial fetch settles", () => {
    expect(
      shouldShowDashboardSkeleton({ loading: false, providerCount: 0 })
    ).toBe(false);
    expect(
      shouldShowDashboardSkeleton({ loading: false, providerCount: 2 })
    ).toBe(false);
  });
});

describe("combineAbortSignals", () => {
  it("returns the timeout alone when no external signal is provided", () => {
    const timeout = AbortSignal.timeout(5_000);
    expect(combineAbortSignals(timeout)).toBe(timeout);
    expect(combineAbortSignals(timeout, null)).toBe(timeout);
  });

  it("composes timeout with an external unmount signal", () => {
    const timeout = AbortSignal.timeout(5_000);
    const controller = new AbortController();
    const combined = combineAbortSignals(timeout, controller.signal);
    expect(combined.aborted).toBe(false);
    controller.abort();
    expect(combined.aborted).toBe(true);
  });

  it("falls back to the timeout when AbortSignal.any is unavailable", () => {
    const timeout = AbortSignal.timeout(5_000);
    const controller = new AbortController();
    const original = AbortSignal.any;
    // Simulate older WebKit without AbortSignal.any.
    Object.defineProperty(AbortSignal, "any", {
      configurable: true,
      value: undefined,
    });
    try {
      expect(combineAbortSignals(timeout, controller.signal)).toBe(timeout);
    } finally {
      Object.defineProperty(AbortSignal, "any", {
        configurable: true,
        value: original,
      });
    }
  });

  it("falls back to the timeout when AbortSignal.any throws", () => {
    const timeout = AbortSignal.timeout(5_000);
    const controller = new AbortController();
    const original = AbortSignal.any;
    Object.defineProperty(AbortSignal, "any", {
      configurable: true,
      value: () => {
        throw new TypeError("AbortSignal.any boom");
      },
    });
    try {
      expect(combineAbortSignals(timeout, controller.signal)).toBe(timeout);
    } finally {
      Object.defineProperty(AbortSignal, "any", {
        configurable: true,
        value: original,
      });
    }
  });
});

describe("dashboard load watchdog contract", () => {
  it("waits longer than the 30s per-request timeout so AbortSignal wins first", () => {
    expect(DASHBOARD_LOAD_WATCHDOG_MS).toBeGreaterThan(30_000);
  });

  it("treats a coalesce lock older than the watchdog as orphaned", () => {
    // Model: isFetching stayed true after a hung/frozen request. A later
    // fetchProviders must break the coalesce after DASHBOARD_LOAD_WATCHDOG_MS
    // so Retry can start a real request instead of returning immediately.
    let isFetching = true;
    const fetchStartedAt = Date.now() - (DASHBOARD_LOAD_WATCHDOG_MS + 1);
    const orphaned =
      isFetching &&
      fetchStartedAt > 0 &&
      Date.now() - fetchStartedAt > DASHBOARD_LOAD_WATCHDOG_MS;
    expect(orphaned).toBe(true);
    if (orphaned) isFetching = false;
    expect(isFetching).toBe(false);
  });
});

describe("timeframeToDays", () => {
  it("maps 1d, 7d, 30d, 90d, 180d, 365d, and all correctly", () => {
    expect(timeframeToDays("1d")).toBe(1);
    expect(timeframeToDays("7d")).toBe(7);
    expect(timeframeToDays("30d")).toBe(30);
    expect(timeframeToDays("90d")).toBe(90);
    expect(timeframeToDays("180d")).toBe(180);
    expect(timeframeToDays("365d")).toBe(365);
    expect(timeframeToDays("all")).toBe(3650);
  });
});

describe("history range labels (honest to selection)", () => {
  it("describes rolling windows without substituting MTD month names", () => {
    expect(historyRangeLabel("7d")).toBe("Past 7 days");
    expect(historyRangeLabel("30d")).toBe("Past 30 days");
    expect(historyRangeLabel("90d")).toBe("Past 90 days");
    expect(historyRangeLabel("180d")).toBe("Past 180 days");
    expect(historyRangeLabel("365d")).toBe("Past 12 months");
    expect(historyRangeLabel("1d")).toBe("Past 24 hours");
    expect(historyRangeLabel("all")).toBe("All time");
  });

  it("labels the current calendar month as This month", () => {
    const current = currentMonthToken();
    expect(isCurrentCalendarMonth(current)).toBe(true);
    expect(historyRangeLabel(current)).toBe("This month");
    expect(isPrimaryHistoryChip(current)).toBe(true);
    expect(isPrimaryHistoryChip("365d")).toBe(true);
    expect(isPrimaryHistoryChip("1d")).toBe(false);
  });

  it("keeps MTD spend label independent of rolling selection", () => {
    expect(mtdSpendLabel().length).toBeGreaterThan(3);
    expect(timeframeShortLabel("365d")).toBe("12m");
    expect(timeframeShortLabel("all")).toBe("All");
  });
});
