import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { initialCycle } from "../subscriptions";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let materializeDueSubscriptions: typeof import("../subscription-materializer").materializeDueSubscriptions;
let pauseGmailUnverifiedSeedSubscriptions: typeof import("../gmail-ledger-ghosts").pauseGmailUnverifiedSeedSubscriptions;

const NOW = new Date("2026-08-21T12:00:00.000Z");

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-ledger-ghosts-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
  ({ materializeDueSubscriptions } = await import("../subscription-materializer"));
  ({ pauseGmailUnverifiedSeedSubscriptions } = await import("../gmail-ledger-ghosts"));
}, 60_000);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await prisma.externalUsageEvent.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.provider.deleteMany();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
});

describe("pauseGmailUnverifiedSeedSubscriptions", () => {
  it("pauses the seeded Massive ghost and retracts its modeled charge", async () => {
    const provider = await prisma.provider.create({
      data: {
        name: "massive",
        displayName: "Massive",
        type: "builtin",
        refreshIntervalMin: 60,
      },
    });
    const cycle = initialCycle({
      startDate: new Date("2026-08-12T05:54:43.346Z"),
      interval: "monthly",
      intervalCount: 1,
      anchorDay: null,
    });
    const subscription = await prisma.subscription.create({
      data: {
        providerId: provider.id,
        name: "Stocks Starter",
        costUsd: 29,
        currency: "USD",
        interval: "monthly",
        intervalCount: 1,
        startDate: cycle.currentPeriodStart,
        currentPeriodStart: cycle.currentPeriodStart,
        nextRenewalAt: cycle.nextRenewalAt,
        autoRenew: true,
        status: "active",
        notes: "annual available $288/yr",
      },
    });
    await materializeDueSubscriptions(NOW);
    expect(await prisma.externalUsageEvent.count()).toBe(1);

    const result = await pauseGmailUnverifiedSeedSubscriptions();
    expect(result.paused).toBe(1);
    expect(result.retracted).toBe(1);

    const updated = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscription.id },
    });
    expect(updated.status).toBe("considering");
    expect(updated.autoRenew).toBe(false);
    expect(updated.lastChargedPeriodStart).toBeNull();
    expect(await prisma.externalUsageEvent.count()).toBe(0);

    const again = await pauseGmailUnverifiedSeedSubscriptions();
    expect(again.paused).toBe(0);
  });
});
