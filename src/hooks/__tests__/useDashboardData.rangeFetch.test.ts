// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useDashboardData } from "@/hooks/useDashboardData";

/**
 * Regression coverage for the "chart range never does anything" bug: the
 * range-scoped fetch (usage-events + project budgets, i.e. fetchPortfolioData)
 * used to be gated behind `if (!portfolioOpen) return;`, so on any load where
 * the portfolio/charts section wasn't auto-opened, changing the timeframe
 * picker never issued a new request at all. useDashboardData.ts now runs
 * that fetch unconditionally on mount and on every timeframe change; only
 * the *poll* interval stays gated on portfolioOpen.
 */

function jsonResponse(body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => body,
  } as unknown as Response);
}

describe("useDashboardData — range-scoped fetch wiring", () => {
  let calls: string[];

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/api/usage-events")) {
          return jsonResponse({
            mode: "summary",
            days: 30,
            totalCostUsd: 0,
            estimatedApiEquivalentUsd: 0,
            pricedEventCount: 0,
            unpricedEventCount: 0,
            unclassifiedCostEventCount: 0,
            costCoverage: "unknown",
            totalRequests: 0,
            eventCount: 0,
            groups: [],
            dailySeries: [],
          });
        }
        if (url.includes("/api/providers/refresh-stale")) {
          return jsonResponse({ refreshed: 0 });
        }
        if (url.includes("/api/providers")) {
          return jsonResponse([]);
        }
        if (url.includes("/api/subscriptions")) {
          return jsonResponse([]);
        }
        if (url.includes("/api/projects")) {
          return jsonResponse({
            projects: [],
            summary: { totalSpentUsd: 0, unbudgetedSpentUsd: 0, unassignedSpentUsd: 0 },
          });
        }
        return jsonResponse({});
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("issues the range-scoped usage-events request on mount and again on every timeframe change, with the portfolio panel closed throughout", async () => {
    const { result, unmount } = renderHook(() => useDashboardData());

    // Never opened in this test — proves the fetch does not depend on it.
    expect(result.current.portfolioOpen).toBe(false);

    await waitFor(() => {
      expect(calls.some((u) => u.includes("/api/usage-events?days=30"))).toBe(true);
    });
    expect(result.current.portfolioOpen).toBe(false);

    calls = [];
    act(() => {
      result.current.setTimeframe("90d");
    });

    await waitFor(() => {
      expect(calls.some((u) => u.includes("/api/usage-events?days=90"))).toBe(true);
    });
    expect(result.current.portfolioOpen).toBe(false);

    unmount();
  });
});
