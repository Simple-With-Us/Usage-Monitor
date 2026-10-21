import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Boundary rows are untrusted input too: validate the stored metadata shape
// with a Zod schema before asserting on its fields.  The raw path hands back
// the SQLite JSON column as TEXT, so validate that it is text first — a type
// assertion cannot prove it and would let a non-string through unchecked.
const storedMetadataSchema = z.record(z.string(), z.unknown());
const storedMetadataTextSchema = z.string();

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  findMany: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    externalUsageEvent: {
      findMany: mocks.findMany,
    },
    $queryRaw: mocks.queryRaw,
  },
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: mocks.captureException,
}));

import { loadLatestQuotaWindowEvents } from "../quota-events-loader";

describe("loadLatestQuotaWindowEvents", () => {
  beforeEach(() => {
    mocks.queryRaw.mockReset();
    mocks.findMany.mockReset();
    mocks.captureException.mockReset();
  });

  it("returns one row per partition from the window query", async () => {
    const since = new Date("2026-10-01T00:00:00.000Z");
    mocks.queryRaw.mockResolvedValue([
      {
        provider: "anthropic",
        service: null,
        sourceApp: "subscription-quota-collector",
        label: "5h",
        credits: 80,
        limit: 100,
        occurredAt: new Date("2026-10-03T12:00:00.000Z"),
        metadata: { bucketId: "anthropic:five_hour", _producerInstanceId: "mac-a" },
      },
    ]);

    const rows = await loadLatestQuotaWindowEvents(since);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceApp).toBe("subscription-quota-collector");
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.queryRaw.mock.calls[0][0].sql).toContain('ORDER BY "occurredAt" DESC');
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("keeps newest observation first and latest receipt on equal observation times", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE ExternalUsageEvent (
      id TEXT, provider TEXT, service TEXT, sourceApp TEXT, label TEXT,
      credits REAL, "limit" REAL, occurredAt INTEGER, createdAt INTEGER,
      metadata TEXT, metricType TEXT
    )`);
    const insert = db.prepare(`INSERT INTO ExternalUsageEvent VALUES (?, 'claude', NULL,
      'codecaps', '5h', 50, 100, ?, ?, ?, 'quota')`);
    insert.run("old", 2000, 3000, JSON.stringify({ planUserName: "Old" }));
    insert.run("new", 2000, 4000, JSON.stringify({ planUserName: "New" }));
    insert.run("late-stale", 1000, 5000, JSON.stringify({ planUserName: "Stale" }));
    mocks.queryRaw.mockImplementation((query) => db.prepare(query.sql).all(0));
    try {
      const rows = await loadLatestQuotaWindowEvents(new Date(0));
      expect(rows).toHaveLength(1);
      expect(storedMetadataSchema.parse(JSON.parse(storedMetadataTextSchema.parse(rows[0].metadata))).planUserName).toBe("New");
      insert.run("z-tie", 2000, 4000, JSON.stringify({ planUserName: "Stable tie" }));
      const tied = await loadLatestQuotaWindowEvents(new Date(0));
      expect(storedMetadataSchema.parse(JSON.parse(storedMetadataTextSchema.parse(tied[0].metadata))).planUserName).toBe("Stable tie");
      insert.run("revision-b", 2000, 6000, JSON.stringify({ planUserName: "B", planUserUpdatedAt: 10 }));
      insert.run("revert-a", 2000, 7000, JSON.stringify({ planUserName: "A", planUserUpdatedAt: 20 }));
      insert.run("delayed-b", 2000, 8000, JSON.stringify({ planUserName: "B", planUserUpdatedAt: 10 }));
      insert.run("invalid", 2000, 9000, JSON.stringify({ planUserName: "Invalid", planUserUpdatedAt: "999999" }));
      const reverted = await loadLatestQuotaWindowEvents(new Date(0));
      expect(storedMetadataSchema.parse(JSON.parse(storedMetadataTextSchema.parse(reverted[0].metadata))).planUserName).toBe("A");
    } finally {
      db.close();
    }
  });

  it("falls back to bounded findMany when the window query throws", async () => {
    const since = new Date("2026-10-01T00:00:00.000Z");
    const queryError = new Error("sqlite busy");
    mocks.queryRaw.mockRejectedValue(queryError);
    mocks.findMany.mockResolvedValue([]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await loadLatestQuotaWindowEvents(since);

    expect(errorSpy).toHaveBeenCalledWith(
      "[quota-events-loader] window query failed; falling back to bounded findMany",
      queryError,
    );
    expect(mocks.captureException).toHaveBeenCalledWith(queryError);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        where: { metricType: "quota", occurredAt: { gte: since } },
      }),
    );
    // A flat row cap is taken before the revision tie-break, so it can drop the
    // winner and make this path disagree with the raw window query.  The path
    // pages instead: a short first page means the window is exhausted.
    expect(mocks.findMany.mock.calls[0][0]).toHaveProperty("take", 500);
    expect(mocks.findMany.mock.calls[0][0]).not.toHaveProperty("cursor");
    expect(mocks.findMany).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it("walks the whole window in keyset pages without losing a late partition", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("sqlite busy"));
    const PAGE = 500;
    const ids = (n: number) => `row-${String(n).padStart(5, "0")}`;
    // Page 1 is full of one chatty series; the low-cadence series only
    // appears on page 2, and its winner is the oldest row.  A flat cap would
    // have evicted it; paging must keep it.
    const page1 = Array.from({ length: PAGE }, (_, n) => ({
      id: ids(n), occurredAt: new Date(100_000 - n), createdAt: new Date(100_000 - n),
      metadata: { bucketId: "chatty", _producerInstanceId: "mac-a" },
    }));
    const page2 = [
      { id: ids(PAGE), occurredAt: new Date(10), createdAt: new Date(10),
        metadata: { bucketId: "quiet", _producerInstanceId: "mac-a" } },
    ];
    mocks.findMany.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const rows = await loadLatestQuotaWindowEvents(new Date(0));
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => storedMetadataSchema.parse(r.metadata).bucketId).sort())
        .toEqual(["chatty", "quiet"]);
      expect(mocks.findMany).toHaveBeenCalledTimes(2);
      expect(mocks.findMany.mock.calls[1][0]).toMatchObject({
        cursor: { id: ids(PAGE - 1) }, skip: 1, take: PAGE,
      });
    } finally { errorSpy.mockRestore(); }
  });

  it("partitions blank modelId and bucketId the same way on both read paths", async () => {
    // Blank or whitespace-only ids are absent for projectQuotaWindows, so two
    // buckets that both send modelId "" are two series, not one.  The window
    // query (real SQLite below) and the fallback must agree on that.
    const eventRows = [
      { id: "blank-a", occurredAt: 2000, createdAt: 3000,
        metadata: { modelId: "", bucketId: "anthropic:five_hour", _producerInstanceId: "mac-a" } },
      { id: "blank-b", occurredAt: 2000, createdAt: 3000,
        metadata: { modelId: "   ", bucketId: "anthropic:seven_day", _producerInstanceId: "mac-a" } },
      { id: "padded", occurredAt: 2000, createdAt: 3000,
        metadata: { modelId: " opus ", _producerInstanceId: "mac-a" } },
      { id: "padded-older", occurredAt: 1000, createdAt: 3000,
        metadata: { modelId: "opus", _producerInstanceId: "mac-a" } },
      { id: "numeric-model", occurredAt: 2000, createdAt: 3000,
        metadata: { modelId: 7, bucketId: "anthropic:thirty_day", _producerInstanceId: "mac-a" } },
      { id: "no-ids", occurredAt: 2000, createdAt: 3000, metadata: {} },
    ];
    const expected = ["anthropic:five_hour", "anthropic:seven_day", "opus",
      "anthropic:thirty_day", undefined].length;

    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE ExternalUsageEvent (
      id TEXT, provider TEXT, service TEXT, sourceApp TEXT, label TEXT,
      credits REAL, "limit" REAL, occurredAt INTEGER, createdAt INTEGER,
      metadata TEXT, metricType TEXT
    )`);
    const insert = db.prepare(`INSERT INTO ExternalUsageEvent VALUES (?, 'claude', NULL,
      'codecaps', '5h', 50, 100, ?, ?, ?, 'quota')`);
    for (const r of eventRows) insert.run(r.id, r.occurredAt, r.createdAt, JSON.stringify(r.metadata));
    mocks.queryRaw.mockImplementation((query) => db.prepare(query.sql).all(0));
    let viaSql: Array<{ metadata?: unknown }>;
    try {
      viaSql = await loadLatestQuotaWindowEvents(new Date(0));
    } finally {
      db.close();
    }

    mocks.queryRaw.mockReset();
    mocks.queryRaw.mockRejectedValue(new Error("sqlite busy"));
    mocks.findMany.mockResolvedValue(eventRows.map((r) => ({
      ...r, occurredAt: new Date(r.occurredAt), createdAt: new Date(r.createdAt),
    })));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let viaFallback: Array<{ metadata?: unknown }>;
    try {
      viaFallback = await loadLatestQuotaWindowEvents(new Date(0));
    } finally { errorSpy.mockRestore(); }

    const idsOf = (rows: Array<{ metadata?: unknown }>) => rows
      .map((r) => storedMetadataSchema.parse(
        typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata,
      ))
      .map((m) => JSON.stringify(m))
      .sort();
    expect(viaSql).toHaveLength(expected);
    expect(viaFallback).toHaveLength(expected);
    expect(idsOf(viaFallback)).toEqual(idsOf(viaSql));
  });

  it("keeps the highest-revision row per partition in the fallback", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("sqlite busy"));
    const occurredAt = new Date(2000);
    mocks.findMany.mockResolvedValue([
      // Newest receipt, lowest revision — must lose to the revision winner.
      { id: "late-old", occurredAt, createdAt: new Date(9000),
        metadata: { bucketId: "anthropic:five_hour", _producerInstanceId: "mac-a", planUserUpdatedAt: 10 } },
      { id: "winner", occurredAt, createdAt: new Date(3000),
        metadata: { bucketId: "anthropic:five_hour", _producerInstanceId: "mac-a", planUserUpdatedAt: 20 } },
      // A different partition is independent and must survive.
      { id: "other", occurredAt, createdAt: new Date(3000),
        metadata: { bucketId: "anthropic:seven_day", _producerInstanceId: "mac-a", planUserUpdatedAt: 1 } },
    ]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const rows = await loadLatestQuotaWindowEvents(new Date(0));
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => storedMetadataSchema.parse(r.metadata).planUserUpdatedAt).sort())
        .toEqual([1, 20]);
    } finally { errorSpy.mockRestore(); }
  });

  it("orders equal-observation fallback rows by valid producer revision", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("sqlite busy"));
    const base = { occurredAt: new Date(2000), createdAt: new Date(3000) };
    mocks.findMany.mockResolvedValue([
      { ...base, id: "late", metadata: { planUserUpdatedAt: "999" } },
      { ...base, id: "old", metadata: { planUserUpdatedAt: 10 } },
      { ...base, id: "new", metadata: { planUserUpdatedAt: 20 } },
    ]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const rows = await loadLatestQuotaWindowEvents(new Date(0));
      expect(rows[0].metadata).toEqual({ planUserUpdatedAt: 20 });
    } finally { errorSpy.mockRestore(); }
  });

  it("still falls back when Sentry.captureException throws", async () => {
    const since = new Date("2026-10-01T00:00:00.000Z");
    mocks.queryRaw.mockRejectedValue(new Error("sqlite busy"));
    mocks.captureException.mockImplementation(() => {
      throw new Error("sentry unavailable");
    });
    mocks.findMany.mockResolvedValue([]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await loadLatestQuotaWindowEvents(since);

    expect(mocks.findMany).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });
});
