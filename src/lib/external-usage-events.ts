import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  canonicalProjectKey,
  canonicalProviderKey,
  normalizedProviderName,
  resolveProviderIdentity,
} from "@/lib/provider-identity";
import {
  API_PREPAID_FUNDING_SERVICE,
  BILLING_RECEIPT_SOURCE_APP,
  RECEIPT_CASH_LABEL,
  isReceiptCashEvent,
  receiptCashProviderId,
} from "@/lib/receipt-cash";
import { SUBSCRIPTION_SOURCE_APP } from "@/lib/subscription-charge-identity";
import {
  MTD_SCAN_MEMO_TTL_MS,
  clearMtdScanMemo,
  getMtdScanMemo,
  setMtdScanMemo,
} from "@/lib/mtd-scan-memo";

export const STATUS_METRIC_TYPES = new Set(["quota_sync", "credit_balance"]);

export interface ExternalUsageEventInput {
  idempotencyKey: string;
  sourceApp: string;
  environment?: string;
  provider: string;
  service?: string;
  // Resolved Project.id (see project-resolver.ts). Null/undefined when the
  // producer supplied no project or none matched a known Project.
  projectId?: string | null;
  label?: string;
  keyRef?: string;
  billingMode: string;
  metricType: string;
  quantity?: number;
  unit?: string;
  costUsd?: number;
  requests?: number;
  credits?: number;
  limit?: number;
  limitWindow?: string;
  tier?: string;
  confidence?: string;
  windowStart?: Date;
  windowEnd?: Date;
  occurredAt: Date;
  metadata?: Prisma.InputJsonObject;
  // Provider-side call/generation identifier from the producer (see
  // usage-telemetry.ts's ParsedUsageTelemetryEvent). Written only at ingest;
  // the verification fields it enables (verifiedCostUsd/verifiedAt/
  // verificationStatus/verifiedSource) are written later by the monitor-side
  // verification worker, never here. Deliberately excluded from
  // comparableEvent below: a replay under the same idempotencyKey with a
  // different providerRequestId (e.g. a producer that couldn't attach it on
  // the first attempt) still dedupes rather than being treated as a
  // collision — same category as the idempotency-key basis itself.
  providerRequestId?: string;
}

export interface PersistExternalUsageEventsResult {
  /** Number of submitted inputs, including active or tombstoned replays. */
  attempted: number;
  /** Number of rows newly inserted by this call; active replays do not count. */
  persisted: number;
  /** Number of unique inputs rejected because retention already pruned them. */
  skippedPrunedDuplicates: number;
  /** Newly inserted event inputs, in insertion order. */
  newEvents: ExternalUsageEventInput[];
}

export class ExternalUsageIdempotencyCollisionError extends Error {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(
      `Idempotency key collision for "${idempotencyKey}". Distinct events that share the ` +
        "five-field fallback key must provide explicit idempotencyKey values."
    );
    this.name = "ExternalUsageIdempotencyCollisionError";
    this.idempotencyKey = idempotencyKey;
  }
}

export interface ExternalUsageEventSummaryGroup {
  sourceApp: string;
  environment: string | null;
  provider: string;
  canonicalProvider: string;
  service: string | null;
  projectId: string | null;
  metricType: string;
  unit: string | null;
  eventCount: number;
  pricedEventCount: number;
  unpricedEventCount: number;
  unclassifiedCostEventCount: number;
  costCoverage: CostCoverage;
  totalCostUsd: number;
  /** Exact cash paid on provider receipts; excluded from observed usage cost. */
  receiptCashPaidUsd: number;
  estimatedApiEquivalentUsd: number;
  totalRequests: number;
  totalQuantity: number;
  limit: number | null;
  limitWindow: string | null;
  latestAt: string;
}

export type CostCoverage = "complete" | "partial" | "unknown" | "legacy_unknown";

export function classifyCostCoverage(counts: {
  pricedEventCount: number;
  unpricedEventCount: number;
  unclassifiedCostEventCount: number;
}): CostCoverage {
  const { pricedEventCount, unpricedEventCount, unclassifiedCostEventCount } = counts;
  if (pricedEventCount > 0) {
    return unpricedEventCount > 0 || unclassifiedCostEventCount > 0
      ? "partial"
      : "complete";
  }
  return unclassifiedCostEventCount > 0 ? "legacy_unknown" : "unknown";
}

/**
 * Claude Code's OTLP cost metric is an estimated API-equivalent value. For
 * Claude Pro/Max sessions it is not a charge and must never enter cash spend,
 * budgets, or alerts. Keep the discriminator exact so unrelated Anthropic
 * telemetry and API usage events retain their normal billing semantics.
 */
export function isClaudeCodeAnalyticsTelemetry(input: {
  sourceApp: string;
  service: string | null | undefined;
}): boolean {
  return (
    input.sourceApp.trim().toLowerCase() === "claude-code" &&
    input.service?.trim().toLowerCase() === "claude-code"
  );
}

