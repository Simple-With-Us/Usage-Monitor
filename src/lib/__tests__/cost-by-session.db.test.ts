import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "@/lib/__tests__/setup-test-db";

// Exercises loadCostBySessionRows against a REAL throwaway SQLite database
// (never the dev `data`/`dev.db`), not a mocked Prisma client -- this is the
// only test in the cost-by-session suite that actually round-trips through
// $queryRaw's json_extract + MIN/MAX(occurredAt) aggregate.  It exists
// specifically because a mocked-Prisma unit test cannot catch a bug in how
// the raw driver represents an *aggregated* DateTime column: a direct SELECT
// of `occurredAt` deserializes to a JS Date via Prisma's normal mapping, but
// MIN()/MAX() loses that column-type metadata and the driver hands back its
// raw underlying representation instead (observed as `bigint` here).  See
// coerceOccurredAt in ../cost-by-session.ts -- P1 review finding on PR #1534
// (chatgpt-codex-connector): passing that raw value straight to `new
// Date(...)` throws `TypeError: Cannot convert a BigInt value to a number`,
// turning every successful non-empty lookup into a 500.  This test asserts
// against real firstOccurredAt/lastOccurredAt Date objects to prove the fix,
// not just that the function doesn't throw.
//
// A second regression is covered below ("does not throw and returns 0 for an
// earlier session's NULL cost/quantity..."): found in the 2026-09-25
// adversarial review of PR #1546 (the agent-model-mix.ts BigInt fix), the
// SAME bug class as that PR was fixing existed here too.
// `COALESCE(SUM(x), 0)` returns the untyped literal `0` whenever a GROUP BY
// bucket's matching rows are all NULL for that column (SUM over an all-NULL
// group is SQL NULL, so COALESCE's fallback fires) -- if that bucket is the
// FIRST row $queryRaw returns, Prisma's SQLite type inference locks the
// whole column to BigInt from that `0`, then throws converting a LATER
// session's genuinely fractional cost/quantity.  Fixed by switching both
// aggregates from `COALESCE(SUM(x), 0)` to `TOTAL(x)`, which always returns
// a REAL and never NULL.  See agent-model-mix.ts's module docblock,
// "Follow-up NULL-first variant", for the fuller incident note (this
// function's own crash was reproduced the same way, against real SQLite,
// before the fix and confirmed gone after).

let dbPath: string;
let loadCostBySessionRows: typeof import("../cost-by-session").loadCostBySessionRows;
let prisma: typeof import("@/lib/prisma").prisma;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-by-session-db-test-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;

  setupPrismaSqliteTestDb(dbPath);

  ({ loadCostBySessionRows } = await import("../cost-by-session"));
  ({ prisma } = await import("@/lib/prisma"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) fs.rmSync(dbPath);
});

beforeEach(async () => {
  await prisma.externalUsageEvent.deleteMany({ where: { sourceApp: "claude-code" } });
});

async function seedEvent(overrides: {
  sessionId: string;
  metricType: string;
  unit?: string | null;
  keyRef?: string | null;
  label?: string | null;
  quantity?: number | null;
  costUsd?: number | null;
  occurredAt: Date;
  idempotencyKey: string;
}) {
  await prisma.externalUsageEvent.create({
    data: {
      idempotencyKey: overrides.idempotencyKey,
      sourceApp: "claude-code",
      provider: "anthropic",
      service: "claude-code",
      metricType: overrides.metricType,
      unit: overrides.unit ?? null,
      keyRef: overrides.keyRef ?? "claude-sonnet-5",
      label: overrides.label ?? null,
      quantity: overrides.quantity ?? null,
      costUsd: overrides.costUsd ?? null,
      occurredAt: overrides.occurredAt,
      metadata: { "session.id": overrides.sessionId },
    },
  });
}

