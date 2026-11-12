import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  externalUsageEvent: { findMany: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  buildSnapshotVariableDayPeaks,
  dailyIncrementsFromSnapshotPeaks,
  loadMtdDailyVariableUsageByProviderId,
  maxDailySeries,
} from "../daily-usage-series";
import { calculateEomForecast, calculateEomForecastFromSeries } from "../forecasting";

describe("buildSnapshotVariableDayPeaks (S4)", () => {
  it("keeps one variable-cost peak per provider per UTC day", () => {
    const peaks = buildSnapshotVariableDayPeaks([
      {
        providerId: "p1",
        fetchedAt: new Date("2026-07-02T08:00:00.000Z"),
        totalCost: 20,
        fixedCostIncludedUsd: 5,
      },
      {
        providerId: "p1",
        fetchedAt: new Date("2026-07-02T20:00:00.000Z"),
        totalCost: 30,
        fixedCostIncludedUsd: 5,
      },
      {
        providerId: "p2",
        fetchedAt: new Date("2026-07-02T12:00:00.000Z"),
        totalCost: 7,
        fixedCostIncludedUsd: null,
      },
      {
        providerId: "p2",
        fetchedAt: new Date("2026-07-03T12:00:00.000Z"),
        totalCost: null,
        fixedCostIncludedUsd: null,
      },
    ]);
    expect(peaks.get("p1")).toEqual(new Map([["2026-07-02", 25]]));
    expect(peaks.get("p2")).toEqual(new Map([["2026-07-02", 7]]));
  });

  it("clamps the fixed portion to the snapshot total before differencing", () => {
    const peaks = buildSnapshotVariableDayPeaks([
      {
        providerId: "p1",
        fetchedAt: new Date("2026-07-02T08:00:00.000Z"),
        totalCost: 4,
        fixedCostIncludedUsd: 10, // fixed exceeds total → variable is 0
      },
    ]);
    expect(peaks.get("p1")).toEqual(new Map([["2026-07-02", 0]]));
  });
});


describe("daily-usage-series helpers (Wave J / E11)", () => {
  it("builds incremental series from cumulative snapshot peaks", () => {
    const monthStart = new Date("2026-07-01T00:00:00.000Z");
    const now = new Date("2026-07-04T12:00:00.000Z");
    const peaks = new Map([
      ["2026-07-01", 10],
      ["2026-07-02", 25],
      ["2026-07-04", 40],
    ]);
    const series = dailyIncrementsFromSnapshotPeaks(peaks, monthStart, now);
    expect(series).toEqual([10, 15, 0, 15]);
  });

  it("takes element-wise max of two series", () => {
    expect(maxDailySeries([1, 5, 0], [2, 3, 9])).toEqual([2, 5, 9]);
    expect(maxDailySeries(null, [1, 2])).toEqual([1, 2]);
    expect(maxDailySeries([1], null)).toEqual([1]);
    expect(maxDailySeries(null, null)).toBeNull();
  });
});

describe("OpenCode daily cash series", () => {
  beforeEach(() => vi.clearAllMocks());

  it("includes PAYG message cost and excludes OpenCode subscription and Fx estimates", async () => {
    prismaMock.externalUsageEvent.findMany.mockResolvedValue([
      { sourceApp: "opencode", provider: "anthropic", service: "opencode", label: "api-equivalent", metricType: "cost", billingMode: "estimated", costUsd: 12, occurredAt: new Date("2026-07-02T12:00:00.000Z") },
      { sourceApp: "opencode", provider: "muse-code", service: "opencode", label: "api-equivalent", metricType: "cost", billingMode: "estimated", costUsd: 7, occurredAt: new Date("2026-07-02T12:00:00.000Z") },
      { sourceApp: "opencode", provider: "anthropic", service: "opencode", label: "other", metricType: "cost", billingMode: "estimated", costUsd: 4, occurredAt: new Date("2026-07-02T12:00:00.000Z") },
      { sourceApp: "fx", provider: "xai", service: "fx", label: "api-equivalent", metricType: "cost", billingMode: "estimated", costUsd: 3, occurredAt: new Date("2026-07-02T12:00:00.000Z") },
    ]);

    const series = await loadMtdDailyVariableUsageByProviderId(
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-07-03T00:00:00.000Z"),
      [
        { id: "anthropic-id", name: "anthropic" },
        { id: "muse-id", name: "muse-code" },
        { id: "xai-id", name: "xai" },
      ]
    );
    expect(series.get("anthropic-id")).toEqual([0, 12, 0]);
    expect(series.has("muse-id")).toBe(false);
    expect(series.has("xai-id")).toBe(false);
  });
});

describe("calculateEomForecastFromSeries fallback (Wave J / E11)", () => {
  it("linear-extrapolates usageSoFarFallback when series is empty", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const withFallback = calculateEomForecastFromSeries([], 10, now, {
      usageSoFarFallback: 50,
    });
    const linear = calculateEomForecast(60, 10, now);
    expect(withFallback).toBeCloseTo(linear, 8);
  });

  it("uses series projection when daily samples exist", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    // Rising daily usage: series forecast should exceed pure average-rate
    // linear on early days of a steep ramp.
    const daily = [1, 2, 3, 4, 5, 6, 7, 8, 9, 20];
    const seriesTotal = calculateEomForecastFromSeries(daily, 0, now);
    const linearTotal = calculateEomForecast(
      daily.reduce((a, b) => a + b, 0),
      0,
      now
    );
    expect(seriesTotal).toBeGreaterThan(linearTotal);
  });
});
