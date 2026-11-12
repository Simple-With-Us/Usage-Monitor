import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Prisma } from "@prisma/client";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";

// Exercises loadAgentModelMixRows against a REAL throwaway SQLite database
// (never the dev `data`/`dev.db`), not a mocked Prisma client -- same reason
// cost-by-session.db.test.ts exists (see that file's docblock): a mocked
// Prisma unit test cannot catch a bug in how the raw SQLite driver infers a
// COMPUTED column's runtime type.
//
// This specific regression: production threw `RangeError: The number
// 0.3498095 cannot be converted to a BigInt because it is not an integer`
// from every call.  Root cause -- confirmed by reproducing it here before the
// fix and watching it disappear after -- SQLite's $queryRaw type inference
// samples the FIRST returned row's storage class per column.  The original
// query's SUM(CASE ...) aggregates were not CAST to REAL, so when the first
// GROUP BY bucket's sum happened to land on an exact integer (a group with
// no matching 'cost' events sums to literal 0), Prisma inferred
// Int64/BigInt for that whole column and crashed converting a LATER group's
// genuinely fractional dollar amount.  See agent-model-mix.ts's module
// docblock for the full incident note.  The fix wraps both SUMs in
// CAST(... AS REAL).
//
// The two groups below (first `it`) are seeded in the same order that
// triggered it in production: an all-"usage" group (exact-zero cost) with a
// keyRef that sorts/groups before a "cost"-bearing group with a real
// fractional amount.
//
// A second, NULL-first variant of the same bug (found in the 2026-09-25
// adversarial review of PR #1546, which shipped the CAST fix above) is
// covered by the "NULL-first" `it` block below: `COALESCE(CAST(SUM(...) AS
// REAL), 0)` still crashed when the FIRST group's matching rows all had a
// NULL costUsd/quantity, because SUM() over all-NULL input is SQL NULL, so
// COALESCE fell back to the untyped literal `0` and Prisma re-locked the
// column to BigInt.  The fix for that variant switched both aggregates from
// `COALESCE(CAST(SUM(...) AS REAL), 0)` to plain `TOTAL(...)`, which always
// returns a REAL and never NULL.  See agent-model-mix.ts's module docblock,
// "Follow-up NULL-first variant", for the full note.
//
// A third `it` block covers the fail-closed catch itself: a $queryRaw that
// rejects must still resolve to `[]` (not throw), and must log a warning
// (2026-09-25 follow-up) instead of swallowing the failure silently the way
// the original incident did.
let dbPath: string;
let loadAgentModelMixRows: typeof import("../agent-model-mix").loadAgentModelMixRows;
let prisma: typeof import("@/lib/prisma").prisma;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-model-mix-db-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;

  setupPrismaSqliteTestDb(dbPath);

  ({ loadAgentModelMixRows } = await import("../agent-model-mix"));
  ({ prisma } = await import("@/lib/prisma"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath);
});

beforeEach(async () => {
  await prisma.externalUsageEvent.deleteMany({});
});

async function seedEvent(overrides: {
  idempotencyKey: string;
  sourceApp?: string;
  provider?: string;
  keyRef?: string | null;
  metricType: string;
  unit?: string | null;
  quantity?: number | null;
  costUsd?: number | null;
  metadata?: Prisma.InputJsonValue;
  occurredAt: Date;
}) {
  await prisma.externalUsageEvent.create({
    data: {
      idempotencyKey: overrides.idempotencyKey,
      sourceApp: overrides.sourceApp ?? "claude-code",
      provider: overrides.provider ?? "anthropic",
      keyRef: overrides.keyRef ?? "claude-sonnet-5",
      metricType: overrides.metricType,
      unit: overrides.unit ?? null,
      quantity: overrides.quantity ?? null,
      costUsd: overrides.costUsd ?? null,
      occurredAt: overrides.occurredAt,
      metadata: overrides.metadata ?? {},
    },
  });
}

const WINDOW_START = new Date("2026-09-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-09-30T00:00:00.000Z");
const OCCURRED_AT = new Date("2026-09-20T10:00:00.000Z");

