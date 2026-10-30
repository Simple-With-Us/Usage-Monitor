import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const externalUsageMocks = vi.hoisted(() => ({
  persist: vi.fn(),
  syncStatus: vi.fn(),
}));
const resolveProjects = vi.hoisted(() => vi.fn());
const providerFindMany = vi.hoisted(() => vi.fn());
const persistAiRequests = vi.hoisted(() => vi.fn());

vi.mock("@/lib/external-usage-events", () => ({
  ExternalUsageIdempotencyCollisionError: class extends Error {},
  NegativeSubscriptionWindowLimitExceededError: class extends Error {},
  persistExternalUsageEvents: externalUsageMocks.persist,
  syncStatusToUsageSnapshot: externalUsageMocks.syncStatus,
}));
vi.mock("@/lib/ai-requests", () => ({
  persistAiRequests,
}));
vi.mock("@/lib/project-resolver", () => ({
  resolveProjectIdsByName: resolveProjects,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { provider: { findMany: providerFindMany } },
}));

import { POST } from "../route";
import { tryAcquireIngestAdmission } from "@/lib/ingest-admission";
import { getNamedRateLimiter } from "@/lib/rate-limit";
import { signReceiptCashEvent } from "@/lib/receipt-cash";
import {
  MAX_NEGATIVE_SUBSCRIPTION_BATCH_COST_USD,
  MAX_NEGATIVE_SUBSCRIPTION_COST_USD,
  MAX_USAGE_TELEMETRY_BODY_BYTES,
} from "@/lib/usage-telemetry";

const USAGE_TOKEN = "usage-test-token";
const RECEIPT_TOKEN = "receipt-test-token-distinct";
const RECEIPT_HMAC_KEY = "receipt-test-signing-key-long-enough";
const LOCAL_RECEIPT_TOKEN = "local-receipt-test-token-distinct";
const LOCAL_RECEIPT_HMAC_KEY = "local-receipt-test-signing-key-long-enough";
const RECEIPT_PROVIDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RECEIPT_DIGEST = "b".repeat(64);
let ipCounter = 0;

function nextRequest(
  body: unknown,
  token: string,
  url = "https://usage.jays.services/api/ingest/usage",
  telemetryVersion?: 2
): NextRequest {
  ipCounter += 1;
  return new NextRequest(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-forwarded-for": `10.1.0.${ipCounter}`,
      ...(telemetryVersion ? { "x-usage-telemetry-version": String(telemetryVersion) } : {}),
    },
    body: JSON.stringify(body),
  });
}

function v2Request(token = USAGE_TOKEN, includeVersionHeader = true): NextRequest {
  return nextRequest(
    {
      schemaVersion: 2,
      producerId: "socratic-trade",
      producerInstanceId: "prod-a",
      events: [{
        eventId: "ledger-event-1",
        provider: "openai",
        producerKeyRef: "configured-openai-primary",
        providerConnectionRef: "openai-org-primary",
        billingAccountRef: "openai-billing-primary",
        occurredAt: "2026-07-21T00:00:00.000Z",
      }],
    },
    token,
    "https://usage.jays.services/api/ingest/usage",
    includeVersionHeader ? 2 : undefined
  );
}

function ordinaryRequest(token = USAGE_TOKEN): NextRequest {
  return nextRequest(
    {
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "cost",
      costUsd: 0,
      occurredAt: "2026-07-14T00:00:00.000Z",
      idempotencyKey: "admission-test-event",
    },
    token
  );
}

