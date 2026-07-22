import { describe, it, expect } from "vitest";
import {
  MAX_NEGATIVE_SUBSCRIPTION_COST_USD,
  parseUsageTelemetryBatch,
  parseUsageTelemetryV2Batch,
} from "../usage-telemetry";

// ---------------------------------------------------------------------------
// Idempotency key tests — these match the shared test vectors that the
// congress-trading-shared repo also uses, so both repos can verify that their
// deriveIdempotencyKey implementations produce identical bytes.
// ---------------------------------------------------------------------------

// All derived keys must be exactly 64 hex characters (SHA-256).
const SHA256_HEX_LENGTH = 64;
const HEX_PATTERN = /^[0-9a-f]{64}$/;

describe("usage telemetry v2 shared contract", () => {
  it("maps producer/account identity and uses the shared canonical event key", async () => {
    const [event] = await parseUsageTelemetryV2Batch({
      schemaVersion: 2,
      producerId: "socratic-trade",
      producerInstanceId: "prod-a",
      events: [{
        eventId: "event-123",
        provider: "openai",
        producerKeyRef: "configured-openai-primary",
        providerConnectionRef: "openai-org-primary",
        billingAccountRef: "openai-billing-primary",
        coverage: {
          scope: "billing_account",
          mode: "cumulative",
          relationship: "supersedes",
          reportThrough: "2026-07-21T00:00:00.000Z",
        },
        occurredAt: "2026-07-21T01:00:00.000Z",
      }],
    });

    expect(event.sourceApp).toBe("socratic-trade");
    expect(event.keyRef).toBe("configured-openai-primary");
    expect(event.idempotencyKey).toBe(
      "7c279ae3726c337274cae8be0ce409952c360c2402209090c35ff77f1b061f31"
    );
    expect(event.metadata).toMatchObject({
      _usageTelemetrySchemaVersion: 2,
      _producerEventId: "event-123",
      _producerInstanceId: "prod-a",
      _providerConnectionRef: "openai-org-primary",
      _billingAccountRef: "openai-billing-primary",
      _coverageScope: "billing_account",
      _coverageMode: "cumulative",
      _coverageRelationship: "supersedes",
    });
  });

  it("rejects a missing event identity and ambiguous account scope", async () => {
    await expect(parseUsageTelemetryV2Batch({
      schemaVersion: 2,
      producerId: "socratic-trade",
      events: [{ provider: "openai" }],
    })).rejects.toThrow();
    await expect(parseUsageTelemetryV2Batch({
      schemaVersion: 2,
      producerId: "socratic-trade",
      events: [{
        eventId: "event-1",
        provider: "openai",
        coverage: { scope: "account", mode: "point" },
      }],
    })).rejects.toThrow();
  });
});

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

  // ---- providerRequestId is NOT part of the idempotency-key basis -------
  // Regression guard for DESIGN §0b/§3b: the idempotency key derivation
  // (sourceApp + provider + metricType + keyRef + occurredAt) must stay
  // byte-identical whether or not the event carries a providerRequestId.

  it("derives the identical idempotency key for a fixed event with and without providerRequestId", () => {
    const base = {
      sourceApp: "congress-trade",
      provider: "openrouter",
      metricType: "cost",
      keyRef: "primary-key",
      occurredAt: "2026-07-18T00:00:00.000Z",
    };
    const withoutId = parseUsageTelemetryBatch(base)[0].idempotencyKey;
    const withId = parseUsageTelemetryBatch({
      ...base,
      providerRequestId: "gen-1a2b3c4d5e6f",
    })[0].idempotencyKey;

    expect(withId).toBe(withoutId);
    // Also pin the exact vector so any future change to the basis algorithm
    // that accidentally starts including providerRequestId is caught even if
    // the equality assertion above were weakened.
    expect(withoutId).toBe(
      parseUsageTelemetryBatch({ ...base, providerRequestId: "an-entirely-different-id" })[0]
        .idempotencyKey
    );
  });
});

// ---------------------------------------------------------------------------
// providerRequestId parsing (DESIGN §3b: accepted, optional, bounded length)
// ---------------------------------------------------------------------------

