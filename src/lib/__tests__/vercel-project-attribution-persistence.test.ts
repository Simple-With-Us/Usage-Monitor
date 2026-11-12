import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchUsage } from "@/lib/adapters/vercel";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let reconcileProviderExternalBilling: typeof import("../provider-external-billing").reconcileProviderExternalBilling;
let providerId: string;

function focusResponse(rows: unknown[]): Response {
  return new Response(rows.map((row) => JSON.stringify(row)).join("\n"), {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vercel-project-detail-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({ reconcileProviderExternalBilling } = await import("../provider-external-billing"));
});

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
});

beforeEach(async () => {
  await prisma.providerExternalBilling.deleteMany();
  await prisma.provider.deleteMany();
  const provider = await prisma.provider.create({
    data: { name: "vercel", displayName: "Vercel", type: "builtin" },
  });
  providerId = provider.id;
});

describe("Vercel FOCUS project-attribution persistence", () => {
  it("does not prune a prior complete project breakdown when a later successful canonical response has incomplete Tags", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        focusResponse([
          {
            BilledCost: "2.50",
            BillingCurrency: "USD",
            ServiceName: "Functions",
            Tags: { ProjectId: "prj_congress", ProjectName: "Congress Trade" },
          },
        ])
      )
    );
    const complete = await fetchUsage("token");
    const projectSync = complete.externalBillingSyncs?.find(
      (sync) => sync.source === "vercel-focus-project-attribution"
    );
    expect(projectSync).toMatchObject({ authoritative: true });
    await reconcileProviderExternalBilling(providerId, complete.externalBilling!);
    await reconcileProviderExternalBilling(providerId, projectSync!);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        focusResponse([
          {
            BilledCost: "3.75",
            BillingCurrency: "USD",
            ServiceName: "Functions",
            Tags: { ProjectName: "Congress Trade" },
          },
        ])
      )
    );
    const incomplete = await fetchUsage("token");

    expect(incomplete.totalCost).toBe(3.75);
    expect(incomplete.externalBillingSyncs?.map((sync) => sync.source)).toEqual([
      "vercel-focus-service-detail",
    ]);
    await reconcileProviderExternalBilling(providerId, incomplete.externalBilling!);
    for (const sync of incomplete.externalBillingSyncs ?? []) {
      await reconcileProviderExternalBilling(providerId, sync);
    }

    expect(await prisma.providerExternalBilling.findMany({ orderBy: { source: "asc" } })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "vercel-focus-billing",
          amountUsd: 3.75,
          rollupRole: "canonical",
        }),
        expect.objectContaining({
          source: "vercel-focus-project-attribution",
          serviceName: "Congress Trade",
          amountUsd: 2.5,
          rollupRole: "component",
        }),
      ])
    );
  });

  it("does not prune a prior service breakdown when later FOCUS detail exceeds its cardinality bound", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        focusResponse([
          {
            BilledCost: "2.50",
            BillingCurrency: "USD",
            ServiceName: "Functions",
          },
        ])
      )
    );
    const complete = await fetchUsage("token");
    const serviceSync = complete.externalBillingSyncs?.find(
      (sync) => sync.source === "vercel-focus-service-detail"
    );
    expect(serviceSync).toMatchObject({ authoritative: true });
    await reconcileProviderExternalBilling(providerId, complete.externalBilling!);
    await reconcileProviderExternalBilling(providerId, serviceSync!);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        focusResponse(
          Array.from({ length: 251 }, (_, index) => ({
            BilledCost: "1",
            BillingCurrency: "USD",
            ServiceName: `Service ${index}`,
          }))
        )
      )
    );
    const suppressed = await fetchUsage("token");

    expect(suppressed.totalCost).toBe(251);
    expect(suppressed.externalBillingSyncs).toBeUndefined();
    await reconcileProviderExternalBilling(providerId, suppressed.externalBilling!);

    expect(await prisma.providerExternalBilling.findMany({ orderBy: { source: "asc" } })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "vercel-focus-billing",
          amountUsd: 251,
          rollupRole: "canonical",
        }),
        expect.objectContaining({
          source: "vercel-focus-service-detail",
          serviceName: "Functions",
          amountUsd: 2.5,
          rollupRole: "component",
        }),
      ])
    );
  });
});