// One month-to-date cost total per (provider, sourceApp, projectId) triple,
// summed across raw events and daily rollups. This is the single source the
// project budget computation slices to derive direct per-project cost,
// legacy sourceApp-name attribution, and the true unattributed residual —
// see budget-status.ts's computeProjectBudgetStatus.
export interface ExternalCostAttributionRow {
  provider: string;
  sourceApp: string;
  projectId: string | null;
  metricType: string;
  costUsd: number;
  pricedEventCount: number;
  unpricedEventCount: number;
  unclassifiedCostEventCount: number;
}

function toCreateData(event: ExternalUsageEventInput): Prisma.ExternalUsageEventUncheckedCreateInput {
  return {
    idempotencyKey: event.idempotencyKey,
    sourceApp: event.sourceApp,
    environment: event.environment,
    provider: event.provider,
    service: event.service,
    projectId: event.projectId ?? null,
    label: event.label,
    keyRef: event.keyRef,
    billingMode: event.billingMode,
    metricType: event.metricType,
    quantity: event.quantity,
    unit: event.unit,
    costUsd: event.costUsd,
    requests: event.requests,
    credits: event.credits,
    limit: event.limit,
    limitWindow: event.limitWindow,
    tier: event.tier,
    confidence: event.confidence,
    windowStart: event.windowStart,
    windowEnd: event.windowEnd,
    occurredAt: event.occurredAt,
    metadata: event.metadata,
    providerRequestId: event.providerRequestId,
    // Verification fields are deliberately absent here: ingest never sets
    // them, so they take the column default (null) on insert. Only the
    // later verification worker updates them.
  };
}

export async function persistExternalUsageEvents(
  events: ExternalUsageEventInput[]
): Promise<PersistExternalUsageEventsResult> {
  if (events.length === 0) {
    return { attempted: 0, persisted: 0, skippedPrunedDuplicates: 0, newEvents: [] };
  }
  // Tombstone lookup and INSERT now share the same write transaction as
  // retention's tombstone+DELETE transaction. SQLite serializes those writers,
  // closing the old window where a retry could observe no tombstone, then
  // resurrect a row immediately after retention pruned it.
  return prisma.$transaction((tx) => persistExternalUsageEventsInTransaction(tx, events), {
    timeout: 30_000,
  });
}

type ExistingExternalUsageEvent = Awaited<
  ReturnType<Prisma.TransactionClient["externalUsageEvent"]["findMany"]>
>[number];

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function stringProjectMetadata(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const project = (value as Record<string, unknown>).project;
  return typeof project === "string" && project.trim()
    ? project.trim()
    : null;
}

function metadataWithoutStringProject(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.project !== "string") return value;
  const rest = { ...record };
  delete rest.project;
  return Object.keys(rest).length > 0 ? rest : null;
}

// NOTE: providerRequestId is deliberately NOT a field here (see its doc
// comment on ExternalUsageEventInput above) — a replay with a different
// providerRequestId under the same idempotencyKey must still dedupe, not
// throw ExternalUsageIdempotencyCollisionError.
function comparableEvent(event: ExternalUsageEventInput | ExistingExternalUsageEvent) {
  const value = event as ExternalUsageEventInput & ExistingExternalUsageEvent;
  const iso = (date: Date | undefined | null) => date?.toISOString() ?? null;
  return {
    sourceApp: value.sourceApp,
    environment: value.environment ?? null,
    provider: value.provider,
    service: value.service ?? null,
    // projectId is resolved server-side and may legitimately change from null
    // to a real id when the operator creates a matching Project after ingest.
    // The raw project name remains in metadata, so a different project still
    // collides while the same event can be attribution-backfilled without
    // changing its mandated idempotency key.
    label: value.label ?? null,
    keyRef: value.keyRef ?? null,
    billingMode: value.billingMode,
    metricType: value.metricType,
    quantity: value.quantity ?? null,
    unit: value.unit ?? null,
    costUsd: value.costUsd ?? null,
    requests: value.requests ?? null,
    credits: value.credits ?? null,
    limit: value.limit ?? null,
    limitWindow: value.limitWindow ?? null,
    tier: value.tier ?? null,
    confidence: value.confidence ?? "estimated",
    windowStart: iso(value.windowStart),
    windowEnd: iso(value.windowEnd),
    occurredAt: value.occurredAt.toISOString(),
    // `project` is intentionally excluded from the shared idempotency-key
    // basis. Compare it separately so an old event can gain attribution on a
    // replay without weakening collision checks for every other metadata
    // field (or allowing one project name to be replaced by another).
    metadata: stableJson(metadataWithoutStringProject(value.metadata ?? null)),
  };
}

function sameEvent(
  left: ExternalUsageEventInput | ExistingExternalUsageEvent,
  right: ExternalUsageEventInput | ExistingExternalUsageEvent
): boolean {
  return stableJson(comparableEvent(left)) === stableJson(comparableEvent(right));
}