function receiptEvent(
  overrides: Record<string, unknown> = {},
  signingKey = RECEIPT_HMAC_KEY
) {
  const event: Record<string, unknown> = {
    idempotencyKey: `billing-receipt:v1:${RECEIPT_DIGEST}`,
    sourceApp: "billing-receipt-import",
    provider: "anthropic",
    service: "api-prepaid-funding",
    label: "receipt_cash_paid",
    keyRef: `provider:${RECEIPT_PROVIDER_ID}:billing-receipt:${RECEIPT_DIGEST}`,
    billingMode: "actual",
    metricType: "cost",
    unit: "usd",
    confidence: "actual",
    costUsd: 47.25,
    occurredAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
  const digestMatch = /billing-receipt:([0-9a-f]{64})$/i.exec(String(event.keyRef));
  const digest = digestMatch?.[1] ?? RECEIPT_DIGEST;
  const providerIdMatch = /^provider:([^:]+):billing-receipt:/i.exec(String(event.keyRef));
  const providerId = providerIdMatch?.[1] ?? RECEIPT_PROVIDER_ID;
  const signature = signReceiptCashEvent(
    {
      providerId,
      providerName: String(event.provider),
      digest,
      amountUsd: Number(event.costUsd),
      occurredAt: String(event.occurredAt),
    },
    signingKey
  );
  event.metadata = {
    schemaVersion: 1,
    costSemantics: "receipt_cash_paid",
    receiptKind: "api_prepaid_funding",
    evidenceRef: `hmac-sha256:${digest}`,
    receiptSignature: `hmac-sha256:${signature}`,
    ...((overrides.metadata as Record<string, unknown> | undefined) ?? {}),
  };
  return event;
}

function receiptRequest(
  overrides: Record<string, unknown> = {},
  token = RECEIPT_TOKEN,
  url = "https://usage.jays.services/api/ingest/usage",
  signingKey = RECEIPT_HMAC_KEY
): NextRequest {
  return nextRequest(receiptEvent(overrides, signingKey), token, url);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("USAGE_INGEST_TOKEN", USAGE_TOKEN);
  vi.stubEnv("BILLING_RECEIPT_INGEST_TOKEN", RECEIPT_TOKEN);
  vi.stubEnv("BILLING_RECEIPT_HMAC_KEY", RECEIPT_HMAC_KEY);
  // The route's rate limiters are process-wide named singletons (they key on
  // the token hash / backstop identity now, not the per-test rotating IP), so
  // clear their windows between tests to keep each case isolated.
  getNamedRateLimiter("ingest-identity", 1_000, 10).reset();
  getNamedRateLimiter("ingest-unauthenticated", 1_000, 10).reset();
  resolveProjects.mockResolvedValue(new Map());
  externalUsageMocks.persist.mockResolvedValue({
    attempted: 1,
    persisted: 1,
    skippedPrunedDuplicates: 0,
    newEvents: [],
  });
  externalUsageMocks.syncStatus.mockResolvedValue(undefined);
  providerFindMany.mockResolvedValue([
    { id: RECEIPT_PROVIDER_ID, name: "anthropic" },
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/ingest/usage admission", () => {
  it("accepts v2 through the shared schema and returns explicit persistence counts", async () => {
    externalUsageMocks.persist.mockResolvedValueOnce({
      attempted: 1,
      persisted: 0,
      skippedPrunedDuplicates: 0,
      newEvents: [],
    });
    const response = await POST(v2Request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      schemaVersion: 2,
      received: 1,
      persisted: 0,
      duplicates: 1,
      pruned: 0,
      rejected: 0,
    });
    expect(externalUsageMocks.persist).toHaveBeenCalledWith([
      expect.objectContaining({
        sourceApp: "socratic-trade",
        keyRef: "configured-openai-primary",
        metadata: expect.objectContaining({
          _producerEventId: "ledger-event-1",
          _producerInstanceId: "prod-a",
          _providerConnectionRef: "openai-org-primary",
          _billingAccountRef: "openai-billing-primary",
        }),
      }),
    ]);
  });

  it("routes a v2 body through the shared schema without a custom version header", async () => {
    const response = await POST(v2Request(USAGE_TOKEN, false));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(expect.objectContaining({
      ok: true,
      schemaVersion: 2,
      received: 1,
      persisted: 1,
    }));
    expect(externalUsageMocks.persist).toHaveBeenCalledWith([
      expect.objectContaining({
        sourceApp: "socratic-trade",
        idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
  });

  it("keeps v1 metadata but strips normalized monitor authority before persistence", async () => {
    const response = await POST(nextRequest(
      {
        sourceApp: "congress-trade",
        provider: "openai",
        metricType: "cost",
        costUsd: 200,
        keyRef: "configured-openai-primary",
        occurredAt: "2026-07-22T00:00:00.000Z",
        metadata: {
          ordinaryV1Note: "retained",
          " _usageTelemetrySchemaVersion ": 2,
          " _coverageDeclared ": true,
          " _coverageScope ": "api_key",
          " _coverageMode ": "point",
          " _coverageRelationship ": "disjoint",
          " _providerConnectionRef ": "spoofed-connection",
          " _billingAccountRef ": "spoofed-account",
        },
      },
      USAGE_TOKEN
    ));

    expect(response.status).toBe(202);
    expect(externalUsageMocks.persist).toHaveBeenCalledWith([
      expect.objectContaining({
        sourceApp: "congress-trade",
        metadata: { ordinaryV1Note: "retained" },
      }),
    ]);
    const [persisted] = externalUsageMocks.persist.mock.calls[0][0];
    expect(Object.keys(persisted.metadata)).not.toEqual(
      expect.arrayContaining([
        "_usageTelemetrySchemaVersion",
        "_coverageDeclared",
        "_coverageScope",
        "_coverageMode",
        "_coverageRelationship",
        "_providerConnectionRef",
        "_billingAccountRef",
      ])
    );
  });

  it("overwrites conflicting or null producer metadata.project with top-level event.project", async () => {
    resolveProjects.mockResolvedValueOnce(new Map([["alpha", "proj-alpha-id"]]));

    const response = await POST(
      nextRequest(
        {
          sourceApp: "socratic-trade",
          provider: "openai",
          project: "Alpha",
          metricType: "usage",
          costUsd: 1,
          occurredAt: "2026-07-14T00:00:00.000Z",
          metadata: { project: "Beta", lane: "rag" },
        },
        USAGE_TOKEN
      )
    );
    expect(response.status).toBe(202);
    expect(externalUsageMocks.persist).toHaveBeenCalledWith([
      expect.objectContaining({
        projectId: "proj-alpha-id",
        // Carried alongside the stamped metadata so the persistence layer can
        // treat a pre-#887 stored producer metadata.project as an
        // authoritative overwrite on replay instead of a 409 collision.
        authoritativeProject: "Alpha",
        metadata: { lane: "rag", project: "Alpha" },
      }),
    ]);
  });

  it("returns the typed v2 error shape for a headerless invalid v2 envelope", async () => {
    // Missing producerId is an ENVELOPE failure: still a hard 400, unlike
    // per-event rejections (X5).
    const response = await POST(nextRequest(
      { schemaVersion: 2, events: [{ eventId: "e", provider: "openai" }] },
      USAGE_TOKEN
    ));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(expect.objectContaining({
      ok: false,
      schemaVersion: 2,
      error: expect.objectContaining({
        code: "invalid_request",
        retryable: false,
      }),
    }));
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();
  });

  it("persists valid events and ACKs rejected ones for a poison event in a v2 batch (X5)", async () => {
    externalUsageMocks.persist.mockResolvedValueOnce({
      attempted: 2,
      persisted: 2,
      skippedPrunedDuplicates: 0,
      newEvents: [],
    });
    const response = await POST(nextRequest(
      {
        schemaVersion: 2,
        producerId: "socratic-trade",
        events: [
          { eventId: "good-1", provider: "openai", occurredAt: "2026-07-21T00:00:00.000Z" },
          { provider: "openai" }, // poison: missing eventId
          { eventId: "good-2", provider: "anthropic", occurredAt: "2026-07-21T00:01:00.000Z" },
        ],
      },
      USAGE_TOKEN,
      "https://usage.jays.services/api/ingest/usage",
      2
    ));

    expect(response.status).toBe(202);
    const body = await response.json();
    // ACK invariant: persisted + duplicates + pruned + rejected === received.
    expect(body).toEqual({
      ok: true,
      schemaVersion: 2,
      received: 3,
      persisted: 2,
      duplicates: 0,
      pruned: 0,
      rejected: 1,
      rejections: [
        expect.objectContaining({ index: 1, issues: expect.any(Array) }),
      ],
    });
    // Only the valid events reached persistence.
    expect(externalUsageMocks.persist).toHaveBeenCalledTimes(1);
    const persistedEvents = externalUsageMocks.persist.mock.calls[0][0];
    expect(persistedEvents).toHaveLength(2);
    expect(
      persistedEvents.map((event: { metadata?: { _producerEventId?: string } }) =>
        event.metadata?._producerEventId
      )
    ).toEqual(["good-1", "good-2"]);
  });

  it("ACKs an all-poison v2 batch with rejected === received instead of a 400", async () => {
    const response = await POST(nextRequest(
      { schemaVersion: 2, producerId: "socratic-trade", events: [{}] },
      USAGE_TOKEN
    ));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      schemaVersion: 2,
      received: 1,
      persisted: 0,
      duplicates: 0,
      pruned: 0,
      rejected: 1,
      rejections: [expect.objectContaining({ index: 0 })],
    });
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();
  });

  it("returns the typed error/backoff contract to v2 clients", async () => {
    const response = await POST(v2Request("wrong-token"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      schemaVersion: 2,
      error: {
        code: "unauthorized",
        message: "Unauthorized",
        retryable: false,
      },
    });
  });

  it("rejects an overlapping writer before any database helper runs", async () => {
    const release = tryAcquireIngestAdmission();
    expect(release).not.toBeNull();
    try {
      const response = await POST(ordinaryRequest());
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(resolveProjects).not.toHaveBeenCalled();
      expect(externalUsageMocks.persist).not.toHaveBeenCalled();
    } finally {
      release?.();
    }
  });

  it("rejects a busy receiver before decoding an otherwise invalid body", async () => {
    const release = tryAcquireIngestAdmission();
    expect(release).not.toBeNull();
    try {
      const response = await POST(nextRequest("not an ingest object", USAGE_TOKEN));
      // Before the admission gate moved above body parsing this was a 400.
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(resolveProjects).not.toHaveBeenCalled();
      expect(externalUsageMocks.persist).not.toHaveBeenCalled();
    } finally {
      release?.();
    }
  });

  it("releases admission after a successful ingest", async () => {
    const response = await POST(ordinaryRequest());
    expect(response.status).toBe(202);

    const release = tryAcquireIngestAdmission();
    expect(release).not.toBeNull();
    release?.();
  });

  it("reports received/duplicates alongside zero accepted rows for an idempotent replay (X7)", async () => {
    externalUsageMocks.persist.mockResolvedValueOnce({
      attempted: 1,
      persisted: 0,
      skippedPrunedDuplicates: 0,
      newEvents: [],
    });

    const response = await POST(ordinaryRequest());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      accepted: 0,
      received: 1,
      duplicates: 1,
      ignoredPruned: 0,
    });

    const release = tryAcquireIngestAdmission();
    expect(release).not.toBeNull();
    release?.();
  });

  it("returns a typed internal_error and releases admission when persistence fails unexpectedly (X6)", async () => {
    externalUsageMocks.persist.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await POST(ordinaryRequest());
    expect(response.status).toBe(500);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.get("content-type")).toContain("application/json");
    // v1 clients get a JSON error body (never an untyped HTML 500)...
    expect(await response.json()).toEqual({ error: "Internal error" });

    const release = tryAcquireIngestAdmission();
    expect(release).not.toBeNull();
    release?.();
  });

  it("returns the typed v2 internal_error shape when persistence fails for a v2 batch (X6)", async () => {
    externalUsageMocks.persist.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await POST(v2Request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      schemaVersion: 2,
      error: {
        code: "internal_error",
        message: "Internal error",
        retryable: true,
        retryAfterSeconds: 30,
      },
    });

    const release = tryAcquireIngestAdmission();
    expect(release).not.toBeNull();
    release?.();
  });

  it.each(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED_SHAREDCACHE"])(
    "returns retryable receiver_busy for %s without acknowledging data",
    async (originalCode) => {
      externalUsageMocks.persist.mockRejectedValueOnce({
        code: "P1008",
        meta: { driverAdapterError: { cause: { originalCode } } },
      });
      const response = await POST(v2Request());
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(await response.json()).toMatchObject({
        ok: false, error: { code: "receiver_busy", retryable: true, retryAfterSeconds: 5 },
      });
      const release = tryAcquireIngestAdmission();
      expect(release).not.toBeNull();
      release?.();
    }
  );

  it("does not classify an unknown busy suffix as lock contention", async () => {
    externalUsageMocks.persist.mockRejectedValueOnce({
      code: "P1008", meta: { driverAdapterError: { cause: { originalCode: "SQLITE_BUSY_UNKNOWN" } } },
    });
    const response = await POST(v2Request());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
  });

  it("accepts an exact signed receipt only for its dedicated token and provider ID", async () => {
    const response = await POST(receiptRequest());
    expect(response.status).toBe(202);
    expect(providerFindMany).toHaveBeenCalledWith({
      where: { id: { in: [RECEIPT_PROVIDER_ID] } },
      select: { id: true, name: true },
    });
    expect(externalUsageMocks.persist).toHaveBeenCalledWith([
      expect.objectContaining({
        provider: "anthropic",
        service: "api-prepaid-funding",
        label: "receipt_cash_paid",
        costUsd: 47.25,
        metadata: expect.not.objectContaining({
          receiptSignature: expect.anything(),
        }),
      }),
    ]);
  });

  it("uses only canonical server credentials for localhost URLs with non-loopback peers", async () => {
    vi.stubEnv("BILLING_RECEIPT_LOCAL_INGEST_TOKEN", LOCAL_RECEIPT_TOKEN);
    vi.stubEnv("BILLING_RECEIPT_LOCAL_HMAC_KEY", LOCAL_RECEIPT_HMAC_KEY);
    const localUrl = "http://localhost:4103/api/ingest/usage";
    const localOnlyResponse = await POST(
      receiptRequest({}, LOCAL_RECEIPT_TOKEN, localUrl, LOCAL_RECEIPT_HMAC_KEY)
    );
    expect(localOnlyResponse.status).toBe(401);
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();

    const canonicalResponse = await POST(
      receiptRequest({}, RECEIPT_TOKEN, localUrl, RECEIPT_HMAC_KEY)
    );
    expect(canonicalResponse.status).toBe(202);
    expect(externalUsageMocks.persist).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary and receipt credentials mutually exclusive", async () => {
    expect((await POST(receiptRequest({}, USAGE_TOKEN))).status).toBe(401);
    expect((await POST(ordinaryRequest(RECEIPT_TOKEN))).status).toBe(401);
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();
  });

  it("fails closed when receipt credentials are shared or signature verification is absent", async () => {
    vi.stubEnv("BILLING_RECEIPT_INGEST_TOKEN", USAGE_TOKEN);
    expect((await POST(ordinaryRequest())).status).toBe(503);

    vi.stubEnv("BILLING_RECEIPT_INGEST_TOKEN", RECEIPT_TOKEN);
    vi.stubEnv("BILLING_RECEIPT_HMAC_KEY", "");
    expect((await POST(receiptRequest())).status).toBe(503);
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();
  });

  it("rejects malformed, tampered, future, or mismatched receipts", async () => {
    expect(
      (await POST(receiptRequest({ keyRef: "receipt-without-provider" }))).status
    ).toBe(400);
    expect(
      (
        await POST(
          receiptRequest({
            metadata: { receiptSignature: `hmac-sha256:${"0".repeat(64)}` },
          })
        )
      ).status
    ).toBe(400);
    expect(
      (await POST(receiptRequest({ occurredAt: "2099-01-01T00:00:00.000Z" }))).status
    ).toBe(400);

    providerFindMany.mockResolvedValueOnce([
      { id: RECEIPT_PROVIDER_ID, name: "openai" },
    ]);
    expect((await POST(receiptRequest())).status).toBe(400);
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();
  });

  it("rejects an event that claims the reserved subscription sourceApp", async () => {
    const response = await POST(
      nextRequest(
        {
          sourceApp: "subscription",
          provider: "anthropic",
          metricType: "subscription",
          costUsd: 5,
          occurredAt: "2026-07-14T00:00:00.000Z",
        },
        USAGE_TOKEN
      )
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'sourceApp "subscription" is reserved',
    });
  });

  it("rejects ordinary v1 events with future-dated occurredAt beyond 5-minute skew", async () => {
    const farFutureResponse = await POST(
      nextRequest(
        {
          sourceApp: "socratic-trade",
          provider: "anthropic",
          metricType: "usage",
          costUsd: 5,
          occurredAt: "2099-01-01T00:00:00.000Z",
        },
        USAGE_TOKEN
      )
    );
    expect(farFutureResponse.status).toBe(400);
    expect(await farFutureResponse.json()).toMatchObject({
      error: "occurredAt cannot be in the future",
    });
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();

    const nearFutureIso = new Date(Date.now() + 4 * 60 * 1_000).toISOString();
    const nearFutureResponse = await POST(
      nextRequest(
        {
          sourceApp: "socratic-trade",
          provider: "anthropic",
          metricType: "usage",
          costUsd: 5,
          occurredAt: nearFutureIso,
        },
        USAGE_TOKEN
      )
    );
    expect(nearFutureResponse.status).toBe(202);
  });

  it("rejects future-dated events in v2 batches with per-event rejections", async () => {
    const response = await POST(
      nextRequest(
        {
          schemaVersion: 2,
          producerId: "congress-trade",
          events: [
            {
              eventId: "valid-event-1",
              provider: "openai",
              metricType: "usage",
              costUsd: 1,
              occurredAt: new Date().toISOString(),
            },
            {
              eventId: "future-event-2",
              provider: "openai",
              metricType: "usage",
              costUsd: 2,
              occurredAt: "2099-01-01T00:00:00.000Z",
            },
          ],
        },
        USAGE_TOKEN
      )
    );
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body.persisted).toBe(1);
    expect(body.rejected).toBe(1);
    expect(body.rejections).toEqual([
      {
        index: 1,
        eventId: "future-event-2",
        issues: ["occurredAt cannot be in the future"],
      },
    ]);
  });

  it("rejects the reserved sourceApp even when it rides alongside ordinary events in a batch", async () => {
    const response = await POST(
      nextRequest(
        {
          events: [
            {
              sourceApp: "socratic-trade",
              provider: "openai",
              metricType: "usage",
              occurredAt: "2026-07-14T00:00:00.000Z",
            },
            {
              sourceApp: "subscription",
              provider: "anthropic",
              metricType: "subscription",
              costUsd: 5,
              occurredAt: "2026-07-14T00:00:00.000Z",
            },
          ],
        },
        USAGE_TOKEN
      )
    );
    expect(response.status).toBe(400);
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();
  });

  it("rejects a negative-cost subscription event that is shaped like a receipt-cash event", async () => {
    // A manual adjustment event can legally carry a negative costUsd (see
    // usage-telemetry.test.ts), but it must never be able to masquerade as a
    // receipt-cash cash-in event by reusing that channel's trigger fields.
    // looksLikeReceiptCashEvent matches on sourceApp/service/label alone, so
    // this batch is routed into the receipt-cash verification path, whose
    // signature/shape checks (metricType "cost", costUsd > 0) reject it.
    const response = await POST(
      nextRequest(
        {
          sourceApp: "billing-receipt-import",
          provider: "anthropic",
          service: "api-prepaid-funding",
          label: "receipt_cash_paid",
          metricType: "subscription",
          billingMode: "actual",
          unit: "usd",
          confidence: "actual",
          costUsd: -19.15,
          occurredAt: "2026-07-14T00:00:00.000Z",
        },
        RECEIPT_TOKEN
      )
    );
    expect(response.status).toBe(400);
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();
  });

  it("rejects a negative-cost subscription event whose magnitude exceeds the bound", async () => {
    const response = await POST(
      nextRequest(
        {
          sourceApp: "manual-billing-adjustment",
          provider: "anthropic",
          metricType: "subscription",
          billingMode: "manual",
          unit: "usd",
          confidence: "estimated",
          costUsd: -(MAX_NEGATIVE_SUBSCRIPTION_COST_USD + 0.01),
          occurredAt: "2026-07-14T00:00:00.000Z",
        },
        USAGE_TOKEN
      )
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("costUsd"),
    });
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();
  });

  it("accepts a negative-cost subscription event exactly at the magnitude bound", async () => {
    const response = await POST(
      nextRequest(
        {
          sourceApp: "manual-billing-adjustment",
          provider: "anthropic",
          metricType: "subscription",
          billingMode: "manual",
          unit: "usd",
          confidence: "estimated",
          costUsd: -MAX_NEGATIVE_SUBSCRIPTION_COST_USD,
          occurredAt: "2026-07-14T00:00:00.000Z",
        },
        USAGE_TOKEN
      )
    );
    expect(response.status).toBe(202);
    expect(externalUsageMocks.persist).toHaveBeenCalled();
  });

  it("rejects a batch whose combined negative subscription magnitude exceeds the per-batch bound even when each event is individually legal", async () => {
    const negativeEvent = (index: number) => ({
      sourceApp: "manual-billing-adjustment",
      provider: "anthropic",
      metricType: "subscription",
      billingMode: "manual",
      unit: "usd",
      confidence: "estimated",
      costUsd: -700,
      occurredAt: "2026-07-14T00:00:00.000Z",
      idempotencyKey: `batch-bound-test-${index}`,
    });
    // 3 x -700 = -2100, past the -2000 aggregate bound while every event is
    // comfortably inside the -1000 per-event bound.
    const response = await POST(
      nextRequest(
        { events: [negativeEvent(1), negativeEvent(2), negativeEvent(3)] },
        USAGE_TOKEN
      )
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining(
        `must not exceed ${MAX_NEGATIVE_SUBSCRIPTION_BATCH_COST_USD} per batch`
      ),
    });
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();
  });

  it("accepts a batch whose combined negative subscription magnitude lands exactly on the per-batch bound", async () => {
    const negativeEvent = (index: number) => ({
      sourceApp: "manual-billing-adjustment",
      provider: "anthropic",
      metricType: "subscription",
      billingMode: "manual",
      unit: "usd",
      confidence: "estimated",
      costUsd: -(MAX_NEGATIVE_SUBSCRIPTION_BATCH_COST_USD / 2),
      occurredAt: "2026-07-14T00:00:00.000Z",
      idempotencyKey: `batch-bound-boundary-test-${index}`,
    });
    const response = await POST(
      nextRequest({ events: [negativeEvent(1), negativeEvent(2)] }, USAGE_TOKEN)
    );
    expect(response.status).toBe(202);
    expect(externalUsageMocks.persist).toHaveBeenCalled();
  });

  it("maps the trailing-window cumulative negative-adjustment rejection to a non-retryable 400", async () => {
    const { NegativeSubscriptionWindowLimitExceededError } = await import(
      "@/lib/external-usage-events"
    );
    externalUsageMocks.persist.mockRejectedValueOnce(
      new NegativeSubscriptionWindowLimitExceededError(4600, 500)
    );
    const response = await POST(
      nextRequest(
        {
          sourceApp: "manual-billing-adjustment",
          provider: "anthropic",
          metricType: "subscription",
          billingMode: "manual",
          unit: "usd",
          confidence: "estimated",
          costUsd: -100,
          occurredAt: "2026-07-14T00:00:00.000Z",
          idempotencyKey: "window-bound-route-test",
        },
        USAGE_TOKEN
      )
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("passes providerRequestId through to persistExternalUsageEvents when supplied", async () => {
    const response = await POST(
      nextRequest(
        {
          sourceApp: "socratic-trade",
          provider: "openrouter",
          metricType: "cost",
          costUsd: 0.01,
          occurredAt: "2026-07-18T00:00:00.000Z",
          providerRequestId: "gen-route-test-1",
        },
        USAGE_TOKEN
      )
    );
    expect(response.status).toBe(202);
    expect(externalUsageMocks.persist).toHaveBeenCalledWith([
      expect.objectContaining({ providerRequestId: "gen-route-test-1" }),
    ]);
  });

  it("omits providerRequestId onto persistExternalUsageEvents when not supplied", async () => {
    const response = await POST(ordinaryRequest());
    expect(response.status).toBe(202);
    expect(externalUsageMocks.persist).toHaveBeenCalledWith([
      expect.objectContaining({ providerRequestId: undefined }),
    ]);
  });

  it("validates every provider ID/name pair in a receipt batch", async () => {
    const response = await POST(
      nextRequest(
        {
          events: [
            receiptEvent(),
            receiptEvent({ provider: "openai", costUsd: 52.5 }),
          ],
        },
        RECEIPT_TOKEN
      )
    );
    expect(response.status).toBe(400);
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();
  });
});

describe("POST /api/ingest/usage body limits", () => {
  it("rejects an oversized declared Content-Length before JSON decoding", async () => {
    ipCounter += 1;
    const request = new NextRequest("https://usage.jays.services/api/ingest/usage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${USAGE_TOKEN}`,
        "content-type": "application/json",
        "content-length": String(MAX_USAGE_TELEMETRY_BODY_BYTES + 1),
        "x-forwarded-for": `10.1.0.${ipCounter}`,
      },
      body: "{}",
    });

    const response = await POST(request);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("exceeds"),
    });
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();
  });

  it("rejects an oversized chunked stream before JSON decoding", async () => {
    ipCounter += 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_USAGE_TELEMETRY_BODY_BYTES));
        controller.enqueue(new Uint8Array([0x7b]));
        controller.close();
      },
    });
    const request = new NextRequest(
      new Request("https://usage.jays.services/api/ingest/usage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${USAGE_TOKEN}`,
          "content-type": "application/json",
          "x-forwarded-for": `10.1.0.${ipCounter}`,
        },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" })
    );

    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();
  });

  it("preserves valid ingest behavior below the limit", async () => {
    const response = await POST(ordinaryRequest());
    expect(response.status).toBe(202);
    expect(externalUsageMocks.persist).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/ingest/usage rate limiting (X1)", () => {
  function requestFrom(
    headers: Record<string, string>,
    body: unknown = {
      sourceApp: "socratic-trade",
      provider: "openai",
      metricType: "cost",
      costUsd: 0,
      occurredAt: "2026-07-14T00:00:00.000Z",
    }
  ): NextRequest {
    return new NextRequest("https://usage.jays.services/api/ingest/usage", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("limits authenticated traffic per token, not per source IP", async () => {
    // 10 distinct source IPs but ONE credential: the 11th request 429s,
    // proving the bucket follows the authenticated identity (before X1 each
    // of these would have had its own per-IP bucket).
    for (let index = 1; index <= 10; index += 1) {
      const response = await POST(requestFrom({
        authorization: `Bearer ${USAGE_TOKEN}`,
        "x-forwarded-for": `10.9.0.${index}`,
      }));
      expect(response.status).toBe(202);
    }
    const limited = await POST(requestFrom({
      authorization: `Bearer ${USAGE_TOKEN}`,
      "x-forwarded-for": "10.9.0.11",
    }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    expect(externalUsageMocks.persist).toHaveBeenCalledTimes(10);
  });

  it("does not let unauthenticated hammering through the shared Cloudflare egress IP drain the producer bucket", async () => {
    // Production topology: every client shares Cloudflare's egress IP as the
    // rightmost XFF hop; CF-Connecting-IP distinguishes them. Bad-token
    // requests from many distinct CF-proxied clients each get their own
    // backstop bucket...
    for (let index = 1; index <= 15; index += 1) {
      const response = await POST(requestFrom({
        authorization: "Bearer wrong-token",
        "x-forwarded-for": "173.245.48.1",
        "cf-connecting-ip": `198.51.100.${index}`,
      }));
      expect(response.status).toBe(401);
    }
    // ...and the legitimate producer (same shared egress IP) is unaffected.
    const producer = await POST(requestFrom({
      authorization: `Bearer ${USAGE_TOKEN}`,
      "x-forwarded-for": "173.245.48.1",
      "cf-connecting-ip": "198.51.100.1",
    }));
    expect(producer.status).toBe(202);
  });

  it("throttles unauthenticated hammering from one direct (non-Cloudflare) peer", async () => {
    for (let index = 0; index < 10; index += 1) {
      const response = await POST(requestFrom({
        authorization: "Bearer wrong-token",
        "x-forwarded-for": "45.33.12.9",
      }));
      expect(response.status).toBe(401);
    }
    const limited = await POST(requestFrom({
      authorization: "Bearer wrong-token",
      "x-forwarded-for": "45.33.12.9",
    }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
  });
});

describe("POST /api/ingest/usage producer scoping", () => {
  const tokA = "tok-socratic-secret";
  const tokB = "tok-congress-secret";

  beforeEach(() => {
    vi.stubEnv(
      "USAGE_INGEST_PRODUCER_TOKENS",
      `socratic-trade:${tokA},congress-trade:${tokB}`
    );
  });

  it("accepts a scoped token when events match allowedSourceApps", async () => {
    const response = await POST(
      nextRequest(
        {
          sourceApp: "socratic-trade",
          provider: "anthropic",
          metricType: "usage",
          costUsd: 1,
          occurredAt: "2026-07-14T00:00:00.000Z",
        },
        tokA
      )
    );
    expect(response.status).toBe(202);
    expect(externalUsageMocks.persist).toHaveBeenCalledTimes(1);
  });

  it("rejects a scoped token with 403 when event sourceApp does not match producer scope", async () => {
    const response = await POST(
      nextRequest(
        {
          sourceApp: "congress-trade",
          provider: "anthropic",
          metricType: "usage",
          costUsd: 1,
          occurredAt: "2026-07-14T00:00:00.000Z",
        },
        tokA
      )
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("Credential is not authorized for this producer"),
    });
    expect(externalUsageMocks.persist).not.toHaveBeenCalled();
  });

  it("gives distinct producer tokens independent 10 rps rate-limit buckets", async () => {
    // Fill tokA rate limit bucket (10 requests)
    for (let i = 0; i < 10; i++) {
      const resA = await POST(
        nextRequest(
          {
            sourceApp: "socratic-trade",
            provider: "anthropic",
            metricType: "usage",
            costUsd: 1,
            occurredAt: "2026-07-14T00:00:00.000Z",
          },
          tokA
        )
      );
      expect(resA.status).toBe(202);
    }

    // 11th request on tokA should be 429
    const limitedA = await POST(
      nextRequest(
        {
          sourceApp: "socratic-trade",
          provider: "anthropic",
          metricType: "usage",
          costUsd: 1,
          occurredAt: "2026-07-14T00:00:00.000Z",
        },
        tokA
      )
    );
    expect(limitedA.status).toBe(429);

    // tokB request should still succeed (202) because rate-limit bucket is per-credential
    const resB = await POST(
      nextRequest(
        {
          sourceApp: "congress-trade",
          provider: "anthropic",
          metricType: "usage",
          costUsd: 1,
          occurredAt: "2026-07-14T00:00:00.000Z",
        },
        tokB
      )
    );
    expect(resB.status).toBe(202);
  });
});

describe("POST /api/ingest/usage canonical AI block (UM-1592)", () => {
  function aiRequest(ai?: Record<string, unknown>): NextRequest {
    return nextRequest(
      {
        schemaVersion: 2,
        producerId: "botfleet",
        events: [{
          eventId: "turn-1",
          provider: "anthropic",
          metricType: "usage",
          unit: "token",
          quantity: 60,
          costUsd: 0.01,
          occurredAt: "2026-10-17T00:00:00.000Z",
          ...(ai ? { ai } : { metadata: { promptTokens: 40, completionTokens: 20 } }),
        }],
      },
      USAGE_TOKEN,
      "https://usage.jays.services/api/ingest/usage",
      2
    );
  }

  it("writes one AiRequest row per ai-block event", async () => {
    persistAiRequests.mockResolvedValueOnce({ inserted: 1, merged: 0, duplicates: 0 });
    const response = await POST(aiRequest({
      model: { requested: "sonnet", served: "claude-sonnet-4-5" },
      harness: "botfleet",
      seat: "CLAUDE",
      tokens: { input: 10, output: 20, cacheRead: 15, cacheWrite5m: 5, cacheWrite1h: 10, reasoning: 4 },
      durationMs: 900.4,
      ttftMs: 120,
      billingMode: "payg",
      costSource: "billed",
    }));
    expect(response.status).toBe(202);
    expect(persistAiRequests).toHaveBeenCalledTimes(1);
    const [[requests]] = persistAiRequests.mock.calls;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: "complete",
      source: "ingest",
      harness: "botfleet",
      seat: "CLAUDE",
      requestedModel: "sonnet",
      servedModel: "claude-sonnet-4-5",
      durationMs: 900,
      ttftMs: 120,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 15,
      cacheWriteTokens: 15,
      cacheWrite5mTokens: 5,
      cacheWrite1hTokens: 10,
      reasoningTokens: 4,
      costUsd: 0.01,
      costSource: "billed",
      billingMode: "payg",
    });
    expect(requests[0].dedupeKey).toMatch(/^ingest:[0-9a-f]{64}$/);
  });

  it("does not write AiRequest rows for legacy-mapped events", async () => {
    const response = await POST(aiRequest());
    expect(response.status).toBe(202);
    expect(persistAiRequests).not.toHaveBeenCalled();
    expect(externalUsageMocks.persist).toHaveBeenCalledWith([
      expect.objectContaining({
        metadata: expect.objectContaining({ _aiTokensInput: 40, _aiTokensOutput: 20, _aiSource: "legacy" }),
      }),
    ]);
  });

  it("still ACKs when the AiRequest store fails", async () => {
    persistAiRequests.mockRejectedValueOnce(new Error("store down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await POST(aiRequest({ tokens: { input: 1 } }));
    expect(response.status).toBe(202);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
