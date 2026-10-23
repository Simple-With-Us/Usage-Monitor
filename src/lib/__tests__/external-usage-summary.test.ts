import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  externalUsageEvent: { findMany: vi.fn(), groupBy: vi.fn() },
  externalUsageEventDailyRollup: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  sumMonthToDateExternalCostAttribution,
  sumMonthToDateExternalCostByProvider,
  sumMonthToDateReceiptCashByProviderId,
  summarizeExternalUsageEvents,
} from "../external-usage-events";

describe("summarizeExternalUsageEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.externalUsageEvent.findMany.mockResolvedValue([]);
  });

  it("aggregates the raw month via one SQL groupBy and preserves rollup totals", async () => {
    // E1: the 1,002 raw events below used to arrive as two cursor-paginated
    // findMany pages; they now arrive as three pre-aggregated groupBy rows
    // (split by the limit dimension) with identical folded output.
    const rawGroup = {
      sourceApp: "socratic-trade",
      environment: "prod",
      provider: "openai",
      service: "responses",
      projectId: "project-a",
      metricType: "usage",
      unit: "token",
      limitWindow: "month",
    };
    prismaMock.externalUsageEvent.groupBy.mockResolvedValueOnce([
      {
        ...rawGroup,
        limit: 100,
        _sum: { costUsd: 1_000, requests: 1_000, quantity: 2_000 },
        _count: { _all: 1_000, costUsd: 1_000 },
        _max: { occurredAt: new Date("2026-07-02T00:00:00.000Z") },
      },
      {
        ...rawGroup,
        limit: 150,
        _sum: { costUsd: 1, requests: 1, quantity: 2 },
        _count: { _all: 1, costUsd: 1 },
        _max: { occurredAt: new Date("2026-07-03T00:00:00.000Z") },
      },
      {
        ...rawGroup,
        limit: 200,
        _sum: { costUsd: 1, requests: 1, quantity: 2 },
        _count: { _all: 1, costUsd: 1 },
        _max: { occurredAt: new Date("2026-07-04T00:00:00.000Z") },
      },
    ]);
    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValue([
      {
        sourceApp: "socratic-trade",
        environment: "prod",
        provider: "openai",
        service: "responses",
        projectId: "project-a",
        metricType: "usage",
        unit: "token",
        eventCount: 5,
        totalCostUsd: 5,
        totalRequests: 5,
        totalQuantity: 10,
        maxLimit: 90,
        limitWindow: "month",
        latestOccurredAt: new Date("2026-06-30T00:00:00.000Z"),
      },
    ]);

    const now = new Date("2026-07-15T00:00:00.000Z");
    const result = await summarizeExternalUsageEvents(
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z"),
      now
    );

    expect(prismaMock.externalUsageEvent.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: [
          "sourceApp",
          "environment",
          "provider",
          "service",
          "label",
          "projectId",
          "metricType",
          "unit",
          "limit",
          "limitWindow",
        ],
        where: expect.objectContaining({
          // Future-dated telemetry fix: the raw scan is bounded to `now` so
          // phantom future rows can never inflate totals or latestAt.
          occurredAt: { gte: new Date("2026-07-01T00:00:00.000Z"), lte: now },
        }),
      })
    );
    // The only raw findMany left is the receipt-candidate superset query -
    // the cursor-paginated full-month scan is gone.
    expect(prismaMock.externalUsageEvent.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.externalUsageEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceApp: "billing-receipt-import",
        }),
      })
    );
    expect(result).toEqual({
      eventCount: 1_007,
      derivedCostEstimateUsd: 0,
      derivedCostEstimateEventCount: 0,
      groups: [
        expect.objectContaining({
          eventCount: 1_007,
          pricedEventCount: 1_002,
          unpricedEventCount: 0,
          unclassifiedCostEventCount: 5,
          costCoverage: "partial",
          totalCostUsd: 1_007,
          totalRequests: 1_007,
          totalQuantity: 2_014,
          limit: 200,
          latestAt: "2026-07-04T00:00:00.000Z",
        }),
      ],
    });
  });

  it("keeps metric units in separate quota groups", async () => {
    const rawGroup = {
      sourceApp: "socratic-trade",
      environment: "prod",
      provider: "openai",
      service: "responses",
      projectId: null,
      metricType: "usage",
      limitWindow: "month",
    };
    prismaMock.externalUsageEvent.groupBy.mockResolvedValueOnce([
      {
        ...rawGroup,
        unit: "token",
        limit: 20_000,
        _sum: { costUsd: null, requests: 0, quantity: 10_000 },
        _count: { _all: 1, costUsd: 0 },
        _max: { occurredAt: new Date("2026-07-12T00:00:00.000Z") },
      },
      {
        ...rawGroup,
        unit: "request",
        limit: 100,
        _sum: { costUsd: null, requests: 10, quantity: 0 },
        _count: { _all: 1, costUsd: 0 },
        _max: { occurredAt: new Date("2026-07-12T00:00:00.000Z") },
      },
    ]);
    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValue([]);

    const result = await summarizeExternalUsageEvents(
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z")
    );

    expect(result.groups).toHaveLength(2);
    expect(result.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ unit: "token", totalQuantity: 10_000, limit: 20_000 }),
        expect.objectContaining({
          unit: "request",
          totalRequests: 10,
          limit: 100,
          costCoverage: "unknown",
          unpricedEventCount: 1,
        }),
      ])
    );
  });

  it("treats explicit zero as priced while preserving legacy rollups as unclassified", async () => {
    prismaMock.externalUsageEvent.groupBy.mockResolvedValueOnce([
      {
        sourceApp: "congress-trade",
        environment: "prod",
        provider: "gemini",
        service: "gemini-3.5-flash",
        projectId: null,
        metricType: "request",
        unit: "request",
        limit: null,
        limitWindow: null,
        _sum: { costUsd: 0, requests: 1, quantity: 1 },
        _count: { _all: 1, costUsd: 1 },
        _max: { occurredAt: new Date("2026-07-13T00:00:00.000Z") },
      },
    ]);
    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValue([
      {
        sourceApp: "congress-trade",
        environment: "prod",
        provider: "gemini",
        service: "gemini-3.5-flash",
        projectId: null,
        metricType: "request",
        unit: "request",
        eventCount: 3,
        pricedEventCount: null,
        unpricedEventCount: null,
        unclassifiedCostEventCount: null,
        totalCostUsd: 0,
        totalRequests: 3,
        totalQuantity: 3,
        maxLimit: null,
        limitWindow: null,
        latestOccurredAt: new Date("2026-06-30T00:00:00.000Z"),
      },
    ]);

    const result = await summarizeExternalUsageEvents(
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z")
    );

    expect(result.groups).toEqual([
      expect.objectContaining({
        provider: "gemini",
        canonicalProvider: "google-ai",
        totalCostUsd: 0,
        pricedEventCount: 1,
        unpricedEventCount: 0,
        unclassifiedCostEventCount: 3,
        costCoverage: "partial",
      }),
    ]);
  });

  it("separates Claude API-equivalent estimates across raw rows and historical rollups", async () => {
    prismaMock.externalUsageEvent.groupBy.mockResolvedValueOnce([
      {
        sourceApp: "socratic-trade",
        environment: "prod",
        provider: "anthropic",
        service: "messages",
        projectId: "project-a",
        metricType: "cost",
        unit: "usd",
        limit: null,
        limitWindow: null,
        _sum: { costUsd: 10, requests: 1, quantity: 0 },
        _count: { _all: 1, costUsd: 1 },
        _max: { occurredAt: new Date("2026-07-03T00:00:00.000Z") },
      },
      {
        sourceApp: "claude-code",
        environment: "prod",
        provider: "anthropic",
        service: "claude-code",
        projectId: "project-a",
        metricType: "cost",
        unit: "usd",
        limit: null,
        limitWindow: null,
        _sum: { costUsd: 5_000, requests: 0, quantity: 0 },
        _count: { _all: 1, costUsd: 1 },
        _max: { occurredAt: new Date("2026-07-03T00:00:00.000Z") },
      },
    ]);
    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValueOnce([
      {
        sourceApp: "socratic-trade",
        environment: "prod",
        provider: "anthropic",
        service: "messages",
        projectId: "project-a",
        metricType: "cost",
        unit: "usd",
        eventCount: 1,
        pricedEventCount: 1,
        unpricedEventCount: 0,
        unclassifiedCostEventCount: 0,
        totalCostUsd: 5,
        totalRequests: 1,
        totalQuantity: 0,
        maxLimit: null,
        limitWindow: null,
        latestOccurredAt: new Date("2026-06-30T00:00:00.000Z"),
      },
      {
        sourceApp: "claude-code",
        environment: "prod",
        provider: "anthropic",
        service: "claude-code",
        projectId: "project-a",
        metricType: "cost",
        unit: "usd",
        eventCount: 1,
        pricedEventCount: 1,
        unpricedEventCount: 0,
        unclassifiedCostEventCount: 0,
        totalCostUsd: 4_000,
        totalRequests: 0,
        totalQuantity: 0,
        maxLimit: null,
        limitWindow: null,
        latestOccurredAt: new Date("2026-06-30T00:00:00.000Z"),
      },
    ]);

    const result = await summarizeExternalUsageEvents(
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z")
    );

    expect(result.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          service: "messages",
          totalCostUsd: 15,
          estimatedApiEquivalentUsd: 0,
          pricedEventCount: 2,
          costCoverage: "complete",
        }),
        expect.objectContaining({
          service: "claude-code",
          totalCostUsd: 0,
          estimatedApiEquivalentUsd: 9_000,
          pricedEventCount: 0,
          unpricedEventCount: 0,
          costCoverage: "unknown",
        }),
      ])
    );
  });

  it("excludes raw and rolled-up Claude estimates from provider and project cash totals", async () => {
    prismaMock.externalUsageEvent.groupBy.mockResolvedValueOnce([
      {
        provider: "anthropic",
        sourceApp: "socratic-trade",
        service: "messages",
        projectId: null,
        metricType: "cost",
        _sum: { costUsd: 10 },
        _count: { _all: 1, costUsd: 1 },
      },
      {
        provider: "anthropic",
        sourceApp: "claude-code",
        service: "claude-code",
        projectId: null,
        metricType: "cost",
        _sum: { costUsd: 5_000 },
        _count: { _all: 1, costUsd: 1 },
      },
    ]);
    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValueOnce([
      {
        provider: "anthropic",
        sourceApp: "socratic-trade",
        service: "messages",
        projectId: null,
        metricType: "cost",
        eventCount: 1,
        pricedEventCount: 1,
        unpricedEventCount: 0,
        unclassifiedCostEventCount: 0,
        totalCostUsd: 5,
      },
      {
        provider: "anthropic",
        sourceApp: "claude-code",
        service: "claude-code",
        projectId: null,
        metricType: "cost",
        eventCount: 1,
        pricedEventCount: 1,
        unpricedEventCount: 0,
        unclassifiedCostEventCount: 0,
        totalCostUsd: 4_000,
      },
      {
        provider: "anthropic",
        sourceApp: "subscription",
        service: null,
        projectId: null,
        metricType: "subscription",
        eventCount: 2,
        pricedEventCount: 2,
        unpricedEventCount: 0,
        unclassifiedCostEventCount: 0,
        totalCostUsd: 400,
      },
    ]);

    const byProvider = await sumMonthToDateExternalCostByProvider(
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-07-03T00:00:00.000Z")
    );
    expect(byProvider.get("anthropic")).toEqual({
      usagePushed: 15,
      subscriptionPushed: 400,
      // Both subscription rows above use sourceApp "subscription" (the
      // materializer's reserved sourceApp), so none of the $400 is manual.
      subscriptionPushedManualUsd: 0,
      estimatedApiEquivalentUsd: 9_000,
      pricedEventCount: 4,
      unpricedEventCount: 0,
      unclassifiedCostEventCount: 0,
    });

    prismaMock.externalUsageEvent.groupBy.mockResolvedValueOnce([
      {
        provider: "anthropic",
        sourceApp: "socratic-trade",
        service: "messages",
        projectId: "project-a",
        metricType: "cost",
        _sum: { costUsd: 10 },
        _count: { _all: 1, costUsd: 1 },
      },
      {
        provider: "anthropic",
        sourceApp: "claude-code",
        service: "claude-code",
        projectId: "project-a",
        metricType: "cost",
        _sum: { costUsd: 5_000 },
        _count: { _all: 1, costUsd: 1 },
      },
    ]);
    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValueOnce([
      {
        provider: "anthropic",
        sourceApp: "socratic-trade",
        service: "messages",
        projectId: "project-a",
        metricType: "cost",
        eventCount: 1,
        pricedEventCount: 1,
        unpricedEventCount: 0,
        unclassifiedCostEventCount: 0,
        totalCostUsd: 5,
      },
      {
        provider: "anthropic",
        sourceApp: "claude-code",
        service: "claude-code",
        projectId: "project-a",
        metricType: "cost",
        eventCount: 1,
        pricedEventCount: 1,
        unpricedEventCount: 0,
        unclassifiedCostEventCount: 0,
        totalCostUsd: 4_000,
      },
    ]);

    const attribution = await sumMonthToDateExternalCostAttribution(
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-07-03T00:00:00.000Z")
    );
    expect(attribution).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        sourceApp: "socratic-trade",
        projectId: "project-a",
        costUsd: 15,
      }),
    ]);
  });

  it("splits subscriptionPushed into the materializer-owned and manual-adjustment slices", async () => {
    prismaMock.externalUsageEvent.groupBy.mockResolvedValueOnce([
      {
        provider: "anthropic",
        sourceApp: "subscription",
        service: null,
        metricType: "subscription",
        _sum: { costUsd: 124.99 },
        _count: { _all: 1, costUsd: 1 },
      },
      {
        provider: "anthropic",
        sourceApp: "manual-billing-adjustment",
        service: null,
        metricType: "subscription",
        _sum: { costUsd: -50 },
        _count: { _all: 1, costUsd: 1 },
      },
    ]);
    // monthStart === rawCutoff below, so the code path never queries rollups
    // (monthStart < rawCutoff is false) — no mock needed for that call, and
    // stubbing an unconsumed mockResolvedValueOnce here would otherwise leak
    // into the next test that shares this same prisma mock.

    const byProvider = await sumMonthToDateExternalCostByProvider(
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z")
    );
    expect(byProvider.get("anthropic")).toEqual({
      usagePushed: 0,
      // Additive total across BOTH sourceApps, matching the pre-existing
      // (unchanged) contract for subscriptionMonthToDateUsd.
      subscriptionPushed: 74.99,
      // Isolated slice from sourceApp != "subscription" only — this is what
      // budget-status.ts's fixed-cost dedupe must NOT cancel out.
      subscriptionPushedManualUsd: -50,
      estimatedApiEquivalentUsd: 0,
      pricedEventCount: 2,
      unpricedEventCount: 0,
      unclassifiedCostEventCount: 0,
    });
  });

  it("collapses raw cost groups and excludes only fully validated receipt cash", async () => {
    const providerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const digest = "b".repeat(64);
    const receiptBase = {
      sourceApp: "billing-receipt-import",
      provider: "anthropic",
      service: "api-prepaid-funding",
      label: "receipt_cash_paid",
      keyRef: `provider:${providerId}:billing-receipt:${digest}`,
      billingMode: "actual",
      metricType: "cost",
      unit: "USD",
      confidence: "actual",
      costUsd: 50,
      occurredAt: new Date("2026-07-10T00:00:00.000Z"),
    };
    prismaMock.externalUsageEvent.findMany.mockResolvedValueOnce([
      {
        id: "valid-receipt",
        idempotencyKey: `billing-receipt:v1:${digest}`,
        metadata: { evidenceRef: `hmac-sha256:${digest}` },
        ...receiptBase,
      },
      {
        id: "malformed-receipt",
        idempotencyKey: `billing-receipt:v1:${digest}`,
        metadata: { evidenceRef: `hmac-sha256:${"c".repeat(64)}` },
        ...receiptBase,
      },
    ]);
    prismaMock.externalUsageEvent.groupBy.mockResolvedValueOnce([
      {
        provider: "anthropic",
        sourceApp: "socratic-trade",
        service: "messages",
        metricType: "cost",
        _sum: { costUsd: 10 },
        _count: { _all: 2, costUsd: 1 },
      },
      {
        provider: "anthropic",
        sourceApp: "claude-code",
        service: "claude-code",
        metricType: "cost",
        _sum: { costUsd: 999 },
        _count: { _all: 1, costUsd: 1 },
      },
      {
        provider: "anthropic",
        sourceApp: "subscription",
        service: null,
        metricType: "subscription",
        _sum: { costUsd: 200 },
        _count: { _all: 1, costUsd: 1 },
      },
      {
        provider: "anthropic",
        sourceApp: "manual-billing-adjustment",
        service: null,
        metricType: "subscription",
        _sum: { costUsd: -25 },
        _count: { _all: 1, costUsd: 1 },
      },
    ]);

    const byProvider = await sumMonthToDateExternalCostByProvider(
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z")
    );

    expect(prismaMock.externalUsageEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceApp: "billing-receipt-import",
          service: "api-prepaid-funding",
          label: "receipt_cash_paid",
          billingMode: "actual",
          metricType: "cost",
          confidence: "actual",
        }),
      })
    );
    expect(prismaMock.externalUsageEvent.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        // Wave H / E1: shared MTD scan always includes projectId.
        by: ["provider", "sourceApp", "service", "label", "projectId", "metricType"],
        where: expect.objectContaining({
          OR: expect.arrayContaining([{ service: null }, { label: null }]),
        }),
      })
    );
    expect(byProvider.get("anthropic")).toEqual({
      usagePushed: 60,
      subscriptionPushed: 175,
      subscriptionPushedManualUsd: -25,
      estimatedApiEquivalentUsd: 999,
      pricedEventCount: 4,
      unpricedEventCount: 1,
      unclassifiedCostEventCount: 0,
    });
  });

  it("uses the reduced raw grouping dimensions for exact project attribution", async () => {
    const providerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const digest = "d".repeat(64);
    const receiptBase = {
      sourceApp: "billing-receipt-import",
      provider: "openai",
      service: "api-prepaid-funding",
      projectId: "project-a",
      label: "receipt_cash_paid",
      keyRef: `provider:${providerId}:billing-receipt:${digest}`,
      billingMode: "actual",
      metricType: "cost",
      unit: "usd",
      confidence: "actual",
      costUsd: 30,
      occurredAt: new Date("2026-07-10T00:00:00.000Z"),
    };
    prismaMock.externalUsageEvent.findMany.mockResolvedValueOnce([
      {
        id: "valid-project-receipt",
        idempotencyKey: `billing-receipt:v1:${digest}`,
        metadata: { evidenceRef: `hmac-sha256:${digest}` },
        ...receiptBase,
      },
      {
        id: "malformed-project-receipt",
        idempotencyKey: "wrong-idempotency-key",
        metadata: { evidenceRef: `hmac-sha256:${digest}` },
        ...receiptBase,
      },
    ]);
    prismaMock.externalUsageEvent.groupBy.mockResolvedValueOnce([
      {
        provider: "openai",
        sourceApp: "socratic-trade",
        service: "responses",
        projectId: "project-a",
        metricType: "cost",
        _sum: { costUsd: 12 },
        _count: { _all: 2, costUsd: 1 },
      },
    ]);

    const attribution = await sumMonthToDateExternalCostAttribution(
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z")
    );

    expect(prismaMock.externalUsageEvent.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["provider", "sourceApp", "service", "label", "projectId", "metricType"],
        where: expect.objectContaining({ OR: expect.any(Array) }),
      })
    );
    expect(attribution).toEqual([
      {
        provider: "openai",
        sourceApp: "socratic-trade",
        projectId: "project-a",
        metricType: "cost",
        costUsd: 12,
        pricedEventCount: 1,
        unpricedEventCount: 1,
        unclassifiedCostEventCount: 0,
      },
      {
        provider: "openai",
        sourceApp: "billing-receipt-import",
        projectId: "project-a",
        metricType: "cost",
        costUsd: 30,
        pricedEventCount: 1,
        unpricedEventCount: 0,
        unclassifiedCostEventCount: 0,
      },
    ]);
  });

  it("keeps exact receipt cash separate across raw rows and rollups", async () => {
    const providerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const receipt = (digest: string) => ({
      sourceApp: "billing-receipt-import",
      service: "api-prepaid-funding",
      label: "receipt_cash_paid",
      keyRef: `provider:${providerId}:billing-receipt:${digest.repeat(64)}`,
      billingMode: "actual",
      metricType: "cost",
      unit: "usd",
      confidence: "actual",
    });
    prismaMock.externalUsageEvent.groupBy.mockResolvedValueOnce([
      {
        ...receipt("a"),
        _sum: { costUsd: 12.5 },
        _count: { _all: 1 },
      },
    ]);
    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValueOnce([
      {
        ...receipt("b"),
        totalCostUsd: 34.75,
        eventCount: 2,
      },
    ]);

    const receiptNow = new Date("2026-07-15T12:00:00.000Z");
    const receipts = await sumMonthToDateReceiptCashByProviderId(
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-07-03T00:00:00.000Z"),
      receiptNow
    );
    expect(receipts.get(providerId)).toEqual({ paidUsd: 47.25, eventCount: 3 });
    expect(prismaMock.externalUsageEvent.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          occurredAt: {
            gte: new Date("2026-07-03T00:00:00.000Z"),
            lte: receiptNow,
          },
        }),
      })
    );
    expect(prismaMock.externalUsageEventDailyRollup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ latestOccurredAt: { lte: receiptNow } }),
      })
    );

    prismaMock.externalUsageEvent.findMany.mockResolvedValueOnce([
      {
        id: "receipt-raw",
        provider: "anthropic",
        environment: null,
        projectId: null,
        quantity: 0,
        costUsd: 12.5,
        requests: 0,
        limit: null,
        limitWindow: null,
        occurredAt: new Date("2026-07-03T00:00:00.000Z"),
        ...receipt("a"),
      },
    ]);
    // The groupBy carries the non-receipt rows; receipt candidates arrive
    // through the findMany above and are folded per-row.
    prismaMock.externalUsageEvent.groupBy.mockResolvedValueOnce([]);
    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValueOnce([
      {
        provider: "anthropic",
        environment: null,
        projectId: null,
        eventCount: 2,
        pricedEventCount: 2,
        unpricedEventCount: 0,
        unclassifiedCostEventCount: 0,
        totalCostUsd: 34.75,
        totalRequests: 0,
        totalQuantity: 0,
        maxLimit: null,
        limitWindow: null,
        latestOccurredAt: new Date("2026-06-30T00:00:00.000Z"),
        ...receipt("b"),
      },
    ]);
    const summary = await summarizeExternalUsageEvents(
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z")
    );
    expect(summary.groups).toEqual([
      expect.objectContaining({
        receiptCashPaidUsd: 47.25,
        totalCostUsd: 0,
        estimatedApiEquivalentUsd: 0,
      }),
    ]);
  });
});