function assertCompatibleProjectAttribution(
  left: ExternalUsageEventInput | ExistingExternalUsageEvent,
  right: ExternalUsageEventInput | ExistingExternalUsageEvent,
  idempotencyKey: string
): void {
  if (left.projectId && right.projectId && left.projectId !== right.projectId) {
    throw new ExternalUsageIdempotencyCollisionError(idempotencyKey);
  }
  const leftName = stringProjectMetadata(left.metadata);
  const rightName = stringProjectMetadata(right.metadata);
  if (
    leftName &&
    rightName &&
    canonicalProjectKey(leftName) !== canonicalProjectKey(rightName)
  ) {
    throw new ExternalUsageIdempotencyCollisionError(idempotencyKey);
  }
}

function mergeBatchProjectAttribution(
  left: ExternalUsageEventInput,
  right: ExternalUsageEventInput
): ExternalUsageEventInput {
  const leftName = stringProjectMetadata(left.metadata);
  const rightName = stringProjectMetadata(right.metadata);
  return {
    ...left,
    projectId: left.projectId ?? right.projectId ?? null,
    metadata: !leftName && rightName ? right.metadata : left.metadata,
  };
}

export async function persistExternalUsageEventsInTransaction(
  tx: Prisma.TransactionClient,
  events: ExternalUsageEventInput[]
): Promise<PersistExternalUsageEventsResult> {
  if (events.length === 0) {
    return { attempted: 0, persisted: 0, skippedPrunedDuplicates: 0, newEvents: [] };
  }

  // Collapse byte-equivalent repeats inside one batch, but never silently
  // collapse distinct lanes that collided on the mandated five-field key.
  const uniqueByKey = new Map<string, ExternalUsageEventInput>();
  for (const event of events) {
    const prior = uniqueByKey.get(event.idempotencyKey);
    if (prior) {
      assertCompatibleProjectAttribution(prior, event, event.idempotencyKey);
      if (!sameEvent(prior, event)) {
        throw new ExternalUsageIdempotencyCollisionError(event.idempotencyKey);
      }
      uniqueByKey.set(
        event.idempotencyKey,
        mergeBatchProjectAttribution(prior, event)
      );
    } else {
      uniqueByKey.set(event.idempotencyKey, event);
    }
  }
  let uniqueEvents = Array.from(uniqueByKey.values());

  // Resolve stale project ids inside this transaction. A concurrent Project
  // deletion is serialized behind/ahead of this transaction, so it cannot
  // create an insert-time foreign-key race.
  const referencedProjectIds = Array.from(
    new Set(uniqueEvents.map((event) => event.projectId).filter((id): id is string => !!id))
  );
  if (referencedProjectIds.length > 0) {
    const alive = new Set(
      (
        await tx.project.findMany({
          where: { id: { in: referencedProjectIds } },
          select: { id: true },
        })
      ).map((project) => project.id)
    );
    uniqueEvents = uniqueEvents.map((event) =>
      event.projectId && !alive.has(event.projectId) ? { ...event, projectId: null } : event
    );
  }

  const keys = uniqueEvents.map((event) => event.idempotencyKey);
  const [tombstones, existingEvents] = await Promise.all([
    tx.externalUsageEventTombstone.findMany({
      where: { idempotencyKey: { in: keys } },
      select: { idempotencyKey: true },
    }),
    tx.externalUsageEvent.findMany({
      where: { idempotencyKey: { in: keys } },
    }),
  ]);
  const prunedKeys = new Set(tombstones.map((row) => row.idempotencyKey));
  const existingByKey = new Map(existingEvents.map((row) => [row.idempotencyKey, row]));
  const activeEvents = uniqueEvents.filter((event) => !prunedKeys.has(event.idempotencyKey));
  const newEvents: ExternalUsageEventInput[] = [];

  for (const event of activeEvents) {
    const existing = existingByKey.get(event.idempotencyKey);
    if (existing) {
      const existingProjectName = stringProjectMetadata(existing.metadata);
      const incomingProjectName = stringProjectMetadata(event.metadata);
      assertCompatibleProjectAttribution(existing, event, event.idempotencyKey);
      if (!sameEvent(existing, event)) {
        throw new ExternalUsageIdempotencyCollisionError(event.idempotencyKey);
      }
      const projectId = !existing.projectId && event.projectId
        ? event.projectId
        : undefined;
      const metadata = !existingProjectName && incomingProjectName
        ? {
            ...(
              existing.metadata &&
              typeof existing.metadata === "object" &&
              !Array.isArray(existing.metadata)
                ? existing.metadata as Record<string, unknown>
                : {}
            ),
            project: incomingProjectName,
          } as Prisma.InputJsonObject
        : undefined;
      if (projectId || metadata) {
        await tx.externalUsageEvent.update({
          where: { id: existing.id },
          data: {
            ...(projectId ? { projectId } : {}),
            ...(metadata ? { metadata } : {}),
          },
        });
      }
      continue;
    }
    newEvents.push(event);
  }

  // Wave G / E15: batch-insert new rows (one SQLite statement) instead of
  // N serial creates. newEvents already holds the inputs we would have
  // inserted; createMany does not return rows, so we keep that list as-is.
  if (newEvents.length > 0) {
    await tx.externalUsageEvent.createMany({
      data: newEvents.map((event) => toCreateData(event)),
    });
  }

  return {
    attempted: events.length,
    persisted: newEvents.length,
    skippedPrunedDuplicates: uniqueEvents.length - activeEvents.length,
    newEvents,
  };
}

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

