import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DashboardSummaryCards from "@/components/DashboardSummaryCards";

function renderSummary(
  incompleteCostProviderCount: number,
  totalCost = 0,
  ambiguousCostFamilyCount = 0,
  spendPeriodLabel = "August 2026"
) {
  return renderToStaticMarkup(
    createElement(DashboardSummaryCards, {
      totalProviderFunds: 25,
      totalProjectedMonthlyCost: 20,
      totalCost,
      incompleteCostProviderCount,
      ambiguousCostFamilyCount,
      attentionItemsCount: 0,
      criticalCount: 0,
      spendPeriodLabel,
    })
  );
}

describe("DashboardSummaryCards", () => {
  it("labels totals as known-only when provider cost coverage is incomplete", () => {
    const html = renderSummary(2, 12.5);

    expect(html).toContain("Known August 2026 Spend");
    expect(html).toContain("$12.50");
    expect(html).toContain("2 provider costs incomplete");
    expect(html).toContain("Known-Cost Projection");
    expect(html).toContain("Excludes unreported or ambiguous provider costs");
  });

  it("keeps explicit complete zero totals as zero", () => {
    const html = renderSummary(0);

    expect(html).toContain("August 2026 Spend");
    expect(html).toContain("Projected Monthly Spend");
    expect(html).toContain("$0.00");
    expect(html).not.toContain("provider cost incomplete");
  });

  it("excludes ambiguous multi-key families from portfolio money totals", () => {
    const html = renderSummary(0, 12.5, 2);

    expect(html).toContain("Known August 2026 Spend");
    expect(html).toContain("2 multi-key families excluded");
    expect(html).toContain("Excludes unreported or ambiguous provider costs");
  });

  it("renders a single bordered KPI strip instead of separate cards", () => {
    const html = renderSummary(0);

    expect(html.match(/gap-px/g)?.length).toBe(1);
    expect(html).not.toContain("p-6");
  });

  it("links the Open Alerts cell to the attention anchor", () => {
    const html = renderSummary(0);

    expect(html).toContain('href="#attention"');
  });

  it("uses neutral styling and money-first order when alerts are zero (D2)", () => {
    const html = renderSummary(0);

    // Spend before alerts in DOM order
    expect(html.indexOf("August 2026 Spend")).toBeLessThan(
      html.indexOf("Open Alerts")
    );
    expect(html).toContain("All clear");
    // Zero alerts / complete spend should not use amber alarm colors
    expect(html).toContain("text-gray-900 dark:text-gray-100");
    expect(html).not.toContain("text-amber-600 dark:text-amber-400");
  });

  it("colors spend amber when coverage is incomplete", () => {
    const html = renderSummary(2, 12.5);
    expect(html).toContain("text-amber-600 dark:text-amber-400");
  });

  it("shows provider funds without inventing an aggregate credit total", () => {
    const html = renderSummary(0);

    expect(html).toContain("Known Provider Funds");
    expect(html).toContain("Excludes ambiguous, brokerage, and merchant assets");
    expect(html).not.toContain("Total Credits");
  });
});
