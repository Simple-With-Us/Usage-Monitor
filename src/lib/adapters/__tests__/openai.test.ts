import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../openai";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function costsPage(
  value: number,
  hasMore = false,
  nextPage: string | null = null,
  currency: string | null = "usd",
  resultFields: Record<string, unknown> = {}
) {
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
            amount: currency ? { value, currency } : { value },
            ...resultFields,
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
        if (parsed.searchParams.get("group_by") === "project_id") {
          return Promise.resolve(
            jsonResponse(costsPage(123.45, false, null, "usd", { project_id: "proj_ct" }))
          );
        }
        if (parsed.searchParams.get("group_by") === "line_item") {
          return Promise.resolve(
            jsonResponse(
              costsPage(123.45, false, null, "usd", {
                line_item: "completions",
                quantity: 42,
              })
            )
          );
        }
        if (parsed.searchParams.get("group_by") === "api_key_id") {
          return Promise.resolve(
            jsonResponse(costsPage(123.45, false, null, "usd", { api_key_id: "key_ct" }))
          );
        }
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
    expect(result.costScope).toBe("calendar_month_to_date");
    expect(new Date(result.costWindowStart!).toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(result.rawData).toMatchObject({
      costSource: "organization_costs",
      organizationCosts: {
        available: true,
        totalCostUsd: 123.45,
        pageCount: 2,
      },
      organizationCostBreakdowns: {
        project_id: { available: true, componentCount: 1 },
        line_item: { available: true, componentCount: 1 },
        api_key_id: { available: true, componentCount: 1 },
      },
      dailyUsage: { costUsd: 1.25, requests: 9 },
      costsApiKeyRequirement: expect.stringContaining("Admin API key"),
      costsCredentialSource: "secretConfig.adminApiKey",
    });
    expect(result.externalBilling?.records[0]).toMatchObject({
      serviceName: "OpenAI API",
      amountUsd: 123.45,
      spendLimitUsd: 100,
      rollupRole: "canonical",
    });
    expect(result.externalBillingSyncs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "openai-organization-costs-projects",
          records: [expect.objectContaining({
            serviceName: "OpenAI project: proj_ct",
            amountUsd: 123.45,
            rollupRole: "component",
          })],
        }),
        expect.objectContaining({
          source: "openai-organization-costs-line-items",
          records: [expect.objectContaining({
            serviceName: "OpenAI line item: completions",
            amountUsd: 123.45,
            usageQuantity: 42,
            rollupRole: "component",
          })],
        }),
        expect.objectContaining({
          source: "openai-organization-costs-api-keys",
          records: [expect.objectContaining({
            serviceName: "OpenAI API key ID: key_ct",
            amountUsd: 123.45,
            usageQuantity: null,
            rollupRole: "component",
          })],
        }),
      ])
    );
    expect(JSON.stringify(result.rawData)).not.toContain("organization.costs.result");
    const costUrls = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => {
        const parsed = new URL(url);
        return parsed.pathname === "/v1/organization/costs" && !parsed.searchParams.has("group_by");
      });
    expect(costUrls).toHaveLength(2);
    expect(costUrls[0]).toContain("start_time=1782864000");
    expect(costUrls[0]).toContain("end_time=1783783801");
    expect(costUrls[1]).toContain("page=cost-page-2");
    const componentUrls = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => new URL(url).searchParams.has("group_by"));
    expect(componentUrls).toHaveLength(3);
    expect(componentUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("group_by=project_id"),
        expect.stringContaining("group_by=line_item"),
        expect.stringContaining("group_by=api_key_id"),
      ])
    );
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

  it("keeps today's cost diagnostic-only when no month-to-date source is available", async () => {
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

    expect(result.totalCost).toBeNull();
    expect(result.totalRequests).toBe(4);
    expect(result.rawData).toMatchObject({
      dailyUsage: { costUsd: 2.75, requests: 4 },
    });
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

  it("does not assume a missing organization-cost currency is USD", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/v1/organization/costs?")) {
          return Promise.resolve(jsonResponse(costsPage(100, false, null, null)));
        }
        if (url.includes("/dashboard/billing/usage?")) {
          return Promise.resolve(jsonResponse({ total_usage: 725 }));
        }
        return Promise.resolve(jsonResponse({}));
      })
    );

    const result = await fetchUsage("test-key");

    expect(result.totalCost).toBe(7.25);
    expect(result.rawData).toMatchObject({
      costSource: "legacy_billing_usage",
      organizationCosts: { available: false },
    });
  });

  it.each([
    ["omits has_more", (page: Record<string, unknown>) => { delete page.has_more; }],
    ["returns non-boolean has_more", (page: Record<string, unknown>) => { page.has_more = 0; }],
    ["returns a cursor on an explicitly final page", (page: Record<string, unknown>) => { page.next_page = "unexpected"; }],
  ])("does not treat a canonical Costs page as complete when it %s", async (_name, corrupt) => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/v1/organization/costs?")) {
          const malformed = costsPage(100) as Record<string, unknown>;
          corrupt(malformed);
          return Promise.resolve(jsonResponse(malformed));
        }
        if (url.includes("/dashboard/billing/usage?")) {
          return Promise.resolve(jsonResponse({ total_usage: 725 }));
        }
        return Promise.resolve(jsonResponse({}));
      })
    );

    const result = await fetchUsage("test-key", { adminApiKey: "admin-key" });

    expect(result.totalCost).toBe(7.25);
    expect(result.rawData).toMatchObject({
      costSource: "legacy_billing_usage",
      organizationCosts: { available: false, totalCostUsd: null },
      organizationCostsError: "Malformed or non-USD organization costs response",
    });
  });

  it("keeps the canonical cash total when one optional component breakdown fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/organization/costs") {
          if (url.searchParams.get("group_by") === "project_id") {
            return Promise.resolve(jsonResponse({ error: "forbidden" }, 403));
          }
          if (url.searchParams.get("group_by") === "line_item") {
            return Promise.resolve(
              jsonResponse(costsPage(9, false, null, "usd", { line_item: "batch", quantity: 3 }))
            );
          }
          if (url.searchParams.get("group_by") === "api_key_id") {
            return Promise.resolve(
              jsonResponse(costsPage(9, false, null, "usd", { api_key_id: "key_shared" }))
            );
          }
          return Promise.resolve(jsonResponse(costsPage(9)));
        }
        return Promise.resolve(jsonResponse({}));
      })
    );

    const result = await fetchUsage("test-key", { adminApiKey: "admin-key" });

    expect(result.totalCost).toBe(9);
    expect(result.rawData).toMatchObject({
      organizationCosts: { available: true, totalCostUsd: 9 },
      organizationCostBreakdowns: {
        project_id: { available: false, status: 403, componentCount: 0 },
        line_item: { available: true, componentCount: 1 },
        api_key_id: { available: true, componentCount: 1 },
      },
    });
    expect(result.externalBilling?.records).toHaveLength(1);
    expect(result.externalBillingSyncs).toEqual([
      expect.objectContaining({
        source: "openai-organization-costs-line-items",
        records: [expect.objectContaining({ amountUsd: 9, rollupRole: "component" })],
      }),
      expect.objectContaining({
        source: "openai-organization-costs-api-keys",
        records: [expect.objectContaining({
          serviceName: "OpenAI API key ID: key_shared",
          amountUsd: 9,
          rollupRole: "component",
        })],
      }),
    ]);
  });

  it("paginates and aggregates a bounded project component breakdown independently of canonical cost", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/organization/costs") {
        if (url.searchParams.get("group_by") === "project_id") {
          if (url.searchParams.get("page") === "projects-page-2") {
            return Promise.resolve(
              jsonResponse(costsPage(2, false, null, "usd", { project_id: "proj_ct" }))
            );
          }
          return Promise.resolve(
            jsonResponse(costsPage(4, true, "projects-page-2", "usd", { project_id: "proj_ct" }))
          );
        }
        if (url.searchParams.get("group_by") === "line_item") {
          return Promise.resolve(
            jsonResponse(costsPage(6, false, null, "usd", { line_item: "completions" }))
          );
        }
        if (url.searchParams.get("group_by") === "api_key_id") {
          return Promise.resolve(
            jsonResponse(costsPage(6, false, null, "usd", { api_key_id: "key_ct" }))
          );
        }
        return Promise.resolve(jsonResponse(costsPage(6)));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("test-key", { adminApiKey: "admin-key" });

    expect(result.totalCost).toBe(6);
    expect(result.rawData).toMatchObject({
      organizationCostBreakdowns: {
        project_id: { available: true, pageCount: 2, componentCount: 1 },
      },
    });
    expect(result.externalBillingSyncs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "openai-organization-costs-projects",
          records: [expect.objectContaining({ amountUsd: 6, serviceName: "OpenAI project: proj_ct" })],
        }),
      ])
    );
    expect(
      fetchMock.mock.calls.some(([input]) => {
        const url = new URL(String(input));
        return url.searchParams.get("group_by") === "project_id" && url.searchParams.get("page") === "projects-page-2";
      })
    ).toBe(true);
  });

  it.each([
    ["omits has_more", (page: Record<string, unknown>) => { delete page.has_more; }],
    ["returns non-boolean has_more", (page: Record<string, unknown>) => { page.has_more = "false"; }],
    ["returns a cursor on an explicitly final page", (page: Record<string, unknown>) => { page.next_page = "unexpected"; }],
  ])("does not publish an authoritative component sync when a breakdown %s", async (_name, corrupt) => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/organization/costs") {
          if (url.searchParams.get("group_by") === "project_id") {
            const malformed = costsPage(4, false, null, "usd", { project_id: "proj_ct" }) as Record<string, unknown>;
            corrupt(malformed);
            return Promise.resolve(jsonResponse(malformed));
          }
          if (url.searchParams.get("group_by") === "line_item") {
            return Promise.resolve(
              jsonResponse(costsPage(4, false, null, "usd", { line_item: "completions", quantity: 3 }))
            );
          }
          if (url.searchParams.get("group_by") === "api_key_id") {
            return Promise.resolve(
              jsonResponse(costsPage(4, false, null, "usd", { api_key_id: "key_ct" }))
            );
          }
          return Promise.resolve(jsonResponse(costsPage(4)));
        }
        return Promise.resolve(jsonResponse({}));
      })
    );

    const result = await fetchUsage("test-key", { adminApiKey: "admin-key" });

    expect(result.totalCost).toBe(4);
    expect(result.rawData).toMatchObject({
      organizationCostBreakdowns: {
        project_id: { available: false, status: 502, componentCount: 0 },
        line_item: { available: true, componentCount: 1 },
      },
      organizationCostProjectBreakdownError: "Malformed or non-USD organization cost component response",
    });
    expect(result.externalBillingSyncs?.map((sync) => sync.source)).toEqual([
      "openai-organization-costs-line-items",
      "openai-organization-costs-api-keys",
    ]);
  });

  it("bounds an over-cardinality component view without discarding the canonical total", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/organization/costs") {
          if (url.searchParams.get("group_by") === "project_id") {
            return Promise.resolve(
              jsonResponse({
                object: "page",
                data: [{
                  object: "bucket",
                  start_time: 1782864000,
                  end_time: 1782950400,
                  results: Array.from({ length: 101 }, (_, index) => ({
                    object: "organization.costs.result",
                    project_id: `proj_${index}`,
                    amount: { value: 0.01, currency: "usd" },
                  })),
                }],
                has_more: false,
                next_page: null,
              })
            );
          }
          if (url.searchParams.get("group_by") === "line_item") {
            return Promise.resolve(
              jsonResponse(costsPage(1.01, false, null, "usd", { line_item: "completions" }))
            );
          }
          if (url.searchParams.get("group_by") === "api_key_id") {
            return Promise.resolve(
              jsonResponse(costsPage(1.01, false, null, "usd", { api_key_id: "key_ct" }))
            );
          }
          return Promise.resolve(jsonResponse(costsPage(1.01)));
        }
        return Promise.resolve(jsonResponse({}));
      })
    );

    const result = await fetchUsage("test-key", { adminApiKey: "admin-key" });

    expect(result.totalCost).toBe(1.01);
    expect(result.rawData).toMatchObject({
      organizationCostBreakdowns: {
        project_id: { available: false, componentCount: 0 },
        line_item: { available: true, componentCount: 1 },
      },
      organizationCostProjectBreakdownError: expect.stringContaining("exceeded 100 components"),
    });
    expect(result.externalBillingSyncs).toEqual([
      expect.objectContaining({ source: "openai-organization-costs-line-items" }),
      expect.objectContaining({ source: "openai-organization-costs-api-keys" }),
    ]);
  });
});