export async function summarizeExternalUsageEvents(
  since: Date,
  rawCutoff: Date
): Promise<{
  eventCount: number;
  groups: ExternalUsageEventSummaryGroup[];
}> {
  const groups = new Map<string, ExternalUsageEventSummaryGroup>();
  const rawSince = since > rawCutoff ? since : rawCutoff;
  let rawEventCount = 0;
  const pageSize = 1_000;
  let cursor: string | undefined;
  while (true) {
    const page = await prisma.externalUsageEvent.findMany({
      where: { 
        occurredAt: { gte: rawSince },
        metricType: { notIn: Array.from(STATUS_METRIC_TYPES) },
      },
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        sourceApp: true,
        environment: true,
        provider: true,
        service: true,
        label: true,
        keyRef: true,
        billingMode: true,
        projectId: true,
        metricType: true,
        unit: true,
        confidence: true,
        quantity: true,
        costUsd: true,
        requests: true,
        limit: true,
        limitWindow: true,
        occurredAt: true,
      },
    });

    // Fold each page into the summary immediately. The endpoint may span the
    // entire raw-retention window, so retaining every row until the final
    // reduction makes its peak memory grow linearly with event volume.
    for (const event of page) {
      const isClaudeCodeAnalytics = isClaudeCodeAnalyticsTelemetry(event);
      const isReceiptCash = isReceiptCashEvent(event);
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

    if (page.length < pageSize) break;
    cursor = page[page.length - 1].id;
  }

  const rollups =
    since < rawCutoff
      ? await prisma.externalUsageEventDailyRollup.findMany({
          where: {
            day: {
              gte: new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())),
              lt: rawCutoff,
            },
            metricType: { notIn: Array.from(STATUS_METRIC_TYPES) },
          },
          select: {
            sourceApp: true,
            environment: true,
            provider: true,
            service: true,
            label: true,
            keyRef: true,
            billingMode: true,
            projectId: true,
            metricType: true,
            unit: true,
            confidence: true,
            eventCount: true,
            pricedEventCount: true,
            unpricedEventCount: true,
            unclassifiedCostEventCount: true,
            totalCostUsd: true,
            totalRequests: true,
            totalQuantity: true,
            maxLimit: true,
            limitWindow: true,
            latestOccurredAt: true,
          },
        })
      : [];

  for (const rollup of rollups) {
    const isClaudeCodeAnalytics = isClaudeCodeAnalyticsTelemetry(rollup);
    const isReceiptCash = isReceiptCashEvent(rollup);
    const hasCoverageCounts =
      rollup.pricedEventCount != null ||
      rollup.unpricedEventCount != null ||
      rollup.unclassifiedCostEventCount != null;
    const costCounts = isClaudeCodeAnalytics || isReceiptCash
      ? {
          pricedEventCount: 0,
          unpricedEventCount: 0,
          unclassifiedCostEventCount: 0,
        }
      : {
          pricedEventCount: rollup.pricedEventCount ?? 0,
          unpricedEventCount: rollup.unpricedEventCount ?? 0,
          unclassifiedCostEventCount: hasCoverageCounts
            ? rollup.unclassifiedCostEventCount ?? 0
            : rollup.eventCount,
        };
    mergeSummaryGroup(groups, {
      sourceApp: rollup.sourceApp,
      environment: rollup.environment,
      provider: rollup.provider,
      canonicalProvider: canonicalProviderKey(rollup.provider),
      service: rollup.service,
      projectId: rollup.projectId,
      metricType: rollup.metricType,
      unit: rollup.unit,
      eventCount: rollup.eventCount,
      ...costCounts,
      costCoverage: classifyCostCoverage(costCounts),
      totalCostUsd:
        isClaudeCodeAnalytics || isReceiptCash ? 0 : rollup.totalCostUsd,
      receiptCashPaidUsd: isReceiptCash ? rollup.totalCostUsd : 0,
      estimatedApiEquivalentUsd: isClaudeCodeAnalytics
        ? rollup.totalCostUsd
        : 0,
      totalRequests: rollup.totalRequests,
      totalQuantity: rollup.totalQuantity,
      limit: rollup.maxLimit,
      limitWindow: rollup.limitWindow,
      latestAt: rollup.latestOccurredAt.toISOString(),
    });
  }

  const summaries = Array.from(groups.values()).sort(
    (left, right) => Date.parse(right.latestAt) - Date.parse(left.latestAt)
  );

  return {
    eventCount:
      rawEventCount + rollups.reduce((sum, rollup) => sum + rollup.eventCount, 0),
    groups: summaries,
  };
}

// Month-to-date pushed cost per provider, split by whether it is "usage-like"
// (metered cost a poll snapshot also sees — deduped against the snapshot via
// max()) or a materialized "subscription" fee (a recurring charge DISJOINT from
// metered usage — always additive). Keeping these separate is what lets
// budget-status add a subscription fee on top of a provider's poll snapshot
// instead of letting max(snapshot, pushed) swallow it.
export const SUBSCRIPTION_METRIC_TYPE = "subscription";

