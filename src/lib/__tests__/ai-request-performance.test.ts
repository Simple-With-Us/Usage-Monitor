import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";

// UM-1610: the performance summary keeps harness-reported cost and the
// monitor's token-derived estimate apart, and covers each request in exactly
// one of them.  Clocks are frozen by passing `now`.

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;
let summarizeAiRequests: typeof import("@/lib/ai-request-performance").summarizeAiRequests;
let getAiRequestPerformance: typeof import("@/lib/ai-request-performance").getAiRequestPerformance;

// DATABASE_URL must exist before the prisma module is first imported.
beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-request-perf-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
  ({ summarizeAiRequests, getAiRequestPerformance } = await import("@/lib/ai-request-performance"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath);
});

const NOW = new Date("2026-10-18T12:00:00.000Z");

const base = {
  harness: "codex",
  requestedModel: null,
  servedModel: "gpt-6-luna",
  durationMs: 1000,
  ttftMs: 100,
  inputTokens: 20_000,
  outputTokens: 500,
  cacheReadTokens: 60_000,
  cacheWriteTokens: null,
  reasoningTokens: null,
  costUsd: null,
  billingMode: "subscription",
  error: null,
};

describe("summarizeAiRequests cost split", () => {
  it("estimates only requests without a reported cost and never double counts", () => {
    const rows = summarizeAiRequests([
      { ...base, harness: "claude-code", servedModel: "claude-sonnet-5", costUsd: 0.5 },
      // Trace-only Claude row: tokens, no reported cost.
      { ...base, harness: "claude-code", servedModel: "claude-sonnet-5", inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 },
      // No tokens at all: neither reported nor estimated.
      { ...base, harness: "claude-code", servedModel: "claude-sonnet-5", inputTokens: null, outputTokens: null, cacheReadTokens: null },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requests: 3,
      costUsd: 0.5,
      costUsdKnownRequests: 1,
      derivedCostUsd: 2,
      derivedCostRequests: 1,
      derivedCostIncompleteRequests: 0,
      unpricedRequests: 0,
    });
  });

  it("counts unpriced models separately from derived ones", () => {
    const rows = summarizeAiRequests([
      { ...base, servedModel: "gpt-6-luna" },
      { ...base, servedModel: "mystery-model-9" },
    ]);
    const byModel = Object.fromEntries(rows.map((r) => [r.model, r]));
    expect(byModel["gpt-6-luna"]).toMatchObject({ costUsd: 0, derivedCostRequests: 1, unpricedRequests: 0 });
    expect(byModel["gpt-6-luna"].derivedCostUsd).toBeCloseTo(0.00285, 9);
    expect(byModel["mystery-model-9"]).toMatchObject({ derivedCostUsd: 0, derivedCostRequests: 0, unpricedRequests: 1 });
  });
});

describe("getAiRequestPerformance", () => {
  beforeEach(async () => {
    await prisma.aiRequest.deleteMany();
  });

  let seq = 0;
  const insert = (data: Record<string, unknown>) => {
    seq += 1;
    return prisma.aiRequest.create({
      data: {
        dedupeKey: `perf-${seq}`,
        harness: "codex",
        sources: "logs",
        occurredAt: new Date("2026-10-17T12:00:00.000Z"),
        ...data,
      } as never,
    });
  };

  it("exposes reported and derived cost with their request counts, and the snapshot provenance", async () => {
    await insert({ harness: "claude-code", servedModel: "claude-sonnet-5", inputTokens: 100, outputTokens: 10, costUsd: 0.25 });
    await insert({ harness: "claude-code", servedModel: "claude-sonnet-5", inputTokens: 1_000_000 });
    await insert({ servedModel: "gpt-6-luna", inputTokens: 20_000, outputTokens: 500, cacheReadTokens: 60_000 });

    const perf = await getAiRequestPerformance(7, NOW);
    expect(perf.totalRequests).toBe(3);
    expect(perf.totalCostUsd).toBeCloseTo(0.25, 9);
    expect(perf.totalDerivedCostUsd).toBeCloseTo(2 + 0.00285, 9);
    expect(perf.totalDerivedCostRequests).toBe(2);
    expect(typeof perf.pricingSnapshotFetchedAt).toBe("string");
    const sonnet = perf.rows.find((r) => r.model === "claude-sonnet-5")!;
    expect(sonnet).toMatchObject({
      costUsd: 0.25,
      costUsdKnownRequests: 1,
      derivedCostUsd: 2,
      derivedCostRequests: 1,
    });
  });

  it("prices the 1h cache-write column at the 1h rate", async () => {
    await insert({
      harness: "claude-code",
      servedModel: "claude-sonnet-5[1m]",
      cacheWriteTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
    });
    const perf = await getAiRequestPerformance(7, NOW);
    expect(perf.rows[0]).toMatchObject({ model: "claude-sonnet-5[1m]", derivedCostRequests: 1 });
    expect(perf.rows[0].derivedCostUsd).toBeCloseTo(4, 9);
  });

  it("hides legacy zero-token codex rows that name no model, but keeps real ones", async () => {
    for (let n = 0; n < 3; n += 1) await insert({ statusCode: 200, durationMs: 40 });
    await insert({ requestedModel: "gpt-6-luna", statusCode: 200, durationMs: 900 });
    const perf = await getAiRequestPerformance(7, NOW);
    expect(perf.totalRequests).toBe(1);
    expect(perf.rows.map((r) => r.model)).toEqual(["gpt-6-luna"]);
  });

  it("ignores rows outside the window", async () => {
    await insert({ servedModel: "gpt-6-luna", inputTokens: 10, occurredAt: new Date("2026-10-01T00:00:00.000Z") });
    const perf = await getAiRequestPerformance(7, NOW);
    expect(perf.totalRequests).toBe(0);
  });
});
