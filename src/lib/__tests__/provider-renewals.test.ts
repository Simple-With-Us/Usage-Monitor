import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

let testDir: string;
let prisma: typeof import("@/lib/prisma").prisma;
let rollForwardProviderRenewals: typeof import("../provider-renewals").rollForwardProviderRenewals;

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-renewals-test-"));
  const dbPath = path.join(testDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
  ({ rollForwardProviderRenewals } = await import("../provider-renewals"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.providerPlan.deleteMany();
  await prisma.provider.deleteMany();
});

describe("rollForwardProviderRenewals", () => {
  it("increments the provider alert revision in the same renewal transaction", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "renewal-revision",
        displayName: "Renewal Revision",
        plan: {
          create: {
            renewalDate: new Date("2026-06-01T00:00:00.000Z"),
            billingInterval: "monthly",
          },
        },
      },
    });

    await expect(
      rollForwardProviderRenewals(new Date("2026-07-14T00:00:00.000Z"))
    ).resolves.toEqual({ examined: 1, advanced: 1 });

    const stored = await prisma.provider.findUniqueOrThrow({
      where: { id: provider.id },
      include: { plan: true },
    });
    expect(stored.alertConfigGeneration).toBe(1);
    expect(stored.plan?.renewalDate).toEqual(
      new Date("2026-08-01T00:00:00.000Z")
    );

    await expect(
      rollForwardProviderRenewals(new Date("2026-07-14T00:00:00.000Z"))
    ).resolves.toEqual({ examined: 0, advanced: 0 });
    expect(
      (
        await prisma.provider.findUniqueOrThrow({
          where: { id: provider.id },
        })
      ).alertConfigGeneration
    ).toBe(1);
  });
});
