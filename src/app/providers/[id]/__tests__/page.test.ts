import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CostCoverageCaveatBanner, spendCoverageNoteText } from "../cost-coverage-caveat";

// The page itself ("use client", data-fetched via useParams + fetch in
// useEffect) has no existing test coverage and no established pattern in
// this repo for exercising a full client page component (only route
// handlers and props-driven components like ProviderCard/
// DashboardProviderWorkspace are tested). Next.js's generated route types
// also reject extra named exports from page.tsx itself, so the pure,
// testable pieces that render/compute the cost coverage caveat live in the
// co-located cost-coverage-caveat.tsx module instead. Rather than inventing
// new page-mounting infrastructure, these tests target that module
// directly: the banner render and the "complete cost coverage" label logic
// - the same render-present/render-absent convention as ProviderCard.test.ts
// and ProviderTable.test.ts use for the same field.

describe("CostCoverageCaveatBanner", () => {
  it("renders the caveat message prominently when present", () => {
    const html = renderToStaticMarkup(
      createElement(CostCoverageCaveatBanner, {
        caveat: {
          code: "cloudflare_paygo_usage_unavailable",
          message:
            "Usage-based costs (D1, R2, Workers, Queues overage) are not visible for this account — only the fixed subscription fee is shown. Cost may be understated.",
        },
      })
    );

    expect(html).toContain("Cost coverage gap");
    expect(html).toContain("Usage-based costs (D1, R2, Workers, Queues overage) are not visible");
  });

  it("renders nothing when no caveat is present", () => {
    const html = renderToStaticMarkup(
      createElement(CostCoverageCaveatBanner, { caveat: null })
    );

    expect(html).toBe("");
  });

  it("renders nothing when caveat is undefined", () => {
    const html = renderToStaticMarkup(
      createElement(CostCoverageCaveatBanner, { caveat: undefined })
    );

    expect(html).toBe("");
  });
});

describe("spendCoverageNoteText", () => {
  it("never claims complete cost coverage when a caveat is present, even though spendCoverage reads complete", () => {
    const text = spendCoverageNoteText("complete", {
      code: "cloudflare_paygo_usage_unavailable",
      message: "Usage-based costs are not visible for this account.",
    });

    expect(text).not.toContain("complete cost coverage");
    expect(text).toBe("cost coverage gap");
  });

  it("reports complete cost coverage when spendCoverage is complete and there is no caveat", () => {
    expect(spendCoverageNoteText("complete", null)).toBe("complete cost coverage");
    expect(spendCoverageNoteText("complete", undefined)).toBe("complete cost coverage");
  });

  it("reports cost coverage unknown for non-complete coverage without a caveat", () => {
    expect(spendCoverageNoteText("unknown", null)).toBe("cost coverage unknown");
    expect(spendCoverageNoteText("legacy_unknown", null)).toBe("cost coverage unknown");
  });
});
