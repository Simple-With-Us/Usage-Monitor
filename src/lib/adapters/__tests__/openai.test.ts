import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../openai";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function costsPage(value: number, hasMore = false, nextPage: string | null = null) {
  return {
    object: "page",
    data: [
      {
        object: "bucket",
        start_time: 1782864000,
        end_time: 1782950400,
        results: [
          {
            object: "organization.costs.result",
            amount: { value, currency: "usd" },
          },
        ],
      },
    ],
    has_more: hasMore,
    next_page: nextPage,
  };
}

describe("openai adapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T15:30:00.000Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses the current UTC calendar month, paginates, and treats organization costs as authoritative", async () => {
    const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);

      if (url.includes("/v1/organization/costs?")) {
        const parsed = new URL(url);
        if (parsed.searchParams.get("page") === "cost-page-2") {
          return Promise.resolve(jsonResponse(costsPage(23.45)));
        }
        return Promise.resolve(jsonResponse(costsPage(100, true, "cost-page-2")));
      }
      if (url.endsWith("/v1/usage?date=2026-07-11")) {
        return Promise.resolve(
          jsonResponse({ data: [{ cost: 125, n_requests: 9 }] })
        );
      }
      if (url.endsWith("/dashboard/billing/subscription")) {
        return Promise.resolve(jsonResponse({ hard_limit_usd: 100 }));
      }
      if (url.endsWith("/dashboard/billing/credit_grants")) {
        return Promise.resolve(jsonResponse({ total_available: 50 }));
      }
      if (
        url.endsWith(
          "/dashboard/billing/usage?start_date=2026-07-01&end_date=2026-07-11"
        )
      ) {
        return Promise.resolve(jsonResponse({ total_usage: 99999 }));
      }

      return Promise.reject(new Error(`Unexpected OpenAI URL: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("test-key", { adminApiKey: "admin-key" });

    expect(result.totalCost).toBe(123.45);
    expect(result.totalRequests).toBe(9);
    expect(result.rawData).toMatchObject({
      costSource: "organization_costs",
      costsApiKeyRequirement: expect.stringContaining("Admin API key"),
      costsCredentialSource: "secretConfig.adminApiKey",
    });
    const costUrls = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes("/v1/organization/costs?"));
    expect(costUrls).toHaveLength(2);
    expect(costUrls[0]).toContain("start_time=1782864000");
    expect(costUrls[0]).toContain("end_time=1783783801");
    expect(costUrls[1]).toContain("page=cost-page-2");
    const costsCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/v1/organization/costs?")
    );
    const usageCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/v1/usage?")
    );
    expect(costsCall?.[1]).toMatchObject({
      headers: { Authorization: "Bearer admin-key" },
    });
    expect(usageCall?.[1]).toMatchObject({
      headers: { Authorization: "Bearer test-key" },
    });
  });

  it("preserves an authoritative zero month-to-date cost", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/v1/organization/costs?")) {
          return Promise.resolve(jsonResponse(costsPage(0)));
        }
        if (url.includes("/dashboard/billing/usage?")) {
          return Promise.resolve(jsonResponse({ total_usage: 500 }));
        }
        if (url.includes("/v1/usage?")) {
          return Promise.resolve(jsonResponse({ data: [{ cost: 275 }] }));
        }
        return Promise.resolve(jsonResponse({}));
      })
    );

    const result = await fetchUsage("test-key");

    expect(result.totalCost).toBe(0);
  });

  it("falls back to the daily cost only when the month range is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/v1/organization/costs?")) {
          return Promise.resolve(jsonResponse({ error: "admin key required" }, 403));
        }
        if (url.includes("/dashboard/billing/usage?")) {
          return Promise.resolve(jsonResponse({ error: "forbidden" }, 403));
        }
        if (url.includes("/v1/usage?")) {
          return Promise.resolve(
            jsonResponse({ data: [{ cost: 275, n_requests: 4 }] })
          );
        }
        return Promise.resolve(jsonResponse({}));
      })
    );

    const result = await fetchUsage("test-key");

    expect(result.totalCost).toBe(2.75);
    expect(result.totalRequests).toBe(4);
  });

  it("accepts the legacy month range as the sole successful response for a non-admin key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/v1/organization/costs?")) {
          return Promise.resolve(jsonResponse({ error: "admin key required" }, 403));
        }
        if (url.includes("/dashboard/billing/usage?")) {
          return Promise.resolve(jsonResponse({ total_usage: "425" }));
        }
        return Promise.resolve(jsonResponse({ error: "unauthorized" }, 401));
      })
    );

    const result = await fetchUsage("test-key");

    expect(result.totalCost).toBe(4.25);
    expect(result.rawData).toMatchObject({ costSource: "legacy_billing_usage" });
  });

  it("requires every costs page to succeed before using the modern total", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/v1/organization/costs?")) {
          if (url.includes("page=broken-page")) {
            return Promise.resolve(jsonResponse({ error: "page failure" }, 400));
          }
          return Promise.resolve(jsonResponse(costsPage(100, true, "broken-page")));
        }
        if (url.includes("/dashboard/billing/usage?")) {
          return Promise.resolve(jsonResponse({ total_usage: 725 }));
        }
        return Promise.resolve(jsonResponse({}));
      })
    );

    const result = await fetchUsage("test-key");

    expect(result.totalCost).toBe(7.25);
    expect(result.rawData).toMatchObject({ costSource: "legacy_billing_usage" });
  });
});
