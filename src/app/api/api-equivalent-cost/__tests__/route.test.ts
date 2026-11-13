import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as retention from "@/lib/data-retention";

const prismaMock = vi.hoisted(() => ({
  externalUsageEvent: { groupBy: vi.fn() },
  externalUsageEventDailyRollup: { groupBy: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import { GET } from "../route";

describe("GET /api/api-equivalent-cost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(retention, "getExternalEventRawCutoff").mockReturnValue(new Date(0));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retains OpenCode token coverage but excludes PAYG cash from reported estimates", async () => {
    prismaMock.externalUsageEvent.groupBy.mockImplementation(async (args: {
      where: { metricType: string };
      by: string[];
    }) => {
      if (args.where.metricType === "usage") {
        return [
          { sourceApp: "opencode", provider: "openrouter", keyRef: "claude-sonnet-4-5", label: "token:input", _sum: { quantity: 1_000_000 } },
          { sourceApp: "fx", provider: "xai", keyRef: "grok-4.6", label: "token:input", _sum: { quantity: 1_000_000 } },
        ];
      }
      expect(args.by).toEqual(["provider", "sourceApp", "service", "keyRef", "label"]);
      return [
        { sourceApp: "opencode", provider: "openrouter", service: "opencode", keyRef: "claude-sonnet-4-5", label: "api-equivalent", _sum: { costUsd: 5 } },
        { sourceApp: "opencode", provider: "muse-code", service: "opencode", keyRef: "claude-sonnet-4-5", label: "api-equivalent", _sum: { costUsd: 7 } },
        { sourceApp: "fx", provider: "xai", service: "fx", keyRef: "grok-4.6", label: "api-equivalent", _sum: { costUsd: 2 } },
      ];
    });

    const response = await GET(new NextRequest("https://usage.jays.services/api/api-equivalent-cost?days=30"));
    expect(response.status).toBe(200);
    const body = await response.json();
    const openrouter = body.providers.find((row: { provider: string }) => row.provider === "openrouter");
    const museCode = body.providers.find((row: { provider: string }) => row.provider === "muse-code");
    expect(openrouter.totals.derivedCostUsd).toBe(3);
    expect(openrouter.totals.reportedCostUsd).toBe(0);
    expect(museCode.totals.reportedCostUsd).toBe(7);
    expect(body.totals.reportedCostUsd).toBe(9);
    const tokenQuery = prismaMock.externalUsageEvent.groupBy.mock.calls.find(
      ([args]) => args.where.metricType === "usage",
    )?.[0];
    expect(tokenQuery.where.sourceApp.in).toContain("opencode");
    expect(tokenQuery.where.sourceApp.in).toContain("fx");
    expect(prismaMock.externalUsageEventDailyRollup.groupBy).not.toHaveBeenCalled();
  });

  it("combines retained raw rows with older rollups once and filters PAYG cost on both sides", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    vi.mocked(retention.getExternalEventRawCutoff).mockReturnValue(
      new Date("2026-07-01T00:00:00.000Z"),
    );
    prismaMock.externalUsageEvent.groupBy.mockImplementation(async (args: {
      where: { metricType: string; occurredAt: { gte: Date } };
    }) => {
      expect(args.where.occurredAt.gte).toEqual(new Date("2026-07-01T00:00:00.000Z"));
      if (args.where.metricType === "usage") {
        return [{ sourceApp: "opencode", provider: "openrouter", keyRef: "claude-sonnet-4-5", label: "token:input", _sum: { quantity: 500_000 } }];
      }
      return [
        { sourceApp: "opencode", provider: "openrouter", service: "opencode", keyRef: "claude-sonnet-4-5", label: "api-equivalent", _sum: { costUsd: 5 } },
        { sourceApp: "opencode", provider: "muse-code", service: "opencode", keyRef: "claude-sonnet-4-5", label: "api-equivalent", _sum: { costUsd: 7 } },
      ];
    });
    prismaMock.externalUsageEventDailyRollup.groupBy.mockImplementation(async (args: {
      where: { metricType: string; day: { gte: Date; lt: Date } };
    }) => {
      expect(args.where.day).toEqual({
        gte: new Date("2026-06-15T00:00:00.000Z"),
        lt: new Date("2026-07-01T00:00:00.000Z"),
      });
      if (args.where.metricType === "usage") {
        return [{ sourceApp: "opencode", provider: "openrouter", keyRef: "claude-sonnet-4-5", label: "token:input", _sum: { totalQuantity: 500_000 } }];
      }
      return [
        { sourceApp: "opencode", provider: "openrouter", service: "opencode", keyRef: "claude-sonnet-4-5", label: "api-equivalent", _sum: { totalCostUsd: 4 } },
        { sourceApp: "opencode", provider: "muse-code", service: "opencode", keyRef: "claude-sonnet-4-5", label: "api-equivalent", _sum: { totalCostUsd: 2 } },
      ];
    });

    const response = await GET(new NextRequest("https://usage.jays.services/api/api-equivalent-cost?days=30"));
    expect(response.status).toBe(200);
    const body = await response.json();
    const openrouter = body.providers.find((row: { provider: string }) => row.provider === "openrouter");
    const museCode = body.providers.find((row: { provider: string }) => row.provider === "muse-code");
    expect(openrouter.totals.derivedCostUsd).toBe(3);
    expect(openrouter.totals.reportedCostUsd).toBe(0);
    expect(museCode.totals.reportedCostUsd).toBe(9);
    expect(body.totals.reportedCostUsd).toBe(9);
    expect(prismaMock.externalUsageEvent.groupBy).toHaveBeenCalledTimes(2);
    expect(prismaMock.externalUsageEventDailyRollup.groupBy).toHaveBeenCalledTimes(2);
  });
});
