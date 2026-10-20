import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
      expect(JSON.parse(rows[0].metadata as string).planUserName).toBe("New");
      insert.run("z-tie", 2000, 4000, JSON.stringify({ planUserName: "Stable tie" }));
      const tied = await loadLatestQuotaWindowEvents(new Date(0));
      expect(JSON.parse(tied[0].metadata as string).planUserName).toBe("Stable tie");
      insert.run("revision-b", 2000, 6000, JSON.stringify({ planUserName: "B", planUserUpdatedAt: 10 }));
      insert.run("revert-a", 2000, 7000, JSON.stringify({ planUserName: "A", planUserUpdatedAt: 20 }));
      insert.run("delayed-b", 2000, 8000, JSON.stringify({ planUserName: "B", planUserUpdatedAt: 10 }));
      insert.run("invalid", 2000, 9000, JSON.stringify({ planUserName: "Invalid", planUserUpdatedAt: "999999" }));
      const reverted = await loadLatestQuotaWindowEvents(new Date(0));
      expect(JSON.parse(reverted[0].metadata as string).planUserName).toBe("A");
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
        take: 400,
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        where: { metricType: "quota", occurredAt: { gte: since } },
      }),
    );
    errorSpy.mockRestore();
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
