import { beforeEach, describe, expect, it, vi } from "vitest";

// Equivalence proof: summarizeExternalUsageEvents folds bounded raw SQL
// pages alongside the receipt-candidate query. This test drives both the
// current algorithm and its prior-fold reference from one in-memory fixture:
//
//   - the current implementation (real module code), with Prisma mocks that
//     return raw event pages and receipt candidates from the fixture, and
//   - a REFERENCE implementation below that is a line-for-line copy of the
//     old JS fold (kept here, not in src/, so no dead code ships),
//
// and asserts their outputs are identical.

const prismaMock = vi.hoisted(() => ({
  externalUsageEvent: { findMany: vi.fn(), groupBy: vi.fn() },
  externalUsageEventDailyRollup: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  STATUS_METRIC_TYPES,
  classifyCostCoverage,
  isSubscriptionAnalyticsTelemetry,
  summarizeExternalUsageEvents,
  type ExternalUsageEventSummaryGroup,
} from "../external-usage-events";
import { canonicalProviderKey } from "../provider-identity";
import { isReceiptCashEvent } from "../receipt-cash";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const PROVIDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DIGEST_VALID = "e".repeat(64);
const DIGEST_OTHER = "f".repeat(64);

let seq = 0;
function rawEvent(overrides: Record<string, unknown>) {
  seq += 1;
  return {
    // ids ascend in creation order, matching the old fold's orderBy(id asc)
    id: `evt-${String(seq).padStart(4, "0")}`,
    sourceApp: "socratic-trade",
    environment: "prod",
    provider: "openai",
    service: "responses",
    projectId: null,
    label: null,
    keyRef: null,
    billingMode: "estimated",
    metricType: "usage",
    unit: "token",
    confidence: "estimated",
    quantity: null,
    costUsd: null,
    requests: null,
    limit: null,
    limitWindow: null,
    occurredAt: new Date("2026-07-02T00:00:00.000Z"),
    idempotencyKey: null,
    metadata: null,
    ...overrides,
  };
}

const RAW_EVENTS = [
  // Group A: mixed priced/unpriced with a limit that must resolve to the
  // LATEST NON-NULL value (200 at 02:00), not the latest event's (null).
  rawEvent({
    projectId: "project-a",
    costUsd: 1.5,
    quantity: 10,
    requests: 1,
    limit: 100,
    limitWindow: "month",
    occurredAt: new Date("2026-07-02T01:00:00.000Z"),
  }),
  rawEvent({
    projectId: "project-a",
    costUsd: 2.25,
    quantity: 20,
    requests: 2,
    limit: 200,
    limitWindow: "month",
    occurredAt: new Date("2026-07-02T02:00:00.000Z"),
  }),
  rawEvent({
    projectId: "project-a",
    costUsd: null,
    quantity: 30,
    requests: 3,
    limit: null,
    limitWindow: null,
    occurredAt: new Date("2026-07-02T03:00:00.000Z"),
  }),
  // Group B: Claude Code analytics (API-equivalent estimate, never cash).
  rawEvent({
    sourceApp: "claude-code",
    provider: "anthropic",
    service: "claude-code",
    metricType: "cost",
    unit: "usd",
    costUsd: 5_000,
    occurredAt: new Date("2026-07-03T00:00:00.000Z"),
  }),
  // Group C: one validated receipt + one malformed receipt-shaped row.
  rawEvent({
    sourceApp: "billing-receipt-import",
    provider: "anthropic",
    service: "api-prepaid-funding",
    label: "receipt_cash_paid",
    keyRef: `provider:${PROVIDER_ID}:billing-receipt:${DIGEST_VALID}`,
    billingMode: "actual",
    metricType: "cost",
    unit: "usd",
    confidence: "actual",
    costUsd: 50,
    occurredAt: new Date("2026-07-04T00:00:00.000Z"),
    idempotencyKey: `billing-receipt:v1:${DIGEST_VALID}`,
    metadata: { evidenceRef: `hmac-sha256:${DIGEST_VALID}` },
  }),
  rawEvent({
    sourceApp: "billing-receipt-import",
    provider: "anthropic",
    service: "api-prepaid-funding",
    label: "receipt_cash_paid",
    keyRef: `provider:${PROVIDER_ID}:billing-receipt:${DIGEST_VALID}`,
    billingMode: "actual",
    metricType: "cost",
    unit: "usd",
    confidence: "actual",
    costUsd: 25,
    occurredAt: new Date("2026-07-05T00:00:00.000Z"),
    idempotencyKey: "not-the-receipt-key",
    metadata: { evidenceRef: `hmac-sha256:${DIGEST_VALID}` },
  }),
  // Group D: explicit zero cost is priced.
  rawEvent({
    sourceApp: "congress-trade",
    provider: "gemini",
    service: "gemini-3.5-flash",
    metricType: "request",
    unit: "request",
    costUsd: 0,
    quantity: 1,
    requests: 1,
    occurredAt: new Date("2026-07-06T00:00:00.000Z"),
  }),
  // Status metrics are excluded from the summary entirely.
  rawEvent({
    metricType: "quota_sync",
    requests: 42,
    occurredAt: new Date("2026-07-07T00:00:00.000Z"),
  }),
];

function rollup(overrides: Record<string, unknown>) {
  return {
    sourceApp: "socratic-trade",
    environment: "prod",
    provider: "openai",
    service: "responses",
    label: null,
    keyRef: null,
    billingMode: "estimated",
    projectId: null,
    metricType: "usage",
    unit: "token",
    confidence: "estimated",
    eventCount: 1,
    pricedEventCount: null,
    unpricedEventCount: null,
    unclassifiedCostEventCount: null,
    totalCostUsd: 0,
    totalRequests: 0,
    totalQuantity: 0,
    maxLimit: null,
    limitWindow: null,
    latestOccurredAt: new Date("2026-06-28T00:00:00.000Z"),
    day: new Date("2026-06-28T00:00:00.000Z"),
    ...overrides,
  };
}

const ROLLUPS = [
  // Group A historical coverage-counted rollup (limit must NOT override the
  // newer raw non-null limit).
  rollup({
    projectId: "project-a",
    eventCount: 4,
    pricedEventCount: 3,
    unpricedEventCount: 1,
    unclassifiedCostEventCount: 0,
    totalCostUsd: 7.5,
    totalRequests: 4,
    totalQuantity: 40,
    maxLimit: 90,
    limitWindow: "month",
    latestOccurredAt: new Date("2026-06-30T10:00:00.000Z"),
    day: new Date("2026-06-30T00:00:00.000Z"),
  }),
  // Legacy rollup without coverage counts -> unclassified.
  rollup({
    sourceApp: "socratic-trade",
    provider: "voyage",
    service: "embeddings",
    eventCount: 3,
    totalCostUsd: 0,
    latestOccurredAt: new Date("2026-06-29T00:00:00.000Z"),
    day: new Date("2026-06-29T00:00:00.000Z"),
  }),
  // Claude analytics rollup.
  rollup({
    sourceApp: "claude-code",
    provider: "anthropic",
    service: "claude-code",
    metricType: "cost",
    unit: "usd",
    eventCount: 1,
    pricedEventCount: 1,
    unpricedEventCount: 0,
    unclassifiedCostEventCount: 0,
    totalCostUsd: 4_000,
    latestOccurredAt: new Date("2026-06-27T00:00:00.000Z"),
    day: new Date("2026-06-27T00:00:00.000Z"),
  }),
  // Receipt-cash rollup.
  rollup({
    sourceApp: "billing-receipt-import",
    provider: "anthropic",
    service: "api-prepaid-funding",
    label: "receipt_cash_paid",
    keyRef: `provider:${PROVIDER_ID}:billing-receipt:${DIGEST_OTHER}`,
    billingMode: "actual",
    metricType: "cost",
    unit: "usd",
    confidence: "actual",
    eventCount: 2,
    totalCostUsd: 75,
    latestOccurredAt: new Date("2026-06-26T00:00:00.000Z"),
    day: new Date("2026-06-26T00:00:00.000Z"),
  }),
];

// ---------------------------------------------------------------------------
// SQLite-faithful prisma mocks over the fixture
// ---------------------------------------------------------------------------

// The fixed-shape receipt-candidate superset, mirroring
// rawReceiptCashCandidates' where clause (and, complemented, the raw scan's
// NON_RECEIPT_CANDIDATE_WHERE exclusion).
function isReceiptCandidateShape(event: {
  sourceApp: string;
  service: string | null;
  label: string | null;
  billingMode: string;
  metricType: string;
  confidence: string;
}): boolean {
  return (
    event.sourceApp === "billing-receipt-import" &&
    event.service === "api-prepaid-funding" &&
    event.label === "receipt_cash_paid" &&
    event.billingMode === "actual" &&
    event.metricType === "cost" &&
    event.confidence === "actual"
  );
}

type FixtureEvent = (typeof RAW_EVENTS)[number];

function installFixtureMocks() {
  let summaryRows: Array<Record<string, unknown>> = [];
  let initialized = false;
  prismaMock.$queryRaw.mockImplementation((query: unknown) => {
    const sql = typeof (query as { sql?: unknown })?.sql === "string"
      ? (query as { sql: string }).sql
      : "";
    if (!sql.includes('"limit", "limitWindow"')) return Promise.resolve([]);
    if (!initialized) {
      initialized = true;
      const values = (query as { values?: unknown[] })?.values ?? [];
      const dates = values.filter((value): value is Date => value instanceof Date);
      const [from, through] = dates;
      const events = RAW_EVENTS
        .filter((event) => (!from || event.occurredAt >= from) && (!through || event.occurredAt <= through))
        .filter((event) => !["quota_sync", "credit_balance"].includes(event.metricType) && !isReceiptCandidateShape(event))
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
      const dimensions = ["sourceApp", "environment", "provider", "service", "label", "projectId", "metricType", "unit", "limit", "limitWindow"] as const;
      const buckets = new Map<string, { dims: Record<string, unknown>; count: number; priced: number; cost: number | null; requests: number | null; quantity: number | null; latest: Date; lastId: string }>();
      for (const event of events) {
        const dims = Object.fromEntries(dimensions.map((field) => [field, event[field] ?? null]));
        const key = JSON.stringify(dims);
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { dims, count: 0, priced: 0, cost: null, requests: null, quantity: null, latest: event.occurredAt, lastId: event.id };
          buckets.set(key, bucket);
        }
        bucket.count += 1;
        if (event.costUsd != null) { bucket.priced += 1; bucket.cost = (bucket.cost ?? 0) + event.costUsd; }
        if (event.requests != null) bucket.requests = (bucket.requests ?? 0) + event.requests;
        if (event.quantity != null) bucket.quantity = (bucket.quantity ?? 0) + event.quantity;
        if (event.occurredAt > bucket.latest || (event.occurredAt.getTime() === bucket.latest.getTime() && event.id > bucket.lastId)) {
          bucket.latest = event.occurredAt;
          bucket.lastId = event.id;
        }
      }
      const pageLast = events[events.length - 1];
      summaryRows = Array.from(buckets.values()).map((bucket) => ({
        ...bucket.dims,
        eventCount: bucket.count,
        pricedEventCount: bucket.priced,
        totalCostUsd: bucket.cost,
        totalRequests: bucket.requests,
        totalQuantity: bucket.quantity,
        latestAt: bucket.latest,
        groupLastId: bucket.lastId,
        pageCount: events.length,
        pageLastOccurredAt: pageLast?.occurredAt ?? from,
        pageLastId: pageLast?.id ?? "",
      })).sort((a, b) => {
        const at = new Date(a.latestAt as Date).getTime() - new Date(b.latestAt as Date).getTime();
        return at || String(a.groupLastId).localeCompare(String(b.groupLastId));
      });
    }
    const page = summaryRows;
    summaryRows = [];
    return Promise.resolve(page);
  });

  prismaMock.externalUsageEvent.findMany.mockImplementation(
    (args?: { where?: { occurredAt?: { gte?: Date } } }) => {
      const gte = args?.where?.occurredAt?.gte;
      return Promise.resolve(
        RAW_EVENTS.filter(
          (event) => isReceiptCandidateShape(event) && (!gte || event.occurredAt >= gte)
        )
      );
    }
  );

  prismaMock.externalUsageEventDailyRollup.findMany.mockImplementation(
    (args?: {
      where?: { day?: { gte?: Date; lt?: Date }; metricType?: { notIn?: string[] } };
    }) => {
      const gte = args?.where?.day?.gte;
      const lt = args?.where?.day?.lt;
      const notIn = new Set(args?.where?.metricType?.notIn ?? []);
      return Promise.resolve(
        ROLLUPS.filter(
          (entry) =>
            (!gte || entry.day >= gte) &&
            (!lt || entry.day < lt) &&
            !notIn.has(entry.metricType)
        )
      );
    }
  );
}

// ---------------------------------------------------------------------------
// Reference: exact copy of the OLD cursor-fold algorithm (pre-E1)
// ---------------------------------------------------------------------------

function summaryGroupKey(group: {
  sourceApp: string;
  environment: string | null;
  provider: string;
  service: string | null;
  projectId: string | null;
  metricType: string;
  unit: string | null;
}): string {
  return [
    group.sourceApp,
    group.environment ?? "",
    group.provider,
    group.service ?? "",
    group.projectId ?? "",
    group.metricType,
    group.unit ?? "",
  ].join("|");
}

function mergeSummaryGroup(
  target: Map<string, ExternalUsageEventSummaryGroup>,
  group: ExternalUsageEventSummaryGroup
): void {
  const key = summaryGroupKey(group);
  const existing = target.get(key);
  if (!existing) {
    target.set(key, group);
    return;
  }

  existing.eventCount += group.eventCount;
  existing.pricedEventCount += group.pricedEventCount;
  existing.unpricedEventCount += group.unpricedEventCount;
  existing.unclassifiedCostEventCount += group.unclassifiedCostEventCount;
  existing.costCoverage = classifyCostCoverage(existing);
  existing.totalCostUsd += group.totalCostUsd;
  existing.receiptCashPaidUsd += group.receiptCashPaidUsd;
  existing.estimatedApiEquivalentUsd += group.estimatedApiEquivalentUsd;
  existing.totalRequests += group.totalRequests;
  existing.totalQuantity += group.totalQuantity;
  if (group.latestAt > existing.latestAt) {
    existing.latestAt = group.latestAt;
    existing.limit = group.limit ?? existing.limit;
    existing.limitWindow = group.limitWindow ?? existing.limitWindow;
  } else {
    existing.limit = existing.limit ?? group.limit;
    existing.limitWindow = existing.limitWindow ?? group.limitWindow;
  }
}

function referenceOldSummarize(
  since: Date,
  rawCutoff: Date
): { eventCount: number; groups: ExternalUsageEventSummaryGroup[] } {
  const groups = new Map<string, ExternalUsageEventSummaryGroup>();
  const rawSince = since > rawCutoff ? since : rawCutoff;
  let rawEventCount = 0;

  const page = RAW_EVENTS.filter(
    (event) =>
      event.occurredAt >= rawSince && !STATUS_METRIC_TYPES.has(event.metricType)
  );
  for (const event of page) {
    const isClaudeCodeAnalytics = isSubscriptionAnalyticsTelemetry(event);
    const isReceiptCash = isReceiptCashEvent(event as FixtureEvent);
    mergeSummaryGroup(groups, {
      sourceApp: event.sourceApp,
      environment: event.environment,
      provider: event.provider,
      canonicalProvider: canonicalProviderKey(event.provider),
      service: event.service,
      projectId: event.projectId,
      metricType: event.metricType,
      unit: event.unit,
      eventCount: 1,
      pricedEventCount:
        isClaudeCodeAnalytics || isReceiptCash || event.costUsd == null ? 0 : 1,
      unpricedEventCount:
        isClaudeCodeAnalytics || isReceiptCash || event.costUsd != null ? 0 : 1,
      unclassifiedCostEventCount: 0,
      costCoverage:
        !isClaudeCodeAnalytics && !isReceiptCash && event.costUsd != null
          ? "complete"
          : "unknown",
      totalCostUsd:
        isClaudeCodeAnalytics || isReceiptCash ? 0 : event.costUsd ?? 0,
      receiptCashPaidUsd: isReceiptCash ? event.costUsd ?? 0 : 0,
      estimatedApiEquivalentUsd: isClaudeCodeAnalytics ? event.costUsd ?? 0 : 0,
      totalRequests: event.requests ?? 0,
      totalQuantity: event.quantity ?? 0,
      limit: event.limit,
      limitWindow: event.limitWindow,
      latestAt: event.occurredAt.toISOString(),
    });
  }
  rawEventCount += page.length;

  const dayGte = new Date(
    Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())
  );
  const rollups =
    since < rawCutoff
      ? ROLLUPS.filter(
          (entry) =>
            entry.day >= dayGte &&
            entry.day < rawCutoff &&
            !STATUS_METRIC_TYPES.has(entry.metricType)
        )
      : [];

  for (const entry of rollups) {
    const isClaudeCodeAnalytics = isSubscriptionAnalyticsTelemetry(entry);
    const isReceiptCash = isReceiptCashEvent(entry as never);
    const hasCoverageCounts =
      entry.pricedEventCount != null ||
      entry.unpricedEventCount != null ||
      entry.unclassifiedCostEventCount != null;
    const costCounts = isClaudeCodeAnalytics || isReceiptCash
      ? {
          pricedEventCount: 0,
          unpricedEventCount: 0,
          unclassifiedCostEventCount: 0,
        }
      : {
          pricedEventCount: entry.pricedEventCount ?? 0,
          unpricedEventCount: entry.unpricedEventCount ?? 0,
          unclassifiedCostEventCount: hasCoverageCounts
            ? entry.unclassifiedCostEventCount ?? 0
            : entry.eventCount,
        };
    mergeSummaryGroup(groups, {
      sourceApp: entry.sourceApp,
      environment: entry.environment,
      provider: entry.provider,
      canonicalProvider: canonicalProviderKey(entry.provider),
      service: entry.service,
      projectId: entry.projectId,
      metricType: entry.metricType,
      unit: entry.unit,
      eventCount: entry.eventCount,
      ...costCounts,
      costCoverage: classifyCostCoverage(costCounts),
      totalCostUsd:
        isClaudeCodeAnalytics || isReceiptCash ? 0 : entry.totalCostUsd,
      receiptCashPaidUsd: isReceiptCash ? entry.totalCostUsd : 0,
      estimatedApiEquivalentUsd: isClaudeCodeAnalytics
        ? entry.totalCostUsd
        : 0,
      totalRequests: entry.totalRequests,
      totalQuantity: entry.totalQuantity,
      limit: entry.maxLimit,
      limitWindow: entry.limitWindow,
      latestAt: entry.latestOccurredAt.toISOString(),
    });
  }

  const summaries = Array.from(groups.values()).sort(
    (left, right) => Date.parse(right.latestAt) - Date.parse(left.latestAt)
  );

  return {
    eventCount:
      rawEventCount + rollups.reduce((sum, entry) => sum + entry.eventCount, 0),
    groups: summaries,
  };
}

