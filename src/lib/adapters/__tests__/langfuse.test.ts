import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterError } from "../helpers";
import { fetchUsage } from "../langfuse";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function queryFromUrl(value: unknown): Record<string, unknown> {
  const query = new URL(String(value)).searchParams.get("query");
  if (!query) throw new Error("missing query");
  return JSON.parse(query) as Record<string, unknown>;
}

describe("langfuse adapter", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sums all four official billable-unit views for the exact UTC month to date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T15:16:17.000Z"));
    const fetchMock = vi.fn().mockImplementation((url: unknown) => {
      const query = queryFromUrl(url);
      const responses: Record<string, unknown> = {
        traces: { data: [{ count_count: "10" }] },
        observations: {
          data: [{ count_count: "25", sum_totalCost: "3.5" }],
        },
        "scores-numeric": { data: [{ count_count: 4 }] },
        "scores-categorical": { data: [{ count_count: "2" }] },
      };
      return Promise.resolve(jsonResponse(responses[String(query.view)]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("pk-live", { secretKey: "sk-live" });

    expect(result.totalCost).toBeNull();
    expect(result.totalRequests).toBe(41);
    expect(result.rawData).toMatchObject({
      billableUnitCount: 41,
      unitCounts: {
        traces: 10,
        observations: 25,
        numericScores: 4,
        categoricalScores: 2,
      },
      trackedLlmCostUsd: 3.5,
      trackedLlmCostCoverage: "unknown",
      capabilities: {
        billableUnitUsage: true,
        trackedLlmCost: true,
        langfuseInvoiceCost: false,
      },
    });
    expect(result.externalBilling).toMatchObject({
      source: "langfuse-legacy-metrics",
      authoritative: true,
      records: [
        { usageQuantity: 10, usageUnit: "traces" },
        { usageQuantity: 25, usageUnit: "observations" },
        { usageQuantity: 4, usageUnit: "numeric_scores" },
        { usageQuantity: 2, usageUnit: "categorical_scores" },
      ],
    });

    const queries = fetchMock.mock.calls.map(([url]) => queryFromUrl(url));
    expect(queries.map((query) => query.view)).toEqual([
      "traces",
      "observations",
      "scores-numeric",
      "scores-categorical",
    ]);
    for (const query of queries) {
      expect(query.fromTimestamp).toBe("2026-07-01T00:00:00.000Z");
      expect(query.toTimestamp).toBe("2026-07-13T15:16:17.000Z");
      expect(query.dimensions).toEqual([]);
      expect(query.filters).toEqual([]);
    }
    expect(queries[1].metrics).toEqual([
      { measure: "count", aggregation: "count" },
      { measure: "totalCost", aggregation: "sum" },
    ]);

    const expectedAuth = `Basic ${Buffer.from("pk-live:sk-live").toString("base64")}`;
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: expectedAuth,
      });
    }
  });

  it("keeps missing underlying-model cost diagnostic instead of treating it as Langfuse $0", async () => {
    const fetchMock = vi.fn().mockImplementation((url: unknown) => {
      const query = queryFromUrl(url);
      return Promise.resolve(
        jsonResponse({
          data: [
            String(query.view) === "observations"
              ? { count_count: 2, sum_totalCost: null }
              : { count_count: 1 },
          ],
        })
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("pk-live", { secretKey: "sk-live" });

    expect(result.totalRequests).toBe(5);
    expect(result.totalCost).toBeNull();
    expect(result.rawData).toMatchObject({
      trackedLlmCostUsd: null,
      trackedLlmCostCoverage: "unknown",
    });
  });

  it("fails the authoritative usage sync when any metrics view fails", async () => {
    const fetchMock = vi.fn().mockImplementation((url: unknown) => {
      const query = queryFromUrl(url);
      if (query.view === "scores-categorical") {
        return Promise.resolve(jsonResponse({ message: "forbidden" }, 403));
      }
      return Promise.resolve(
        jsonResponse({
          data: [
            query.view === "observations"
              ? { count_count: 1, sum_totalCost: 0 }
              : { count_count: 1 },
          ],
        })
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await fetchUsage("pk-live", { secretKey: "sk-live" }).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ code: "HTTP_ERROR", status: 403 });
  });
});
