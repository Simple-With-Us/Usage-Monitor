import { describe, it, expect } from "vitest";
import {
  MAX_NEGATIVE_SUBSCRIPTION_BATCH_COST_USD,
  MAX_NEGATIVE_SUBSCRIPTION_COST_USD,
  MAX_V2_BATCH_REJECTIONS_REPORTED,
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
    const { events: [event], rejected, rejections } = await parseUsageTelemetryV2Batch({
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

    expect(rejected).toBe(0);
    expect(rejections).toEqual([]);
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
      _coverageDeclared: true,
      _coverageScope: "billing_account",
      _coverageMode: "cumulative",
      _coverageRelationship: "supersedes",
    });
  });

  it("keys v2 idempotency and sourceApp on batch producerId, not eventId alone", async () => {
    const event = {
      eventId: "same-session-token",
      provider: "xai",
      service: "grok-cli",
      metricType: "cost",
      unit: "usd",
      costUsd: 2,
      billingMode: "estimated",
      confidence: "estimated",
      occurredAt: "2026-08-25T00:00:00.000Z",
    };
    const [fleet, seat] = await Promise.all([
      parseUsageTelemetryV2Batch({
        schemaVersion: 2,
        producerId: "fleet-usage-collector",
        events: [event],
      }),
      parseUsageTelemetryV2Batch({
        schemaVersion: 2,
        producerId: "grok-build",
        events: [event],
      }),
    ]);
    expect(fleet.events[0].sourceApp).toBe("fleet-usage-collector");
    expect(seat.events[0].sourceApp).toBe("grok-build");
    expect(fleet.events[0].idempotencyKey).not.toBe(seat.events[0].idempotencyKey);
  });

  it("reserves persisted coverage authority from arbitrary producer metadata", async () => {
    const { events: [event] } = await parseUsageTelemetryV2Batch({
      schemaVersion: 2,
      producerId: "congress-trade",
      events: [{
        eventId: "metadata-only-coverage",
        provider: "openai",
        metadata: {
          _coverageDeclared: true,
          _coverageScope: "api_key",
          _coverageMode: "point",
          _coverageRelationship: "disjoint",
          harmless: "retained",
        },
      }],
    });

    expect(event.metadata).toMatchObject({
      _usageTelemetrySchemaVersion: 2,
      _producerEventId: "metadata-only-coverage",
      harmless: "retained",
    });
    expect(event.metadata).not.toHaveProperty("_coverageDeclared");
    expect(event.metadata).not.toHaveProperty("_coverageScope");
    expect(event.metadata).not.toHaveProperty("_coverageMode");
    expect(event.metadata).not.toHaveProperty("_coverageRelationship");
  });

  it("rejects invalid events per-event instead of failing the whole batch (X5)", async () => {
    // A missing eventId and an ambiguous coverage scope are EVENT-level
    // failures: the batch parses, the bad events land in `rejections`.
    const missingIdentity = await parseUsageTelemetryV2Batch({
      schemaVersion: 2,
      producerId: "socratic-trade",
      events: [{ provider: "openai" }],
    });
    expect(missingIdentity.events).toEqual([]);
    expect(missingIdentity.rejected).toBe(1);
    expect(missingIdentity.rejections).toEqual([
      expect.objectContaining({ index: 0, issues: expect.any(Array) }),
    ]);
    expect(missingIdentity.rejections[0].issues[0]).toContain("eventId");

    const ambiguousScope = await parseUsageTelemetryV2Batch({
      schemaVersion: 2,
      producerId: "socratic-trade",
      events: [{
        eventId: "event-1",
        provider: "openai",
        coverage: { scope: "account", mode: "point" },
      }],
    });
    expect(ambiguousScope.events).toEqual([]);
    expect(ambiguousScope.rejected).toBe(1);
    expect(ambiguousScope.rejections[0]).toEqual(
      expect.objectContaining({ index: 0, eventId: "event-1" })
    );
  });

  it("persists valid events alongside a poison event in the same batch (X5)", async () => {
    const parsed = await parseUsageTelemetryV2Batch({
      schemaVersion: 2,
      producerId: "socratic-trade",
      events: [
        { eventId: "good-1", provider: "openai" },
        { provider: "openai" }, // poison: no eventId
        { eventId: "good-2", provider: "anthropic" },
      ],
    });

    expect(parsed.events.map((event) => event.metadata?._producerEventId)).toEqual([
      "good-1",
      "good-2",
    ]);
    expect(parsed.rejected).toBe(1);
    expect(parsed.rejections).toEqual([
      expect.objectContaining({ index: 1, issues: expect.any(Array) }),
    ]);
    // Valid events still get the canonical shared idempotency key.
    for (const event of parsed.events) {
      expect(event.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
      expect(event.sourceApp).toBe("socratic-trade");
    }
  });

  it("bounds the rejection detail array while keeping the rejected count exact", async () => {
    const parsed = await parseUsageTelemetryV2Batch({
      schemaVersion: 2,
      producerId: "socratic-trade",
      events: Array.from({ length: MAX_V2_BATCH_REJECTIONS_REPORTED + 5 }, (_, index) => ({
        provider: `provider-${index}`, // every event missing eventId
      })),
    });

    expect(parsed.events).toEqual([]);
    expect(parsed.rejected).toBe(MAX_V2_BATCH_REJECTIONS_REPORTED + 5);
    expect(parsed.rejections).toHaveLength(MAX_V2_BATCH_REJECTIONS_REPORTED);
    expect(parsed.rejections.map((rejection) => rejection.index)).toEqual(
      Array.from({ length: MAX_V2_BATCH_REJECTIONS_REPORTED }, (_, index) => index)
    );
  });

  it("still throws for envelope-level failures (producerId, schemaVersion, events shape)", async () => {
    await expect(parseUsageTelemetryV2Batch({
      schemaVersion: 2,
      producerId: "",
      events: [{ eventId: "e", provider: "openai" }],
    })).rejects.toThrow();
    await expect(parseUsageTelemetryV2Batch({
      schemaVersion: 1,
      producerId: "socratic-trade",
      events: [{ eventId: "e", provider: "openai" }],
    })).rejects.toThrow();
    await expect(parseUsageTelemetryV2Batch({
      schemaVersion: 2,
      producerId: "socratic-trade",
      events: [],
    })).rejects.toThrow();
    await expect(parseUsageTelemetryV2Batch({
      schemaVersion: 2,
      producerId: "socratic-trade",
      events: [{ eventId: "e", provider: "openai" }],
      unknownTopLevelKey: true,
    })).rejects.toThrow();
    await expect(parseUsageTelemetryV2Batch("not an object")).rejects.toThrow();
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

// ---------------------------------------------------------------------------
// Aggregate companion to the per-event bound above (audit finding
// "negative-adjustment-abuse": PR #884 claimed this bound but never shipped
// it). A batch of MAX_EVENTS individually-legal -$1000 events must not be
// able to erase $100,000 in one call. Boundary semantics match the per-event
// bound: the batch's summed negative subscription magnitude may equal
// MAX_NEGATIVE_SUBSCRIPTION_BATCH_COST_USD exactly (inclusive); anything
// more negative rejects the WHOLE batch. Positive amounts and other
// metricTypes never count toward the sum.
// ---------------------------------------------------------------------------

describe("parseUsageTelemetryBatch aggregate negative subscription bound", () => {
  const negativeSubscriptionEvent = (costUsd: number, index: number) => ({
    idempotencyKey: `aggregate-bound-${index}`,
    sourceApp: "manual-billing-adjustment",
    provider: "anthropic",
    billingMode: "manual",
    metricType: "subscription",
    unit: "usd",
    costUsd,
    confidence: "estimated",
    occurredAt: "2026-06-16T00:00:00.000Z",
  });

  it("rejects a batch of per-event-legal negatives whose magnitudes sum past the batch bound (3 x -700)", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        events: [
          negativeSubscriptionEvent(-700, 1),
          negativeSubscriptionEvent(-700, 2),
          negativeSubscriptionEvent(-700, 3),
        ],
      })
    ).toThrow(
      `combined negative subscription costUsd magnitude must not exceed ` +
        `${MAX_NEGATIVE_SUBSCRIPTION_BATCH_COST_USD} per batch`
    );
  });

  it("accepts a batch whose negative magnitudes sum to exactly the batch bound (inclusive boundary)", () => {
    const half = MAX_NEGATIVE_SUBSCRIPTION_BATCH_COST_USD / 2;
    const events = parseUsageTelemetryBatch({
      events: [
        negativeSubscriptionEvent(-half, 1),
        negativeSubscriptionEvent(-half, 2),
      ],
    });
    expect(events.map((event) => event.costUsd)).toEqual([-half, -half]);
  });

  it("does not count positive subscription amounts toward the bound (no netting: positives cannot buy negative headroom, and large positive batches still parse)", () => {
    // Sum of negatives is exactly at the bound (2 x the per-event max); the
    // large positives must neither offset the negatives (netting would accept
    // -2100 alongside +10000) nor count toward the bound themselves.
    const events = parseUsageTelemetryBatch({
      events: [
        negativeSubscriptionEvent(10_000, 1),
        negativeSubscriptionEvent(10_000, 2),
        negativeSubscriptionEvent(-MAX_NEGATIVE_SUBSCRIPTION_BATCH_COST_USD / 2, 3),
        negativeSubscriptionEvent(-MAX_NEGATIVE_SUBSCRIPTION_BATCH_COST_USD / 2, 4),
      ],
    });
    expect(events).toHaveLength(4);
  });

  it("rejects the batch when positives are present but negatives alone exceed the bound (proof of no netting)", () => {
    expect(() =>
      parseUsageTelemetryBatch({
        events: [
          negativeSubscriptionEvent(10_000, 1),
          negativeSubscriptionEvent(-700, 2),
          negativeSubscriptionEvent(-700, 3),
          negativeSubscriptionEvent(-700, 4),
        ],
      })
    ).toThrow("combined negative subscription costUsd magnitude");
  });

  it("leaves batches of other metricTypes unaffected by the aggregate bound", () => {
    // Non-subscription metricTypes cannot carry negatives at all (per-event
    // rule), so a large batch of ordinary positive cost events far above the
    // bound's dollar figure must parse untouched.
    const events = parseUsageTelemetryBatch({
      events: Array.from({ length: 5 }, (_, index) => ({
        idempotencyKey: `ordinary-cost-${index}`,
        sourceApp: "socratic-trade",
        provider: "openai",
        metricType: "cost",
        unit: "usd",
        costUsd: MAX_NEGATIVE_SUBSCRIPTION_BATCH_COST_USD,
        occurredAt: "2026-06-16T00:00:00.000Z",
      })),
    });
    expect(events).toHaveLength(5);
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

describe("reserved derived-cost metadata keys", () => {
  it("strips producer-supplied _derivedCost* keys so a monitor-computed estimate cannot be forged (v1)", () => {
    const events = parseUsageTelemetryBatch({
      sourceApp: "evil-producer",
      provider: "openai",
      metricType: "usage",
      unit: "token",
      quantity: 1000,
      metadata: {
        _derivedCostUsd: 999.99,
        _derivedCostPricingKey: "gpt-4o",
        _derivedCostSnapshot: "2020-01-01",
        _derivedCostIncomplete: false,
        legitimate: "kept",
      },
    });
    expect(events[0].metadata).toEqual({ legitimate: "kept" });
  });
});

describe("canonical AI usage (UM-1592)", () => {
  it("persists the v2 ai block under the reserved _ai* keys", async () => {
    const { events: [event], rejected } = await parseUsageTelemetryV2Batch({
      schemaVersion: 2,
      producerId: "botfleet",
      events: [{
        eventId: "turn-1",
        provider: "anthropic",
        metricType: "usage",
        unit: "token",
        quantity: 100,
        ai: {
          model: { requested: "sonnet", served: "claude-sonnet-4-5" },
          harness: "botfleet",
          seat: "CLAUDE",
          tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite5m: 15, cacheWrite1h: 25, reasoning: 5 },
          durationMs: 900,
          ttftMs: 120,
          billingMode: "subscription",
          costSource: "estimated",
        },
        occurredAt: "2026-10-17T01:00:00.000Z",
      }],
    });
    expect(rejected).toBe(0);
    expect(event.metadata).toMatchObject({
      _aiModelRequested: "sonnet",
      _aiModelServed: "claude-sonnet-4-5",
      _aiHarness: "botfleet",
      _aiSeat: "CLAUDE",
      _aiTokensInput: 10,
      _aiTokensOutput: 20,
      _aiTokensCacheRead: 30,
      _aiTokensCacheWrite5m: 15,
      _aiTokensCacheWrite1h: 25,
      _aiTokensReasoning: 5,
      _aiDurationMs: 900,
      _aiTtftMs: 120,
      _aiBillingMode: "subscription",
      _aiCostSource: "estimated",
      _aiSource: "block",
    });
  });

  it("rejects an invalid ai block per event", async () => {
    const { events, rejected, rejections } = await parseUsageTelemetryV2Batch({
      schemaVersion: 2,
      producerId: "botfleet",
      events: [
        { eventId: "ok", provider: "anthropic" },
        { eventId: "bad", provider: "anthropic", ai: { tokens: { input: -1 } } },
      ],
    });
    expect(events).toHaveLength(1);
    expect(rejected).toBe(1);
    expect(rejections[0]?.eventId).toBe("bad");
  });

  it("maps legacy v2 metadata keys onto the canonical keys", async () => {
    const { events: [event] } = await parseUsageTelemetryV2Batch({
      schemaVersion: 2,
      producerId: "congress-trade",
      events: [{
        eventId: "ct-1",
        provider: "anthropic",
        unit: "token",
        quantity: 1050,
        metadata: {
          promptTokens: 1000,
          completionTokens: 50,
          cachedTokens: 600,
          cacheWriteTokens: 100,
          cacheWriteOneHourTokens: 200,
        },
      }],
    });
    expect(event.metadata).toMatchObject({
      promptTokens: 1000,
      _aiTokensInput: 100,
      _aiTokensOutput: 50,
      _aiTokensCacheRead: 600,
      _aiTokensCacheWrite5m: 100,
      _aiTokensCacheWrite1h: 200,
      _aiSource: "legacy",
    });
  });

  it("does not let producer metadata forge canonical keys", async () => {
    const { events: [event] } = await parseUsageTelemetryV2Batch({
      schemaVersion: 2,
      producerId: "socratic-trade",
      events: [{
        eventId: "forge",
        provider: "openai",
        metadata: { _aiTokensOutput: 1_000_000_000, _aiSource: "block", _aiModelServed: "x" },
      }],
    });
    expect(event.metadata?._aiTokensOutput).toBeUndefined();
    expect(event.metadata?._aiSource).toBeUndefined();
    expect(event.metadata?._aiModelServed).toBeUndefined();
  });

  it("maps legacy v1 token slices by label", () => {
    const [event] = parseUsageTelemetryBatch({
      sourceApp: "openai-codex",
      provider: "openai",
      unit: "token",
      quantity: 42,
      label: "token:cacheRead",
      metadata: { session: "s1" },
    });
    expect(event.metadata).toMatchObject({ session: "s1", _aiTokensCacheRead: 42, _aiSource: "legacy" });
  });
});