describe("summarizeExternalUsageEvents derived cost estimates", () => {
  const FLAG = "INGEST_COST_DERIVATION_ENABLED";

  beforeEach(() => {
    prismaMock.externalUsageEvent.findMany.mockResolvedValue([]);
    prismaMock.externalUsageEvent.groupBy.mockResolvedValue([]);
    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValue([]);
    prismaMock.$queryRaw.mockResolvedValue([{ totalUsd: 12.5, eventCount: 7 }]);
  });

  afterEach(() => {
    delete process.env[FLAG];
  });

  it("skips the json_extract scan entirely when the flag is off (default)", async () => {
    const summary = await summarizeExternalUsageEvents(
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z")
    );
    expect(summary.derivedCostEstimateUsd).toBe(0);
    expect(summary.derivedCostEstimateEventCount).toBe(0);
  });

  it("surfaces monitor-estimated totals separately when the flag is on", async () => {
    process.env[FLAG] = "true";
    const summary = await summarizeExternalUsageEvents(
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z")
    );
    expect(summary.derivedCostEstimateUsd).toBe(12.5);
    expect(summary.derivedCostEstimateEventCount).toBe(7);
    // Derived estimates never leak into the producer-reported cost pool.
    expect(summary.groups).toEqual([]);
  });
});

