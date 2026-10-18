import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

// UM-1592: ingest now adds a canonical `_ai*` projection to AI event metadata.
// A row persisted before that projection existed has none, so a producer
// replaying the same event must dedupe instead of raising an idempotency
// collision.  Once both sides carry the projection it is compared as usual.
describe("ExternalUsageEvent canonical AI metadata replay (integration)", () => {
  let dbPath: string;
  let prisma: typeof import("@/lib/prisma").prisma;
  let persistExternalUsageEvents: typeof import("../external-usage-events").persistExternalUsageEvents;
  let ExternalUsageIdempotencyCollisionError: typeof import("../external-usage-events").ExternalUsageIdempotencyCollisionError;

  const occurredAt = new Date("2026-10-17T00:00:00.000Z");
  const base = {
    idempotencyKey: "canonical-ai-replay",
    sourceApp: "congress-trade",
    provider: "anthropic",
    billingMode: "actual",
    metricType: "usage",
    unit: "token",
    quantity: 150,
    occurredAt,
  };
  const legacy = { promptTokens: 100, completionTokens: 50 };
  const projected = { ...legacy, _aiTokensInput: 100, _aiTokensOutput: 50, _aiSource: "legacy" };

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-ai-test-"));
    dbPath = path.join(dir, "test.db");
    process.env.DATABASE_URL = `file:${dbPath}`;
    setupPrismaSqliteTestDb(dbPath);

    ({ prisma } = await import("@/lib/prisma"));
    ({ persistExternalUsageEvents, ExternalUsageIdempotencyCollisionError } = await import(
      "../external-usage-events"
    ));
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
  });

  beforeEach(async () => {
    await prisma.externalUsageEvent.deleteMany();
  });

  it("dedupes a projected replay of a row stored before the projection", async () => {
    await persistExternalUsageEvents([{ ...base, metadata: legacy }]);
    const result = await persistExternalUsageEvents([{ ...base, metadata: projected }]);
    expect(result.persisted).toBe(0);
    expect(await prisma.externalUsageEvent.count()).toBe(1);
  });

  it("dedupes a replay whose derived cost stamp differs", async () => {
    await persistExternalUsageEvents([
      { ...base, metadata: { ...legacy, _derivedCostUsd: 0.0003, _derivedCostIncomplete: true } },
    ]);
    const result = await persistExternalUsageEvents([
      { ...base, metadata: { ...projected, _derivedCostUsd: 0.00105 } },
    ]);
    expect(result.persisted).toBe(0);
    expect(await prisma.externalUsageEvent.count()).toBe(1);
  });

  it("still collides when the producer metadata itself changed", async () => {
    await persistExternalUsageEvents([{ ...base, metadata: legacy }]);
    await expect(
      persistExternalUsageEvents([
        { ...base, metadata: { ...projected, completionTokens: 51, _aiTokensOutput: 51 } },
      ])
    ).rejects.toBeInstanceOf(ExternalUsageIdempotencyCollisionError);
  });

  it("compares the projection when both sides carry it", async () => {
    await persistExternalUsageEvents([{ ...base, metadata: projected }]);
    await expect(
      persistExternalUsageEvents([{ ...base, metadata: { ...projected, _aiTokensOutput: 49 } }])
    ).rejects.toBeInstanceOf(ExternalUsageIdempotencyCollisionError);
  });
});
