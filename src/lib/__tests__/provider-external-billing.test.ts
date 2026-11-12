import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";
import { fetchUsage as fetchFirecrawlUsage } from "../adapters/firecrawl";
import { fetchUsage as fetchOpenAiUsage } from "../adapters/openai";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let reconcileProviderExternalBilling: typeof import("../provider-external-billing").reconcileProviderExternalBilling;
let providerId: string;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openAiCostsPage(value: number, fields: Record<string, unknown> = {}) {
  return {
    object: "page",
    data: [{
      object: "bucket",
      start_time: 1782864000,
      end_time: 1782950400,
      results: [{
        object: "organization.costs.result",
        amount: { value, currency: "usd" },
        ...fields,
      }],
    }],
    has_more: false,
    next_page: null,
  };
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "external-billing-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({ reconcileProviderExternalBilling } = await import("../provider-external-billing"));
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await prisma.providerExternalBilling.deleteMany();
  await prisma.provider.deleteMany();
  const provider = await prisma.provider.create({
    data: {
      name: "cloudflare",
      displayName: "Cloudflare",
      type: "builtin",
    },
  });
  providerId = provider.id;
});

describe("reconcileProviderExternalBilling", () => {
  it("does not infer paid-recurring authority from collection completeness", async () => {
    await reconcileProviderExternalBilling(providerId, {
      source: "complete-plan-list",
      authoritative: true,
      records: [
        {
          externalId: "plan-without-charge-attestation",
          kind: "subscription",
          status: "active",
          amountUsd: 5,
          currency: "USD",
          billingInterval: "monthly",
          currentPeriodStart: "2026-07-01T00:00:00.000Z",
          currentPeriodEnd: "2026-08-01T00:00:00.000Z",
          rollupRole: "canonical",
          dateKind: "renewal",
        },
      ],
    });

    expect(await prisma.providerExternalBilling.findFirst()).toMatchObject({
      paidRecurringAuthoritative: false,
    });
  });

  it("is idempotent and never creates a charge-producing Subscription", async () => {
    const sync = {
      source: "cloudflare-subscriptions",
      authoritative: true,
      records: [
        {
          externalId: "sub_1",
          paidRecurringAuthoritative: true,
          kind: "subscription" as const,
          serviceName: "Cloudflare Workers",
          planName: "Workers Paid",
          status: "active",
          amountUsd: 5,
          currency: "usd",
          billingInterval: "monthly",
          currentPeriodStart: "2026-07-01T00:00:00.000Z",
          currentPeriodEnd: "2026-08-01T00:00:00.000Z",
          nextRenewalAt: "2026-08-01T00:00:00.000Z",
          usageQuantity: 2_500_000,
          remainingQuantity: 7_500_000,
          usageUnit: "requests",
          rollupRole: "canonical" as const,
          dateKind: "renewal" as const,
        },
      ],
    };

    await reconcileProviderExternalBilling(providerId, sync);
    await reconcileProviderExternalBilling(providerId, sync);

    expect(await prisma.providerExternalBilling.count()).toBe(1);
    expect(await prisma.subscription.count()).toBe(0);
    expect(await prisma.providerExternalBilling.findFirst()).toMatchObject({
      source: "cloudflare-subscriptions",
      externalId: "sub_1",
      paidRecurringAuthoritative: true,
      serviceName: "Cloudflare Workers",
      planName: "Workers Paid",
      currency: "USD",
      usageQuantity: 2_500_000,
      remainingQuantity: 7_500_000,
      usageUnit: "requests",
      rollupRole: "canonical",
      dateKind: "renewal",
    });
  });

  it("prunes missing rows only for a complete authoritative sync", async () => {
    await reconcileProviderExternalBilling(providerId, {
      source: "cloudflare-subscriptions",
      authoritative: true,
      records: [
        { externalId: "sub_1", kind: "subscription" },
        { externalId: "sub_2", kind: "subscription" },
      ],
    });

    await reconcileProviderExternalBilling(providerId, {
      source: "cloudflare-subscriptions",
      authoritative: true,
      records: [{ externalId: "sub_2", kind: "subscription", status: "canceled" }],
    });

    const rows = await prisma.providerExternalBilling.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: "sub_2", status: "canceled" });
  });

  it("replaces stale Google pending identities after a complete empty query", async () => {
    await reconcileProviderExternalBilling(providerId, {
      source: "google-cloud-billing-export",
      authoritative: false,
      records: [
        {
          externalId: "gemini-mtd:unattributed",
          kind: "billing_period",
          serviceName: "Gemini API",
          status: "pending",
          amountUsd: null,
        },
        {
          externalId: "gemini-sku:unattributed:sku-old:requests",
          kind: "billing_period",
          serviceName: "Gemini API",
          status: "active",
          amountUsd: 4.25,
        },
      ],
    });

    await reconcileProviderExternalBilling(providerId, {
      source: "google-cloud-billing-export",
      authoritative: true,
      records: [
        {
          externalId: "gemini-mtd:gen-lang-client-0280782620",
          kind: "billing_period",
          serviceName: "Gemini API",
          planName: "Cloud Billing export",
          status: "pending",
          amountUsd: null,
        },
      ],
    });

    expect(await prisma.providerExternalBilling.findMany()).toEqual([
      expect.objectContaining({
        source: "google-cloud-billing-export",
        externalId: "gemini-mtd:gen-lang-client-0280782620",
        status: "pending",
        amountUsd: null,
      }),
    ]);
  });

  it("preserves prior Google rows while export table discovery is incomplete", async () => {
    await reconcileProviderExternalBilling(providerId, {
      source: "google-cloud-billing-export",
      authoritative: true,
      records: [
        {
          externalId: "gemini-mtd:project-a",
          kind: "billing_period",
          serviceName: "Gemini API",
          status: "active",
          amountUsd: 8.25,
        },
      ],
    });

    await reconcileProviderExternalBilling(providerId, {
      source: "google-cloud-billing-export",
      authoritative: false,
      records: [
        {
          externalId: "gemini-mtd:pending",
          kind: "billing_period",
          serviceName: "Gemini API",
          status: "pending",
          amountUsd: null,
        },
      ],
    });

    expect(
      (await prisma.providerExternalBilling.findMany({
        orderBy: { externalId: "asc" },
      })).map((row) => ({
        externalId: row.externalId,
        status: row.status,
        amountUsd: row.amountUsd,
        paidRecurringAuthoritative: row.paidRecurringAuthoritative,
      }))
    ).toEqual([
      {
        externalId: "gemini-mtd:pending",
        status: "pending",
        amountUsd: null,
        paidRecurringAuthoritative: false,
      },
      {
        externalId: "gemini-mtd:project-a",
        status: "active",
        amountUsd: 8.25,
        paidRecurringAuthoritative: false,
      },
    ]);
  });

  it("preserves a prior Gemini request total through an empty query and updates on later data", async () => {
    await reconcileProviderExternalBilling(providerId, {
      source: "google-cloud-monitoring-requests",
      authoritative: true,
      records: [
        {
          externalId: "gemini-requests-mtd",
          kind: "account",
          serviceName: "Gemini API aggregate requests",
          planName: "Service Runtime aggregate fallback",
          status: "active",
          currentPeriodStart: "2026-07-01T00:00:00.000Z",
          currentPeriodEnd: "2026-07-13T20:00:00.000Z",
          usageQuantity: 12,
          usageUnit: "requests",
          rollupRole: "metadata",
          dateKind: "report_through",
        },
      ],
    });

    await reconcileProviderExternalBilling(providerId, {
      source: "google-cloud-monitoring-requests",
      authoritative: false,
      records: [],
    });

    expect(
      await prisma.providerExternalBilling.findUnique({
        where: {
          providerId_source_externalId: {
            providerId,
            source: "google-cloud-monitoring-requests",
            externalId: "gemini-requests-mtd",
          },
        },
      })
    ).toMatchObject({
      usageQuantity: 12,
      currentPeriodEnd: new Date("2026-07-13T20:00:00.000Z"),
    });

    await reconcileProviderExternalBilling(providerId, {
      source: "google-cloud-monitoring-requests",
      authoritative: true,
      records: [
        {
          externalId: "gemini-requests-mtd",
          kind: "account",
          serviceName: "Gemini API aggregate requests",
          planName: "Service Runtime aggregate fallback",
          status: "active",
          currentPeriodStart: "2026-07-01T00:00:00.000Z",
          currentPeriodEnd: "2026-07-13T20:05:00.000Z",
          usageQuantity: 19,
          usageUnit: "requests",
          rollupRole: "metadata",
          dateKind: "report_through",
        },
      ],
    });

    expect(
      await prisma.providerExternalBilling.findUnique({
        where: {
          providerId_source_externalId: {
            providerId,
            source: "google-cloud-monitoring-requests",
            externalId: "gemini-requests-mtd",
          },
        },
      })
    ).toMatchObject({
      usageQuantity: 19,
      currentPeriodEnd: new Date("2026-07-13T20:05:00.000Z"),
    });
  });

  it("does not prune persisted Firecrawl history when the optional response is invalid", async () => {
    await reconcileProviderExternalBilling(providerId, {
      source: "firecrawl-team-credit-history",
      authoritative: true,
      records: [
        {
          externalId:
            "credit-history:2026-06-01T00:00:00.000Z:2026-07-01T00:00:00.000Z",
          kind: "billing_period",
          serviceName: "Firecrawl API credit usage",
          currentPeriodStart: "2026-06-01T00:00:00.000Z",
          currentPeriodEnd: "2026-07-01T00:00:00.000Z",
          usageQuantity: 321,
          usageUnit: "credits",
          rollupRole: "metadata",
          dateKind: "report_through",
        },
      ],
    });

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            data: {
              remainingCredits: 700,
              planCredits: 1_000,
              billingPeriodStart: "2026-07-01T00:00:00Z",
              billingPeriodEnd: "2026-08-01T00:00:00Z",
            },
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            success: true,
            periods: [
              {
                startDate: "2026-07-01T00:00:00Z",
                endDate: "invalid",
                totalCredits: 100,
              },
            ],
          })
        )
    );

    const result = await fetchFirecrawlUsage("test-key");
    expect(result.externalBillingSyncs).toBeUndefined();
    await reconcileProviderExternalBilling(providerId, result.externalBilling!);

    expect(
      await prisma.providerExternalBilling.findMany({
        where: { source: "firecrawl-team-credit-history" },
      })
    ).toEqual([
      expect.objectContaining({
        externalId:
          "credit-history:2026-06-01T00:00:00.000Z:2026-07-01T00:00:00.000Z",
        usageQuantity: 321,
      }),
    ]);
  });

  it("does not prune persisted OpenAI project components when a malformed detail page is not authoritative", async () => {
    await reconcileProviderExternalBilling(providerId, {
      source: "openai-organization-costs-projects",
      authoritative: true,
      records: [{
        externalId: "2026-07:project_id:proj_existing",
        kind: "billing_period",
        serviceName: "OpenAI project: proj_existing",
        amountUsd: 4,
        currency: "USD",
        rollupRole: "component",
      }],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/organization/costs") {
          if (url.searchParams.get("group_by") === "project_id") {
            const malformed = openAiCostsPage(8, { project_id: "proj_new" }) as Record<string, unknown>;
            delete malformed.has_more;
            return Promise.resolve(jsonResponse(malformed));
          }
          if (url.searchParams.get("group_by") === "line_item") {
            return Promise.resolve(
              jsonResponse(openAiCostsPage(8, { line_item: "completions", quantity: 12 }))
            );
          }
          if (url.searchParams.get("group_by") === "api_key_id") {
            return Promise.resolve(jsonResponse(openAiCostsPage(8, { api_key_id: "key_new" })));
          }
          return Promise.resolve(jsonResponse(openAiCostsPage(8)));
        }
        return Promise.resolve(jsonResponse({}));
      })
    );

    const result = await fetchOpenAiUsage("test-key", { adminApiKey: "admin-key" });
    expect(result.externalBillingSyncs?.map((sync) => sync.source)).toEqual([
      "openai-organization-costs-line-items",
      "openai-organization-costs-api-keys",
    ]);
    for (const sync of result.externalBillingSyncs ?? []) {
      await reconcileProviderExternalBilling(providerId, sync);
    }

    expect(
      await prisma.providerExternalBilling.findMany({
        where: { source: "openai-organization-costs-projects" },
      })
    ).toEqual([
      expect.objectContaining({
        externalId: "2026-07:project_id:proj_existing",
        amountUsd: 4,
      }),
    ]);
  });

  it("does not prune persisted OpenAI API-key-ID components when a malformed detail page is not authoritative", async () => {
    await reconcileProviderExternalBilling(providerId, {
      source: "openai-organization-costs-api-keys",
      authoritative: true,
      records: [{
        externalId: "2026-07:api_key_id:key_existing",
        kind: "billing_period",
        serviceName: "OpenAI API key ID: key_existing",
        amountUsd: 4,
        currency: "USD",
        rollupRole: "component",
      }],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/organization/costs") {
          if (url.searchParams.get("group_by") === "project_id") {
            return Promise.resolve(jsonResponse(openAiCostsPage(8, { project_id: "proj_new" })));
          }
          if (url.searchParams.get("group_by") === "line_item") {
            return Promise.resolve(
              jsonResponse(openAiCostsPage(8, { line_item: "completions", quantity: 12 }))
            );
          }
          if (url.searchParams.get("group_by") === "api_key_id") {
            const malformed = openAiCostsPage(8, { api_key_id: "key_new" }) as Record<string, unknown>;
            malformed.has_more = "false";
            return Promise.resolve(jsonResponse(malformed));
          }
          return Promise.resolve(jsonResponse(openAiCostsPage(8)));
        }
        return Promise.resolve(jsonResponse({}));
      })
    );

    const result = await fetchOpenAiUsage("test-key", { adminApiKey: "admin-key" });
    expect(result.externalBillingSyncs?.map((sync) => sync.source)).toEqual([
      "openai-organization-costs-projects",
      "openai-organization-costs-line-items",
    ]);
    for (const sync of result.externalBillingSyncs ?? []) {
      await reconcileProviderExternalBilling(providerId, sync);
    }

    expect(
      await prisma.providerExternalBilling.findMany({
        where: { source: "openai-organization-costs-api-keys" },
      })
    ).toEqual([
      expect.objectContaining({
        externalId: "2026-07:api_key_id:key_existing",
        amountUsd: 4,
      }),
    ]);
  });
});
