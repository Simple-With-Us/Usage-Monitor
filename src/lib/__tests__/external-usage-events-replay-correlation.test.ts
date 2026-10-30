import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

// Collectors start sending correlation keys (`session.id`, `agent.launcher`)
// on events the monitor already stored without them.  One-sided, those keys
// mean "now known", not "changed", so the replay must dedupe instead of
// answering the whole batch with idempotency_conflict.  Present on both sides
// with different values, they still collide.
describe("ExternalUsageEvent replay that adds correlation metadata", () => {
  let dbPath: string;
  let prisma: typeof import("@/lib/prisma").prisma;
  let persistExternalUsageEvents: typeof import("../external-usage-events").persistExternalUsageEvents;

  const base = {
    idempotencyKey: "correlation-replay",
    sourceApp: "claude-code",
    provider: "anthropic",
    label: "token:output",
    keyRef: "claude-opus-5-5",
    billingMode: "estimated" as const,
    metricType: "usage" as const,
    quantity: 168,
    unit: "token",
    confidence: "estimated" as const,
    occurredAt: new Date("2026-10-29T14:00:00.000Z"),
  };
  const meta = (extra: Record<string, string> = {}) => ({
    tokenType: "output",
    model: "claude-opus-5-5",
    collector: "transcript",
    "host.name": "fleet-hetzner-nbg1",
    _usageTelemetrySchemaVersion: 2,
    _producerEventId: "evt-1",
    ...extra,
  });

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-correlation-test-"));
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

  it("dedupes a replay that newly carries session.id and agent.launcher", async () => {
    await persistExternalUsageEvents([{ ...base, metadata: meta() }]);
    const replay = await persistExternalUsageEvents([
      { ...base, metadata: meta({ "session.id": "sess-1", "agent.launcher": "botfleet" }) },
    ]);
    expect(replay.persisted).toBe(0);
    expect(await prisma.externalUsageEvent.count()).toBe(1);
  });

  it("accepts a newly learned call identity but rejects changing a known call", async () => {
    await persistExternalUsageEvents([{ ...base, metadata: meta() }]);
    expect((await persistExternalUsageEvents([{ ...base, metadata: meta({ "call.id": "call-1" }) }])).persisted).toBe(0);
    await prisma.externalUsageEvent.deleteMany();
    await persistExternalUsageEvents([{ ...base, metadata: meta({ "call.id": "call-1" }) }]);
    await expect(persistExternalUsageEvents([{ ...base, metadata: meta({ "call.id": "call-2" }) }])).rejects.toMatchObject({ name: "ExternalUsageIdempotencyCollisionError" });
  });

  it("still collides when both sides carry a different session id", async () => {
    await persistExternalUsageEvents([{ ...base, metadata: meta({ "session.id": "sess-1" }) }]);
    await expect(
      persistExternalUsageEvents([{ ...base, metadata: meta({ "session.id": "sess-2" }) }]),
    ).rejects.toMatchObject({ name: "ExternalUsageIdempotencyCollisionError" });
  });

  it("still collides on a real content difference alongside a new correlation key", async () => {
    await persistExternalUsageEvents([{ ...base, metadata: meta() }]);
    await expect(
      persistExternalUsageEvents([
        { ...base, quantity: 1, metadata: meta({ "session.id": "sess-1" }) },
      ]),
    ).rejects.toMatchObject({ name: "ExternalUsageIdempotencyCollisionError" });
  });
});
