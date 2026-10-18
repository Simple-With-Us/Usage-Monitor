import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

// UM-1469: collectors stamp the sending host into metadata._producerInstanceId.
// A hostname rename (jays.services -> Mac.Jays.Services) made every replay of
// a pre-rename event fail with idempotency_conflict, which rejects the whole
// batch and pins the collector checkpoint forever.  The host label is
// provenance, not event identity, so a replay from another host label must
// dedupe while a real content difference must still collide.
describe("ExternalUsageEvent replay from a renamed host (UM-1469)", () => {
  let dbPath: string;
  let prisma: typeof import("@/lib/prisma").prisma;
  let persistExternalUsageEvents: typeof import("../external-usage-events").persistExternalUsageEvents;

  const occurredAt = new Date("2026-09-10T13:04:41.000Z");
  const base = {
    idempotencyKey: "host-rename-replay",
    sourceApp: "grok-build",
    provider: "xai",
    label: "token:input",
    keyRef: "grok-4.6-build",
    billingMode: "estimated" as const,
    metricType: "usage" as const,
    quantity: 569020,
    unit: "token",
    confidence: "estimated" as const,
    occurredAt,
  };
  const meta = (host: string) => ({
    tokenType: "input",
    model: "grok-4.6-build",
    _usageTelemetrySchemaVersion: 2,
    _producerEventId: "evt-1",
    _producerInstanceId: host,
  });

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-host-test-"));
    dbPath = path.join(dir, "test.db");
    process.env.DATABASE_URL = `file:${dbPath}`;
    setupPrismaSqliteTestDb(dbPath);
    ({ prisma } = await import("@/lib/prisma"));
    ({ persistExternalUsageEvents } = await import("../external-usage-events"));
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
  });

  beforeEach(async () => {
    await prisma.externalUsageEvent.deleteMany();
  });

  it("dedupes a replay whose only difference is the producer host label", async () => {
    await persistExternalUsageEvents([{ ...base, metadata: meta("jays.services") }]);
    const replay = await persistExternalUsageEvents([
      { ...base, metadata: meta("Mac.Jays.Services") },
    ]);
    expect(replay.persisted).toBe(0);
    expect(await prisma.externalUsageEvent.count()).toBe(1);
  });

  it("dedupes a quota replay whose machine only echoes the host label", async () => {
    const quota = {
      ...base,
      idempotencyKey: "host-rename-quota",
      metricType: "quota" as const,
      label: "5h",
    };
    await persistExternalUsageEvents([
      { ...quota, metadata: { ...meta("Jay"), machine: "Jay" } },
    ]);
    const replay = await persistExternalUsageEvents([
      { ...quota, metadata: { ...meta("Mac.Jays.Services"), machine: "Mac.Jays.Services" } },
    ]);
    expect(replay.persisted).toBe(0);
  });

  it("still rejects a replay whose real content differs", async () => {
    await persistExternalUsageEvents([{ ...base, metadata: meta("jays.services") }]);
    await expect(
      persistExternalUsageEvents([
        { ...base, quantity: 1, metadata: meta("Mac.Jays.Services") },
      ]),
    ).rejects.toMatchObject({ name: "ExternalUsageIdempotencyCollisionError" });
  });
});
