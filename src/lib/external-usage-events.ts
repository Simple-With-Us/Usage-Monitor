import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  canonicalProjectKey,
  canonicalProviderKey,
  normalizedProviderName,
} from "@/lib/provider-identity";
import { hashProviderBillingAccountId } from "@/lib/provider-billing-account";
import {
  API_PREPAID_FUNDING_SERVICE,
  BILLING_RECEIPT_SOURCE_APP,
  RECEIPT_CASH_LABEL,
  isReceiptCashEvent,
  receiptCashProviderId,
} from "@/lib/receipt-cash";
import { SUBSCRIPTION_SOURCE_APP } from "@/lib/subscription-charge-identity";
import { ingestCostDerivationEnabled } from "@/lib/pricing/derive-ingest-cost";
import {
  canonicalTokenType,
  deriveTokenCostUsd,
  getModelPricing,
} from "@/lib/pricing/model-pricing";
import {
  DERIVED_ANALYTICS_TOKEN_SOURCE_APPS,
  isSubscriptionAnalyticsTelemetry,
  shouldDeriveAnalyticsTokenEstimate,
} from "@/lib/subscription-analytics";
import {
  MTD_SCAN_MEMO_TTL_MS,
  clearMtdScanMemo,
  getMtdScanMemo,
  getUsageEventsSummaryMemo,
  setMtdScanMemo,
  setUsageEventsSummaryMemo,
} from "@/lib/mtd-scan-memo";

export {
  isClaudeCodeAnalyticsTelemetry,
  isSubscriptionAnalyticsTelemetry,
  shouldDeriveAnalyticsTokenEstimate,
  SUBSCRIPTION_ANALYTICS_SOURCE_APPS,
} from "@/lib/subscription-analytics";

export const STATUS_METRIC_TYPES = new Set(["quota_sync", "credit_balance"]);

// Trailing-window cumulative bound on negative subscription adjustments —
// the DB-backed companion to usage-telemetry.ts's parse-time per-event
// (MAX_NEGATIVE_SUBSCRIPTION_COST_USD) and per-batch
// (MAX_NEGATIVE_SUBSCRIPTION_BATCH_COST_USD) bounds. Without it a token
// holder could repeat maximal per-batch erasures indefinitely. The window is
// keyed on server-stamped `createdAt`, NOT producer-controlled `occurredAt`:
// backdating occurredAt must not be able to age prior negative adjustments
// out of the window. A trailing window (not a calendar month) is used so the
// bound cannot be straddled at a month boundary. Raw rows are retained 90
// days (data-retention.ts's DEFAULT_EXTERNAL_EVENT_RETENTION_DAYS), so a
// 30-day lookback has no retention blind spot. INCLUSIVE like the other two
// bounds: a total landing exactly on the cap is accepted.
export const MAX_NEGATIVE_SUBSCRIPTION_WINDOW_COST_USD = 5000;
export const NEGATIVE_SUBSCRIPTION_WINDOW_DAYS = 30;

