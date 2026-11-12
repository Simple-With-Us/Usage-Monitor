import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../github";

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("github billing adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("syncs canonical enhanced-billing spend, budget caps, and Copilot breakdowns without double counting", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) {
        return response({
          usageItems: [
            { product: "Actions", sku: "Linux", netQuantity: 10, unitType: "minutes", netAmount: 1.25 },
            { product: "Packages", sku: "Storage", netQuantity: 2, unitType: "GB", netAmount: 0.5 },
          ],
        });
      }
      if (input.includes("/budgets?")) {
        return response({
          budgets: [{
            id: "actions-cap",
            budget_type: "SkuPricing",
            budget_product_skus: ["actions_linux"],
            budget_scope: "organization",
            budget_amount: 50,
            prevent_further_usage: true,
            budget_alerting: { will_alert: true, alert_recipients: ["billing-manager"] },
          }],
          has_next_page: false,
          total_count: 1,
        });
      }
      if (input.includes("/ai_credit/usage?")) {
        return response({
          usageItems: [{ product: "Copilot", sku: "AI Credits", model: "GPT-5", netQuantity: 40, unitType: "credits", netAmount: 0.4 }],
        });
      }
      if (input.includes("/premium_request/usage?")) {
        return response({
          usageItems: [{ product: "Copilot", sku: "Premium Request", model: "GPT-5", netQuantity: 10, unitType: "requests", netAmount: 0.4 }],
        });
      }
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { org: "Acme" });

    expect(result.totalCost).toBe(1.75);
    expect(result.externalBilling).toBeUndefined();
    expect(result.externalBillingSyncs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "github-enhanced-billing", authoritative: true }),
        expect.objectContaining({ source: "github-enhanced-billing-budgets", authoritative: true }),
        expect.objectContaining({ source: "github-enhanced-billing-ai-credits", authoritative: true }),
        expect.objectContaining({ source: "github-enhanced-billing-premium-requests", authoritative: true }),
      ])
    );
    const usage = result.externalBillingSyncs?.find((sync) => sync.source === "github-enhanced-billing");
    expect(usage?.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "billing_period", amountUsd: 1.75, rollupRole: "canonical" }),
      expect.objectContaining({ serviceName: "Actions", planName: "Linux", amountUsd: 1.25, rollupRole: "component" }),
    ]));
    const budget = result.externalBillingSyncs?.find((sync) => sync.source === "github-enhanced-billing-budgets");
    expect(budget?.records).toEqual([expect.objectContaining({
      externalId: "actions-cap",
      spendLimitUsd: 50,
      rollupRole: "metadata",
      status: "enforced",
    })]);
    const ai = result.externalBillingSyncs?.find((sync) => sync.source === "github-enhanced-billing-ai-credits");
    expect(ai?.records[0]).toMatchObject({ amountUsd: 0.4, rollupRole: "component" });
    expect((result.rawData as { capabilities: { planSubscription: string } }).capabilities.planSubscription).toBe("not_exposed");
    expect(fetchMock.mock.calls[0][0]).toContain("/organizations/Acme/settings/billing/usage/summary?");
  });

  it("uses the detailed report only as a safe fallback and preserves unavailable optional surfaces explicitly", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) return response({ message: "preview unavailable" }, 404);
      if (input.includes("/budgets?")) return response({ message: "forbidden" }, 403);
      if (input.includes("/ai_credit/usage?")) return response({ message: "not found" }, 404);
      if (input.includes("/premium_request/usage?")) return response({ message: "unavailable" }, 503);
      if (input.includes("/usage?")) {
        return response({
          usageItems: [{ product: "Actions", sku: "Linux", quantity: 10, netAmount: 1.25, repositoryName: "private/repo" }],
        });
      }
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { org: "Acme" });

    expect(result.totalCost).toBe(1.25);
    expect(result.externalBillingSyncs).toHaveLength(1);
    expect(JSON.stringify(result.rawData)).not.toContain("private/repo");
    const capabilities = (result.rawData as {
      billing: { source: string };
      capabilities: { budgets: { status: string }; aiCredits: { status: string }; premiumRequests: { status: string } };
    }).capabilities;
    expect((result.rawData as { billing: { source: string } }).billing.source).toBe("detailed_report_fallback");
    expect(capabilities.budgets.status).toBe("permission_unavailable");
    expect(capabilities.aiCredits.status).toBe("not_available");
    expect(capabilities.premiumRequests.status).toBe("upstream_unavailable");
  });

  it("uses the personal-account endpoint when configured", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) return response({ usageItems: [] });
      if (input.includes("/ai_credit/usage?")) return response({ usageItems: [] });
      if (input.includes("/premium_request/usage?")) return response({ usageItems: [] });
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { accountType: "user", account: "jay" });

    expect(result.totalCost).toBe(0);
    expect(fetchMock.mock.calls[0][0]).toContain("/users/jay/settings/billing/usage/summary?");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/budgets?"))).toBe(false);
    expect((result.rawData as { capabilities: { budgets: { status: string } } }).capabilities.budgets.status).toBe("not_exposed");
  });

  it("uses the configured GHE.com API origin for an enterprise boundary", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) return response({ usageItems: [] });
      if (input.includes("/budgets?")) return response({ budgets: [], has_next_page: false, total_count: 0 });
      if (input.includes("/ai_credit/usage?")) return response({ usageItems: [] });
      if (input.includes("/premium_request/usage?")) return response({ usageItems: [] });
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchUsage("token", {
      accountType: "enterprise",
      account: "octo-enterprise",
      apiOrigin: "https://api.octo.ghe.com",
    });

    expect(fetchMock.mock.calls[0][0]).toContain("https://api.octo.ghe.com/enterprises/octo-enterprise/settings/billing/usage/summary?");
  });

  it("never falls back to the incomplete enterprise detailed report", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) return response({ message: "unavailable" }, 404);
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchUsage("token", {
      accountType: "enterprise",
      account: "octo-enterprise",
    })).rejects.toMatchObject({ code: "HTTP_ERROR", status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/usage?"))).toBe(false);
  });

  it("preserves retryable transport failures when summary and fallback both fail", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("DNS unavailable"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchUsage("token", { org: "Acme" })).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
      status: null,
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves a retryable summary transport failure when the fallback is unavailable", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) throw new Error("DNS unavailable");
      if (input.includes("/usage?")) return response({ message: "not found" }, 404);
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchUsage("token", { org: "Acme" })).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
      status: null,
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves a retryable summary 5xx when the fallback is forbidden", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) {
        return new Response(JSON.stringify({ message: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      }
      if (input.includes("/usage?")) return response({ message: "forbidden" }, 403);
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchUsage("token", { org: "Acme" })).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 503,
      retryable: true,
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/usage?"))).toBe(true);
  });

  it("keeps canonical usage when an optional Copilot response is malformed", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) return response({ usageItems: [] });
      if (input.includes("/budgets?")) return response({ budgets: [], has_next_page: false, total_count: 0 });
      if (input.includes("/ai_credit/usage?")) return response({ unexpected: true });
      if (input.includes("/premium_request/usage?")) return response({ usageItems: [] });
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { org: "Acme" });

    expect(result.totalCost).toBe(0);
    expect(result.externalBillingSyncs?.some((sync) => sync.source === "github-enhanced-billing-ai-credits")).toBe(false);
    expect((result.rawData as { capabilities: { aiCredits: { status: string; errorCode: string } } }).capabilities.aiCredits).toMatchObject({
      status: "error",
      errorCode: "INVALID_RESPONSE",
    });
  });

  it("keeps canonical usage when an optional budget record is malformed", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) return response({ usageItems: [] });
      if (input.includes("/budgets?")) return response({
        budgets: [{ budget_type: "SkuPricing", budget_amount: 50 }],
        has_next_page: false,
        total_count: 1,
      });
      if (input.includes("/ai_credit/usage?")) return response({ usageItems: [] });
      if (input.includes("/premium_request/usage?")) return response({ usageItems: [] });
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { org: "Acme" });

    expect(result.totalCost).toBe(0);
    expect(result.externalBillingSyncs?.some((sync) => sync.source === "github-enhanced-billing-budgets")).toBe(false);
    expect((result.rawData as { capabilities: { budgets: { status: string; errorCode: string } } }).capabilities.budgets).toMatchObject({
      status: "error",
      errorCode: "INVALID_RESPONSE",
    });
  });

  it("preserves license and unknown budget units as metadata instead of requests or USD", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) return response({ usageItems: [] });
      if (input.includes("/budgets?")) return response({
        budgets: [
          {
            id: "copilot-license-cap",
            budget_type: "SkuPricing",
            budget_product_skus: ["copilot_enterprise"],
            budget_scope: "organization",
            budget_amount: 25,
            prevent_further_usage: true,
            budget_alerting: { will_alert: true, alert_recipients: [] },
          },
          {
            id: "future-unit-cap",
            budget_type: "SkuPricing",
            budget_product_skus: ["future_provider_unit"],
            budget_scope: "organization",
            budget_amount: 7,
            prevent_further_usage: true,
            budget_alerting: { will_alert: false, alert_recipients: [] },
          },
        ],
        has_next_page: false,
        total_count: 2,
      });
      if (input.includes("/ai_credit/usage?")) return response({ usageItems: [] });
      if (input.includes("/premium_request/usage?")) return response({ usageItems: [] });
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { org: "Acme" });
    const budgets = result.externalBillingSyncs?.find(
      (sync) => sync.source === "github-enhanced-billing-budgets"
    )?.records;
    const licenseBudget = budgets?.find((record) => record.externalId === "copilot-license-cap");
    const unknownBudget = budgets?.find((record) => record.externalId === "future-unit-cap");

    expect(licenseBudget).toMatchObject({
      currency: null,
      spendLimitUsd: null,
      requestLimit: null,
      requestLimitWindow: null,
      status: "active",
    });
    expect(licenseBudget?.planName).toContain("25 licenses");
    expect(unknownBudget).toMatchObject({
      currency: null,
      spendLimitUsd: null,
      requestLimit: null,
      requestLimitWindow: null,
      status: "active",
    });
    expect(unknownBudget?.planName).toContain("7 provider-defined units");
  });

  it("accepts GitHub's enterprise multi_user_cost_center budget scope", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) return response({ usageItems: [] });
      if (input.includes("/budgets?")) return response({
        budgets: [{
          id: "cost-center-ai-cap",
          budget_type: "BundlePricing",
          budget_product_skus: ["ai_credits"],
          budget_scope: "multi_user_cost_center",
          budget_amount: 30,
          prevent_further_usage: true,
          budget_alerting: { will_alert: true, alert_recipients: [] },
        }],
        has_next_page: false,
        total_count: 1,
      });
      if (input.includes("/ai_credit/usage?")) return response({ usageItems: [] });
      if (input.includes("/premium_request/usage?")) return response({ usageItems: [] });
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", {
      accountType: "enterprise",
      account: "octo-enterprise",
    });
    const budget = result.externalBillingSyncs?.find(
      (sync) => sync.source === "github-enhanced-billing-budgets"
    )?.records[0];

    expect(budget).toMatchObject({
      serviceName: "GitHub multi_user_cost_center budget",
      spendLimitUsd: 30,
      status: "enforced",
    });
  });

  it("classifies every newly documented metered product/SKU family as USD", async () => {
    const identifiers = [
      ["sandbox-product", "ProductPricing", "sandbox"],
      ["sandbox-sku", "SkuPricing", "sandbox_memory"],
      ["models", "SkuPricing", "models_inference"],
      ["copilot-ai", "SkuPricing", "copilot_ai_credits"],
      ["spark-ai", "SkuPricing", "spark_ai_credits"],
    ] as const;
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) return response({ usageItems: [] });
      if (input.includes("/budgets?")) return response({
        budgets: identifiers.map(([id, budgetType, sku]) => ({
          id,
          budget_type: budgetType,
          budget_product_skus: [sku],
          budget_scope: "organization",
          budget_amount: 10,
          prevent_further_usage: true,
          budget_alerting: { will_alert: false, alert_recipients: [] },
        })),
        has_next_page: false,
        total_count: identifiers.length,
      });
      if (input.includes("/ai_credit/usage?")) return response({ usageItems: [] });
      if (input.includes("/premium_request/usage?")) return response({ usageItems: [] });
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { org: "Acme" });
    const budgets = result.externalBillingSyncs?.find(
      (sync) => sync.source === "github-enhanced-billing-budgets"
    )?.records;

    expect(budgets).toHaveLength(identifiers.length);
    expect(budgets?.every((budget) => budget.spendLimitUsd === 10 && budget.currency === "USD")).toBe(true);
  });

  it("never marks a product-level GHAS budget enforced but allows exact GHAS SKU enforcement", async () => {
    const identifiers = [
      ["ghas-product", "ProductPricing", "ghas"],
      ["ghas-code-security", "SkuPricing", "ghas_code_security_licenses"],
      ["ghas-legacy", "SkuPricing", "ghas_licenses"],
      ["ghas-secret-protection", "SkuPricing", "ghas_secret_protection_licenses"],
    ] as const;
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) return response({ usageItems: [] });
      if (input.includes("/budgets?")) return response({
        budgets: identifiers.map(([id, budgetType, sku]) => ({
          id,
          budget_type: budgetType,
          budget_product_skus: [sku],
          budget_scope: "organization",
          budget_amount: 10,
          prevent_further_usage: true,
          budget_alerting: { will_alert: false, alert_recipients: [] },
        })),
        has_next_page: false,
        total_count: identifiers.length,
      });
      if (input.includes("/ai_credit/usage?")) return response({ usageItems: [] });
      if (input.includes("/premium_request/usage?")) return response({ usageItems: [] });
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { org: "Acme" });
    const budgets = result.externalBillingSyncs?.find(
      (sync) => sync.source === "github-enhanced-billing-budgets"
    )?.records;

    expect(budgets?.find((budget) => budget.externalId === "ghas-product")?.status).toBe("active");
    expect(budgets?.filter((budget) => budget.externalId !== "ghas-product"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ externalId: "ghas-code-security", status: "enforced" }),
        expect.objectContaining({ externalId: "ghas-legacy", status: "enforced" }),
        expect.objectContaining({ externalId: "ghas-secret-protection", status: "enforced" }),
      ]));
  });

  it.each([undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid budget total_count (%s)",
    async (totalCount) => {
      const fetchMock = vi.fn(async (input: string) => {
        if (input.includes("/usage/summary?")) return response({ usageItems: [] });
        if (input.includes("/budgets?")) return response({
          budgets: [],
          has_next_page: false,
          total_count: totalCount,
        });
        if (input.includes("/ai_credit/usage?")) return response({ usageItems: [] });
        if (input.includes("/premium_request/usage?")) return response({ usageItems: [] });
        throw new Error(`unexpected URL: ${input}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchUsage("token", { org: "Acme" });

      expect(result.externalBillingSyncs?.some(
        (sync) => sync.source === "github-enhanced-billing-budgets"
      )).toBe(false);
      expect((result.rawData as {
        capabilities: { budgets: { status: string; errorCode: string } };
      }).capabilities.budgets).toMatchObject({ status: "error", errorCode: "INVALID_RESPONSE" });
    }
  );

  it.each(["changes between pages", "does not match the final collection"])(
    "rejects authoritative budget sync when total_count %s",
    async (failureMode) => {
      const fetchMock = vi.fn(async (input: string) => {
        if (input.includes("/usage/summary?")) return response({ usageItems: [] });
        if (input.includes("/budgets?") && new URL(input).searchParams.get("page") === "1") return response({
          budgets: [],
          has_next_page: failureMode === "changes between pages",
          total_count: 1,
        });
        if (input.includes("/budgets?") && new URL(input).searchParams.get("page") === "2") return response({
          budgets: [],
          has_next_page: false,
          total_count: 2,
        });
        if (input.includes("/ai_credit/usage?")) return response({ usageItems: [] });
        if (input.includes("/premium_request/usage?")) return response({ usageItems: [] });
        throw new Error(`unexpected URL: ${input}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await fetchUsage("token", { org: "Acme" });

      expect(result.externalBillingSyncs?.some(
        (sync) => sync.source === "github-enhanced-billing-budgets"
      )).toBe(false);
      expect((result.rawData as {
        capabilities: { budgets: { status: string; errorCode: string } };
      }).capabilities.budgets).toMatchObject({ status: "error", errorCode: "INVALID_RESPONSE" });
    }
  );

  it("accepts a complete paginated budget collection with a stable total_count", async () => {
    const budget = (id: string) => ({
      id,
      budget_type: "SkuPricing",
      budget_product_skus: ["actions_linux"],
      budget_scope: "organization",
      budget_amount: 50,
      prevent_further_usage: true,
      budget_alerting: { will_alert: false, alert_recipients: [] },
    });
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) return response({ usageItems: [] });
      if (input.includes("/budgets?") && new URL(input).searchParams.get("page") === "1") return response({
        budgets: [budget("first")],
        has_next_page: true,
        total_count: 2,
      });
      if (input.includes("/budgets?") && new URL(input).searchParams.get("page") === "2") return response({
        budgets: [budget("second")],
        has_next_page: false,
        total_count: 2,
      });
      if (input.includes("/ai_credit/usage?")) return response({ usageItems: [] });
      if (input.includes("/premium_request/usage?")) return response({ usageItems: [] });
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { org: "Acme" });
    const sync = result.externalBillingSyncs?.find(
      (candidate) => candidate.source === "github-enhanced-billing-budgets"
    );

    expect(sync).toMatchObject({ authoritative: true });
    expect(sync?.records.map((record) => record.externalId)).toEqual(["first", "second"]);
  });

  it.each([
    ["type", { budget_type: "" }],
    ["scope", { budget_scope: "" }],
    ["enforcement", { prevent_further_usage: undefined }],
    ["amount", { budget_amount: -1 }],
    ["alerting", { budget_alerting: { will_alert: true } }],
  ])("rejects a partially invalid budget collection with missing %s", async (_field, override) => {
    const validBudget = {
      id: "valid-actions-cap",
      budget_type: "SkuPricing",
      budget_product_skus: ["actions_linux"],
      budget_scope: "organization",
      budget_amount: 50,
      prevent_further_usage: true,
      budget_alerting: { will_alert: true, alert_recipients: [] },
    };
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("/usage/summary?")) return response({ usageItems: [] });
      if (input.includes("/budgets?")) return response({
        budgets: [validBudget, { ...validBudget, id: "invalid", ...override }],
        has_next_page: false,
        total_count: 2,
      });
      if (input.includes("/ai_credit/usage?")) return response({ usageItems: [] });
      if (input.includes("/premium_request/usage?")) return response({ usageItems: [] });
      throw new Error(`unexpected URL: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("token", { org: "Acme" });

    expect(result.totalCost).toBe(0);
    expect(result.externalBillingSyncs?.some(
      (sync) => sync.source === "github-enhanced-billing-budgets"
    )).toBe(false);
    expect((result.rawData as {
      capabilities: { budgets: { status: string; errorCode: string } };
    }).capabilities.budgets).toMatchObject({
      status: "error",
      errorCode: "INVALID_RESPONSE",
    });
  });

  it("fails closed when the canonical usage response omits usageItems", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({}))
    );

    await expect(fetchUsage("token", { org: "Acme" })).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});