// ---------------------------------------------------------------------------
// Comparison (float-addition order differs between the two algorithms)
// ---------------------------------------------------------------------------

function normalize(summary: {
  eventCount: number;
  groups: ExternalUsageEventSummaryGroup[];
}) {
  const round = (value: number) => Math.round(value * 1e9) / 1e9;
  return {
    eventCount: summary.eventCount,
    groups: summary.groups.map((group) => ({
      ...group,
      totalCostUsd: round(group.totalCostUsd),
      receiptCashPaidUsd: round(group.receiptCashPaidUsd),
      estimatedApiEquivalentUsd: round(group.estimatedApiEquivalentUsd),
      totalRequests: round(group.totalRequests),
      totalQuantity: round(group.totalQuantity),
    })),
  };
}

describe("summarizeExternalUsageEvents E1 equivalence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFixtureMocks();
  });

  it("produces output identical to the old JS cursor fold on a mixed fixture", async () => {
    const since = new Date("2026-06-01T00:00:00.000Z");
    const rawCutoff = new Date("2026-07-01T00:00:00.000Z");

    const expected = referenceOldSummarize(since, rawCutoff);
    const actual = await summarizeExternalUsageEvents(since, rawCutoff);

    expect(normalize(actual)).toEqual(normalize(expected));
    // Sanity: the fixture is non-trivial, so equivalence is not vacuous.
    expect(actual.groups.length).toBeGreaterThanOrEqual(5);
    expect(actual.eventCount).toBe(expected.eventCount);
    expect(actual.groups).toEqual(
      expect.arrayContaining([
        // Latest non-null limit wins even though the latest event has null.
        expect.objectContaining({ provider: "openai", limit: 200 }),
        expect.objectContaining({ provider: "anthropic", receiptCashPaidUsd: 125 }),
      ])
    );
  });

  it("matches the old fold on an empty window", async () => {
    const since = new Date("2026-07-01T00:00:00.000Z");
    const rawCutoff = new Date("2026-07-01T00:00:00.000Z");
    // No events before the cutoff window in this variant.
    installFixtureMocks();
    prismaMock.externalUsageEvent.findMany.mockResolvedValue([]);
    prismaMock.externalUsageEvent.groupBy.mockResolvedValue([]);
    prismaMock.$queryRaw.mockResolvedValue([]);
    prismaMock.externalUsageEventDailyRollup.findMany.mockResolvedValue([]);

    const actual = await summarizeExternalUsageEvents(since, rawCutoff);
    expect(actual).toEqual({
      eventCount: 0,
      groups: [],
      derivedCostEstimateUsd: 0,
      derivedCostEstimateEventCount: 0,
    });
  });
});
