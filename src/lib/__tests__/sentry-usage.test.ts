import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, findFirst } = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    provider: { findMany },
    usageSnapshot: { findFirst },
  },
}));

import { fetchSentryUsage } from "@/lib/sentry-usage";

describe("fetchSentryUsage", () => {
  beforeEach(() => {
    findMany.mockReset();
    findFirst.mockReset();
  });

  it("returns unconfigured when no Sentry provider exists", async () => {
    findMany.mockResolvedValue([{ id: "p1", name: "openai" }]);
    await expect(fetchSentryUsage()).resolves.toEqual({ configured: false });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("returns category totals with balance, cost, and credits null and billingCost false", async () => {
    findMany.mockResolvedValue([{ id: "sentry-1", name: "Sentry" }]);
    findFirst.mockResolvedValue({
      fetchedAt: new Date("2026-09-04T12:00:00.000Z"),
      rawData: {
        period: {
          scope: "calendar_month_to_date",
          start: "2026-09-01T00:00:00.000Z",
          end: "2026-09-04T12:00:00.000Z",
        },
        categories: {
          byCategory: [
            {
              category: "error",
              label: "Errors",
              family: "Errors",
              unit: "events",
              accepted: 12,
              rateLimited: 3,
              filtered: 0,
              other: 0,
              total: 15,
            },
          ],
        },
        stats: { capabilities: { billingCost: false } },
      },
    });

    const result = await fetchSentryUsage();
    expect(result).toEqual({
      configured: true,
      providerId: "sentry-1",
      fetchedAt: "2026-09-04T12:00:00.000Z",
      period: {
        scope: "calendar_month_to_date",
        start: "2026-09-01T00:00:00.000Z",
        end: "2026-09-04T12:00:00.000Z",
      },
      byCategory: [
        expect.objectContaining({
          label: "Errors",
          accepted: 12,
          rateLimited: 3,
        }),
      ],
      billingCost: false,
      balance: null,
      totalCost: null,
      credits: null,
    });
  });
});