describe("loadAgentModelMixRows (real SQLite)", () => {
  it("does not throw and returns the correct fractional costUsd when an earlier group's sum is an exact integer", async () => {
    // Group A ("model-a"): only 'usage' events -> the cost CASE's ELSE
    // branch fires every time -> exact integer 0 for that group's costUsd.
    await seedEvent({
      idempotencyKey: "amm-db-a1",
      keyRef: "model-a",
      metricType: "usage",
      unit: "token",
      quantity: 100,
      occurredAt: OCCURRED_AT,
    });
    await seedEvent({
      idempotencyKey: "amm-db-a2",
      keyRef: "model-a",
      metricType: "usage",
      unit: "token",
      quantity: 50,
      occurredAt: OCCURRED_AT,
    });
    // Group B ("model-b"): a real fractional cost -- this is the value that
    // crashed in production once Prisma had locked the column to BigInt
    // from group A's exact-zero sum.
    await seedEvent({
      idempotencyKey: "amm-db-b1",
      keyRef: "model-b",
      metricType: "cost",
      costUsd: 0.3498095,
      occurredAt: OCCURRED_AT,
    });

    const rows = await loadAgentModelMixRows(WINDOW_START, WINDOW_END);

    expect(rows).toHaveLength(2);
    const groupA = rows.find((r) => r.model === "model-a");
    const groupB = rows.find((r) => r.model === "model-b");
    expect(groupA).toMatchObject({ tokens: 150, costUsd: 0, eventCount: 2 });
    expect(groupB).toMatchObject({ tokens: 0, costUsd: 0.3498095, eventCount: 1 });
    for (const row of rows) {
      expect(typeof row.tokens).toBe("number");
      expect(typeof row.costUsd).toBe("number");
      expect(typeof row.eventCount).toBe("number");
      expect(Number.isNaN(row.tokens)).toBe(false);
      expect(Number.isNaN(row.costUsd)).toBe(false);
    }
  });

  it("groups by sourceApp x provider x model x seat x project and sums tokens/cost/events per group", async () => {
    await seedEvent({
      idempotencyKey: "amm-db-g1",
      sourceApp: "claude-code",
      provider: "anthropic",
      keyRef: "claude-sonnet-5",
      metricType: "usage",
      unit: "token",
      quantity: 1000,
      metadata: { project: "usage-monitor" },
      occurredAt: OCCURRED_AT,
    });
    await seedEvent({
      idempotencyKey: "amm-db-g2",
      sourceApp: "claude-code",
      provider: "anthropic",
      keyRef: "claude-sonnet-5",
      metricType: "usage",
      unit: "token",
      quantity: 500,
      metadata: { project: "usage-monitor" },
      occurredAt: OCCURRED_AT,
    });
    await seedEvent({
      idempotencyKey: "amm-db-g3",
      sourceApp: "codex-cli",
      provider: "openai",
      keyRef: "gpt-5-codex",
      metricType: "cost",
      costUsd: 2.5,
      metadata: { project: "fleet-infra" },
      occurredAt: OCCURRED_AT,
    });

    const rows = await loadAgentModelMixRows(WINDOW_START, WINDOW_END);

    expect(rows).toHaveLength(2);
    const claudeRow = rows.find((r) => r.sourceApp === "claude-code");
    expect(claudeRow).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5",
      project: "usage-monitor",
      tokens: 1500,
      costUsd: 0,
      eventCount: 2,
    });
    const codexRow = rows.find((r) => r.sourceApp === "codex-cli");
    expect(codexRow).toMatchObject({
      provider: "openai",
      model: "gpt-5-codex",
      project: "fleet-infra",
      tokens: 0,
      costUsd: 2.5,
      eventCount: 1,
    });
  });

  it("excludes events outside the given window", async () => {
    await seedEvent({
      idempotencyKey: "amm-db-out",
      metricType: "usage",
      unit: "token",
      quantity: 999,
      occurredAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    await seedEvent({
      idempotencyKey: "amm-db-in",
      metricType: "usage",
      unit: "token",
      quantity: 10,
      occurredAt: OCCURRED_AT,
    });

    const rows = await loadAgentModelMixRows(WINDOW_START, WINDOW_END);

    expect(rows).toHaveLength(1);
    expect(rows[0].tokens).toBe(10);
  });

  it("returns [] for a window with no matching events", async () => {
    const rows = await loadAgentModelMixRows(WINDOW_START, WINDOW_END);
    expect(rows).toEqual([]);
  });

  // NULL-first variant of the BigInt crash (2026-09-25 adversarial review of
  // PR #1546) -- see the file-level docblock above and agent-model-mix.ts's
  // "Follow-up NULL-first variant" module docblock note.  Unlike the first
  // test in this file (an exact-integer-zero first group), these seed a
  // FIRST group whose matching column is NULL on every row, which
  // `COALESCE(CAST(SUM(...) AS REAL), 0)` also collapsed to the untyped
  // literal `0`.
  it("does not throw and returns 0 tokens when an earlier group's quantity is NULL on every row", async () => {
    // Group A ("model-a"): a 'usage'/'token' row with quantity left NULL --
    // SUM(quantity) over an all-NULL group is SQL NULL, not 0.
    await seedEvent({
      idempotencyKey: "amm-db-nulla",
      keyRef: "model-a",
      metricType: "usage",
      unit: "token",
      quantity: null,
      occurredAt: OCCURRED_AT,
    });
    // Group B ("model-b"): a real fractional quantity -- the value that
    // crashed once Prisma had locked the "tokens" column to BigInt from
    // group A's NULL-collapsed-to-0 sum.
    await seedEvent({
      idempotencyKey: "amm-db-nullb",
      keyRef: "model-b",
      metricType: "usage",
      unit: "token",
      quantity: 12.5,
      occurredAt: OCCURRED_AT,
    });

    const rows = await loadAgentModelMixRows(WINDOW_START, WINDOW_END);

    expect(rows).toHaveLength(2);
    const groupA = rows.find((r) => r.model === "model-a");
    const groupB = rows.find((r) => r.model === "model-b");
    expect(groupA).toMatchObject({ tokens: 0, eventCount: 1 });
    expect(groupB).toMatchObject({ tokens: 12.5, eventCount: 1 });
    for (const row of rows) {
      expect(typeof row.tokens).toBe("number");
      expect(Number.isNaN(row.tokens)).toBe(false);
    }
  });

  it("does not throw and returns 0 costUsd when an earlier group's costUsd is NULL on every row", async () => {
    // Group A ("model-a"): a 'cost' row with costUsd left NULL.
    await seedEvent({
      idempotencyKey: "amm-db-nullc",
      keyRef: "model-a",
      metricType: "cost",
      costUsd: null,
      occurredAt: OCCURRED_AT,
    });
    // Group B ("model-b"): a real fractional cost.
    await seedEvent({
      idempotencyKey: "amm-db-nulld",
      keyRef: "model-b",
      metricType: "cost",
      costUsd: 0.3498095,
      occurredAt: OCCURRED_AT,
    });

    const rows = await loadAgentModelMixRows(WINDOW_START, WINDOW_END);

    expect(rows).toHaveLength(2);
    const groupA = rows.find((r) => r.model === "model-a");
    const groupB = rows.find((r) => r.model === "model-b");
    expect(groupA).toMatchObject({ costUsd: 0, eventCount: 1 });
    expect(groupB).toMatchObject({ costUsd: 0.3498095, eventCount: 1 });
    for (const row of rows) {
      expect(typeof row.costUsd).toBe("number");
      expect(Number.isNaN(row.costUsd)).toBe(false);
    }
  });

  it("fails closed to [] and logs a warning (not silently) when the query rejects", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const queryRawSpy = vi
      .spyOn(prisma, "$queryRaw")
      .mockRejectedValueOnce(new Error("simulated query failure"));

    try {
      const rows = await loadAgentModelMixRows(WINDOW_START, WINDOW_END);

      expect(rows).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("[agent-model-mix]");
    } finally {
      queryRawSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
