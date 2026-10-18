import { afterEach, describe, expect, it } from "vitest";
import {
  applyIngestCostDerivation,
  deriveEventCostEstimate,
  ingestCostDerivationEnabled,
  type CostDerivationEvent,
} from "../pricing/derive-ingest-cost";
import { PRICING_SNAPSHOT_META } from "../pricing/model-pricing";

const FLAG = "INGEST_COST_DERIVATION_ENABLED";

afterEach(() => {
  delete process.env[FLAG];
});

describe("ingestCostDerivationEnabled", () => {
  it("is default-off", () => {
    expect(ingestCostDerivationEnabled()).toBe(false);
  });

  it("accepts common truthy spellings and rejects others", () => {
    for (const value of ["true", "1", "yes", "TRUE", " Yes "]) {
      process.env[FLAG] = value;
      expect(ingestCostDerivationEnabled()).toBe(true);
    }
    for (const value of ["false", "0", "no", "on", ""]) {
      process.env[FLAG] = value;
      expect(ingestCostDerivationEnabled()).toBe(false);
    }
  });
});

describe("deriveEventCostEstimate", () => {
  it("derives from the matching token-type rate when tokenType is supplied", () => {
    const estimate = deriveEventCostEstimate({
      metricType: "usage",
      unit: "token",
      quantity: 1_000_000,
      keyRef: "claude-sonnet-4-5",
      metadata: { tokenType: "output" },
    });
    // Sonnet output: $15 / 1M.
    expect(estimate?.costUsd).toBeCloseTo(15, 6);
    expect(estimate?.pricingKey).toBe("claude-sonnet-4-5");
    expect(estimate?.incomplete).toBe(false);
  });

  it("falls back to the input-rate floor and flags incomplete when tokenType is absent", () => {
    const estimate = deriveEventCostEstimate({
      metricType: "usage",
      unit: "token",
      quantity: 1_000_000,
      keyRef: "claude-sonnet-4-5",
    });
    expect(estimate?.costUsd).toBeCloseTo(3, 6);
    expect(estimate?.incomplete).toBe(true);
  });

  it("resolves provider-prefixed keyRefs", () => {
    const estimate = deriveEventCostEstimate({
      metricType: "usage",
      unit: "token",
      quantity: 1_000_000,
      keyRef: "openrouter/anthropic/claude-sonnet-4-5",
      metadata: { tokenType: "input" },
    });
    expect(estimate?.pricingKey).toBe("claude-sonnet-4-5");
    expect(estimate?.incomplete).toBe(false);
  });

  it("returns null when the event already carries a producer cost", () => {
    expect(
      deriveEventCostEstimate({
        metricType: "usage",
        unit: "token",
        quantity: 100,
        costUsd: 0.01,
        keyRef: "gpt-4o",
      })
    ).toBeNull();
  });

  it("returns null for non-token or non-usage events", () => {
    expect(
      deriveEventCostEstimate({ metricType: "usage", unit: "request", quantity: 10, keyRef: "gpt-4o" })
    ).toBeNull();
    expect(
      deriveEventCostEstimate({ metricType: "cost", unit: "token", quantity: 10, keyRef: "gpt-4o" })
    ).toBeNull();
    expect(
      deriveEventCostEstimate({ metricType: "usage", unit: "token", quantity: 10 })
    ).toBeNull();
  });

  it("returns null for unknown models instead of inventing a price", () => {
    expect(
      deriveEventCostEstimate({
        metricType: "usage",
        unit: "token",
        quantity: 1000,
        keyRef: "not-a-real-model-zzz",
      })
    ).toBeNull();
  });

  it("returns null for non-positive quantities", () => {
    expect(
      deriveEventCostEstimate({ metricType: "usage", unit: "token", quantity: 0, keyRef: "gpt-4o" })
    ).toBeNull();
  });
});

describe("applyIngestCostDerivation", () => {
  it("is a no-op when the flag is disabled", () => {
    const events: CostDerivationEvent[] = [
      { metricType: "usage", unit: "token", quantity: 1_000_000, keyRef: "gpt-4o" },
    ];
    expect(applyIngestCostDerivation(events)).toBe(0);
    expect(events[0].metadata).toBeUndefined();
  });

  it("stamps metadata with cost, pricing key, snapshot provenance, and completeness", () => {
    process.env[FLAG] = "true";
    const events: CostDerivationEvent[] = [
      {
        metricType: "usage",
        unit: "token",
        quantity: 1_000_000,
        keyRef: "claude-sonnet-4-5",
        metadata: { tokenType: "input", existing: "kept" },
      },
      { metricType: "usage", unit: "token", quantity: 1_000_000, keyRef: "gpt-4o" },
      { metricType: "usage", unit: "request", quantity: 5, keyRef: "gpt-4o" },
    ];
    expect(applyIngestCostDerivation(events)).toBe(2);

    expect(events[0].metadata?._derivedCostUsd).toBeCloseTo(3, 6);
    expect(events[0].metadata?._derivedCostPricingKey).toBe("claude-sonnet-4-5");
    expect(events[0].metadata?._derivedCostSnapshot).toBe(PRICING_SNAPSHOT_META.fetchedAt);
    expect(events[0].metadata?._derivedCostIncomplete).toBeUndefined();
    expect(events[0].metadata?.existing).toBe("kept");

    // No tokenType -> input-rate floor, flagged incomplete.
    expect(events[1].metadata?._derivedCostIncomplete).toBe(true);

    // Non-token event untouched.
    expect(events[2].metadata).toBeUndefined();
  });
});

describe("deriveEventCostEstimate: 1h cache writes and [1m] models (UM-1591)", () => {
  const base = { metricType: "usage", unit: "token", quantity: 1_000_000 } as const;

  it("prices tokenType cacheCreation1h (and aliases) at the 1h rate", () => {
    for (const tokenType of ["cacheCreation1h", "cacheWrite1h", "cacheWriteOneHour"]) {
      const estimate = deriveEventCostEstimate({
        ...base,
        keyRef: "claude-sonnet-5-5",
        metadata: { tokenType },
      });
      expect(estimate?.costUsd, tokenType).toBeCloseTo(4, 6);
      expect(estimate?.incomplete, tokenType).toBe(false);
    }
  });

  it("keeps plain cacheCreation at the 5m rate unless metadata.cacheTtl says 1h", () => {
    const five = deriveEventCostEstimate({
      ...base,
      keyRef: "claude-sonnet-5-5",
      metadata: { tokenType: "cacheCreation" },
    });
    const hour = deriveEventCostEstimate({
      ...base,
      keyRef: "claude-sonnet-5-5",
      metadata: { tokenType: "cacheCreation", cacheTtl: "1h" },
    });
    expect(five?.costUsd).toBeCloseTo(2.5, 6);
    expect(hour?.costUsd).toBeCloseTo(4, 6);
  });

  it("resolves [1m] models and reports unknown versions as unpriced (null)", () => {
    const priced = deriveEventCostEstimate({
      ...base,
      keyRef: "claude-opus-5-5[1m]",
      metadata: { tokenType: "output" },
    });
    expect(priced?.pricingKey).toBe("claude-opus-5-5");
    expect(priced?.costUsd).toBeCloseTo(20, 6);
    expect(
      deriveEventCostEstimate({ ...base, keyRef: "claude-opus-5-9", metadata: { tokenType: "input" } })
    ).toBeNull();
  });
});
