import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    externalUsageEvent: {
      findMany: mocks.findMany,
    },
    $queryRaw: mocks.queryRaw,
  },
}));

import { loadLatestQuotaWindowEvents } from "../quota-events-loader";

describe("loadLatestQuotaWindowEvents", () => {
  it("returns one row per partition from the window query", async () => {
    const since = new Date("2026-10-01T00:00:00.000Z");
    mocks.queryRaw.mockResolvedValue([
      {
        provider: "anthropic",
        service: null,
        label: "5h",
        credits: 80,
        limit: 100,
        occurredAt: new Date("2026-10-03T12:00:00.000Z"),
        metadata: { bucketId: "anthropic:five_hour", _producerInstanceId: "mac-a" },
      },
    ]);

    const rows = await loadLatestQuotaWindowEvents(since);
    expect(rows).toHaveLength(1);
    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("falls back to bounded findMany when the window query throws", async () => {
    const since = new Date("2026-10-01T00:00:00.000Z");
    mocks.queryRaw.mockRejectedValue(new Error("sqlite busy"));
    mocks.findMany.mockResolvedValue([]);

    await loadLatestQuotaWindowEvents(since);

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 400,
        where: { metricType: "quota", occurredAt: { gte: since } },
      }),
    );
  });
});
