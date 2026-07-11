import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let reconcileProviderExternalBilling: typeof import("../provider-external-billing").reconcileProviderExternalBilling;
let providerId: string;

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
  it("is idempotent and never creates a charge-producing Subscription", async () => {
    const sync = {
      source: "cloudflare-subscriptions",
      authoritative: true,
      records: [
        {
          externalId: "sub_1",
          kind: "subscription" as const,
          planName: "Workers Paid",
          status: "active",
          amountUsd: 5,
          currency: "usd",
          billingInterval: "monthly",
          currentPeriodStart: "2026-07-01T00:00:00.000Z",
          currentPeriodEnd: "2026-08-01T00:00:00.000Z",
          nextRenewalAt: "2026-08-01T00:00:00.000Z",
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
      planName: "Workers Paid",
      currency: "USD",
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
});
