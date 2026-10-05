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
        where: { metricType: "quota", occurredAt: { gte: since } },
      }),
    );
    errorSpy.mockRestore();
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