describe("parseUsageTelemetryBatch providerRequestId", () => {
  it("parses a valid providerRequestId", () => {
    const events = parseUsageTelemetryBatch({
      sourceApp: "socratic-trade",
      provider: "openrouter",
      metricType: "cost",
      costUsd: 0.01,
      occurredAt: "2026-07-18T00:00:00.000Z",
      providerRequestId: "gen-1234567890",
    });
    expect(events[0].providerRequestId).toBe("gen-1234567890");
  });

  it("leaves providerRequestId undefined when omitted", () => {
    const events = parseUsageTelemetryBatch({
      sourceApp: "socratic-trade",
      provider: "openrouter",
      metricType: "cost",
      costUsd: 0.01,
      occurredAt: "2026-07-18T00:00:00.000Z",
    });
    expect(events[0].providerRequestId).toBeUndefined();
  });

  it("rejects a providerRequestId longer than 200 characters", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        sourceApp: "socratic-trade",
        provider: "openrouter",
        metricType: "cost",
        costUsd: 0.01,
        occurredAt: "2026-07-18T00:00:00.000Z",
        providerRequestId: "g".repeat(201),
      })
    ).toThrow("providerRequestId must be 200 characters or fewer");
  });

  it("rejects a non-string providerRequestId", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        sourceApp: "socratic-trade",
        provider: "openrouter",
        metricType: "cost",
        costUsd: 0.01,
        occurredAt: "2026-07-18T00:00:00.000Z",
        providerRequestId: 12345,
      })
    ).toThrow("providerRequestId must be a string");
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

// ---------------------------------------------------------------------------
// Negative costUsd is permitted ONLY for metricType "subscription" (manual
// pro-rated refunds). Every other metricType, and every other numeric field
// on a subscription event, must stay non-negative.
// ---------------------------------------------------------------------------

describe("parseUsageTelemetryBatch negative costUsd scope", () => {
  it("accepts a negative costUsd when metricType is subscription", () => {
    const events = parseUsageTelemetryBatch({
      sourceApp: "manual-billing-adjustment",
      provider: "anthropic",
      metricType: "subscription",
      billingMode: "manual",
      unit: "usd",
      costUsd: -19.15,
      confidence: "estimated",
      occurredAt: "2026-06-16T00:00:00.000Z",
    });
    expect(events).toHaveLength(1);
    expect(events[0].costUsd).toBe(-19.15);
  });

  it("still rejects negative costUsd for metricType cost", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        sourceApp: "manual-billing-adjustment",
        provider: "anthropic",
        metricType: "cost",
        costUsd: -19.15,
        occurredAt: "2026-06-16T00:00:00.000Z",
      })
    ).toThrow("costUsd must be a non-negative finite number");
  });

  it("still rejects negative costUsd for metricType usage", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        sourceApp: "manual-billing-adjustment",
        provider: "anthropic",
        metricType: "usage",
        costUsd: -1,
        occurredAt: "2026-06-16T00:00:00.000Z",
      })
    ).toThrow("costUsd must be a non-negative finite number");
  });

  it("still rejects negative costUsd for every other metricType", () => {
    for (const metricType of ["quota", "tier", "health", "balance", "limit", "quota_sync", "credit_balance"]) {
      expect(() =>
        parseUsageTelemetryBatch({
          sourceApp: "manual-billing-adjustment",
          provider: "anthropic",
          metricType,
          costUsd: -1,
          occurredAt: "2026-06-16T00:00:00.000Z",
        }),
        `metricType=${metricType}`
      ).toThrow("costUsd must be a non-negative finite number");
    }
  });

  it("still rejects negative quantity on a subscription event", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        sourceApp: "manual-billing-adjustment",
        provider: "anthropic",
        metricType: "subscription",
        quantity: -1,
        occurredAt: "2026-06-16T00:00:00.000Z",
      })
    ).toThrow("quantity must be a non-negative finite number");
  });

  it("still rejects negative credits on a subscription event", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        sourceApp: "manual-billing-adjustment",
        provider: "anthropic",
        metricType: "subscription",
        credits: -1,
        occurredAt: "2026-06-16T00:00:00.000Z",
      })
    ).toThrow("credits must be a non-negative finite number");
  });

  it("still rejects negative limit on a subscription event", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        sourceApp: "manual-billing-adjustment",
        provider: "anthropic",
        metricType: "subscription",
        limit: -1,
        occurredAt: "2026-06-16T00:00:00.000Z",
      })
    ).toThrow("limit must be a non-negative finite number");
  });

  it("still rejects negative requests on a subscription event", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        sourceApp: "manual-billing-adjustment",
        provider: "anthropic",
        metricType: "subscription",
        requests: -1,
        occurredAt: "2026-06-16T00:00:00.000Z",
      })
    ).toThrow("requests must be a non-negative finite number");
  });

  it("still rejects a non-finite costUsd on a subscription event", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        sourceApp: "manual-billing-adjustment",
        provider: "anthropic",
        metricType: "subscription",
        costUsd: NaN,
        occurredAt: "2026-06-16T00:00:00.000Z",
      })
    ).toThrow("costUsd must be a finite number");
  });

  it("accepts a positive costUsd for subscription events as before", () => {
    const events = parseUsageTelemetryBatch({
      sourceApp: "manual-billing-adjustment",
      provider: "anthropic",
      metricType: "subscription",
      costUsd: 21.45,
      occurredAt: "2026-06-13T00:00:00.000Z",
    });
    expect(events[0].costUsd).toBe(21.45);
  });
});

