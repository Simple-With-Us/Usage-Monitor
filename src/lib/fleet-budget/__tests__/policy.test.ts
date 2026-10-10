import { describe, expect, it } from "vitest";
import { dayKey, nextDayStart, policySchema, requestSchema, upperBound, usageCost } from "../policy";
import { input, POLICY } from "./fixture";

describe("fleet policy units and Chicago days", () => {
  it("admits a full binary-million context bound without raising dollar ceilings", () => {
    for (const maxInputTokens of [1_000_000, 1_048_576]) {
      expect(requestSchema.safeParse(input("context", { maxInputTokens })).success).toBe(true);
      expect(policySchema.safeParse({ ...POLICY, deepseek: { ...POLICY.deepseek, maxInputTokens } }).success).toBe(true);
    }
    expect(requestSchema.safeParse(input("too-large", { maxInputTokens: 1_048_577 })).success).toBe(false);
    expect(policySchema.safeParse({ ...POLICY, deepseek: { ...POLICY.deepseek, maxInputTokens: 1_048_577 } }).success).toBe(false);
  });
  it("uses Chicago midnight across standard time and daylight time", () => {
    expect(dayKey(new Date("2026-01-02T05:59:59Z"))).toBe("2026-01-01");
    expect(dayKey(new Date("2026-01-02T06:00:00Z"))).toBe("2026-01-02");
    expect(dayKey(new Date("2026-07-02T04:59:59Z"))).toBe("2026-07-01");
    expect(dayKey(new Date("2026-07-02T05:00:00Z"))).toBe("2026-07-02");
  });
  it("handles both DST transitions without fixed 24-hour arithmetic", () => {
    expect(dayKey(new Date("2026-03-08T07:59:59Z"))).toBe("2026-03-08");
    expect(dayKey(new Date("2026-03-08T08:00:00Z"))).toBe("2026-03-08");
    expect(dayKey(new Date("2026-03-09T05:00:00Z"))).toBe("2026-03-09");
    expect(dayKey(new Date("2026-11-01T06:59:59Z"))).toBe("2026-11-01");
    expect(dayKey(new Date("2026-11-01T07:00:00Z"))).toBe("2026-11-01");
    expect(dayKey(new Date("2026-11-02T06:00:00Z"))).toBe("2026-11-02");
  });
  it("clips leases to the actual next local midnight, including DST-length days", () => {
    expect(nextDayStart(new Date("2026-03-08T06:00:00Z")).toISOString()).toBe("2026-03-09T05:00:00.000Z");
    expect(nextDayStart(new Date("2026-11-01T05:00:00Z")).toISOString()).toBe("2026-11-02T06:00:00.000Z");
  });
  it("allows lower limits but never an upward override of the policy ceiling", () => {
    expect(policySchema.safeParse({ ...POLICY, softLimitMicros: 400_000, hardLimitMicros: 1_000_000 }).success).toBe(true);
    expect(policySchema.safeParse({ ...POLICY, hardLimitMicros: 1_500_001 }).success).toBe(false);
    expect(policySchema.safeParse({ ...POLICY, softLimitMicros: 500_001 }).success).toBe(false);
  });
  it("rounds conservatively once using integer micro-USD", () => {
    const price = { ...POLICY.deepseek, inputMicrosPerMillion: 3, outputMicrosPerMillion: 3, cachedInputMicrosPerMillion: 0 };
    expect(upperBound(price, input("small", { maxInputTokens: 1, maxOutputTokens: 1 }))).toBe(BigInt(1));
    expect(usageCost(price, { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 })).toBe(BigInt(1));
  });
  it("reserves the higher input rate even for unusual cache pricing", () => {
    const price = { ...POLICY.deepseek, cachedInputMicrosPerMillion: 3_000_000 };
    expect(upperBound(price, input("cached"))).toBe(BigInt(400_000));
  });
  it("has no fabricated default model pricing and rejects malformed policy", () => {
    expect(policySchema.safeParse({}).success).toBe(false);
    expect(policySchema.safeParse({ ...POLICY, softLimitMicros: 2_000_000 }).success).toBe(false);
    expect(policySchema.safeParse({ ...POLICY, deepseek: { ...POLICY.deepseek, validUntil: "2027-10-10T00:00:00Z" } }).success).toBe(false);
    expect(policySchema.safeParse({ ...POLICY, deepseek: { ...POLICY.deepseek, source: "http://example.invalid" } }).success).toBe(false);
  });
});
