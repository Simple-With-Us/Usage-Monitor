import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const prismaMock = vi.hoisted(() => ({
  usageSnapshot: { findMany: vi.fn() },
  usageSnapshotDailyRollup: { findMany: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import { GET } from "../route";

describe("GET /api/snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.usageSnapshot.findMany.mockResolvedValue([]);
    prismaMock.usageSnapshotDailyRollup.findMany.mockResolvedValue([]);
  });

  it("bounds the default raw query and selects the newest points", async () => {
    await GET(new NextRequest("https://usage.jays.services/api/snapshots?days=30"));

    expect(prismaMock.usageSnapshot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { fetchedAt: "desc" },
        take: 5_000,
      })
    );
  });

  it("clamps explicit bounds and falls back for invalid values", async () => {
    await GET(
      new NextRequest("https://usage.jays.services/api/snapshots?days=30&maxPoints=999999")
    );
    await GET(
      new NextRequest("https://usage.jays.services/api/snapshots?days=30&maxPoints=0")
    );
    await GET(
      new NextRequest("https://usage.jays.services/api/snapshots?days=30&maxPoints=invalid")
    );

    expect(prismaMock.usageSnapshot.findMany.mock.calls.map(([query]) => query.take)).toEqual([
      10_000,
      1,
      5_000,
    ]);
  });
});
