import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { externalUsageEvent: { findFirst: (...args: unknown[]) => findFirst(...args) } },
}));
const sendPushover = vi.fn();
vi.mock("@/lib/r2-usage", () => ({
  sendPushoverNotification: (...args: unknown[]) => sendPushover(...args),
}));

import {
  assessStreamAge,
  formatStaleStreamsMessage,
  resetProducerStalenessForTests,
  runProducerStalenessCheck,
  type ProducerStreamRule,
} from "../producer-staleness";

const now = new Date("2026-10-17T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
const rule: ProducerStreamRule = { sourceApp: "grok-build", metricType: "usage", maxAgeHours: 24 };

describe("assessStreamAge", () => {
  it("is fresh within the allowance", () => {
    expect(assessStreamAge(rule, hoursAgo(23), now)).toBeNull();
  });
  it("is stale past the allowance", () => {
    const stale = assessStreamAge(rule, hoursAgo(30), now);
    expect(stale).toMatchObject({ sourceApp: "grok-build", ageHours: 30 });
  });
  it("treats a stream with no rows as stale", () => {
    expect(assessStreamAge(rule, null, now)).toMatchObject({ lastSeenAt: null, ageHours: null });
  });
});

describe("runProducerStalenessCheck", () => {
  beforeEach(() => {
    resetProducerStalenessForTests();
    findFirst.mockReset();
    sendPushover.mockReset();
    process.env.USAGE_MONITOR_DATA_DIR = "/nonexistent-producer-staleness-dir";
    delete process.env.USAGE_PRODUCER_STALENESS_DISABLED;
  });
  afterEach(() => {
    delete process.env.USAGE_MONITOR_DATA_DIR;
  });

  it("sends nothing when every stream is fresh", async () => {
    findFirst.mockResolvedValue({ occurredAt: hoursAgo(1) });
    const result = await runProducerStalenessCheck(vi.fn() as unknown as typeof fetch, now);
    expect(result.stale).toEqual([]);
    expect(sendPushover).not.toHaveBeenCalled();
  });

  it("alerts once for an unchanged stale set, throttles repeat sweeps", async () => {
    findFirst.mockResolvedValue({ occurredAt: hoursAgo(500) });
    sendPushover.mockResolvedValue({ ok: true });
    const first = await runProducerStalenessCheck(vi.fn() as unknown as typeof fetch, now);
    expect(first.alertSent).toBe(true);
    expect(sendPushover).toHaveBeenCalledTimes(1);

    const sooner = await runProducerStalenessCheck(
      vi.fn() as unknown as typeof fetch,
      new Date(now.getTime() + 10 * 60_000)
    );
    expect(sooner.skipped).toBe("throttled");

    const nextHour = await runProducerStalenessCheck(
      vi.fn() as unknown as typeof fetch,
      new Date(now.getTime() + 61 * 60_000)
    );
    expect(nextHour.stale.length).toBeGreaterThan(0);
    expect(nextHour.alertSent).toBe(false);
    expect(sendPushover).toHaveBeenCalledTimes(1);
  });

  it("can be disabled", async () => {
    process.env.USAGE_PRODUCER_STALENESS_DISABLED = "1";
    const result = await runProducerStalenessCheck(vi.fn() as unknown as typeof fetch, now);
    expect(result.skipped).toBe("disabled");
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("formatStaleStreamsMessage", () => {
  it("names each quiet stream", () => {
    const msg = formatStaleStreamsMessage([
      { ...rule, lastSeenAt: "2026-10-15T00:00:00.000Z", ageHours: 60 },
      { ...rule, sourceApp: "x", lastSeenAt: null, ageHours: null },
    ]);
    expect(msg.title).toContain("2 producer streams");
    expect(msg.body).toContain("grok-build usage: quiet 60h");
    expect(msg.body).toContain("x usage: no rows at all");
  });
});
