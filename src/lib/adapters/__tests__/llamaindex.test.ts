import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterError } from "../helpers";
import { fetchUsage } from "../llamaindex";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function usageMetric(
  organizationId: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "metric-1",
    user_id: "private-user",
    event_type: "pages_parsed",
    project_id: "project-1",
    organization_id: organizationId,
    value: 10,
    day: "2026-07-13",
    event_aggregation_key: "job-1",
    event_aggregation_type: "pdf",
    credits: 1.5,
    ...overrides,
  };
}

describe("LlamaIndex Cloud adapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("discovers organizations and strictly paginates current UTC-month credit usage", async () => {
    vi.setSystemTime(new Date("2026-07-13T15:16:17.000Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: "org-1", name: "Primary" }],
          next_page_token: "next-org",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: "org-2", name: "Secondary" }],
          next_page_token: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [usageMetric("org-1")],
          next_page_token: "next-usage",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            usageMetric("org-1", {
              id: "metric-2",
              event_type: "pages_indexed",
              value: 4,
              credits: 2.25,
            }),
          ],
          next_page_token: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            usageMetric("org-2", {
              id: "metric-3",
              value: 1,
              credits: 1,
            }),
          ],
          next_page_token: null,
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("key", { projectId: "project-1" });

    expect(result.totalCost).toBeNull();
    expect(result.totalRequests).toBeNull();
    expect(result.balance).toBeNull();
    expect(result.credits).toBeNull();
    expect(result.externalBilling).toMatchObject({
      source: "llamaindex-usage-metrics",
      authoritative: true,
      records: [
        { serviceName: "Primary", usageQuantity: 3.75, usageUnit: "credits_consumed" },
        { serviceName: "Secondary", usageQuantity: 1, usageUnit: "credits_consumed" },
      ],
    });
    expect(result.rawData).toMatchObject({
      creditsConsumed: 4.75,
      creditsConsumedKnownLowerBound: 4.75,
      creditCoverage: "complete",
      organizationCount: 2,
      capabilities: {
        usageCredits: true,
        usageCreditsComplete: true,
        creditBalance: false,
        billingCost: false,
      },
    });
    expect(JSON.stringify(result.rawData)).not.toContain("private-user");

    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls[0].pathname).toBe("/api/v2/organizations");
    expect(urls[1].searchParams.get("page_token")).toBe("next-org");
    expect(urls[2].pathname).toBe("/api/v1/beta/usage-metrics");
    expect(urls[2].searchParams.get("organization_id")).toBe("org-1");
    expect(urls[2].searchParams.get("project_id")).toBe("project-1");
    expect(urls[2].searchParams.get("day_on_or_after")).toBe("2026-07-01");
    expect(urls[2].searchParams.get("day_on_or_before")).toBe("2026-07-13");
    expect(urls[3].searchParams.get("page_token")).toBe("next-usage");
  });

  it("keeps an empty complete report authoritative and cost unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ items: [], next_page_token: null }))
    );

    const result = await fetchUsage("key");

    expect(result.credits).toBeNull();
    expect(result.totalCost).toBeNull();
    expect(result.externalBilling).toEqual({
      source: "llamaindex-usage-metrics",
      authoritative: true,
      records: [],
    });
    expect(result.rawData).toMatchObject({
      creditsConsumed: 0,
      creditsConsumedKnownLowerBound: 0,
      creditCoverage: "complete",
    });
  });

  it("does not present nullable credit metrics as an exact zero or lower-bound total", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T15:16:17.000Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            { id: "org-1", name: "Mixed coverage" },
            { id: "org-2", name: "No coverage" },
          ],
          next_page_token: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            usageMetric("org-1", { credits: 1.5 }),
            usageMetric("org-1", { id: "metric-2", credits: null }),
          ],
          next_page_token: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [usageMetric("org-2", { credits: null })],
          next_page_token: null,
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("key");

    expect(result.externalBilling?.records).toEqual([
      expect.objectContaining({
        serviceName: "Mixed coverage",
        status: "usage_partial",
        usageQuantity: null,
      }),
      expect.objectContaining({
        serviceName: "No coverage",
        status: "usage_partial",
        usageQuantity: null,
      }),
    ]);
    expect(result.rawData).toMatchObject({
      creditsConsumed: null,
      creditsConsumedKnownLowerBound: 1.5,
      creditCoverage: "partial",
      organizations: [
        {
          name: "Mixed coverage",
          creditsConsumed: null,
          creditsConsumedKnownLowerBound: 1.5,
          creditCoverage: "partial",
          metricCount: 2,
          metricsWithCredits: 1,
        },
        {
          name: "No coverage",
          creditsConsumed: null,
          creditsConsumedKnownLowerBound: 0,
          creditCoverage: "unknown",
          metricCount: 1,
          metricsWithCredits: 0,
        },
      ],
      capabilities: {
        usageCredits: false,
        usageCreditsComplete: false,
      },
    });
  });

  it("fails the whole sync when a usage page fails instead of returning a partial authoritative result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            { id: "org-1", name: "Primary" },
            { id: "org-2", name: "Secondary" },
          ],
          next_page_token: null,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ items: [usageMetric("org-1")], next_page_token: null })
      )
      .mockResolvedValueOnce(jsonResponse({ detail: "forbidden" }, 403));
    vi.stubGlobal("fetch", fetchMock);

    const error = await fetchUsage("key").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ code: "HTTP_ERROR", status: 403 });
  });

  it("rejects repeated pagination tokens", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: "org-1", name: "Primary" }],
          next_page_token: "repeat",
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({ items: [], next_page_token: "repeat" })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchUsage("key")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});
