import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SpendBurnChart, {
  buildPaceChartRows,
  buildSpendPace,
  derivePaceFromBudgetStatus,
} from "@/components/SpendBurnChart";

describe("buildSpendPace", () => {
  it("builds a linear pace for the current UTC month", () => {
    const pace = buildSpendPace({
      month: "2026-08",
      generatedAt: "2026-08-10T12:00:00.000Z",
      spent: 100,
      projected: 310,
      budget: 400,
    });
    expect(pace).not.toBeNull();
    expect(pace!.daysInMonth).toBe(31);
    expect(pace!.currentDay).toBe(10);
    expect(pace!.spent).toBe(100);
    expect(pace!.budget).toBe(400);
  });

  it("returns null for invalid month tokens", () => {
    expect(
      buildSpendPace({
        month: "nope",
        spent: 1,
        projected: 2,
        budget: null,
      })
    ).toBeNull();
  });
});

describe("buildPaceChartRows", () => {
  it("emits one row per day with toDate only through current day", () => {
    const pace = buildSpendPace({
      month: "2026-08",
      generatedAt: "2026-08-05T00:00:00.000Z",
      spent: 50,
      projected: 310,
      budget: 400,
    })!;
    const rows = buildPaceChartRows(pace);
    expect(rows).toHaveLength(31);
    expect(rows[0].toDate).toBeCloseTo(10, 5);
    expect(rows[4].toDate).toBeCloseTo(50, 5);
    expect(rows[5].toDate).toBeNull();
    expect(rows[30].projection).not.toBeNull();
  });
});

describe("derivePaceFromBudgetStatus", () => {
  it("sums provider spend and budgets", () => {
    const pace = derivePaceFromBudgetStatus({
      month: "2026-08",
      generatedAt: "2026-08-15T00:00:00.000Z",
      providers: [
        { spentUsd: 10, projectedEomUsd: 20, monthlyBudgetUsd: 50 },
        { spentUsd: 5, projectedEomUsd: 15, monthlyBudgetUsd: 25 },
      ],
    });
    expect(pace?.spent).toBe(15);
    expect(pace?.projected).toBe(35);
    expect(pace?.budget).toBe(75);
  });

  it("returns null for empty body", () => {
    expect(derivePaceFromBudgetStatus(null)).toBeNull();
    expect(derivePaceFromBudgetStatus(undefined)).toBeNull();
  });
});

describe("SpendBurnChart smoke", () => {
  it("renders month pace labels with override props", () => {
    const html = renderToStaticMarkup(
      createElement(SpendBurnChart, {
        spentUsd: 42,
        projectedEomUsd: 100,
        monthlyBudgetUsd: 200,
        month: "2026-08",
        generatedAt: "2026-08-04T12:00:00.000Z",
      })
    );
    expect(html).toContain("Month Pace");
    expect(html).toContain("Linear estimate");
    expect(html).toContain("Day 4 of 31");
  });
});