export class NegativeSubscriptionWindowLimitExceededError extends Error {
  constructor(persistedNegativeUsd: number, incomingNegativeUsd: number) {
    super(
      `Cumulative negative subscription adjustments over the trailing ` +
        `${NEGATIVE_SUBSCRIPTION_WINDOW_DAYS} days would exceed ` +
        `$${MAX_NEGATIVE_SUBSCRIPTION_WINDOW_COST_USD} ` +
        `(already persisted $${persistedNegativeUsd.toFixed(2)} + incoming ` +
        `$${incomingNegativeUsd.toFixed(2)}). Submit smaller corrections or ` +
        `wait for older adjustments to age out of the window.`
    );
    this.name = "NegativeSubscriptionWindowLimitExceededError";
  }
}

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
  // The validated TOP-LEVEL `project` field from the ingest wire, when the
  // producer sent one. The ingest route stamps this same value into
  // metadata.project (top-level project is authoritative — see AGENTS.md and
  // route.ts), so carrying it separately lets the existing-row replay branch
  // below distinguish an authoritative-attribution overwrite from a genuine
  // producer-metadata conflict: rows ingested before the top-level field
  // became authoritative (pre-#887) stored the producer's raw
  // metadata.project verbatim, and their byte-identical replays must dedupe,
  // not 409. NOT a persisted column and NOT part of comparableEvent.
  authoritativeProject?: string;
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
  return prisma.$transaction(
    async (tx) => {
      const result = await persistExternalUsageEventsInTransaction(tx, events);
      await syncStatusToUsageSnapshot(result.newEvents, tx);
      return result;
    },
    {
      timeout: 30_000,
    }
  );
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
  const leftComp = comparableEvent(left);
  const rightComp = comparableEvent(right);
  if (stableJson(leftComp) === stableJson(rightComp)) {
    return true;
  }
  // Allow timestamp jitter up to 5 seconds when all other fields match exactly.
  // This prevents subsecond clock drift or JSON serialization differences in
  // historical sessions from falsely triggering idempotency collisions.
  const timeDiffMs = Math.abs(left.occurredAt.getTime() - right.occurredAt.getTime());
  if (timeDiffMs <= 5000) {
    const leftWithoutTime = { ...leftComp, occurredAt: null };
    const rightWithoutTime = { ...rightComp, occurredAt: null };
    if (stableJson(leftWithoutTime) === stableJson(rightWithoutTime)) {
      return true;
    }
  }
  return false;
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
      // #887 replay-409 regression fix: a row ingested before the top-level
      // `project` field became authoritative stored the producer's raw
      // metadata.project verbatim, while its byte-identical replay now
      // arrives with the validated top-level project stamped into
      // metadata.project by the route. Overwrite the stored name with the
      // authoritative value (mirroring the !existingProjectName backfill
      // below) ONLY for rows that look producer-era on both axes:
      // no resolved projectId, and a stored name that does not match any
      // live Project. A row that was already attributed either way was
      // authoritative itself — replacing it would silently move money
      // between projects, so that stays a collision. Residuals, both
      // deliberate: a producer-era name that happens to match a live
      // Project still 409s on replay (conservative — fail loud rather than
      // reattribute), and two successive authoritative sends whose names
      // BOTH resolve to no Project update last-writer-wins (no live
      // attribution is affected; the covering test documents it).
      let authoritativeProjectOverride = false;
      if (
        !!event.authoritativeProject &&
        !!incomingProjectName &&
        !!existingProjectName &&
        existing.projectId === null &&
        canonicalProjectKey(existingProjectName) !==
          canonicalProjectKey(incomingProjectName)
      ) {
        const storedKey = canonicalProjectKey(existingProjectName);
        const projects = await tx.project.findMany({
          select: { name: true },
        });
        authoritativeProjectOverride = !projects.some(
          (project) => canonicalProjectKey(project.name) === storedKey
        );
      }
      if (!authoritativeProjectOverride) {
        assertCompatibleProjectAttribution(existing, event, event.idempotencyKey);
      }
      if (!sameEvent(existing, event)) {
        throw new ExternalUsageIdempotencyCollisionError(event.idempotencyKey);
      }
      const projectId = !existing.projectId && event.projectId
        ? event.projectId
        : undefined;
      const metadata = incomingProjectName &&
        (!existingProjectName || authoritativeProjectOverride)
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

  // Trailing-window cumulative negative-adjustment bound (see
  // MAX_NEGATIVE_SUBSCRIPTION_WINDOW_COST_USD's doc comment at the top of
  // this file). Counts only NEW rows about to be inserted — idempotent
  // replays are absent from newEvents AND already counted in the persisted
  // aggregate, so a retry never double-counts. The aggregate runs on `tx`,
  // the same transaction that performs the insert below: SQLite serializes
  // write transactions (and HTTP ingest additionally holds the
  // single-in-flight admission lease, ingest-admission.ts), so two
  // concurrent batches cannot both pass on a stale read — no residual
  // TOCTOU race. Batches with no new negative subscription rows (the
  // entire hot path, including every internal materializer write) skip the
  // query entirely. Throwing here rolls back the whole transaction, so a
  // rejected batch persists nothing — including its non-negative events.
  const incomingNegativeSubscriptionUsd = newEvents.reduce(
    (sum, event) =>
      event.metricType === SUBSCRIPTION_METRIC_TYPE &&
      event.costUsd != null &&
      event.costUsd < 0
        ? sum + -event.costUsd
        : sum,
    0
  );
  if (incomingNegativeSubscriptionUsd > 0) {
    const windowStart = new Date(
      Date.now() - NEGATIVE_SUBSCRIPTION_WINDOW_DAYS * 24 * 60 * 60 * 1000
    );
    const persistedAggregate = await tx.externalUsageEvent.aggregate({
      _sum: { costUsd: true },
      where: {
        metricType: SUBSCRIPTION_METRIC_TYPE,
        costUsd: { lt: 0 },
        // Server-stamped receipt time, deliberately NOT producer-controlled
        // occurredAt — see the window constant's doc comment.
        createdAt: { gte: windowStart },
      },
    });
    const persistedNegativeUsd = -(persistedAggregate._sum.costUsd ?? 0);
    if (
      persistedNegativeUsd + incomingNegativeSubscriptionUsd >
      MAX_NEGATIVE_SUBSCRIPTION_WINDOW_COST_USD
    ) {
      throw new NegativeSubscriptionWindowLimitExceededError(
        persistedNegativeUsd,
        incomingNegativeSubscriptionUsd
      );
    }
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

// Internal accumulator for summarizeExternalUsageEvents. The two *SourceAt
// fields track provenance for limit/limitWindow so each can come from the
// latest contributing entry (by occurredAt) that actually has a non-null
// value - the exact semantics the old per-event fold produced, which a plain
// "latest entry wins" merge does not reproduce once SQL pre-aggregates rows.
interface SummaryAccumulator extends ExternalUsageEventSummaryGroup {
  limitSourceAt: string | null;
  limitWindowSourceAt: string | null;
}

interface SummaryContribution {
  sourceApp: string;
  environment: string | null;
  provider: string;
  service: string | null;
  projectId: string | null;
  metricType: string;
  unit: string | null;
  eventCount: number;
  pricedEventCount: number;
  unpricedEventCount: number;
  unclassifiedCostEventCount: number;
  totalCostUsd: number;
  receiptCashPaidUsd: number;
  estimatedApiEquivalentUsd: number;
  totalRequests: number;
  totalQuantity: number;
  limit: number | null;
  limitWindow: string | null;
  latestAt: string;
}

function addSummaryContribution(
  target: Map<string, SummaryAccumulator>,
  contribution: SummaryContribution
): void {
  const key = summaryGroupKey(contribution);
  const existing = target.get(key);
  if (!existing) {
    target.set(key, {
      ...contribution,
      canonicalProvider: canonicalProviderKey(contribution.provider),
      costCoverage: classifyCostCoverage(contribution),
      limitSourceAt: contribution.limit != null ? contribution.latestAt : null,
      limitWindowSourceAt:
        contribution.limitWindow != null ? contribution.latestAt : null,
    });
    return;
  }

  existing.eventCount += contribution.eventCount;
  existing.pricedEventCount += contribution.pricedEventCount;
  existing.unpricedEventCount += contribution.unpricedEventCount;
  existing.unclassifiedCostEventCount += contribution.unclassifiedCostEventCount;
  existing.costCoverage = classifyCostCoverage(existing);
  existing.totalCostUsd += contribution.totalCostUsd;
  existing.receiptCashPaidUsd += contribution.receiptCashPaidUsd;
  existing.estimatedApiEquivalentUsd += contribution.estimatedApiEquivalentUsd;
  existing.totalRequests += contribution.totalRequests;
  existing.totalQuantity += contribution.totalQuantity;
  if (contribution.latestAt > existing.latestAt) {
    existing.latestAt = contribution.latestAt;
  }
  if (
    contribution.limit != null &&
    (existing.limitSourceAt == null ||
      contribution.latestAt >= existing.limitSourceAt)
  ) {
    existing.limit = contribution.limit;
    existing.limitSourceAt = contribution.latestAt;
  }
  if (
    contribution.limitWindow != null &&
    (existing.limitWindowSourceAt == null ||
      contribution.latestAt >= existing.limitWindowSourceAt)
  ) {
    existing.limitWindow = contribution.limitWindow;
    existing.limitWindowSourceAt = contribution.latestAt;
  }
}

export interface ExternalUsageEventSummary {
  eventCount: number;
  groups: ExternalUsageEventSummaryGroup[];
  /** Monitor-computed token x LiteLLM cost estimates (metadata-only
   * `_derivedCostUsd` stamps from pricing/derive-ingest-cost.ts). Never cash,
   * never counted as priced — surfaced separately so unpriced-coverage gaps
   * can be sized without distorting the producer-reported cost pool. Zero
   * when INGEST_COST_DERIVATION_ENABLED is off. */
  derivedCostEstimateUsd: number;
  derivedCostEstimateEventCount: number;
}

/**
 * Sum server-stamped derived cost estimates over the RAW window. One bounded
 * aggregate query (json_extract over metadata), called only when the
 * derivation flag is enabled so default-off deployments pay zero query cost.
 * Derived stamps exist only on metricType="usage"/unit="token" rows, so
 * receipt-cash and status-metric shapes are excluded by construction — no
 * receipt-candidate where-clause replication needed here.
 */
const TOKEN_TYPE_LABEL_PREFIX = "token:";

function tokenTypeFromUsageLabel(label: string | null | undefined): string {
  if (!label) return "unknown";
  return label.startsWith(TOKEN_TYPE_LABEL_PREFIX)
    ? label.slice(TOKEN_TYPE_LABEL_PREFIX.length)
    : "unknown";
}

interface AnalyticsTokenRow {
  sourceApp: string;
  provider: string;
  service: string | null;
  keyRef: string | null;
  label: string | null;
  quantity: number;
}

/**
 * Catalog-priced API-equivalent for subscription seats that post tokens
 * without a vendor costUsd (Codex JSONL). Claude is excluded: its OTLP
 * cost.usage already fills estimatedApiEquivalentUsd. Fail-closed when the
 * Prisma client in tests has no $queryRaw.
 */
async function loadAnalyticsTokenRows(
  since: Date,
  until: Date
): Promise<AnalyticsTokenRow[]> {
  if (typeof prisma.$queryRaw !== "function") return [];
  try {
    const rows = await prisma.$queryRaw<
      Array<{
        sourceApp: string;
        provider: string;
        service: string | null;
        keyRef: string | null;
        label: string | null;
        quantity: unknown;
      }>
    >(Prisma.sql`
      SELECT
        "sourceApp",
        "provider",
        "service",
        "keyRef",
        "label",
        COALESCE(SUM("quantity"), 0) AS "quantity"
      FROM "ExternalUsageEvent"
      WHERE "occurredAt" >= ${since}
        AND "occurredAt" <= ${until}
        AND "metricType" = 'usage'
        AND "unit" = 'token'
        AND "sourceApp" IN (${Prisma.join(DERIVED_ANALYTICS_TOKEN_SOURCE_APPS)})
      GROUP BY "sourceApp", "provider", "service", "keyRef", "label"
    `);
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((row) => typeof row?.sourceApp === "string" && typeof row.provider === "string")
      .map((row) => ({
        sourceApp: row.sourceApp,
        provider: row.provider,
        service: row.service,
        keyRef: row.keyRef,
        label: row.label,
        quantity: Number(row.quantity ?? 0),
      }));
  } catch {
    return [];
  }
}

function deriveAnalyticsTokenUsdByProvider(
  rows: AnalyticsTokenRow[]
): Map<string, number> {
  const byModel = new Map<
    string,
    {
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation: number;
      cacheCreation1h: number;
      unknown: number;
    }
  >();
  for (const row of rows) {
    if (!shouldDeriveAnalyticsTokenEstimate(row)) continue;
    if (!Number.isFinite(row.quantity) || row.quantity <= 0) continue;
    const model = row.keyRef?.trim() || "";
    const key = `${canonicalProviderKey(row.provider)}|${model}`;
    const bucket =
      byModel.get(key) ??
      { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, unknown: 0 };
    const tokenType = canonicalTokenType(tokenTypeFromUsageLabel(row.label));
    if (tokenType) {
      bucket[tokenType] += row.quantity;
    } else {
      bucket.unknown += row.quantity;
    }
    byModel.set(key, bucket);
  }

  const byProvider = new Map<string, number>();
  for (const [key, tokens] of byModel) {
    const provider = key.slice(0, key.indexOf("|"));
    const model = key.slice(key.indexOf("|") + 1);
    const resolved = model ? getModelPricing(model) : null;
    if (!resolved) continue;
    const derived = deriveTokenCostUsd(resolved.pricing, tokens);
    let usd = derived.costUsd;
    if (tokens.unknown > 0) {
      usd += deriveTokenCostUsd(resolved.pricing, { input: tokens.unknown }).costUsd;
    }
    byProvider.set(provider, (byProvider.get(provider) ?? 0) + usd);
  }
  return byProvider;
}

async function sumDerivedCostEstimates(
  rawSince: Date
): Promise<{ totalUsd: number; eventCount: number }> {
  const rows = await prisma.$queryRaw<Array<{ totalUsd: unknown; eventCount: unknown }>>`
    SELECT
      COALESCE(SUM(json_extract("metadata", '$._derivedCostUsd')), 0) AS "totalUsd",
      COUNT(*) AS "eventCount"
    FROM "ExternalUsageEvent"
    WHERE "occurredAt" >= ${rawSince}
      AND json_extract("metadata", '$._derivedCostUsd') IS NOT NULL
  `;
  const row = rows[0];
  return {
    totalUsd: Number(row?.totalUsd ?? 0),
    eventCount: Number(row?.eventCount ?? 0),
  };
}

// The dashboard portfolio panel polls this every 60s. The SQL groupBy below
// already collapsed ~336 cursor round trips to one aggregate query; this
// short process-local memo additionally dedupes back-to-back polls, matching
// the accepted staleness of the budget-status SWR cache (also 60s). Disabled
// under vitest like the MTD scan memo; invalidated post-ingest through the
// same clearMtdScanMemo() path budget-status already calls.
const USAGE_EVENTS_SUMMARY_MEMO_DEFAULT_TTL_MS = 60_000;

function usageEventsSummaryMemoTtlMs(): number {
  const raw = process.env.USAGE_EVENTS_SUMMARY_MEMO_TTL_MS?.trim();
  if (!raw) return USAGE_EVENTS_SUMMARY_MEMO_DEFAULT_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return USAGE_EVENTS_SUMMARY_MEMO_DEFAULT_TTL_MS;
  }
  return parsed;
}