describe("subscription analytics estimates shared across providers", () => {
  const now = new Date("2026-07-03T00:00:00.000Z");
  const monthStart = new Date("2026-07-01T00:00:00.000Z");
  const sources = [
    { sourceApp: "claude-code", provider: "anthropic", service: "claude-code", cost: 10 },
    { sourceApp: "grok-build", provider: "xai", service: "grok-cli", cost: 8 },
    { sourceApp: "openai-codex", provider: "openai", service: "codex-cli", cost: 5 },
  ];
  const tokens = [
    { sourceApp: "opencode", provider: "anthropic", service: "opencode", keyRef: "claude-sonnet-4-5", label: "token:input", quantity: 1_000_000 },
    { sourceApp: "antigravity-statusline", provider: "anthropic", service: "antigravity", keyRef: "claude-sonnet-4-5", label: "token:input", quantity: 1_000_000 },
    { sourceApp: "fx", provider: "xai", service: "fx", keyRef: "grok-4.6", label: "token:input", quantity: 1_000_000 },
    { sourceApp: "openai-codex", provider: "openai", service: "codex-cli", keyRef: "claude-sonnet-4-5", label: "token:input", quantity: 1_000_000 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.externalUsageEvent.findMany.mockResolvedValue([]);
    prismaMock.$queryRaw.mockResolvedValue(tokens);
  });

  it("keeps each source's derived summary estimate beside another source's reported cost", async () => {
    prismaMock.externalUsageEvent.groupBy.mockResolvedValueOnce([
      ...sources.map(({ sourceApp, provider, service, cost }) => ({
        sourceApp,
        provider,
        service,
        environment: null,
        projectId: null,
        metricType: "cost",
        unit: "usd",
        limit: null,
        limitWindow: null,
        _sum: { costUsd: cost, requests: 0, quantity: 0 },
        _count: { _all: 1, costUsd: 1 },
        _max: { occurredAt: now },
      })),
      ...tokens.map(({ sourceApp, provider, service, quantity }) => ({
        sourceApp,
        provider,
        service,
        environment: null,
        projectId: null,
        metricType: "usage",
        unit: "token",
        limit: null,
        limitWindow: null,
        _sum: { costUsd: null, requests: 0, quantity },
        _count: { _all: 1, costUsd: 0 },
        _max: { occurredAt: now },
      })),
    ]);
    const summary = await summarizeExternalUsageEvents(monthStart, monthStart, now);
    const estimateFor = (sourceApp: string) =>
      summary.groups.reduce(
        (sum, group) => sum + (group.sourceApp === sourceApp ? group.estimatedApiEquivalentUsd : 0),
        0
      );

    expect(estimateFor("claude-code")).toBe(10);
    expect(estimateFor("opencode")).toBe(3);
    expect(estimateFor("antigravity-statusline")).toBe(3);
    expect(estimateFor("grok-build")).toBe(8);
    expect(estimateFor("fx")).toBe(2);
    expect(estimateFor("openai-codex")).toBe(5);
    expect(summary.groups.every((group) => group.totalCostUsd === 0)).toBe(true);
  });

  it("adds derived estimates by source in the month-to-date provider view without adding cash", async () => {
    prismaMock.externalUsageEvent.groupBy.mockResolvedValueOnce([
      ...sources.slice(1).map(({ sourceApp, provider, service, cost }) => ({
        sourceApp,
        provider,
        service,
        projectId: null,
        metricType: "cost",
        _sum: { costUsd: cost },
        _count: { _all: 1, costUsd: 1 },
      })),
      ...tokens.map(({ sourceApp, provider, service }) => ({
        sourceApp,
        provider,
        service,
        projectId: null,
        metricType: "usage",
        _sum: { costUsd: null },
        _count: { _all: 1, costUsd: 0 },
      })),
    ]);
    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValueOnce([{
      sourceApp: "claude-code",
      provider: "anthropic",
      service: "claude-code",
      projectId: null,
      metricType: "cost",
      eventCount: 1,
      pricedEventCount: 1,
      unpricedEventCount: 0,
      unclassifiedCostEventCount: 0,
      totalCostUsd: 10,
    }]);

    const byProvider = await sumMonthToDateExternalCostByProvider(
      new Date("2026-06-01T00:00:00.000Z"),
      monthStart,
      now
    );
    expect(byProvider.get("anthropic")?.estimatedApiEquivalentUsd).toBe(16);
    expect(byProvider.get("xai")?.estimatedApiEquivalentUsd).toBe(10);
    expect(byProvider.get("openai")?.estimatedApiEquivalentUsd).toBe(5);
    for (const bucket of byProvider.values()) {
      expect(bucket.usagePushed).toBe(0);
      expect(bucket.subscriptionPushed).toBe(0);
      expect(bucket.pricedEventCount).toBe(0);
    }
  });
});

