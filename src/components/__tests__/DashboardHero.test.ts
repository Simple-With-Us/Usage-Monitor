import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DashboardHero from "@/components/DashboardHero";

describe("DashboardHero", () => {
  it("renders MTD spend, status, and budget basis caption", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardHero, {
        totalCost: 42.5,
        totalProjectedMonthlyCost: 90,
        totalBudgetUsd: 100,
        budgetedProviderCount: 3,
        incompleteCostProviderCount: 0,
        ambiguousCostFamilyCount: 0,
        accountStatus: "ok",
        spendPeriodLabel: "Past 30 Days",
        mtdMonthLabel: "August 2026",
      })
    );

    expect(html).toContain("August 2026 spend");
    expect(html).toContain("$42.50");
    expect(html).toContain("On track");
    expect(html).toContain("Across 3 provider budgets");
    expect(html).toContain("Chart range");
    expect(html).toContain("Past 30 Days");
    expect(html).toContain("Charts only");
    expect(html).toContain("Edit Global Budget");
    expect(html).toContain("role=\"meter\"");
  });

  it("does not force amber spend when on track", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardHero, {
        totalCost: 10,
        totalProjectedMonthlyCost: 20,
        totalBudgetUsd: 100,
        budgetedProviderCount: 1,
        incompleteCostProviderCount: 0,
        ambiguousCostFamilyCount: 0,
        accountStatus: "ok",
        spendPeriodLabel: "Past Week",
        mtdMonthLabel: "August 2026",
      })
    );
    expect(html).toContain("text-gray-900 dark:text-gray-100");
  });
});
