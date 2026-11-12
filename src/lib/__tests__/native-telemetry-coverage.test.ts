import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedUsageTelemetryEvent } from "../usage-telemetry";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { externalUsageEvent: { findMany } },
}));
import { dropEventsCoveredByNative } from "../native-telemetry-coverage";

const transcript = (host: string): ParsedUsageTelemetryEvent => ({
  sourceApp: "claude-code", provider: "anthropic", service: "claude-code",
  billingMode: "estimated", metricType: "usage", confidence: "estimated",
  occurredAt: new Date("2026-10-30T12:00:00Z"), quantity: 1000, unit: "token",
  idempotencyKey: host, metadata: { collector: "transcript", "host.name": host, tokenType: "cacheRead" },
});
beforeEach(() => { findMany.mockReset(); });

describe("unproven native aggregate coverage", () => {
  it("retains cache reads beside native input telemetry on the same host", async () => {
    findMany.mockResolvedValue([{ occurredAt: new Date("2026-10-30T12:00:01Z"), metadata: { "host.name": "host-a", tokenType: "input" } }]);
    const events = [transcript("host-a")];
    expect(await dropEventsCoveredByNative(events)).toEqual({
      events, skippedNativeCovered: 0, nativeRowsConsidered: 0,
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("retains every transcript in a mixed-host batch beside one native feed", async () => {
    findMany.mockResolvedValue([{ occurredAt: new Date("2026-10-30T12:00:01Z"), metadata: { "host.name": "host-a" } }]);
    const events = [transcript("host-a"), transcript("host-b")];
    expect((await dropEventsCoveredByNative(events)).events).toBe(events);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("retains native, transcript and cash records even when lookup would fail", async () => {
    findMany.mockImplementation(() => { throw new Error("database unavailable"); });
    const events = [transcript("host-a"), { ...transcript("host-a"), metadata: {} },
      { ...transcript("host-a"), sourceApp: "other-producer", costUsd: 1 }];
    const result = await dropEventsCoveredByNative(events);
    expect(result.events).toBe(events);
    expect(result.skippedNativeCovered).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
