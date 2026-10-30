import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

describe("receipt authority across idempotent replay", () => {
  let directory: string;
  let prisma: typeof import("@/lib/prisma").prisma;
  let persist: typeof import("../external-usage-events").persistExternalUsageEvents;
  const event = {
    idempotencyKey: "receipt-authority-replay", sourceApp: "botfleet", provider: "anthropic",
    billingMode: "estimated" as const, metricType: "usage" as const,
    quantity: 10, unit: "token", occurredAt: new Date("2026-10-30T12:00:00Z"),
  };
  const metadata = (trusted: boolean) => ({
    model: "test-model", ...(trusted ? { _botFleetReceiptCredential: "botfleet-v1" } : {}),
  });

  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-authority-"));
    const database = path.join(directory, "test.db");
    process.env.DATABASE_URL = `file:${database}`;
    setupPrismaSqliteTestDb(database);
    ({ prisma } = await import("@/lib/prisma"));
    ({ persistExternalUsageEvents: persist } = await import("../external-usage-events"));
  }, 60_000);
  afterAll(async () => {
    await prisma?.$disconnect();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });
  beforeEach(async () => { await prisma.externalUsageEvent.deleteMany(); });

  it.each([false, true])("accepts replay while preserving original authority: trusted=%s", async (trusted) => {
    await persist([{ ...event, metadata: metadata(trusted) }]);
    const result = await persist([{ ...event, metadata: { ...metadata(!trusted), project: "example-project" } }]);
    expect(result.persisted).toBe(0);
    const stored = await prisma.externalUsageEvent.findUniqueOrThrow({ where: { idempotencyKey: event.idempotencyKey } });
    expect(stored.metadata).toEqual({ ...metadata(trusted), project: "example-project" });
    expect(await prisma.externalUsageEvent.count()).toBe(1);
  });

  it("still rejects a changed quantity across a credential rollout", async () => {
    await persist([{ ...event, metadata: metadata(false) }]);
    await expect(persist([{ ...event, quantity: 11, metadata: metadata(true) }]))
      .rejects.toMatchObject({ name: "ExternalUsageIdempotencyCollisionError" });
  });
});
