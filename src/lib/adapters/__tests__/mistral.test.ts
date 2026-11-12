import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../mistral";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function currentUsage() {
  const now = new Date();
  return {
    start_date: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    end_date: now.toISOString(),
    currency: "USD",
    chat: {},
  };
}

function workspacePage(items: unknown[], total = items.length, page = 1) {
  return { items, total, page, page_size: 100 };
}

describe("Mistral billing adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never converts spend-limit consumption into cash while preserving cap and rate metadata", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ ...currentUsage(), total_usage: 99, total_cost: 99 }))
      .mockResolvedValueOnce(json({ limits: { completion: { total_usage: 12, usage: 11, usage_limit: 100, monthly_limit_reached: false }, currency: "USD", last_payment_failure: false } }))
      .mockResolvedValueOnce(json({ requests_per_second: 5, tokens_limits_by_model: {} }))
      .mockResolvedValueOnce(json(workspacePage([])));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("inference-key", { adminApiKey: "admin-key" });

    expect(result.totalCost).toBeNull();
    expect(result.balance).toBeNull();
    expect(result.costCoverageCaveat?.code).toBe(
      "mistral_usage_cash_total_schema_unavailable"
    );
    const usageSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-usage-billing"
    );
    const spendSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-spend-limits"
    );
    const rateSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-rate-limits"
    );
    expect(usageSync?.records[0]).toMatchObject({
      amountUsd: null,
      rollupRole: "canonical",
      status: "cost_unavailable",
    });
    expect(spendSync?.records[0]).toMatchObject({
      spendLimitUsd: 100,
      rollupRole: "metadata",
    });
    expect(rateSync?.records[0]).toMatchObject({
      requestLimit: 5,
      rollupRole: "metadata",
    });
    expect(fetchMock.mock.calls[0][0]).toContain("https://console.mistral.ai/api/admin/usage?");
    expect(fetchMock.mock.calls[0][1].headers["x-api-key"]).toBe("admin-key");
  });

  it("treats no_monthly_limit as unlimited even when the response includes a numeric usage_limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json(currentUsage()))
        .mockResolvedValueOnce(json({
          limits: {
            completion: {
              no_monthly_limit: true,
              usage_limit: 100,
              monthly_limit_reached: false,
            },
            currency: "USD",
            last_payment_failure: false,
          },
        }))
        .mockResolvedValueOnce(json({ requests_per_second: 5 }))
        .mockResolvedValueOnce(json(workspacePage([])))
    );

    const result = await fetchUsage("admin-key");
    const spendSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-spend-limits"
    );

    expect(spendSync?.records[0]).toMatchObject({
      status: "unlimited",
      spendLimitUsd: null,
      spendLimitWindow: null,
      rollupRole: "metadata",
    });
    expect(result.rawData).toMatchObject({
      capabilities: { spendLimit: false },
      spendLimit: {
        limits: { completion: { no_monthly_limit: true, usage_limit: 100 } },
      },
    });
  });

  it("does not reconcile a malformed successful spend-limit response over prior good metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json(currentUsage()))
        .mockResolvedValueOnce(json({}))
        .mockResolvedValueOnce(json({ requests_per_second: 5 }))
        .mockResolvedValueOnce(json(workspacePage([])))
    );

    const result = await fetchUsage("admin-key");

    expect(result.externalBillingSyncs?.map((sync) => sync.source)).not.toContain(
      "mistral-spend-limits"
    );
    expect(result.rawData).toMatchObject({
      spendLimit: {},
      capabilities: { spendLimit: false },
    });
  });

  it("paginates workspace inventory and emits bounded, non-additive workspace components", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      uuid: index === 0 ? "one" : `workspace-${index + 1}`,
      name: index === 0 ? "One" : `Workspace ${index + 1}`,
    }));
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce(json(currentUsage()))
      .mockResolvedValueOnce(json({ limits: { completion: { usage_limit: 100 }, currency: "USD" } }))
      .mockResolvedValueOnce(json({ requests_per_second: 5 }))
      .mockResolvedValueOnce(json(workspacePage(firstPage, 101)))
      .mockResolvedValueOnce(json(workspacePage([{ uuid: "two", name: "Two" }], 101, 2)));
    for (let index = 0; index < 50; index += 1) {
      fetchMock.mockResolvedValueOnce(json(currentUsage()));
    }
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("admin-key");
    const workspaceSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-workspace-usage"
    );

    expect(workspaceSync?.authoritative).toBe(false);
    expect(workspaceSync?.records).toHaveLength(50);
    expect(workspaceSync?.records[0]).toMatchObject({
      externalId: "one",
      amountUsd: null,
      rollupRole: "component",
      status: "cost_unavailable",
    });
    expect(result.rawData).toMatchObject({
      workspaceCoverage: {
        enumerationComplete: true,
        reportsAttempted: 50,
        reportsSucceeded: 50,
        reportsFailed: 0,
        reportsCapped: true,
        complete: false,
        enumerated: 101,
      },
    });
    expect(fetchMock.mock.calls[4][0]).toContain("page=2&page_size=100");
    expect(fetchMock.mock.calls[5][0]).toContain("workspace_id=one");
  });

  it("accepts safe integer strings in workspace pagination metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json(currentUsage()))
        .mockResolvedValueOnce(json({ limits: { completion: { usage_limit: 100 }, currency: "USD" } }))
        .mockResolvedValueOnce(json({ requests_per_second: 5 }))
        .mockResolvedValueOnce(json({
          items: [{ uuid: "one", name: "One" }],
          total: "1",
          page: "1",
          page_size: "100",
        }))
        .mockResolvedValueOnce(json(currentUsage()))
    );

    const result = await fetchUsage("admin-key");
    const workspaceSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-workspace-usage"
    );

    expect(workspaceSync?.authoritative).toBe(true);
    expect(workspaceSync?.records).toHaveLength(1);
    expect(result.rawData).toMatchObject({
      workspaceCoverage: {
        enumerated: 1,
        enumerationComplete: true,
        complete: true,
      },
    });
  });

  it("keeps valid organization metadata when an optional workspace report fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json(currentUsage()))
        .mockResolvedValueOnce(json({ limits: { completion: { usage_limit: 100 }, currency: "USD" } }))
        .mockResolvedValueOnce(json({ requests_per_second: 5 }))
        .mockResolvedValueOnce(json(workspacePage([{ uuid: "one", name: "One" }, { uuid: "two", name: "Two" }])))
        .mockResolvedValueOnce(json(currentUsage()))
        .mockResolvedValueOnce(json({}, 400))
    );

    const result = await fetchUsage("admin-key");
    const usageSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-usage-billing"
    );
    const workspaceSync = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-workspace-usage"
    );

    expect(usageSync?.records[0].amountUsd).toBeNull();
    expect(workspaceSync?.authoritative).toBe(false);
    expect(workspaceSync?.records).toHaveLength(1);
    expect(result.totalCost).toBeNull();
    expect(result.rawData).toMatchObject({
      workspaceCoverage: {
        enumerationComplete: true,
        reportsAttempted: 2,
        reportsSucceeded: 1,
        reportsFailed: 1,
        complete: false,
      },
    });
  });

  it("accepts the official nullable usage currency while keeping cash unavailable", async () => {
    const nullableCurrencyUsage = { ...currentUsage(), currency: null };
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json(nullableCurrencyUsage))
        .mockResolvedValueOnce(json({ limits: { completion: { usage_limit: 100 }, currency: "USD" } }))
        .mockResolvedValueOnce(json({ requests_per_second: 5 }))
        .mockResolvedValueOnce(json(workspacePage([{ uuid: "one", name: "One" }])))
        .mockResolvedValueOnce(json(nullableCurrencyUsage))
    );

    const result = await fetchUsage("admin-key");
    const organization = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-usage-billing"
    );
    const workspace = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-workspace-usage"
    );
    expect(organization?.records[0]).toMatchObject({ amountUsd: null, currency: null });
    expect(workspace?.records[0]).toMatchObject({ amountUsd: null, currency: null });
    expect(result.totalCost).toBeNull();
  });

  it("isolates an optional endpoint transport failure from valid organization usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json(currentUsage()))
        .mockRejectedValueOnce(new Error("spend-limit transport failed"))
        .mockResolvedValueOnce(json({ requests_per_second: 5 }))
        .mockResolvedValueOnce(json(workspacePage([])))
    );

    const result = await fetchUsage("admin-key");
    expect(result.externalBillingSyncs?.map((sync) => sync.source)).toEqual([
      "mistral-usage-billing",
      "mistral-rate-limits",
      "mistral-workspace-usage",
    ]);
    expect(result.totalCost).toBeNull();
  });

  it("hard-bounds excessive workspace totals and marks collection incomplete", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      uuid: `workspace-${index}`,
      name: `Workspace ${index}`,
    }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(currentUsage()))
      .mockResolvedValueOnce(json({ limits: { completion: { usage_limit: 100 }, currency: "USD" } }))
      .mockResolvedValueOnce(json({ requests_per_second: 5 }))
      .mockResolvedValueOnce(json(workspacePage(firstPage, 1001)));
    for (let index = 0; index < 50; index += 1) {
      fetchMock.mockResolvedValueOnce(json(currentUsage()));
    }
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("admin-key");
    const workspace = result.externalBillingSyncs?.find(
      (sync) => sync.source === "mistral-workspace-usage"
    );
    expect(workspace?.authoritative).toBe(false);
    expect(workspace?.records).toHaveLength(50);
    expect(result.rawData).toMatchObject({
      workspaceCoverage: {
        enumerationComplete: false,
        enumerated: 100,
        reportsCapped: true,
        complete: false,
      },
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/workspaces")))
      .toHaveLength(1);
  });

  it("does not treat inconsistent empty pagination metadata as authoritative", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json(currentUsage()))
        .mockResolvedValueOnce(json({ limits: { completion: { usage_limit: 100 }, currency: "USD" } }))
        .mockResolvedValueOnce(json({ requests_per_second: 5 }))
        .mockResolvedValueOnce(json(workspacePage([{ uuid: "impossible" }], 0)))
    );
    const result = await fetchUsage("admin-key");
    expect(result.externalBillingSyncs?.map((sync) => sync.source)).not.toContain(
      "mistral-workspace-usage"
    );
    expect(result.rawData).toMatchObject({
      workspaceCoverage: {
        enumerationComplete: false,
        enumerated: 0,
        complete: false,
      },
    });
  });

  it("keeps non-USD usage metadata but rejects non-USD caps and wrong UTC-month windows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ ...currentUsage(), currency: "EUR" }))
        .mockResolvedValueOnce(json({ limits: { completion: { usage_limit: 100 }, currency: "EUR" } }))
        .mockResolvedValueOnce(json({ requests_per_second: 5 }))
        .mockResolvedValueOnce(json(workspacePage([])))
    );
    const wrongCurrency = await fetchUsage("admin-key");
    expect(wrongCurrency.totalCost).toBeNull();
    expect(wrongCurrency.externalBillingSyncs?.find((sync) => sync.source === "mistral-usage-billing")?.records[0])
      .toMatchObject({ amountUsd: null, currency: "EUR" });
    expect(wrongCurrency.externalBillingSyncs?.find((sync) => sync.source === "mistral-spend-limits")?.records[0].spendLimitUsd)
      .toBeNull();

    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(json({ ...currentUsage(), start_date: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString() }))
        .mockResolvedValueOnce(json({ limits: { completion: { usage_limit: 100 }, currency: "USD" } }))
        .mockResolvedValueOnce(json({ requests_per_second: 5 }))
        .mockResolvedValueOnce(json(workspacePage([])))
    );
    const wrongWindow = await fetchUsage("admin-key");
    expect(wrongWindow.totalCost).toBeNull();
    expect(wrongWindow.externalBillingSyncs?.map((sync) => sync.source)).not.toContain(
      "mistral-usage-billing"
    );
    expect(wrongWindow.totalCost).not.toBe(0);
  });
});