export interface ProviderPushedCost {
  usagePushed: number;
  subscriptionPushed: number;
  // The slice of subscriptionPushed contributed by sourceApp !=
  // SUBSCRIPTION_SOURCE_APP — i.e. manual adjustments (owner-directed
  // historical corrections, refunds) rather than the internal subscription
  // materializer. budget-status.ts's fixed-cost dedupe must cancel out only
  // the materializer-linked portion (subscriptionPushed - this field)
  // against a provider's fixed-cost-included snapshot; the manual portion is
  // never represented in that snapshot and must stay additive, positive or
  // negative, or a manual refund gets silently cancelled by the dedupe (or,
  // if it drives the pool net-negative, cancelled *and* have spend added
  // back). See sumMonthToDateExternalCostByProvider's `add` below.
  subscriptionPushedManualUsd: number;
  estimatedApiEquivalentUsd: number;
  pricedEventCount: number;
  unpricedEventCount: number;
  unclassifiedCostEventCount: number;
}

export interface ProviderReceiptCash {
  paidUsd: number;
  eventCount: number;
}

/**
 * Exact receipt cash is keyed by the provider UUID embedded in the importer
 * keyRef. This prevents same-name provider rows from claiming one another's
 * receipt evidence and continues to work after raw events become rollups.
 */