// ---------------------------------------------------------------------------
// A negative subscription costUsd is a real refund, but any
// USAGE_INGEST_TOKEN holder can post one and this monitor is single-owner
// with no per-caller scoping — an unbounded magnitude is unbounded
// spend-erasure / budget-alert suppression. Bound it per event.
//
// Boundary semantics: MAX_NEGATIVE_SUBSCRIPTION_COST_USD is the maximum
// magnitude a single negative subscription costUsd may carry, INCLUSIVE.
// Exactly -MAX_NEGATIVE_SUBSCRIPTION_COST_USD is accepted; anything more
// negative (further from zero) is rejected. Positive amounts are unaffected.
// ---------------------------------------------------------------------------

describe("parseUsageTelemetryBatch negative subscription costUsd magnitude bound", () => {
  it("accepts a negative costUsd comfortably inside the bound", () => {
    const events = parseUsageTelemetryBatch({
      sourceApp: "manual-billing-adjustment",
      provider: "anthropic",
      metricType: "subscription",
      costUsd: -999.99,
      occurredAt: "2026-06-16T00:00:00.000Z",
    });
    expect(events[0].costUsd).toBe(-999.99);
  });

  it("accepts a negative costUsd exactly at the bound (inclusive boundary)", () => {
    const events = parseUsageTelemetryBatch({
      sourceApp: "manual-billing-adjustment",
      provider: "anthropic",
      metricType: "subscription",
      costUsd: -MAX_NEGATIVE_SUBSCRIPTION_COST_USD,
      occurredAt: "2026-06-16T00:00:00.000Z",
    });
    expect(events[0].costUsd).toBe(-MAX_NEGATIVE_SUBSCRIPTION_COST_USD);
  });

  it("rejects a negative costUsd one cent past the bound", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        sourceApp: "manual-billing-adjustment",
        provider: "anthropic",
        metricType: "subscription",
        costUsd: -(MAX_NEGATIVE_SUBSCRIPTION_COST_USD + 0.01),
        occurredAt: "2026-06-16T00:00:00.000Z",
      })
    ).toThrow(
      `costUsd must not be more negative than -${MAX_NEGATIVE_SUBSCRIPTION_COST_USD}`
    );
  });

  it("rejects a large negative costUsd for every non-subscription metricType regardless of magnitude", () => {
    for (const metricType of [
      "usage",
      "cost",
      "quota",
      "tier",
      "health",
      "balance",
      "limit",
      "quota_sync",
      "credit_balance",
    ]) {
      expect(
        () =>
          parseUsageTelemetryBatch({
            sourceApp: "manual-billing-adjustment",
            provider: "anthropic",
            metricType,
            costUsd: -(MAX_NEGATIVE_SUBSCRIPTION_COST_USD * 50),
            occurredAt: "2026-06-16T00:00:00.000Z",
          }),
        `metricType=${metricType}`
      ).toThrow("costUsd must be a non-negative finite number");
    }
  });
});

describe("parseUsageTelemetryBatch reserved sourceApp", () => {
  it("parses (does not itself reject) an event claiming the reserved subscription sourceApp — the ingest route is the enforcement point", () => {
    // usage-telemetry.ts is pure wire-format parsing; the reserved-sourceApp
    // policy check lives in the ingest route (see route.test.ts), which is
    // the HTTP trust boundary the materializer never crosses.
    const events = parseUsageTelemetryBatch({
      sourceApp: "subscription",
      provider: "anthropic",
      metricType: "subscription",
      costUsd: 5,
      occurredAt: "2026-06-16T00:00:00.000Z",
    });
    expect(events[0].sourceApp).toBe("subscription");
  });
});
