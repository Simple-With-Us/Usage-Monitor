// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import DashboardCharts, { shapeRangeSpendBreakdown } from "@/components/DashboardCharts";
import { buildHistoryChartRows } from "@/components/SpendHistoryChart";
import type { ExternalUsageGroup } from "@/components/ExternalTelemetryPanel";

// jsdom has no ResizeObserver; Recharts' ResponsiveContainer reaches for one
// on mount. A no-op stub is enough — these tests assert on the plain-text
// headings/captions the components render directly, never on chart SVG
// internals, so a real observer/measured size is not needed.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver ??=
  ResizeObserverStub;

afterEach(() => {
  cleanup();
});

function group(overrides: Partial<ExternalUsageGroup> = {}): ExternalUsageGroup {
  return {
    sourceApp: "app",
    environment: null,
    provider: "anthropic",
    canonicalProvider: "anthropic",
    service: null,
    projectId: null,
    metricType: "cost",
    unit: null,
    eventCount: 1,
    pricedEventCount: 1,
    unpricedEventCount: 0,
    unclassifiedCostEventCount: 0,
    costCoverage: "complete",
    totalCostUsd: 10,
    estimatedApiEquivalentUsd: 0,
    totalRequests: 1,
    totalQuantity: 1,
    limit: null,
    limitWindow: null,
    latestAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("shapeRangeSpendBreakdown", () => {
  it("merges groups by resolved display name and drops non-positive rows", () => {
    const { slices } = shapeRangeSpendBreakdown([
      group({ provider: "anthropic", totalCostUsd: 5 }),
      group({ provider: "anthropic", totalCostUsd: 2.5 }),
      group({ provider: "openai", totalCostUsd: 0 }),
      group({
        provider: "raw-name",
        matchedProvider: { id: "p1", name: "raw-name", displayName: "OpenAI" },
        totalCostUsd: 9,
      }),
    ]);
    expect(slices).toEqual([
      { name: "OpenAI", value: 9 },
      { name: "anthropic", value: 7.5 },
    ]);
  });
});

describe("DashboardCharts — range-scoped rendering (test b: differs by range data)", () => {
  it("renders a different total for a different range's dailySeries", () => {
    const { rerender } = render(
      <DashboardCharts
        timeframe="30d"
        dailySeries={[
          { day: "2026-09-10", totalCostUsd: 1.5 },
          { day: "2026-09-11", totalCostUsd: 2.5 },
        ]}
        groups={[group({ totalCostUsd: 5 })]}
      />
    );
    expect(screen.getByText("Total $4.00")).toBeTruthy();

    rerender(
      <DashboardCharts
        timeframe="90d"
        dailySeries={[
          { day: "2026-08-01", totalCostUsd: 10 },
          { day: "2026-08-02", totalCostUsd: 20 },
          { day: "2026-09-11", totalCostUsd: 2.5 },
        ]}
        groups={[group({ totalCostUsd: 33 })]}
      />
    );
    expect(screen.getByText("Total $32.50")).toBeTruthy();
    expect(screen.queryByText("Total $4.00")).toBeNull();
  });
});

describe("DashboardCharts — non-current-month ranges (test c: no month name, no projection)", () => {
  it("labels rolling ranges with the range, not a month, and never renders the MTD projection chart", () => {
    render(
      <DashboardCharts
        timeframe="30d"
        dailySeries={[{ day: "2026-09-01", totalCostUsd: 4 }]}
        groups={[group()]}
      />
    );
    // Honest range label, not a month name.
    expect(screen.getByText("Spend — Past 30 days")).toBeTruthy();
    // History chart, never the MTD linear-projection chart.
    expect(screen.getByText("Daily history — not a projection")).toBeTruthy();
    expect(screen.queryByText(/Month Pace/)).toBeNull();
    // Pie is labeled as actual range spend, not a month-to-date projection.
    expect(screen.getByText("Spend by Provider")).toBeTruthy();
    expect(screen.queryByText("Projected Cost Breakdown")).toBeNull();
  });

  it("does the same for a different rolling range (90d)", () => {
    render(
      <DashboardCharts
        timeframe="90d"
        dailySeries={[{ day: "2026-07-01", totalCostUsd: 4 }]}
        groups={[group()]}
      />
    );
    expect(screen.getByText("Spend — Past 90 days")).toBeTruthy();
    expect(screen.queryByText("Projected Cost Breakdown")).toBeNull();
    expect(screen.queryByText(/Month Pace/)).toBeNull();
  });
});

describe("buildHistoryChartRows", () => {
  it("sorts by day and coerces missing/invalid costs to 0", () => {
    const rows = buildHistoryChartRows([
      { day: "2026-09-02", totalCostUsd: 3 },
      { day: "2026-09-01", totalCostUsd: Number.NaN },
    ]);
    expect(rows).toEqual([
      { day: "2026-09-01", totalCostUsd: 0 },
      { day: "2026-09-02", totalCostUsd: 3 },
    ]);
  });
});