export async function sumMonthToDateReceiptCashByProviderId(
  monthStart: Date,
  rawCutoff: Date,
  now: Date = new Date()
): Promise<Map<string, ProviderReceiptCash>> {
  const rawSince = monthStart > rawCutoff ? monthStart : rawCutoff;
  const exactReceiptWhere = {
    sourceApp: BILLING_RECEIPT_SOURCE_APP,
    service: API_PREPAID_FUNDING_SERVICE,
    label: RECEIPT_CASH_LABEL,
    billingMode: "actual",
    metricType: "cost",
    unit: "usd",
    confidence: "actual",
  } as const;
  const [rawGroups, rollups] = await Promise.all([
    prisma.externalUsageEvent.groupBy({
      by: [
        "sourceApp",
        "service",
        "label",
        "keyRef",
        "billingMode",
        "metricType",
        "unit",
        "confidence",
      ],
      where: { ...exactReceiptWhere, occurredAt: { gte: rawSince, lte: now } },
      _sum: { costUsd: true },
      _count: { _all: true },
    }),
    monthStart < rawCutoff
      ? prisma.externalUsageEventDailyRollup.findMany({
          where: {
            ...exactReceiptWhere,
            day: { gte: monthStart, lt: rawCutoff },
            latestOccurredAt: { lte: now },
          },
          select: {
            sourceApp: true,
            service: true,
            label: true,
            keyRef: true,
            billingMode: true,
            metricType: true,
            unit: true,
            confidence: true,
            totalCostUsd: true,
            eventCount: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const totals = new Map<string, ProviderReceiptCash>();
  const add = (row: ReceiptCashEventLikeWithCost, costUsd: number, eventCount: number) => {
    const providerId = receiptCashProviderId(row);
    if (!providerId) return;
    const current = totals.get(providerId) ?? { paidUsd: 0, eventCount: 0 };
    current.paidUsd += costUsd;
    current.eventCount += eventCount;
    totals.set(providerId, current);
  };
  for (const row of rawGroups) {
    add(row, row._sum.costUsd ?? 0, row._count._all);
  }
  for (const rollup of rollups) {
    add(rollup, rollup.totalCostUsd, rollup.eventCount);
  }
  return totals;
}

type ReceiptCashEventLikeWithCost = Parameters<typeof receiptCashProviderId>[0];

// One-time diagnostic: log how many raw ExternalUsageEvent rows the
// current-month groupBy below actually scans. rawSince == monthStart for
// every current-month call (the daily-rollup branch never applies to the
// current month - only to days older than the raw-retention cutoff), so
// this is effectively "how big is the current month's raw event volume,"
// which is what determines whether the ~11.4s this query used to take
// (see the SWR cache on computeBudgetStatus in budget-status.ts) is normal
// telemetry volume or a sign retention isn't keeping up. Logged once per
// process rather than per-call since the cache above means this now runs
// rarely anyway, and the count barely changes call-to-call.
let loggedExternalEventsRawSizeOnce = false;

// Provider totals and project attribution both scan and materialize the
// current month's raw ExternalUsageEvent rows. A stale provider-cache hit can
// start its refresh in the background and return immediately; a stale project
// cache refresh may then reach its separate attribution aggregate before that
// provider refresh finishes. On the 512 MB production instance, retaining
// both aggregate result sets at once is enough to kill the process.
//
// Serialize the complete aggregation bodies, not just their groupBy calls, so
// the next aggregate cannot start while the prior query result is still being
// classified into application maps. The lease lives below the SWR caches:
// stale callers still receive their cached response immediately, while only
// background/cold recomputation queues. Keeping it here also covers every
// caller and avoids taking a higher-level lock before a nested budget compute.
//
// Wave H / E1: both provider and project MTD views share one raw+rollup scan
// (attribution-shaped groupBy) with a short process-local memo so a cold
// dashboard that loads provider then project status does not pay ~11s twice.
let externalUsageCostAggregationTail: Promise<void> = Promise.resolve();

async function withExclusiveExternalUsageCostAggregation<T>(
  work: () => Promise<T>
): Promise<T> {
  const previous = externalUsageCostAggregationTail;
  let release!: () => void;
  externalUsageCostAggregationTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

function mtdScanKey(monthStart: Date, rawCutoff: Date): string {
  // rawCutoff for the live month is clamped to monthStart (see
  // getExternalEventRawCutoff), so the effective scan window is the month
  // start plus "use rollups for days older than rawCutoff". Key by the two
  // UTC day starts only — not wall-clock ms on rawCutoff — so sequential
  // default-`now` provider/project dashboard calls share one memo entry.
  const monthKey = monthStart.toISOString().slice(0, 10);
  const rawDay = rawCutoff.toISOString().slice(0, 10);
  return `${monthKey}|${rawDay}`;
}

function emptyProviderPushedCost(): ProviderPushedCost {
  return {
    usagePushed: 0,
    subscriptionPushed: 0,
    subscriptionPushedManualUsd: 0,
    estimatedApiEquivalentUsd: 0,
    pricedEventCount: 0,
    unpricedEventCount: 0,
    unclassifiedCostEventCount: 0,
  };
}

/** Drop the Wave H MTD scan memo (tests + post-write invalidation). */
export function __resetMonthToDateExternalCostScanMemoForTests(): void {
  clearMtdScanMemo();
}

/**
 * Return a narrow superset of possible raw receipt-cash rows. Full identity
 * validation still happens through isReceiptCashEvent so a malformed
 * receipt-like row remains ordinary cost.
 *
 * The main aggregate excludes this fixed-shape superset without an id list,
 * then the caller adds every invalid candidate back individually. That avoids
 * an unbounded SQLite `NOT IN (?, ...)` parameter list while excluding valid
 * receipts before SUM (so receipt subtraction cannot introduce float drift).
 * It also lets the main groupBy use only the dimensions that affect money
 * semantics. Previously label/keyRef/billingMode/unit/confidence were all
 * group dimensions solely so the loop could recognize receipts;
 * high-cardinality keyRef values therefore made the database return nearly
 * one group per event.
 */
async function rawReceiptCashCandidates(rawSince: Date) {
  return prisma.externalUsageEvent.findMany({
    where: {
      occurredAt: { gte: rawSince },
      sourceApp: BILLING_RECEIPT_SOURCE_APP,
      service: API_PREPAID_FUNDING_SERVICE,
      label: RECEIPT_CASH_LABEL,
      billingMode: "actual",
      metricType: "cost",
      confidence: "actual",
    },
    select: {
      id: true,
      idempotencyKey: true,
      sourceApp: true,
      provider: true,
      service: true,
      projectId: true,
      label: true,
      keyRef: true,
      billingMode: true,
      metricType: true,
      unit: true,
      confidence: true,
      costUsd: true,
      occurredAt: true,
      metadata: true,
    },
  });
}

// Exact logical complement of rawReceiptCashCandidates' fixed-shape filter.
// Nullable service/label columns need explicit null branches: relying on SQL
// `NOT (a AND b ...)` would drop NULL rows under three-valued logic.
const NON_RECEIPT_CANDIDATE_WHERE: Prisma.ExternalUsageEventWhereInput = {
  OR: [
    { sourceApp: { not: BILLING_RECEIPT_SOURCE_APP } },
    { service: null },
    { service: { not: API_PREPAID_FUNDING_SERVICE } },
    { label: null },
    { label: { not: RECEIPT_CASH_LABEL } },
    { billingMode: { not: "actual" } },
    { metricType: { not: "cost" } },
    { confidence: { not: "actual" } },
  ],
};

export async function sumMonthToDateExternalCostByProvider(
  monthStart: Date,
  rawCutoff: Date
): Promise<Map<string, ProviderPushedCost>> {
  const material = await loadMonthToDateExternalCostMaterial(monthStart, rawCutoff);
  return material.byProvider;
}

// Month-to-date external cost split by (provider, sourceApp, projectId), across
// both raw events and rollups. The project budget computation derives every
// attribution slice it needs from this one result: direct per-project cost
// (rows with a projectId), legacy sourceApp-name attribution (untagged rows
// whose sourceApp matches a Project.name), and the residual that percentage
// allocations distribute (provider cost not directly attributed to any
// project). Returning the raw triples — rather than pre-summed maps — is what
// lets budget-status avoid the previous double-count between the provider-keyed
// and sourceApp-keyed aggregations.
export async function sumMonthToDateExternalCostAttribution(
  monthStart: Date,
  rawCutoff: Date
): Promise<ExternalCostAttributionRow[]> {
  const material = await loadMonthToDateExternalCostMaterial(monthStart, rawCutoff);
  return material.attribution;
}

/**
 * Wave H / E1: one exclusive scan feeds both provider totals and project
 * attribution. A short memo lets sequential cold computeBudgetStatus +
 * computeProjectBudgetStatus share the same ~11s groupBy within TTL.
 */
async function loadMonthToDateExternalCostMaterial(
  monthStart: Date,
  rawCutoff: Date
): Promise<{
  byProvider: Map<string, ProviderPushedCost>;
  attribution: ExternalCostAttributionRow[];
}> {
  // Under vitest, skip the process memo so mocked groupBy sequences and
  // per-test SQLite fixtures never observe cross-call contamination. Production
  // still memos so provider+project cold paths share one ~11s scan.
  const memoEnabled = process.env.VITEST !== "true";
  const key = mtdScanKey(monthStart, rawCutoff);
  const nowMs = Date.now();
  if (memoEnabled) {
    const hit = getMtdScanMemo<
      Map<string, ProviderPushedCost>,
      ExternalCostAttributionRow[]
    >();
    if (hit && hit.key === key && hit.expiresAt > nowMs) {
      return { byProvider: hit.byProvider, attribution: hit.attribution };
    }
  }

  return withExclusiveExternalUsageCostAggregation(async () => {
    if (memoEnabled) {
      const again = getMtdScanMemo<
        Map<string, ProviderPushedCost>,
        ExternalCostAttributionRow[]
      >();
      if (again && again.key === key && again.expiresAt > Date.now()) {
        return { byProvider: again.byProvider, attribution: again.attribution };
      }
    }

    const material = await loadMonthToDateExternalCostMaterialUnserialized(
      monthStart,
      rawCutoff
    );
    if (memoEnabled) {
      setMtdScanMemo({
        key,
        byProvider: material.byProvider,
        attribution: material.attribution,
        expiresAt: Date.now() + MTD_SCAN_MEMO_TTL_MS,
      });
    }
    return material;
  });
}

async function loadMonthToDateExternalCostMaterialUnserialized(
  monthStart: Date,
  rawCutoff: Date
): Promise<{
  byProvider: Map<string, ProviderPushedCost>;
  attribution: ExternalCostAttributionRow[];
}> {
  const rawSince = monthStart > rawCutoff ? monthStart : rawCutoff;

  if (!loggedExternalEventsRawSizeOnce) {
    loggedExternalEventsRawSizeOnce = true;
    if (typeof prisma.externalUsageEvent?.count === "function") {
      try {
        prisma.externalUsageEvent
          .count({ where: { occurredAt: { gte: rawSince } } })
          .then((rawSinceRows) => {
            // eslint-disable-next-line no-console -- one-time diagnostic
            console.info(
              "[external-events-size]",
              JSON.stringify({ rawSinceRows, monthStart, rawCutoff })
            );
          })
          .catch((error) => {
            console.warn("[external-events-size] row-count diagnostic failed", error);
          });
      } catch (error) {
        console.warn("[external-events-size] row-count diagnostic failed", error);
      }
    }
  }

  const receiptCandidates = await rawReceiptCashCandidates(rawSince);
  const [rawGroups, rollups] = await Promise.all([
    prisma.externalUsageEvent.groupBy({
      by: ["provider", "sourceApp", "service", "projectId", "metricType"],
      where: {
        occurredAt: { gte: rawSince },
        metricType: { notIn: Array.from(STATUS_METRIC_TYPES) },
        ...NON_RECEIPT_CANDIDATE_WHERE,
      },
      _sum: { costUsd: true },
      _count: { _all: true, costUsd: true },
    }),
    monthStart < rawCutoff
      ? prisma.externalUsageEventDailyRollup.findMany({
          where: {
            day: { gte: monthStart, lt: rawCutoff },
            metricType: { notIn: Array.from(STATUS_METRIC_TYPES) },
          },
          select: {
            provider: true,
            sourceApp: true,
            service: true,
            label: true,
            keyRef: true,
            billingMode: true,
            projectId: true,
            metricType: true,
            unit: true,
            confidence: true,
            eventCount: true,
            pricedEventCount: true,
            unpricedEventCount: true,
            unclassifiedCostEventCount: true,
            totalCostUsd: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const byProvider = new Map<string, ProviderPushedCost>();
  const attributionMap = new Map<string, ExternalCostAttributionRow>();

  const addProvider = (
    provider: string,
    sourceApp: string,
    service: string | null,
    metricType: string,
    cost: number,
    counts: {
      pricedEventCount: number;
      unpricedEventCount: number;
      unclassifiedCostEventCount: number;
    }
  ) => {
    const key = normalizedProviderName(provider);
    const bucket = byProvider.get(key) ?? emptyProviderPushedCost();
    if (isClaudeCodeAnalyticsTelemetry({ sourceApp, service })) {
      bucket.estimatedApiEquivalentUsd += cost;
      byProvider.set(key, bucket);
      return;
    }
    if (metricType === SUBSCRIPTION_METRIC_TYPE) {
      bucket.subscriptionPushed += cost;
      if (sourceApp !== SUBSCRIPTION_SOURCE_APP) {
        bucket.subscriptionPushedManualUsd += cost;
      }
    } else {
      bucket.usagePushed += cost;
    }
    bucket.pricedEventCount += counts.pricedEventCount;
    bucket.unpricedEventCount += counts.unpricedEventCount;
    bucket.unclassifiedCostEventCount += counts.unclassifiedCostEventCount;
    byProvider.set(key, bucket);
  };

  const addAttribution = (
    provider: string,
    sourceApp: string,
    service: string | null,
    projectId: string | null,
    metricType: string,
    cost: number,
    counts: {
      pricedEventCount: number;
      unpricedEventCount: number;
      unclassifiedCostEventCount: number;
    }
  ) => {
    // Attribution deliberately excludes Claude analytics telemetry (estimate
    // only on provider view) and receipt-cash rows (handled separately).
    if (isClaudeCodeAnalyticsTelemetry({ sourceApp, service })) return;
    const key = `${normalizedProviderName(provider)}|${sourceApp.toLowerCase()}|${projectId ?? ""}|${metricType}`;
    const existing = attributionMap.get(key);
    if (existing) {
      existing.costUsd += cost;
      existing.pricedEventCount += counts.pricedEventCount;
      existing.unpricedEventCount += counts.unpricedEventCount;
      existing.unclassifiedCostEventCount += counts.unclassifiedCostEventCount;
    } else {
      attributionMap.set(key, {
        provider,
        sourceApp,
        projectId,
        metricType,
        costUsd: cost,
        ...counts,
      });
    }
  };

  for (const row of rawGroups) {
    const counts = {
      pricedEventCount: row._count.costUsd,
      unpricedEventCount: row._count._all - row._count.costUsd,
      unclassifiedCostEventCount: 0,
    };
    const cost = row._sum.costUsd ?? 0;
    addProvider(row.provider, row.sourceApp, row.service, row.metricType, cost, counts);
    addAttribution(
      row.provider,
      row.sourceApp,
      row.service,
      row.projectId,
      row.metricType,
      cost,
      counts
    );
  }
  for (const candidate of receiptCandidates) {
    if (isReceiptCashEvent(candidate)) continue;
    const counts = {
      pricedEventCount: candidate.costUsd == null ? 0 : 1,
      unpricedEventCount: candidate.costUsd == null ? 1 : 0,
      unclassifiedCostEventCount: 0,
    };
    const cost = candidate.costUsd ?? 0;
    addProvider(
      candidate.provider,
      candidate.sourceApp,
      candidate.service,
      candidate.metricType,
      cost,
      counts
    );
    addAttribution(
      candidate.provider,
      candidate.sourceApp,
      candidate.service,
      candidate.projectId,
      candidate.metricType,
      cost,
      counts
    );
  }
  for (const rollup of rollups) {
    if (isReceiptCashEvent(rollup)) continue;
    const hasCoverageCounts =
      rollup.pricedEventCount != null ||
      rollup.unpricedEventCount != null ||
      rollup.unclassifiedCostEventCount != null;
    const counts = {
      pricedEventCount: rollup.pricedEventCount ?? 0,
      unpricedEventCount: rollup.unpricedEventCount ?? 0,
      unclassifiedCostEventCount: hasCoverageCounts
        ? rollup.unclassifiedCostEventCount ?? 0
        : rollup.eventCount,
    };
    addProvider(
      rollup.provider,
      rollup.sourceApp,
      rollup.service,
      rollup.metricType,
      rollup.totalCostUsd,
      counts
    );
    addAttribution(
      rollup.provider,
      rollup.sourceApp,
      rollup.service,
      rollup.projectId,
      rollup.metricType,
      rollup.totalCostUsd,
      counts
    );
  }

  return {
    byProvider,
    attribution: Array.from(attributionMap.values()),
  };
}

export async function syncStatusToUsageSnapshot(events: ExternalUsageEventInput[]): Promise<void> {
  const statusEvents = events.filter((e) => STATUS_METRIC_TYPES.has(e.metricType));
  if (statusEvents.length === 0) return;

  const allProviders = await prisma.provider.findMany({
    select: { id: true, name: true, groupId: true },
  });

  for (const event of statusEvents) {
    let provider = event.keyRef
      ? allProviders.find((p) => p.groupId === event.keyRef || p.id === event.keyRef)
      : undefined;

    if (!provider) {
      provider = resolveProviderIdentity(event.provider, allProviders) ?? undefined;
    }
    if (!provider) continue;

    const data: Prisma.UsageSnapshotCreateInput = {
      provider: { connect: { id: provider.id } },
      fetchedAt: event.occurredAt,
    };

    if (event.metricType === "quota_sync") {
      if (event.requests != null || event.quantity != null) {
        data.totalRequests = event.requests ?? event.quantity ?? undefined;
      }
      if (event.costUsd != null) data.totalCost = event.costUsd;
    } else if (event.metricType === "credit_balance") {
      data.credits = event.credits ?? event.quantity ?? undefined;
    }

    await prisma.usageSnapshot.create({ data });
  }
}