describe("OpenCode PAYG cost beside session estimates", () => {
  const now = new Date("2026-07-03T00:00:00.000Z");
  const monthStart = new Date("2026-06-01T00:00:00.000Z");
  const rawCutoff = new Date("2026-07-01T00:00:00.000Z");
  const raw = [
    { sourceApp: "opencode", provider: "anthropic", service: "opencode", label: "api-equivalent", metricType: "cost", unit: "usd", cost: 12, quantity: 0 },
    { sourceApp: "opencode", provider: "muse-code", service: "opencode", label: "api-equivalent", metricType: "cost", unit: "usd", cost: 7, quantity: 0 },
    { sourceApp: "opencode", provider: "anthropic", service: "opencode", label: "token:input", metricType: "usage", unit: "token", cost: null, quantity: 1_000_000 },
    { sourceApp: "fx", provider: "xai", service: "fx", label: "token:input", metricType: "usage", unit: "token", cost: null, quantity: 1_000_000 },
  ];
  const rollups = [
    { sourceApp: "opencode", provider: "anthropic", service: "opencode", label: "api-equivalent", metricType: "cost", unit: "usd", totalCostUsd: 5 },
    { sourceApp: "opencode", provider: "opencode", service: "opencode", label: "api-equivalent", metricType: "cost", unit: "usd", totalCostUsd: 2 },
  ];
  const tokenRows = [
    { sourceApp: "opencode", provider: "anthropic", service: "opencode", keyRef: "claude-sonnet-4-5", label: "token:input", quantity: 1_000_000 },
    { sourceApp: "fx", provider: "xai", service: "fx", keyRef: "grok-4.6", label: "token:input", quantity: 1_000_000 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.externalUsageEvent.findMany.mockResolvedValue([]);
    prismaMock.$queryRaw.mockResolvedValue(tokenRows);
  });

  it("separates raw and rolled-up PAYG cash from token and subscription estimates in the summary", async () => {
    prismaMock.externalUsageEvent.groupBy.mockResolvedValueOnce(raw.map((row) => ({
      ...row,
      projectId: null,
      environment: null,
      limit: null,
      limitWindow: null,
      _sum: { costUsd: row.cost, requests: 0, quantity: row.quantity },
      _count: { _all: 1, costUsd: row.cost === null ? 0 : 1 },
      _max: { occurredAt: now },
    })));
    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValueOnce(rollups.map((row) => ({
      ...row,
      projectId: null,
      environment: null,
      eventCount: 1,
      pricedEventCount: 1,
      unpricedEventCount: 0,
      unclassifiedCostEventCount: 0,
      totalRequests: 0,
      totalQuantity: 0,
      maxLimit: null,
      limitWindow: null,
      latestOccurredAt: new Date("2026-06-30T00:00:00.000Z"),
    })));

    const summary = await summarizeExternalUsageEvents(monthStart, rawCutoff, now);
    const group = (provider: string, metricType: string) =>
      summary.groups.find((item) => item.provider === provider && item.metricType === metricType);
    expect(group("anthropic", "cost")).toEqual(expect.objectContaining({
      totalCostUsd: 17,
      pricedEventCount: 2,
      estimatedApiEquivalentUsd: 0,
    }));
    expect(group("anthropic", "usage")?.estimatedApiEquivalentUsd).toBe(3);
    expect(group("muse-code", "cost")).toEqual(expect.objectContaining({
      totalCostUsd: 0,
      estimatedApiEquivalentUsd: 7,
    }));
    expect(group("opencode", "cost")?.estimatedApiEquivalentUsd).toBe(2);
    expect(group("xai", "usage")?.estimatedApiEquivalentUsd).toBe(2);
  });

  it("keeps the same raw and rollup split in month-to-date cash and attribution", async () => {
    prismaMock.externalUsageEvent.groupBy.mockResolvedValue(raw.map((row) => ({
      ...row,
      projectId: "project-a",
      _sum: { costUsd: row.cost },
      _count: { _all: 1, costUsd: row.cost === null ? 0 : 1 },
    })));
    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValue(rollups.map((row) => ({
      ...row,
      projectId: "project-a",
      eventCount: 1,
      pricedEventCount: 1,
      unpricedEventCount: 0,
      unclassifiedCostEventCount: 0,
    })));

    const byProvider = await sumMonthToDateExternalCostByProvider(monthStart, rawCutoff, now);
    expect(byProvider.get("anthropic")).toEqual(expect.objectContaining({
      usagePushed: 17,
      estimatedApiEquivalentUsd: 3,
      pricedEventCount: 2,
    }));
    expect(byProvider.get("muse-code")?.estimatedApiEquivalentUsd).toBe(7);
    expect(byProvider.get("opencode")?.estimatedApiEquivalentUsd).toBe(2);
    expect(byProvider.get("xai")?.estimatedApiEquivalentUsd).toBe(2);
    expect(byProvider.get("muse-code")?.usagePushed).toBe(0);
    expect(byProvider.get("opencode")?.usagePushed).toBe(0);
    expect(byProvider.get("xai")?.usagePushed).toBe(0);

    const attribution = await sumMonthToDateExternalCostAttribution(monthStart, rawCutoff, now);
    expect(attribution).toEqual([expect.objectContaining({
      provider: "anthropic",
      sourceApp: "opencode",
      projectId: "project-a",
      costUsd: 17,
    })]);
  });
});
