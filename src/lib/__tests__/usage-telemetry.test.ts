import { describe, it, expect } from "vitest";
import { parseUsageTelemetryBatch } from "../usage-telemetry";

// ---------------------------------------------------------------------------
// Idempotency key tests — these match the shared test vectors that the
// congress-trading-shared repo also uses, so both repos can verify that their
// deriveIdempotencyKey implementations produce identical bytes.
// ---------------------------------------------------------------------------

// All derived keys must be exactly 64 hex characters (SHA-256).
const SHA256_HEX_LENGTH = 64;
const HEX_PATTERN = /^[0-9a-f]{64}$/;

describe("deriveIdempotencyKey", () => {
  // ---- Shared contract vectors (byte-for-byte with congress-trading-shared) ---
  // These hashes MUST match src/__tests__/usageTelemetry.test.ts in the shared
  // package. If they diverge, the cross-app idempotency contract is broken.

  it("vector 1: basic usage event", () => {
    const events = parseUsageTelemetryBatch({
      sourceApp: "congress-trade",
      provider: "cloudflare",
      metricType: "usage",
      keyRef: "",
      occurredAt: "2026-01-15T10:30:00.000Z",
    });
    expect(events).toHaveLength(1);
    expect(events[0].idempotencyKey).toBe(
      "a580c6a4b2836b7ee5474f00200d2f073245369701273bc7764869783eb07343",
    );
  });

  it("vector 2: different sourceApp", () => {
    const events = parseUsageTelemetryBatch({
      sourceApp: "agentic-trading",
      provider: "cloudflare",
      metricType: "usage",
      keyRef: "",
      occurredAt: "2026-01-15T10:30:00.000Z",
    });
    expect(events[0].idempotencyKey).toBe(
      "0a7d4876d2f48397f04dcb6d8a61fd73e61d7b3ac518e9e4617016f1f55cc3e8",
    );
  });

  it("vector 3: different provider", () => {
    const events = parseUsageTelemetryBatch({
      sourceApp: "congress-trade",
      provider: "pinecone",
      metricType: "usage",
      keyRef: "",
      occurredAt: "2026-01-15T10:30:00.000Z",
    });
    expect(events[0].idempotencyKey).toBe(
      "cb9a7853f5641727929d6a065f5ae06999981120ac8c597e84394ba2b962a363",
    );
  });

  it("vector 4: with non-empty keyRef", () => {
    const events = parseUsageTelemetryBatch({
      sourceApp: "congress-trade",
      provider: "cloudflare",
      metricType: "usage",
      keyRef: "api-usage-monitor-lite",
      occurredAt: "2026-01-15T10:30:00.000Z",
    });
    expect(events[0].idempotencyKey).toBe(
      "300ff3d978e9153e616c1e2d7d30d67cb20d6360fe37702df19f31e4338fcacb",
    );
  });

  it("vector 5: different metricType", () => {
    const events = parseUsageTelemetryBatch({
      sourceApp: "congress-trade",
      provider: "cloudflare",
      metricType: "cost",
      keyRef: "",
      occurredAt: "2026-01-15T10:30:00.000Z",
    });
    expect(events[0].idempotencyKey).toBe(
      "683201827280518fcd9657a54790ddf2122b6aac7b8f87b88aaf26b860fe2593",
    );
  });

  it("vector 6: different timestamp", () => {
    const events = parseUsageTelemetryBatch({
      sourceApp: "congress-trade",
      provider: "cloudflare",
      metricType: "usage",
      keyRef: "",
      occurredAt: "2026-01-16T14:45:00.000Z",
    });
    expect(events[0].idempotencyKey).toBe(
      "9693f31f9477e3a8c9864147a8ecb3310ef7e7f6027e3dea92aeeffc49271f63",
    );
  });

  it("vector 7: special characters in provider name", () => {
    const events = parseUsageTelemetryBatch({
      sourceApp: "congress-trade",
      provider: "acme-corp|v2",
      metricType: "usage",
      keyRef: "",
      occurredAt: "2026-01-15T10:30:00.000Z",
    });
    expect(events[0].idempotencyKey).toBe(
      "32a0a0b13d5b3edafd460655d6fb9b6d277c2f87c2c4be6460b1bcd2f3d701e0",
    );
  });

  // ---- Determinism: same input → same key -------------------------------

  it("produces the same key for identical inputs across multiple calls", () => {
    const input = {
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "usage",
      keyRef: "gpt-5.5",
      occurredAt: "2026-06-15T00:00:00.000Z",
    };
    const key1 = parseUsageTelemetryBatch(input)[0].idempotencyKey;
    const key2 = parseUsageTelemetryBatch(input)[0].idempotencyKey;
    const key3 = parseUsageTelemetryBatch(input)[0].idempotencyKey;
    expect(key1).toBe(key2);
    expect(key1).toBe(key3);
  });

  it("preserves the mandated five-field basis when non-basis lane data differs", () => {
    const [first, second] = parseUsageTelemetryBatch({
      events: [
        {
          sourceApp: "socratic-trade",
          provider: "openai",
          metricType: "cost",
          keyRef: "shared-key-ref",
          occurredAt: "2026-06-15T00:00:00.000Z",
          label: "lane-a",
          costUsd: 1,
        },
        {
          sourceApp: "socratic-trade",
          provider: "openai",
          metricType: "cost",
          keyRef: "shared-key-ref",
          occurredAt: "2026-06-15T00:00:00.000Z",
          label: "lane-b",
          costUsd: 2,
        },
      ],
    });
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
  });

  // ---- Uniqueness: different inputs → different keys --------------------

  it("produces different keys for different sourceApp values", () => {
    const a = parseUsageTelemetryBatch({
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "usage",
      keyRef: "gpt-5.5",
      occurredAt: "2026-06-15T00:00:00.000Z",
    })[0].idempotencyKey;

    const b = parseUsageTelemetryBatch({
      sourceApp: "congress-feed",
      provider: "openai",
      metricType: "usage",
      keyRef: "gpt-5.5",
      occurredAt: "2026-06-15T00:00:00.000Z",
    })[0].idempotencyKey;

    expect(a).not.toBe(b);
  });

  it("produces different keys for different provider values", () => {
    const a = parseUsageTelemetryBatch({
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "usage",
      keyRef: "gpt-5.5",
      occurredAt: "2026-06-15T00:00:00.000Z",
    })[0].idempotencyKey;

    const b = parseUsageTelemetryBatch({
      sourceApp: "socratic-trade",
      provider: "anthropic",
      metricType: "usage",
      keyRef: "gpt-5.5",
      occurredAt: "2026-06-15T00:00:00.000Z",
    })[0].idempotencyKey;

    expect(a).not.toBe(b);
  });

  it("produces different keys for different occurredAt timestamps", () => {
    const a = parseUsageTelemetryBatch({
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "usage",
      keyRef: "gpt-5.5",
      occurredAt: "2026-06-15T00:00:00.000Z",
    })[0].idempotencyKey;

    const b = parseUsageTelemetryBatch({
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "usage",
      keyRef: "gpt-5.5",
      occurredAt: "2026-06-15T00:00:01.000Z",
    })[0].idempotencyKey;

    expect(a).not.toBe(b);
  });

  // ---- Explicit idempotencyKey passes through verbatim ------------------

  it("uses the explicit idempotencyKey when provided by the caller", () => {
    const input = {
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "usage",
      occurredAt: "2026-06-15T00:00:00.000Z",
      idempotencyKey: "my-custom-key-123",
    };
    const events = parseUsageTelemetryBatch(input);
    expect(events).toHaveLength(1);
    expect(events[0].idempotencyKey).toBe("my-custom-key-123");
  });

  // ---- No occurredAt fallback → random UUID -----------------------------

  it("falls back to a random UUID when no occurredAt or explicit key is supplied", () => {
    const input = {
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "usage",
    };
    const events = parseUsageTelemetryBatch(input);
    expect(events).toHaveLength(1);
    // UUID v4 format: 8-4-4-4-12 hex digits
    expect(events[0].idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

describe("parseUsageTelemetryBatch validation", () => {
  it("accepts a valid single event", () => {
    const input = {
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "usage",
      occurredAt: "2026-06-15T00:00:00.000Z",
    };
    const events = parseUsageTelemetryBatch(input);
    expect(events).toHaveLength(1);
    expect(events[0].sourceApp).toBe("socratic-trade");
    expect(events[0].provider).toBe("openai");
    expect(events[0].metricType).toBe("usage");
  });

  it("accepts a valid batch of events", () => {
    const input = {
      events: [
        {
          sourceApp: "socratic-trade",
          provider: "openai",
          metricType: "usage",
          occurredAt: "2026-06-15T00:00:00.000Z",
        },
        {
          sourceApp: "socratic-trade",
          provider: "twilio",
          metricType: "cost",
          costUsd: 0.05,
          occurredAt: "2026-06-15T01:00:00.000Z",
        },
      ],
    };
    const events = parseUsageTelemetryBatch(input);
    expect(events).toHaveLength(2);
    expect(events[0].provider).toBe("openai");
    expect(events[1].provider).toBe("twilio");
    expect(events[1].costUsd).toBe(0.05);
  });

  it("rejects an empty events array", () => {
    expect(() => parseUsageTelemetryBatch({ events: [] })).toThrow(
      "events must not be empty"
    );
  });

  it("rejects when sourceApp is missing", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        provider: "openai",
        metricType: "usage",
      })
    ).toThrow("sourceApp is required");
  });

  it("rejects when provider is missing", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        sourceApp: "socratic-trade",
        metricType: "usage",
      })
    ).toThrow("provider is required");
  });

  it("rejects invalid metricType", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        sourceApp: "socratic-trade",
        provider: "openai",
        metricType: "invalid-type",
        occurredAt: "2026-06-15T00:00:00.000Z",
      })
    ).toThrow("metricType is not supported");
  });

  it("rejects negative costUsd", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        sourceApp: "socratic-trade",
        provider: "openai",
        metricType: "usage",
        costUsd: -1,
        occurredAt: "2026-06-15T00:00:00.000Z",
      })
    ).toThrow("costUsd");
  });

  it("rejects non-finite numbers", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        sourceApp: "socratic-trade",
        provider: "openai",
        metricType: "usage",
        quantity: NaN,
        occurredAt: "2026-06-15T00:00:00.000Z",
      })
    ).toThrow("quantity");
  });
});
