import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NextRequest } from "next/server";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

// Exercises DESIGN §3a/§3b: ExternalUsageEvent.providerRequestId is accepted
// and persisted at ingest, but is deliberately excluded from both the
// idempotency-key basis (see usage-telemetry.test.ts for that contract) and
// the dedupe/collision comparison in external-usage-events.ts — a replay
// under the same idempotencyKey with a different (or newly-added, or
// dropped) providerRequestId must still dedupe cleanly, never throw
// ExternalUsageIdempotencyCollisionError, and never create a second row.
describe("ExternalUsageEvent providerRequestId (integration)", () => {
  let dbPath: string;
  let prisma: typeof import("@/lib/prisma").prisma;
  let persistExternalUsageEvents: typeof import("../external-usage-events").persistExternalUsageEvents;
  let ingestPost: typeof import("@/app/api/ingest/usage/route").POST;

  const occurredAt = new Date("2026-07-18T00:00:00.000Z");

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-request-id-test-"));
    dbPath = path.join(dir, "test.db");
    process.env.DATABASE_URL = `file:${dbPath}`;
    setupPrismaSqliteTestDb(dbPath);

    ({ prisma } = await import("@/lib/prisma"));
    ({ persistExternalUsageEvents } = await import("../external-usage-events"));
    ({ POST: ingestPost } = await import("@/app/api/ingest/usage/route"));
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
  });

  beforeEach(async () => {
    await prisma.externalUsageEvent.deleteMany();
  });

  it("persists providerRequestId onto a newly created event", async () => {
    await persistExternalUsageEvents([
      {
        idempotencyKey: "with-provider-request-id",
        sourceApp: "socratic-trade",
        provider: "openrouter",
        billingMode: "estimated",
        metricType: "cost",
        costUsd: 0.01,
        occurredAt,
        providerRequestId: "gen-abc123",
      },
    ]);

    const event = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { idempotencyKey: "with-provider-request-id" },
      select: { providerRequestId: true, verificationStatus: true, verifiedCostUsd: true, verifiedAt: true, verifiedSource: true },
    });
    expect(event.providerRequestId).toBe("gen-abc123");
    // verified* fields are never set at ingest — only a later verification
    // worker (a separate wave) writes them.
    expect(event.verificationStatus).toBeNull();
    expect(event.verifiedCostUsd).toBeNull();
    expect(event.verifiedAt).toBeNull();
    expect(event.verifiedSource).toBeNull();
  });

  it("persists a null providerRequestId when the producer omits it", async () => {
    await persistExternalUsageEvents([
      {
        idempotencyKey: "without-provider-request-id",
        sourceApp: "socratic-trade",
        provider: "openrouter",
        billingMode: "estimated",
        metricType: "cost",
        costUsd: 0.02,
        occurredAt,
      },
    ]);

    const event = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { idempotencyKey: "without-provider-request-id" },
      select: { providerRequestId: true },
    });
    expect(event.providerRequestId).toBeNull();
  });

  it("dedupes a replay under the same idempotencyKey even when providerRequestId differs", async () => {
    const base = {
      idempotencyKey: "replay-different-provider-request-id",
      sourceApp: "socratic-trade",
      provider: "openrouter",
      billingMode: "estimated" as const,
      metricType: "cost" as const,
      costUsd: 0.03,
      occurredAt,
    };

    const first = await persistExternalUsageEvents([
      { ...base, providerRequestId: "gen-first" },
    ]);
    expect(first.persisted).toBe(1);

    // A replay with a DIFFERENT providerRequestId must not throw and must
    // not create a second row (DESIGN §3b acceptance criterion).
    const second = await persistExternalUsageEvents([
      { ...base, providerRequestId: "gen-second" },
    ]);
    expect(second.persisted).toBe(0);
    expect(second.attempted).toBe(1);

    expect(await prisma.externalUsageEvent.count()).toBe(1);
    const event = await prisma.externalUsageEvent.findUniqueOrThrow({
      where: { idempotencyKey: base.idempotencyKey },
      select: { providerRequestId: true },
    });
    // The original value is retained — a later providerRequestId does not
    // silently overwrite it.
    expect(event.providerRequestId).toBe("gen-first");
  });

  it("dedupes a replay that drops a previously-supplied providerRequestId", async () => {
    const base = {
      idempotencyKey: "replay-drops-provider-request-id",
      sourceApp: "congress-trade",
      provider: "openrouter",
      billingMode: "estimated" as const,
      metricType: "cost" as const,
      costUsd: 0.04,
      occurredAt,
    };

    await persistExternalUsageEvents([{ ...base, providerRequestId: "gen-original" }]);
    await expect(persistExternalUsageEvents([base])).resolves.toMatchObject({
      persisted: 0,
      attempted: 1,
    });
    expect(await prisma.externalUsageEvent.count()).toBe(1);
  });

  it("still rejects a real collision on the same idempotencyKey (different costUsd)", async () => {
    const base = {
      idempotencyKey: "real-collision-still-rejected",
      sourceApp: "socratic-trade",
      provider: "openrouter",
      billingMode: "estimated" as const,
      metricType: "cost" as const,
      occurredAt,
    };

    await persistExternalUsageEvents([{ ...base, costUsd: 0.05, providerRequestId: "gen-a" }]);
    await expect(
      persistExternalUsageEvents([{ ...base, costUsd: 0.06, providerRequestId: "gen-a" }])
    ).rejects.toMatchObject({ name: "ExternalUsageIdempotencyCollisionError" });
  });

  it("collapses a same-batch duplicate that differs only by providerRequestId", async () => {
    const base = {
      idempotencyKey: "same-batch-provider-request-id",
      sourceApp: "socratic-trade",
      provider: "openrouter",
      billingMode: "estimated" as const,
      metricType: "cost" as const,
      costUsd: 0.07,
      occurredAt,
    };

    const result = await persistExternalUsageEvents([
      { ...base, providerRequestId: "gen-batch-a" },
      { ...base, providerRequestId: "gen-batch-b" },
    ]);
    expect(result.persisted).toBe(1);
    expect(await prisma.externalUsageEvent.count()).toBe(1);
  });

  it("dedupes a replay where occurredAt has minor timestamp jitter (<= 5s)", async () => {
    const base = {
      idempotencyKey: "replay-timestamp-jitter",
      sourceApp: "codex",
      provider: "openai",
      billingMode: "estimated" as const,
      metricType: "tokens" as const,
      inputTokens: 100,
      outputTokens: 50,
      occurredAt,
    };

    await persistExternalUsageEvents([base]);
    // Replay with 2.5 seconds difference — should be accepted as duplicate, not a collision
    const jitteredTime = new Date(occurredAt.getTime() + 2500);
    const replay = await persistExternalUsageEvents([{ ...base, occurredAt: jitteredTime }]);
    expect(replay.persisted).toBe(0);
    expect(replay.attempted).toBe(1);
    expect(await prisma.externalUsageEvent.count()).toBe(1);
  });

  it("rejects a replay where occurredAt differs by more than 5s", async () => {
    const base = {
      idempotencyKey: "replay-timestamp-large-diff",
      sourceApp: "codex",
      provider: "openai",
      billingMode: "estimated" as const,
      metricType: "tokens" as const,
      inputTokens: 100,
      outputTokens: 50,
      occurredAt,
    };

    await persistExternalUsageEvents([base]);
    // Replay with 10 seconds difference — should trigger collision error
    const largeDiffTime = new Date(occurredAt.getTime() + 10000);
    await expect(
      persistExternalUsageEvents([{ ...base, occurredAt: largeDiffTime }])
    ).rejects.toMatchObject({ name: "ExternalUsageIdempotencyCollisionError" });
  });

  it("ignores producer-supplied verification fields on the wire — verified* always persist as null", async () => {
    // Hardening (adversarial-review nit): producers must never be able to
    // self-verify. A wire payload that explicitly claims verification state
    // goes through the REAL ingest route against the REAL database, and the
    // persisted row must still have every verified* column null — the parser
    // has no readers for these fields and toCreateData never sets them, so
    // they can only ever be written by the later monitor-side verification
    // worker.
    vi.stubEnv("USAGE_INGEST_TOKEN", "wire-verification-test-token");
    try {
      const response = await ingestPost(
        new NextRequest("https://usage.jays.services/api/ingest/usage", {
          method: "POST",
          headers: {
            authorization: "Bearer wire-verification-test-token",
            "content-type": "application/json",
            "x-forwarded-for": "10.9.0.1",
          },
          body: JSON.stringify({
            idempotencyKey: "wire-self-verification-attempt",
            sourceApp: "socratic-trade",
            provider: "openrouter",
            metricType: "cost",
            costUsd: 0.5,
            occurredAt: occurredAt.toISOString(),
            providerRequestId: "gen-wire-1",
            // Rogue self-verification claims — must be dropped, not persisted.
            verificationStatus: "match",
            verifiedCostUsd: 1.23,
            verifiedAt: "2026-07-18T01:00:00.000Z",
            verifiedSource: "forged-by-producer",
          }),
        })
      );
      expect(response.status).toBe(202);

      const event = await prisma.externalUsageEvent.findUniqueOrThrow({
        where: { idempotencyKey: "wire-self-verification-attempt" },
        select: {
          providerRequestId: true,
          verificationStatus: true,
          verifiedCostUsd: true,
          verifiedAt: true,
          verifiedSource: true,
        },
      });
      // The legitimate field flows through…
      expect(event.providerRequestId).toBe("gen-wire-1");
      // …while every verification field stays null despite the wire claims.
      expect(event.verificationStatus).toBeNull();
      expect(event.verifiedCostUsd).toBeNull();
      expect(event.verifiedAt).toBeNull();
      expect(event.verifiedSource).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