describe("loadCostBySessionRows (real SQLite)", () => {
  it("returns real Date instances for firstOccurredAt/lastOccurredAt, not a raw driver value", async () => {
    await seedEvent({
      sessionId: "db-test-session",
      metricType: "usage",
      unit: "token",
      label: "token:input",
      quantity: 100,
      occurredAt: new Date("2026-09-20T10:00:00.000Z"),
      idempotencyKey: "cbs-db-test-1",
    });
    await seedEvent({
      sessionId: "db-test-session",
      metricType: "usage",
      unit: "token",
      label: "token:output",
      quantity: 20,
      occurredAt: new Date("2026-09-24T15:30:00.000Z"),
      idempotencyKey: "cbs-db-test-2",
    });

    const rows = await loadCostBySessionRows(
      ["db-test-session"],
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-09-30T00:00:00.000Z")
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.firstOccurredAt).toBeInstanceOf(Date);
      expect(row.lastOccurredAt).toBeInstanceOf(Date);
      expect(Number.isNaN(row.firstOccurredAt.getTime())).toBe(false);
      expect(Number.isNaN(row.lastOccurredAt.getTime())).toBe(false);
    }

    const inputRow = rows.find((r) => r.label === "token:input");
    expect(inputRow?.firstOccurredAt.toISOString()).toBe("2026-09-20T10:00:00.000Z");
    const outputRow = rows.find((r) => r.label === "token:output");
    expect(outputRow?.firstOccurredAt.toISOString()).toBe("2026-09-24T15:30:00.000Z");
  });

  it("matches only rows inside the given window and with a matching session.id", async () => {
    await seedEvent({
      sessionId: "in-window",
      metricType: "cost",
      costUsd: 0.5,
      occurredAt: new Date("2026-09-22T00:00:00.000Z"),
      idempotencyKey: "cbs-db-test-3",
    });
    await seedEvent({
      sessionId: "out-of-window",
      metricType: "cost",
      costUsd: 9,
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      idempotencyKey: "cbs-db-test-4",
    });
    await seedEvent({
      sessionId: "different-session",
      metricType: "cost",
      costUsd: 3,
      occurredAt: new Date("2026-09-22T00:00:00.000Z"),
      idempotencyKey: "cbs-db-test-5",
    });

    const rows = await loadCostBySessionRows(
      ["in-window"],
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-09-30T00:00:00.000Z")
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("in-window");
    expect(rows[0].costUsd).toBeCloseTo(0.5);
  });

  it("returns an empty array when ids is empty, without querying the database", async () => {
    const rows = await loadCostBySessionRows([], new Date(0), new Date());
    expect(rows).toEqual([]);
  });

  // NULL-first regression (2026-09-25 adversarial review of PR #1546) -- see
  // the file-level docblock above.  Session ids are prefixed "a-"/"b-" so the
  // usage-only session's group sorts/groups first, matching the order that
  // reproduced the bug.
  it("does not throw and returns the correct fractional costUsd when an earlier session's group is usage-only (NULL costUsd)", async () => {
    // Group A ("a-usage-only-session"): a 'usage' row -- costUsd is NULL for
    // every row in this group, so SUM(costUsd) over it is SQL NULL.
    await seedEvent({
      sessionId: "a-usage-only-session",
      metricType: "usage",
      unit: "token",
      label: "token:input",
      quantity: 100,
      occurredAt: new Date("2026-09-20T10:00:00.000Z"),
      idempotencyKey: "cbs-db-nulla",
    });
    // Group B ("b-fractional-cost-session"): a real fractional cost -- the
    // value that crashed once Prisma had locked the "costUsd" column to
    // BigInt from group A's NULL-collapsed-to-0 sum.
    await seedEvent({
      sessionId: "b-fractional-cost-session",
      metricType: "cost",
      costUsd: 0.3498095,
      occurredAt: new Date("2026-09-20T10:00:00.000Z"),
      idempotencyKey: "cbs-db-nullb",
    });

    const rows = await loadCostBySessionRows(
      ["a-usage-only-session", "b-fractional-cost-session"],
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-09-30T00:00:00.000Z")
    );

    expect(rows).toHaveLength(2);
    const groupA = rows.find((r) => r.sessionId === "a-usage-only-session");
    const groupB = rows.find((r) => r.sessionId === "b-fractional-cost-session");
    expect(groupA).toMatchObject({ quantity: 100, costUsd: 0 });
    expect(groupB).toMatchObject({ quantity: 0, costUsd: 0.3498095 });
    for (const row of rows) {
      expect(typeof row.quantity).toBe("number");
      expect(typeof row.costUsd).toBe("number");
      expect(Number.isNaN(row.quantity)).toBe(false);
      expect(Number.isNaN(row.costUsd)).toBe(false);
    }
  });
});
