import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DashboardCharts, {
  shapeFamilyProjectedBreakdown,
} from "@/components/DashboardCharts";

describe("shapeFamilyProjectedBreakdown", () => {
  it("keeps exact positive slices and tallies exclusions", () => {
    const { slices, excludedIncomplete } = shapeFamilyProjectedBreakdown([
      { displayName: "OpenAI", projectedEomUsd: 40, exact: true },
      { displayName: "Anthropic", projectedEomUsd: 80, exact: true },
      { displayName: "Ambiguous Co", projectedEomUsd: 12, exact: false },
      { displayName: "Unknown", projectedEomUsd: null },
      { displayName: "Zero", projectedEomUsd: 0, exact: true },
    ]);

    expect(excludedIncomplete).toBe(2);
    expect(slices).toEqual([
      { name: "Anthropic", value: 80 },
      { name: "OpenAI", value: 40 },
    ]);
  });

  it("handles empty / undefined input", () => {
    expect(shapeFamilyProjectedBreakdown(undefined)).toEqual({
      slices: [],
      excludedIncomplete: 0,
    });
    expect(shapeFamilyProjectedBreakdown([])).toEqual({
      slices: [],
      excludedIncomplete: 0,
    });
  });
});

describe("DashboardCharts smoke", () => {
  it("renders primary pace shell + secondary breakdown caption", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardCharts, {
        families: [
          { displayName: "OpenAI", projectedEomUsd: 40, exact: true },
          { displayName: "Partial Co", projectedEomUsd: 5, exact: false },
        ],
        spentUsd: 20,
        projectedEomUsd: 60,
        monthlyBudgetUsd: 100,
      })
    );

    expect(html).toContain("Month Pace");
    expect(html).toContain("Projected Cost Breakdown");
    expect(html).toContain("incomplete");
    expect(html).toContain("rounded-2xl");
  });

  it("hides breakdown when all family slices are excluded", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardCharts, {
        families: [{ displayName: "X", projectedEomUsd: null }],
        spentUsd: 5,
        projectedEomUsd: 15,
        monthlyBudgetUsd: null,
      })
    );
    expect(html).toContain("Month Pace");
    expect(html).not.toContain("Projected Cost Breakdown");
  });
});