export async function summarizeExternalUsageEvents(
  since: Date,
  rawCutoff: Date,
  now = new Date(),
  /** Optional upper bound for the query window. When provided the memo is
   * bypassed (calendar-range queries are infrequent and key-cardinality would
   * pollute the memo). Defaults to `now` when omitted. */
  until?: Date
): Promise<ExternalUsageEventSummary> {
  // Bypass the memo for explicit calendar-range queries: the date range is
  // the canonical key, and unbounded month/year tokens would blow up the
  // memo key space. Default-window calls (until === undefined) still memo.
  const memoEnabled = process.env.VITEST !== "true" && until === undefined;
  // Day-granularity key (same shape as mtdScanKey): sequential same-day
  // default-window dashboard calls share one memo entry. The derivation-flag
  // bit keeps a same-day flag flip from serving the other mode's cached
  // derived-estimate totals.
  const key = `${since.toISOString().slice(0, 10)}|${rawCutoff.toISOString().slice(0, 10)}|${ingestCostDerivationEnabled() ? 1 : 0}`;
  if (memoEnabled) {
    const hit = getUsageEventsSummaryMemo<ExternalUsageEventSummary>();
    if (hit && hit.key === key && hit.expiresAt > Date.now()) {
      return hit.value;
    }
  }

  // Share the exclusive-aggregation lease with the MTD cost scans: the
  // groupBy result set for a summary window can be as large as theirs, and
  // on the 512 MB instance two concurrent in-flight aggregations are enough
  // to kill the process.
  return withExclusiveExternalUsageCostAggregation(async () => {
    if (memoEnabled) {
      const again = getUsageEventsSummaryMemo<ExternalUsageEventSummary>();
      if (again && again.key === key && again.expiresAt > Date.now()) {
        return again.value;
      }
    }
    const summary = await summarizeExternalUsageEventsUnserialized(
      since,
      rawCutoff,
      now,
      until
    );
    if (memoEnabled) {
      setUsageEventsSummaryMemo({
        key,
        value: summary,
        expiresAt: Date.now() + usageEventsSummaryMemoTtlMs(),
      });
    }
    return summary;
  });
}

