import { describe, it, expect } from "vitest";
import {
  gemini4PricingForDate,
  gemini4RatePeriod,
  isGemini4DatedModel,
  priceGemini4UsageEvent,
  sumGemini4DatedEvents,
} from "../pricing/gemini4-dated";
import { getModelPricing, resolvePricingKey } from "../pricing/model-pricing";

// Gemini 4 Argon / Carbon introductory rates run through Nov 30, 2026 and
// double on Dec 1, 2026 (input $2 -> $4, output $10 -> $20, cached input
// $0.10 -> $0.20 per 1M tokens).  The LiteLLM snapshot holds only the
// introductory Argon rates and no Carbon rows, so both models are priced
// per event from occurredAt and the flat lookup stays null.
const NOV_15 = new Date("2026-11-15T12:00:00Z");
const NOV_30_END = new Date("2026-11-30T23:59:59Z");
const DEC_1_START = new Date("2026-12-01T00:00:00Z");
const DEC_15 = new Date("2026-12-15T12:00:00Z");

describe("isGemini4DatedModel", () => {
  it("matches both models bare and provider-prefixed", () => {
    expect(isGemini4DatedModel("gemini-4-argon")).toBe(true);
    expect(isGemini4DatedModel("gemini-4-carbon")).toBe(true);
    expect(isGemini4DatedModel("gemini/gemini-4-argon")).toBe(true);
    expect(isGemini4DatedModel("vertex_ai/gemini-4-argon")).toBe(true);
    expect(isGemini4DatedModel("google/gemini-4-carbon")).toBe(true);
  });

  it("does not match other Gemini models or the cyber-permissive variant", () => {
    expect(isGemini4DatedModel("gemini-3.8-flash")).toBe(false);
    expect(isGemini4DatedModel("gemini-4-neon")).toBe(false);
    expect(isGemini4DatedModel("vertex_ai/gemini-4-argon-cyber-permissive")).toBe(false);
    expect(isGemini4DatedModel("")).toBe(false);
  });
});

describe("gemini4PricingForDate", () => {
  it("prices a November date at the introductory rates", () => {
    for (const model of ["gemini-4-argon", "gemini-4-carbon"]) {
      const entry = gemini4PricingForDate(model, NOV_15);
      expect(entry?.input_cost_per_token).toBeCloseTo(2e-6, 12);
      expect(entry?.output_cost_per_token).toBeCloseTo(1e-5, 12);
      expect(entry?.cache_read_input_token_cost).toBeCloseTo(1e-7, 12);
    }
  });

  it("prices a December date at the doubled rates", () => {
    for (const model of ["gemini-4-argon", "gemini-4-carbon"]) {
      const entry = gemini4PricingForDate(model, DEC_15);
      expect(entry?.input_cost_per_token).toBeCloseTo(4e-6, 12);
      expect(entry?.output_cost_per_token).toBeCloseTo(2e-5, 12);
      expect(entry?.cache_read_input_token_cost).toBeCloseTo(2e-7, 12);
    }
  });

  it("turns at the Dec 1, 2026 UTC boundary", () => {
    expect(gemini4RatePeriod(NOV_30_END)).toBe("introductory");
    expect(gemini4RatePeriod(DEC_1_START)).toBe("doubled");
    expect(gemini4PricingForDate("gemini-4-argon", NOV_30_END)?.input_cost_per_token).toBeCloseTo(2e-6, 12);
    expect(gemini4PricingForDate("gemini-4-argon", DEC_1_START)?.input_cost_per_token).toBeCloseTo(4e-6, 12);
  });

  it("returns null for other models and invalid dates", () => {
    expect(gemini4PricingForDate("gemini-3.8-flash", NOV_15)).toBeNull();
    expect(gemini4PricingForDate("gemini-4-argon", new Date("not-a-date"))).toBeNull();
  });
});

describe("priceGemini4UsageEvent", () => {
  it("prices 1M of each token type at $12.10 in November and $24.20 in December", () => {
    for (const [date, expected] of [
      [NOV_15, 12.1],
      [DEC_15, 24.2],
    ] as const) {
      const sum = sumGemini4DatedEvents([
        { model: "gemini-4-argon", occurredAt: date, label: "token:input", quantity: 1_000_000 },
        { model: "gemini-4-argon", occurredAt: date, label: "token:output", quantity: 1_000_000 },
        { model: "gemini-4-argon", occurredAt: date, label: "token:cacheRead", quantity: 1_000_000 },
      ]);
      expect(sum.complete).toBe(true);
      expect(sum.costUsd).toBeCloseTo(expected, 6);
    }
  });

  it("splits a sum across the Dec 1 boundary by each event's own date", () => {
    const sum = sumGemini4DatedEvents([
      { model: "gemini-4-carbon", occurredAt: NOV_15, label: "token:input", quantity: 1_000_000 },
      { model: "gemini-4-carbon", occurredAt: DEC_15, label: "token:input", quantity: 1_000_000 },
    ]);
    // $2.00 of November input + $4.00 of December input.
    expect(sum.costUsd).toBeCloseTo(6, 6);
    expect(sum.seenQuantity).toBe(2_000_000);
  });

  it("marks cache-creation tokens incomplete at the cached-input rate", () => {
    const priced = priceGemini4UsageEvent({
      model: "gemini-4-argon",
      occurredAt: DEC_15,
      label: "token:cacheCreation",
      quantity: 1_000_000,
    });
    expect(priced?.complete).toBe(false);
    expect(priced?.costUsd).toBeCloseTo(0.2, 6);
  });

  it("ignores other models and empty quantities", () => {
    expect(
      priceGemini4UsageEvent({
        model: "claude-sonnet-4-5",
        occurredAt: NOV_15,
        label: "token:input",
        quantity: 100,
      }),
    ).toBeNull();
    expect(
      priceGemini4UsageEvent({
        model: "gemini-4-argon",
        occurredAt: NOV_15,
        label: "token:input",
        quantity: 0,
      }),
    ).toEqual({ costUsd: 0, complete: true, seenQuantity: 0 });
  });
});

describe("flat catalog lookup", () => {
  it("does not apply a flat Gemini 4 catalog rate without an event date", () => {
    expect(resolvePricingKey("gemini-4-argon")).toBeNull();
    expect(resolvePricingKey("gemini/gemini-4-argon")).toBeNull();
    expect(resolvePricingKey("vertex_ai/gemini-4-argon")).toBeNull();
    expect(resolvePricingKey("gemini-4-carbon")).toBeNull();
    expect(getModelPricing("gemini-4-argon")).toBeNull();
    expect(getModelPricing("google/gemini-4-carbon")).toBeNull();
  });

  it("leaves the cyber-permissive variant on its own snapshot row", () => {
    const variant = getModelPricing("vertex_ai/gemini-4-argon-cyber-permissive");
    expect(variant?.pricing.input_cost_per_token).toBeCloseTo(4e-6, 12);
    expect(variant?.pricing.output_cost_per_token).toBeCloseTo(2e-5, 12);
  });
});
