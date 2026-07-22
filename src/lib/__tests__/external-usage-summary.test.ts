import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  externalUsageEvent: { findMany: vi.fn(), groupBy: vi.fn() },
  externalUsageEventDailyRollup: { findMany: vi.fn() },
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

  it("merges each raw page directly into the summary and preserves rollup totals", async () => {
    const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
      id: `raw-${String(index).padStart(4, "0")}`,
      sourceApp: "socratic-trade",
      environment: "prod",
      provider: "openai",
      service: "responses",
      projectId: "project-a",
      metricType: "usage",
      unit: "token",
      quantity: 2,
      costUsd: 1,
      requests: 1,
      limit: 100,
      limitWindow: "month",
      occurredAt: new Date("2026-07-02T00:00:00.000Z"),
    }));
    const finalPage = [
      {
        ...firstPage[0],
        id: "raw-1000",
        occurredAt: new Date("2026-07-03T00:00:00.000Z"),
        limit: 150,
      },
      {
        ...firstPage[0],
        id: "raw-1001",
        occurredAt: new Date("2026-07-04T00:00:00.000Z"),
        limit: 200,
      },
    ];

    prismaMock.externalUsageEvent.findMany
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(finalPage);
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

    const result = await summarizeExternalUsageEvents(
      new Date("2026-06-01T00:00:00.000Z"),
      new Date("2026-07-01T00:00:00.000Z")
    );

    expect(prismaMock.externalUsageEvent.findMany).toHaveBeenCalledTimes(2);
    expect(prismaMock.externalUsageEvent.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: { id: "raw-0999" }, skip: 1 })
    );
    expect(result).toEqual({
      eventCount: 1_007,
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
    prismaMock.externalUsageEvent.findMany.mockResolvedValueOnce([
      {
        id: "tokens",
        sourceApp: "socratic-trade",
        environment: "prod",
        provider: "openai",
        service: "responses",
        projectId: null,
        metricType: "usage",
        unit: "token",
        quantity: 10_000,
        costUsd: null,
        requests: 0,
        limit: 20_000,
        limitWindow: "month",
        occurredAt: new Date("2026-07-12T00:00:00.000Z"),
      },
      {
        id: "requests",
        sourceApp: "socratic-trade",
        environment: "prod",
        provider: "openai",
        service: "responses",
        projectId: null,
        metricType: "usage",
        unit: "request",
        quantity: 0,
        costUsd: null,
        requests: 10,
        limit: 100,
        limitWindow: "month",
        occurredAt: new Date("2026-07-12T00:00:00.000Z"),
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
    prismaMock.externalUsageEvent.findMany.mockResolvedValueOnce([
      {
        id: "zero-cost",
        sourceApp: "congress-trade",
        environment: "prod",
        provider: "gemini",
        service: "gemini-3.5-flash",
        projectId: null,
        metricType: "request",
        unit: "request",
        quantity: 1,
        costUsd: 0,
        requests: 1,
        limit: null,
        limitWindow: null,
        occurredAt: new Date("2026-07-13T00:00:00.000Z"),
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
    prismaMock.externalUsageEvent.findMany.mockResolvedValueOnce([
      {
        id: "raw-cash",
        sourceApp: "socratic-trade",
        environment: "prod",
        provider: "anthropic",
        service: "messages",
        projectId: "project-a",
        metricType: "cost",
        unit: "usd",
        quantity: 0,
        costUsd: 10,
        requests: 1,
        limit: null,
        limitWindow: null,
        occurredAt: new Date("2026-07-03T00:00:00.000Z"),
      },
      {
        id: "raw-claude-estimate",
        sourceApp: "claude-code",
        environment: "prod",
        provider: "anthropic",
        service: "claude-code",
        projectId: "project-a",
        metricType: "cost",
        unit: "usd",
        quantity: 0,
        costUsd: 5_000,
        requests: 0,
        limit: null,
        limitWindow: null,
        occurredAt: new Date("2026-07-03T00:00:00.000Z"),
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
        by: ["provider", "sourceApp", "service", "projectId", "metricType"],
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
        by: ["provider", "sourceApp", "service", "projectId", "metricType"],
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