export interface DailySpendPoint {
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
  totalCostUsd: number;
}

/**
 * Per-day cost series over [since, until] — the range-scoped counterpart to
 * summarizeExternalUsageEvents above, bucketed by UTC calendar day instead of
 * by summary dimension. Feeds the dashboard's chart-range burn chart (see
 * GET /api/usage-events) so changing the timeframe visibly changes what the
 * chart renders instead of only changing a caption.
 *
 * Same raw/rollup split as summarizeExternalUsageEventsUnserialized: days at
 * or after `rawCutoff` are summed straight from ExternalUsageEvent; older
 * days are summed from the durable ExternalUsageEventDailyRollup table.
 *
 * Approximate, not exact: unlike the grouped summary, this does not net out
 * receipt-cash payments or subscription-analytics token estimates from
 * totalCostUsd (both are rare and small in practice). Use `groups` on the
 * summary response, not this series, for anything that must reconcile
 * exactly — this is a trend chart, not a ledger.
 */
export async function buildDailySpendSeries(
  since: Date,
  rawCutoff: Date,
  until: Date
): Promise<DailySpendPoint[]> {
  const byDay = new Map<string, number>();

  if (since < rawCutoff) {
    const rollupDayLt =
      until < rawCutoff
        ? new Date(
            Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate() + 1)
          )
        : rawCutoff;
    const rollupRows = await prisma.externalUsageEventDailyRollup.groupBy({
      by: ["day"],
      where: {
        day: {
          gte: new Date(
            Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())
          ),
          lt: rollupDayLt,
        },
        metricType: { notIn: Array.from(STATUS_METRIC_TYPES) },
      },
      _sum: { totalCostUsd: true },
    });
    for (const row of rollupRows) {
      const key = row.day.toISOString().slice(0, 10);
      byDay.set(key, (byDay.get(key) ?? 0) + (row._sum.totalCostUsd ?? 0));
    }
  }

  const rawSince = since > rawCutoff ? since : rawCutoff;
  // Fail-closed like loadAnalyticsTokenRows above: a test double without
  // $queryRaw degrades to rollup-only data rather than throwing.
  if (rawSince <= until && typeof prisma.$queryRaw === "function") {
    try {
      const rawRows = await prisma.$queryRaw<Array<{ day: string; totalUsd: unknown }>>`
        SELECT
          date("occurredAt") AS "day",
          COALESCE(SUM("costUsd"), 0) AS "totalUsd"
        FROM "ExternalUsageEvent"
        WHERE "occurredAt" >= ${rawSince}
          AND "occurredAt" <= ${until}
          AND "metricType" NOT IN ('quota_sync', 'credit_balance')
        GROUP BY date("occurredAt")
      `;
      for (const row of rawRows) {
        if (!row?.day) continue;
        byDay.set(row.day, (byDay.get(row.day) ?? 0) + Number(row.totalUsd ?? 0));
      }
    } catch {
      // Best-effort — the series degrades to whatever rollup data covers.
    }
  }

  return Array.from(byDay.entries())
    .map(([day, totalCostUsd]) => ({ day, totalCostUsd }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/**
 * E1: SQL-groupBy rewrite of the old cursor-paginated JS fold. The raw side
 * is ONE aggregate query grouped by every summary dimension (plus limit /
 * limitWindow so their latest-non-null semantics survive pre-aggregation)
 * instead of ~336 findMany round trips folding 1,000-row pages in JS.
 *
 * Receipt-cash rows keep their exact per-row identity validation: the
 * groupBy excludes the fixed-shape receipt candidate superset
 * (NON_RECEIPT_CANDIDATE_WHERE) and candidates are folded individually, so
 * validated receipts land in receiptCashPaidUsd and malformed receipt-shaped
 * rows fall back to ordinary cost - identical to the MTD cost aggregate and
 * to the old fold.
 */
async function summarizeExternalUsageEventsUnserialized(
  since: Date,
  rawCutoff: Date,
  now: Date,
  until?: Date
): Promise<ExternalUsageEventSummary> {
  const groups = new Map<string, SummaryAccumulator>();
  // `upperBound` caps both raw-event and rollup upper bounds so calendar-range
  // queries (from/to) see only events in their window. For rollup queries the
  // upper bound must not exceed rawCutoff (start of retention window).
  const upperBound = until !== undefined && until < now ? until : now;
  const rawSince = since > rawCutoff ? since : rawCutoff;

  const receiptCandidates = await rawReceiptCashCandidates(rawSince, upperBound);
  // For rollups: the day-lt bound is the lesser of rawCutoff and the day after
  // `upperBound`, so a calendar-range query doesn't include rollup days beyond
  // the requested `to` date.
  const rollupDayLt = upperBound < rawCutoff
    ? new Date(Date.UTC(upperBound.getUTCFullYear(), upperBound.getUTCMonth(), upperBound.getUTCDate() + 1))
    : rawCutoff;
  const [rawGroups, rollups, derivedCostEstimates] = await Promise.all([
    prisma.externalUsageEvent.groupBy({
      by: [
        "sourceApp",
        "environment",
        "provider",
        "service",
        "projectId",
        "metricType",
        "unit",
        "limit",
        "limitWindow",
      ],
      where: {
        occurredAt: { gte: rawSince, lte: upperBound },
        metricType: { notIn: Array.from(STATUS_METRIC_TYPES) },
        ...NON_RECEIPT_CANDIDATE_WHERE,
      },
      _sum: { costUsd: true, requests: true, quantity: true },
      _count: { _all: true, costUsd: true },
      _max: { occurredAt: true },
    }),
    since < rawCutoff
      ? prisma.externalUsageEventDailyRollup.findMany({
          where: {
            day: {
              gte: new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())),
              lt: rollupDayLt,
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
      : Promise.resolve([]),
    // Flag-gated: default-off deployments skip the json_extract scan entirely.
    ingestCostDerivationEnabled()
      ? sumDerivedCostEstimates(rawSince)
      : Promise.resolve({ totalUsd: 0, eventCount: 0 }),
  ]);

  let rawEventCount = receiptCandidates.length;

  for (const row of rawGroups) {
    // occurredAt is a non-nullable column and every group has at least one
    // row, so _max.occurredAt is always set; skip defensively if a future
    // engine ever returns null.
    if (!row._max.occurredAt) continue;
    rawEventCount += row._count._all;
    const isAnalytics = isSubscriptionAnalyticsTelemetry({
      sourceApp: row.sourceApp,
      service: row.service,
    });
    addSummaryContribution(groups, {
      sourceApp: row.sourceApp,
      environment: row.environment,
      provider: row.provider,
      service: row.service,
      projectId: row.projectId,
      metricType: row.metricType,
      unit: row.unit,
      eventCount: row._count._all,
      pricedEventCount: isAnalytics ? 0 : row._count.costUsd,
      unpricedEventCount: isAnalytics
        ? 0
        : row._count._all - row._count.costUsd,
      unclassifiedCostEventCount: 0,
      totalCostUsd: isAnalytics ? 0 : row._sum.costUsd ?? 0,
      receiptCashPaidUsd: 0,
      estimatedApiEquivalentUsd: isAnalytics
        ? row._sum.costUsd ?? 0
        : 0,
      totalRequests: row._sum.requests ?? 0,
      totalQuantity: row._sum.quantity ?? 0,
      limit: row.limit,
      limitWindow: row.limitWindow,
      latestAt: row._max.occurredAt.toISOString(),
    });
  }

  // Receipt candidates are rare (only exact receipt-shaped rows); folding
  // them per-row preserves the old fold's validated-receipt semantics.
  for (const candidate of receiptCandidates) {
    const isAnalytics = isSubscriptionAnalyticsTelemetry(candidate);
    const isReceiptCash = isReceiptCashEvent(candidate);
    addSummaryContribution(groups, {
      sourceApp: candidate.sourceApp,
      environment: candidate.environment ?? null,
      provider: candidate.provider,
      service: candidate.service,
      projectId: candidate.projectId,
      metricType: candidate.metricType,
      unit: candidate.unit,
      eventCount: 1,
      pricedEventCount:
        isAnalytics || isReceiptCash || candidate.costUsd == null
          ? 0
          : 1,
      unpricedEventCount:
        isAnalytics || isReceiptCash || candidate.costUsd != null
          ? 0
          : 1,
      unclassifiedCostEventCount: 0,
      totalCostUsd:
        isAnalytics || isReceiptCash ? 0 : candidate.costUsd ?? 0,
      receiptCashPaidUsd: isReceiptCash ? candidate.costUsd ?? 0 : 0,
      estimatedApiEquivalentUsd: isAnalytics
        ? candidate.costUsd ?? 0
        : 0,
      totalRequests: candidate.requests ?? 0,
      totalQuantity: candidate.quantity ?? 0,
      limit: candidate.limit,
      limitWindow: candidate.limitWindow,
      latestAt: candidate.occurredAt.toISOString(),
    });
  }

  for (const rollup of rollups) {
    const isAnalytics = isSubscriptionAnalyticsTelemetry(rollup);
    const isReceiptCash = isReceiptCashEvent(rollup);
    const hasCoverageCounts =
      rollup.pricedEventCount != null ||
      rollup.unpricedEventCount != null ||
      rollup.unclassifiedCostEventCount != null;
    const costCounts = isAnalytics || isReceiptCash
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
    addSummaryContribution(groups, {
      sourceApp: rollup.sourceApp,
      environment: rollup.environment,
      provider: rollup.provider,
      service: rollup.service,
      projectId: rollup.projectId,
      metricType: rollup.metricType,
      unit: rollup.unit,
      eventCount: rollup.eventCount,
      ...costCounts,
      totalCostUsd:
        isAnalytics || isReceiptCash ? 0 : rollup.totalCostUsd,
      receiptCashPaidUsd: isReceiptCash ? rollup.totalCostUsd : 0,
      estimatedApiEquivalentUsd: isAnalytics
        ? rollup.totalCostUsd
        : 0,
      totalRequests: rollup.totalRequests,
      totalQuantity: rollup.totalQuantity,
      limit: rollup.maxLimit,
      limitWindow: rollup.limitWindow,
      latestAt: rollup.latestOccurredAt.toISOString(),
    });
  }

  const tokenRows = await loadAnalyticsTokenRows(rawSince, upperBound);
  const derivedByProvider = deriveAnalyticsTokenUsdByProvider(tokenRows);
  const providersWithReportedEstimate = new Set<string>();
  for (const group of groups.values()) {
    if (group.estimatedApiEquivalentUsd > 0) {
      providersWithReportedEstimate.add(canonicalProviderKey(group.provider));
    }
  }
  const appliedDerived = new Set<string>();
  for (const group of groups.values()) {
    if (!shouldDeriveAnalyticsTokenEstimate(group)) continue;
    const providerKey = canonicalProviderKey(group.provider);
    if (providersWithReportedEstimate.has(providerKey)) continue;
    if (appliedDerived.has(providerKey)) continue;
    const extra = derivedByProvider.get(providerKey);
    if (extra && extra > 0) {
      group.estimatedApiEquivalentUsd += extra;
      appliedDerived.add(providerKey);
    }
  }

  const summaries = Array.from(groups.values())
    .map(
      ({
        limitSourceAt: _limitSourceAt,
        limitWindowSourceAt: _limitWindowSourceAt,
        ...group
      }) => group
    )
    .sort(
      (left, right) => Date.parse(right.latestAt) - Date.parse(left.latestAt)
    );

  return {
    eventCount:
      rawEventCount + rollups.reduce((sum, rollup) => sum + rollup.eventCount, 0),
    groups: summaries,
    derivedCostEstimateUsd: derivedCostEstimates.totalUsd,
    derivedCostEstimateEventCount: derivedCostEstimates.eventCount,
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
async function rawReceiptCashCandidates(rawSince: Date, now: Date) {
  return prisma.externalUsageEvent.findMany({
    where: {
      occurredAt: { gte: rawSince, lte: now },
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
      environment: true,
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
      quantity: true,
      requests: true,
      limit: true,
      limitWindow: true,
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
  rawCutoff: Date,
  now = new Date()
): Promise<Map<string, ProviderPushedCost>> {
  const material = await loadMonthToDateExternalCostMaterial(monthStart, rawCutoff, now);
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
  rawCutoff: Date,
  now = new Date()
): Promise<ExternalCostAttributionRow[]> {
  const material = await loadMonthToDateExternalCostMaterial(monthStart, rawCutoff, now);
  return material.attribution;
}

/**
 * Wave H / E1: one exclusive scan feeds both provider totals and project
 * attribution. A short memo lets sequential cold computeBudgetStatus +
 * computeProjectBudgetStatus share the same ~11s groupBy within TTL.
 */
async function loadMonthToDateExternalCostMaterial(
  monthStart: Date,
  rawCutoff: Date,
  now: Date
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
      rawCutoff,
      now
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
  rawCutoff: Date,
  now: Date
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
          .count({ where: { occurredAt: { gte: rawSince, lte: now } } })
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

  const receiptCandidates = await rawReceiptCashCandidates(rawSince, now);
  const [rawGroups, rollups] = await Promise.all([
    prisma.externalUsageEvent.groupBy({
      by: ["provider", "sourceApp", "service", "projectId", "metricType"],
      where: {
        occurredAt: { gte: rawSince, lte: now },
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
            latestOccurredAt: { lte: now },
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
    if (isSubscriptionAnalyticsTelemetry({ sourceApp, service })) {
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
    // Attribution deliberately excludes subscription analytics telemetry
    // (estimate only on provider view) and receipt-cash rows.
    if (isSubscriptionAnalyticsTelemetry({ sourceApp, service })) return;
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

  const tokenRows = await loadAnalyticsTokenRows(rawSince, now);
  const derivedByProvider = deriveAnalyticsTokenUsdByProvider(tokenRows);
  for (const [providerKey, extra] of derivedByProvider) {
    if (!(extra > 0)) continue;
    const bucket = byProvider.get(providerKey) ?? emptyProviderPushedCost();
    if (bucket.estimatedApiEquivalentUsd > 0) continue;
    bucket.estimatedApiEquivalentUsd += extra;
    byProvider.set(providerKey, bucket);
  }

  return {
    byProvider,
    attribution: Array.from(attributionMap.values()),
  };
}

type StatusSnapshotProvider = {
  id: string;
  name: string;
  groupId: string | null;
  billingAccountIdentity: string | null;
};

function billingAccountRefFromMetadata(
  metadata: Prisma.InputJsonObject | undefined
): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const raw = metadata._billingAccountRef;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Map a pushed status metric onto exactly one Provider row.
 *
 * Prefer durable identity (`keyRef` / billing-account ref) over display name.
 * When multiple same-name providers exist and no identity selects one row,
 * return null (fail closed) instead of `resolveProviderIdentity`'s arbitrary
 * first-match — attaching quota/credits to the wrong account silently corrupts
 * dashboards.
 */
export function resolveStatusSnapshotProvider(
  event: Pick<
    ExternalUsageEventInput,
    "provider" | "keyRef" | "metadata"
  >,
  providers: readonly StatusSnapshotProvider[]
): StatusSnapshotProvider | null {
  if (event.keyRef) {
    const byKey = providers.find(
      (p) => p.groupId === event.keyRef || p.id === event.keyRef
    );
    if (byKey) return byKey;
  }

  const accountRef = billingAccountRefFromMetadata(event.metadata);
  if (accountRef) {
    const byAccount: StatusSnapshotProvider[] = [];
    for (const candidate of providers) {
      if (!candidate.billingAccountIdentity) continue;
      try {
        const hashed = hashProviderBillingAccountId(candidate.name, accountRef);
        if (candidate.billingAccountIdentity === hashed) {
          byAccount.push(candidate);
        }
      } catch {
        // ENCRYPTION_KEY missing/invalid — skip account matching rather than throw mid-ingest.
      }
    }
    if (byAccount.length === 1) return byAccount[0];
    if (byAccount.length > 1) {
      const canonical = canonicalProviderKey(event.provider);
      const named = byAccount.filter(
        (p) => canonicalProviderKey(p.name) === canonical
      );
      if (named.length === 1) return named[0];
      return null;
    }
  }

  const exactName = normalizedProviderName(event.provider);
  const exact = providers.filter(
    (p) => normalizedProviderName(p.name) === exactName
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  const canonical = canonicalProviderKey(event.provider);
  const aliases = providers.filter(
    (p) => canonicalProviderKey(p.name) === canonical
  );
  if (aliases.length === 1) return aliases[0];
  return null;
}

export async function syncStatusToUsageSnapshot(
  events: ExternalUsageEventInput[],
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<void> {
  const statusEvents = events.filter((e) => STATUS_METRIC_TYPES.has(e.metricType));
  if (statusEvents.length === 0) return;

  const allProviders = await client.provider.findMany({
    select: {
      id: true,
      name: true,
      groupId: true,
      billingAccountIdentity: true,
    },
  });

  for (const event of statusEvents) {
    const provider = resolveStatusSnapshotProvider(event, allProviders);
    if (!provider) continue;

    const data: Prisma.UsageSnapshotCreateInput = {
      provider: { connect: { id: provider.id } },
      fetchedAt: event.occurredAt,
    };

    if (event.metricType === "quota_sync") {
      const totalRequests = event.requests ?? event.quantity ?? null;
      if (totalRequests != null && Number.isFinite(totalRequests)) {
        data.totalRequests = Math.round(totalRequests);
      }
      if (event.costUsd != null) data.totalCost = event.costUsd;
    } else if (event.metricType === "credit_balance") {
      data.credits = event.credits ?? event.quantity ?? undefined;
    }

    await client.usageSnapshot.create({ data });
  }
}
