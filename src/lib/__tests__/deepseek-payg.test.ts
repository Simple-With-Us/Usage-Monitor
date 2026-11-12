import { describe, expect, it } from "vitest";
import {
  deepSeekPaygFamily,
  isDeepSeekPeakUtc,
  priceDeepSeekUsageEvent,
  sumDeepSeekPaygEvents,
} from "../pricing/deepseek-payg";
import { getModelPricing, resolvePricingKey } from "../pricing/model-pricing";

describe("isDeepSeekPeakUtc", () => {
  // 2026-09-21 is a Monday.  Windows are half-open [01:00, 04:00) and
  // [06:00, 10:00) UTC.  04:00 and 10:00 themselves are off-peak.
  it("treats weekday peak hours as peak and the gap plus edges as off-peak", () => {
    expect(isDeepSeekPeakUtc(new Date("2026-09-21T00:59:59.000Z"))).toBe(false);
    expect(isDeepSeekPeakUtc(new Date("2026-09-21T01:00:00.000Z"))).toBe(true);
    expect(isDeepSeekPeakUtc(new Date("2026-09-21T03:59:59.000Z"))).toBe(true);
    expect(isDeepSeekPeakUtc(new Date("2026-09-21T04:00:00.000Z"))).toBe(false);
    expect(isDeepSeekPeakUtc(new Date("2026-09-21T05:59:59.000Z"))).toBe(false);
    expect(isDeepSeekPeakUtc(new Date("2026-09-21T06:00:00.000Z"))).toBe(true);
    expect(isDeepSeekPeakUtc(new Date("2026-09-21T09:59:59.000Z"))).toBe(true);
    expect(isDeepSeekPeakUtc(new Date("2026-09-21T10:00:00.000Z"))).toBe(false);
    expect(isDeepSeekPeakUtc(new Date("2026-09-21T23:00:00.000Z"))).toBe(false);
  });

  it("treats Saturday and Sunday as off-peak inside a weekday peak hour", () => {
    expect(isDeepSeekPeakUtc(new Date("2026-09-19T02:00:00.000Z"))).toBe(false);
    expect(isDeepSeekPeakUtc(new Date("2026-09-20T07:30:00.000Z"))).toBe(false);
  });

  it("keeps Friday inside the second window as peak", () => {
    expect(isDeepSeekPeakUtc(new Date("2026-09-25T09:00:00.000Z"))).toBe(true);
  });
});

describe("sumDeepSeekPaygEvents", () => {
  it("sums each event at its own UTC window and keeps off-peak at half of peak", () => {
    const summed = sumDeepSeekPaygEvents([
      {
        model: "deepseek-v4-flash",
        occurredAt: new Date("2026-09-21T02:00:00.000Z"),
        label: "token:input",
        quantity: 2_000_000,
      },
      {
        model: "deepseek-v4-flash",
        occurredAt: new Date("2026-09-21T02:00:00.000Z"),
        label: "token:cacheRead",
        quantity: 1_000_000,
      },
      {
        model: "deepseek-v4-flash",
        occurredAt: new Date("2026-09-21T05:00:00.000Z"),
        label: "token:output",
        quantity: 500_000,
      },
      {
        model: "deepseek-v4-pro",
        occurredAt: new Date("2026-09-19T02:00:00.000Z"),
        label: "token:output",
        quantity: 1_000_000,
      },
      {
        model: "deepseek-flash",
        occurredAt: new Date("2026-09-21T08:00:00.000Z"),
        label: "token:input",
        quantity: 1_000_000,
      },
    ]);

    // Flash peak miss 2M * $0.30, peak hit 1M * $0.006, off-peak output
    // 0.5M * $0.60, weekend Pro output 1M * $1.98, Flash peak miss 1M * $0.30.
    expect(summed.complete).toBe(true);
    expect(summed.seenQuantity).toBe(5_500_000);
    expect(summed.costUsd).toBeCloseTo(0.6 + 0.006 + 0.3 + 1.98 + 0.3, 8);
  });

  it("prices cache-write and unsplit input at the cache-miss rate and marks them incomplete", () => {
    const write = priceDeepSeekUsageEvent({
      model: "deepseek-v4-pro",
      occurredAt: new Date("2026-09-21T12:00:00.000Z"),
      label: "token:cacheCreation",
      quantity: 1_000_000,
    });
    expect(write?.complete).toBe(false);
    expect(write?.costUsd).toBeCloseTo(0.66, 8);

    const unsplit = priceDeepSeekUsageEvent({
      model: "deepseek/deepseek-v4-flash",
      occurredAt: new Date("2026-09-21T02:00:00.000Z"),
      label: "token:inputUnsplit",
      quantity: 1_000_000,
    });
    expect(unsplit?.complete).toBe(false);
    expect(unsplit?.costUsd).toBeCloseTo(0.3, 8);
  });

  it("bills legacy flash ids at the Flash table and leaves a flat catalog lookup unknown", () => {
    expect(deepSeekPaygFamily("openrouter/deepseek/deepseek-v4-flash-20260913")).toBe("flash");
    expect(deepSeekPaygFamily("deepseek-v4-flash-vision-exp")).toBe("flash");
    expect(deepSeekPaygFamily("deepseek-chat")).toBeNull();
    const legacy = priceDeepSeekUsageEvent({
      model: "deepseek-v4-flash-vision-exp",
      occurredAt: new Date("2026-09-20T02:00:00.000Z"),
      label: "token:output",
      quantity: 1_000_000,
    });
    expect(legacy?.complete).toBe(true);
    expect(legacy?.costUsd).toBeCloseTo(0.6, 8);
    expect(resolvePricingKey("deepseek-v4-flash")).toBeNull();
    expect(resolvePricingKey("deepseek-v4-pro")).toBeNull();
    expect(resolvePricingKey("deepseek-flash")).toBeNull();
    expect(getModelPricing("deepseek-v4-pro")).toBeNull();
  });
});
