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
import {
  DERIVED_COST_METADATA_KEYS,
  ingestCostDerivationEnabled,
} from "@/lib/pricing/derive-ingest-cost";
import {
  canonicalTokenType,
  deriveTokenCostUsd,
  getModelPricing,
} from "@/lib/pricing/model-pricing";
import {
  hasCanonicalAiMetadata,
  withoutCanonicalAiMetadata,
} from "@/lib/ai-usage-metadata";
import {
  DERIVED_ANALYTICS_TOKEN_SOURCE_APPS,
  isSubscriptionAnalyticsTelemetry,
  shouldDeriveAnalyticsTokenEstimate,
} from "@/lib/subscription-analytics";
import { logSlowScanTimingIfNeeded } from "@/lib/slow-scan-timing";
import { oneSidedCorrelationKeys, withoutMetadataKeys } from "@/lib/telemetry-correlation";
import {
  MTD_SCAN_MEMO_TTL_MS,
  clearMtdScanMemo,
  getMtdScanMemo,
  getUsageEventsSummaryMemo,
  setMtdScanMemo,
  setUsageEventsSummaryMemo,
} from "@/lib/mtd-scan-memo";
import { querySqliteUsageAggregate } from "@/lib/sqlite-usage-aggregates";

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
      // Prisma's SQLite adapter starts a deferred BEGIN. Reserve the writer
      // before reading tombstones/replays: an external writer (including the
      // replicator) can otherwise invalidate that read snapshot, and the later
      // INSERT fails immediately with SQLITE_BUSY_SNAPSHOT/P1008 regardless of
      // busy_timeout. WHERE 0 changes no rows and cannot scan the event table.
      await reserveExternalUsageWriter(tx);
      const result = await persistExternalUsageEventsInTransaction(tx, events);
      await syncStatusToUsageSnapshot(result.newEvents, tx);
      return result;
    },
    {
      timeout: 30_000,
    }
  );
}

export async function reserveExternalUsageWriter(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`UPDATE "ExternalUsageEvent" SET "id" = "id" WHERE 0`;
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

// UM-1469: `_producerInstanceId` records WHICH HOST sent an event, not what
// the event is.  macOS renamed the Mac's hostname (`jays.services` ->
// `Mac.Jays.Services`) and every collector replay of a pre-rename event then
// failed with idempotency_conflict, because the stored row and the replay
// differed only in that host label.  Quota enrichment copies the same label
// into `machine`, so drop that too when it merely echoes the instance id.
// A producer that sets `machine` to something else still collides.
function metadataComparableForReplay(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const rest = { ...record };
  let changed = false;
  if (typeof record.project === "string") {
    delete rest.project;
    changed = true;
  }
  if ("_producerInstanceId" in record) {
    if (record.machine === record._producerInstanceId) delete rest.machine;
    delete rest._producerInstanceId;
    changed = true;
  }
  if (!changed) return value;
  return Object.keys(rest).length > 0 ? rest : null;
}

// `_derivedCost*` stamps are computed server-side at ingest from fields that
// are already compared (tokens, model) plus the bundled pricing snapshot.  A
// replay derived under a newer snapshot, or with canonical tokens a pre-UM-1592
// row lacked, would otherwise read as a producer change and return 409.
function withoutDerivedCostMetadata(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!DERIVED_COST_METADATA_KEYS.some((key) => key in record)) return value;
  const rest = { ...record };
  for (const key of DERIVED_COST_METADATA_KEYS) delete rest[key];
  return Object.keys(rest).length > 0 ? rest : null;
}

// NOTE: providerRequestId is deliberately NOT a field here (see its doc
// comment on ExternalUsageEventInput above) — a replay with a different
// providerRequestId under the same idempotencyKey must still dedupe, not
// throw ExternalUsageIdempotencyCollisionError.
function comparableEvent(
  event: ExternalUsageEventInput | ExistingExternalUsageEvent,
  options: { ignoreCanonicalAi?: boolean; ignoreMetadataKeys?: readonly string[] } = {}
) {
  const value = event as ExternalUsageEventInput & ExistingExternalUsageEvent;
  const serverComparable = withoutMetadataKeys(
    withoutDerivedCostMetadata(value.metadata ?? null),
    options.ignoreMetadataKeys ?? []
  );
  const metadata = options.ignoreCanonicalAi
    ? withoutCanonicalAiMetadata(serverComparable)
    : serverComparable;
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
    metadata: stableJson(metadataComparableForReplay(metadata)),
  };
}

function sameEvent(
  left: ExternalUsageEventInput | ExistingExternalUsageEvent,
  right: ExternalUsageEventInput | ExistingExternalUsageEvent
): boolean {
  // The `_ai*` keys are a server-side projection added at ingest (UM-1592).
  // A row persisted before that projection existed has none, so a replay of
  // it must not read as an idempotency collision just because the replay now
  // carries the projection.  When both sides have it, it is compared as usual.
  const ignoreCanonicalAi =
    hasCanonicalAiMetadata(left.metadata) !== hasCanonicalAiMetadata(right.metadata);
  // Correlation keys (session id, launcher) a producer learned after it first
  // sent the event: one-sided means "now known", not "changed".  See
  // telemetry-correlation.ts.
  const ignoreMetadataKeys = oneSidedCorrelationKeys(left.metadata, right.metadata);
  const leftComp = comparableEvent(left, { ignoreCanonicalAi, ignoreMetadataKeys });
  const rightComp = comparableEvent(right, { ignoreCanonicalAi, ignoreMetadataKeys });
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
 * Sum server-stamped derived cost estimates over the RAW window in a read-only
 * child process.  Called only when the derivation flag is enabled, so
 * default-off deployments pay zero query cost.  Derived stamps exist only on
 * metricType="usage"/unit="token" rows, so receipt-cash and status-metric
 * shapes are excluded by construction.
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

// --- Raw event scans and isolated aggregates --------------------------------
// Prisma 7 uses the synchronous better-sqlite3 adapter on the Node main
// thread.  The raw token-detail scan below stays in bounded keyset pages; the
// larger summary, daily, derived-metadata, and MTD aggregates run in a
// short-lived read-only child so SQLite work does not block HTTP or scheduler
// health checks.
const RAW_EVENT_SCAN_CHUNK_ROWS = 2_000;

function yieldEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface RawEventScanCursor {
  occurredAt: Date;
  id: string;
}

function rawEventScanStartClause(since: Date, cursor: RawEventScanCursor | null): Prisma.Sql {
  if (!cursor) return Prisma.sql`"occurredAt" >= ${since}`;
  // The cursor already bounds the window after its first page.  Repeating
  // the earlier date bound makes SQLite rescan that prefix on every page
  // instead of seeking directly into the (occurredAt, id) covering index.
  return Prisma.sql`("occurredAt", "id") > (${cursor.occurredAt}, ${cursor.id})`;
}

function rawEventScanCursorFromRow(row: {
  occurredAt: Date | string;
  id: string;
}): RawEventScanCursor {
  // Prisma stores DateTime in SQLite as ISO text with an explicit offset
  // ("2026-10-15T12:00:00.000+00:00") and the adapter hands it back as a
  // Date or that same string — both parse unambiguously. Normalize
  // defensively anyway (review, PR #1820): a space-separated value would
  // parse as LOCAL time via new Date(), silently shifting the keyset
  // boundary, so rewrite it to the UTC ISO form; a value with no offset
  // is read as UTC, matching how the column is written. An unparseable
  // value fails the scan loudly instead of binding a NaN cursor.
  let occurredAt: Date;
  if (row.occurredAt instanceof Date) {
    occurredAt = row.occurredAt;
  } else {
    const raw = String(row.occurredAt).trim();
    const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
    const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso);
    occurredAt = new Date(hasOffset ? iso : `${iso}Z`);
  }
  if (Number.isNaN(occurredAt.getTime())) {
    throw new Error(
      `raw event scan: unparseable occurredAt cursor value ${JSON.stringify(row.occurredAt)}`
    );
  }
  return { occurredAt, id: String(row.id) };
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
    const totals = new Map<string, AnalyticsTokenRow>();
    let cursor: RawEventScanCursor | null = null;
    for (;;) {
      const rows = await prisma.$queryRaw<
        Array<{
          id: string;
          occurredAt: Date | string;
          sourceApp: string;
          provider: string;
          service: string | null;
          keyRef: string | null;
          label: string | null;
          quantity: unknown;
        }>
      >(Prisma.sql`
        SELECT
          "id",
          "occurredAt",
          "sourceApp",
          "provider",
          "service",
          "keyRef",
          "label",
          "quantity"
        FROM "ExternalUsageEvent"
        WHERE ${rawEventScanStartClause(since, cursor)}
          AND "occurredAt" <= ${until}
          AND "metricType" = 'usage'
          AND "unit" = 'token'
          AND "sourceApp" IN (${Prisma.join(DERIVED_ANALYTICS_TOKEN_SOURCE_APPS)})
        ORDER BY "occurredAt" ASC, "id" ASC
        LIMIT ${RAW_EVENT_SCAN_CHUNK_ROWS}
      `);
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) {
        if (
          typeof row?.sourceApp !== "string" ||
          typeof row.provider !== "string"
        ) {
          continue;
        }
        const key = JSON.stringify([
          row.sourceApp,
          row.provider,
          row.service,
          row.keyRef,
          row.label,
        ]);
        const existing = totals.get(key);
        if (existing) {
          existing.quantity += Number(row.quantity ?? 0);
        } else {
          totals.set(key, {
            sourceApp: row.sourceApp,
            provider: row.provider,
            service: row.service,
            keyRef: row.keyRef,
            label: row.label,
            quantity: Number(row.quantity ?? 0),
          });
        }
      }
      if (rows.length < RAW_EVENT_SCAN_CHUNK_ROWS) break;
      cursor = rawEventScanCursorFromRow(rows[rows.length - 1]);
      await yieldEventLoopTurn();
    }
    return Array.from(totals.values());
  } catch {
    return [];
  }
}

function analyticsEstimateSourceKey(provider: string, sourceApp: string): string {
  return JSON.stringify([
    canonicalProviderKey(provider),
    sourceApp.trim().toLowerCase(),
  ]);
}

function deriveAnalyticsTokenUsdBySource(
  rows: AnalyticsTokenRow[]
): Map<string, { bucketKey: string; usd: number }> {
  const byModel = new Map<
    string,
    {
      bucketKey: string;
      sourceKey: string;
      model: string;
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
    const bucketKey = normalizedProviderName(row.provider);
    const sourceKey = analyticsEstimateSourceKey(row.provider, row.sourceApp);
    const key = JSON.stringify([sourceKey, model]);
    const bucket =
      byModel.get(key) ??
      {
        bucketKey,
        sourceKey,
        model,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
        cacheCreation1h: 0,
        unknown: 0,
      };
    const tokenType = canonicalTokenType(tokenTypeFromUsageLabel(row.label));
    if (tokenType) {
      bucket[tokenType] += row.quantity;
    } else {
      bucket.unknown += row.quantity;
    }
    byModel.set(key, bucket);
  }

  const bySource = new Map<string, { bucketKey: string; usd: number }>();
  for (const tokens of byModel.values()) {
    const { bucketKey, sourceKey, model } = tokens;
    const resolved = model ? getModelPricing(model) : null;
    if (!resolved) continue;
    const derived = deriveTokenCostUsd(resolved.pricing, tokens);
    let usd = derived.costUsd;
    if (tokens.unknown > 0) {
      usd += deriveTokenCostUsd(resolved.pricing, { input: tokens.unknown }).costUsd;
    }
    const existing = bySource.get(sourceKey);
    bySource.set(sourceKey, {
      bucketKey: existing?.bucketKey ?? bucketKey,
      usd: (existing?.usd ?? 0) + usd,
    });
  }
  return bySource;
}

async function sumDerivedCostEstimates(
  rawSince: Date
): Promise<{ totalUsd: number; eventCount: number }> {
  const rows = await querySqliteUsageAggregate<Array<{
    totalUsd: number | null;
    eventCount: number;
  }>>("derived", rawSince, undefined);
  return {
    totalUsd: Number(rows[0]?.totalUsd ?? 0),
    eventCount: Number(rows[0]?.eventCount ?? 0),
  };
}

// The dashboard portfolio panel polls this every 60s.  This short process-local
// memo dedupes back-to-back bounded scans, matching the accepted staleness of
// the budget-status SWR cache (also 60s).  Disabled
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

  // Serialize summaries with other summaries while allowing MTD budget scans
  // to use the second bounded SQLite reader.  The process-global reader pool
  // still caps native aggregate children across all aggregation families.
  return withExclusiveExternalUsageSummaryAggregation(async () => {
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
      const rawRowsByDay = await scanRawDailySpendByDay(rawSince, until);
      for (const [day, totalUsd] of rawRowsByDay) {
        byDay.set(day, (byDay.get(day) ?? 0) + totalUsd);
      }
    } catch {
      // Best-effort — the series degrades to whatever rollup data covers.
    }
  }

  return Array.from(byDay.entries())
    .map(([day, totalCostUsd]) => ({ day, totalCostUsd }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

async function scanRawDailySpendByDay(
  rawSince: Date,
  until: Date
): Promise<Map<string, number>> {
  const byDay = new Map<string, number>();
  const rows = await querySqliteUsageAggregate<Array<{
    day: string;
    totalUsd: number | null;
  }>>("daily", rawSince, until);
  for (const row of rows) {
    byDay.set(row.day, Number(row.totalUsd ?? 0));
  }
  return byDay;
}

/**
 * The raw side uses native SQLite groups on the read-only child and folds the
 * compact result into the same summary dimensions as the prior SQL groupBy.
 * A packed timestamp/id cursor preserves latest-non-null limit provenance
 * when timestamps tie.
 *
 * Receipt-cash rows keep their exact per-row identity validation: the raw
 * scan excludes the fixed-shape receipt candidate superset and candidates
 * are folded individually, so validated receipts land in receiptCashPaidUsd
 * and malformed receipt-shaped rows fall back to ordinary cost.
 */
async function scanRawUsageSummaryEvents(
  rawSince: Date,
  upperBound: Date,
  groups: Map<string, SummaryAccumulator>
): Promise<number> {
  const rows = await querySqliteUsageAggregate<Array<{
    packedLatest: string;
    sourceApp: string;
    environment: string | null;
    provider: string;
    service: string | null;
    label: string | null;
    projectId: string | null;
    metricType: string;
    unit: string | null;
    limit: number | null;
    limitWindow: string | null;
    eventCount: number;
    pricedEventCount: number;
    totalCostUsd: number | null;
    totalRequests: number | null;
    totalQuantity: number | null;
  }>>("summary", rawSince, upperBound);

  let eventCount = 0;
  for (const row of rows) {
    const separatorIndex = row.packedLatest.indexOf("\u0001");
    if (separatorIndex < 1) {
      throw new Error("SQLite summary aggregate returned an invalid latest cursor");
    }
    const latestAt = rawEventScanCursorFromRow({
      occurredAt: row.packedLatest.slice(0, separatorIndex),
      id: row.packedLatest.slice(separatorIndex + 1),
    }).occurredAt.toISOString();
    const isAnalytics = isSubscriptionAnalyticsTelemetry(row);
    const rowEventCount = Number(row.eventCount ?? 0);
    const pricedEventCount = Number(row.pricedEventCount ?? 0);
    eventCount += rowEventCount;
    addSummaryContribution(groups, {
      sourceApp: row.sourceApp,
      environment: row.environment,
      provider: row.provider,
      service: row.service,
      projectId: row.projectId,
      metricType: row.metricType,
      unit: row.unit,
      eventCount: rowEventCount,
      pricedEventCount: isAnalytics ? 0 : pricedEventCount,
      unpricedEventCount: isAnalytics ? 0 : rowEventCount - pricedEventCount,
      unclassifiedCostEventCount: 0,
      totalCostUsd: isAnalytics ? 0 : Number(row.totalCostUsd ?? 0),
      receiptCashPaidUsd: 0,
      estimatedApiEquivalentUsd: isAnalytics ? Number(row.totalCostUsd ?? 0) : 0,
      totalRequests: Number(row.totalRequests ?? 0),
      totalQuantity: Number(row.totalQuantity ?? 0),
      limit: row.limit,
      limitWindow: row.limitWindow,
      latestAt,
    });
  }
  return eventCount;
}

/**
 * Summarizes historical rollups plus native SQLite aggregates executed by a
 * bounded, read-only child process.
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

  // For rollups: the day-lt bound is the lesser of rawCutoff and the day after
  // `upperBound`, so a calendar-range query doesn't include rollup days beyond
  // the requested `to` date.
  const rollupDayLt = upperBound < rawCutoff
    ? new Date(Date.UTC(upperBound.getUTCFullYear(), upperBound.getUTCMonth(), upperBound.getUTCDate() + 1))
    : rawCutoff;
  // Run bounded native aggregates before entering the shared legacy-result
  // lease.  In particular, never hold the heap lease while waiting for a child
  // reader, or an MTD request queued behind this summary could not progress.
  const [scannedRawEventCount, derivedCostEstimates] = await Promise.all([
    scanRawUsageSummaryEvents(rawSince, upperBound, groups),
    // Flag-gated: default-off deployments skip the json_extract scan entirely.
    ingestCostDerivationEnabled()
      ? sumDerivedCostEstimates(rawSince)
      : Promise.resolve({ totalUsd: 0, eventCount: 0 }),
  ]);

  const loadLegacyMaterial = async () => {
    const [receiptCandidates, rollups] = await awaitAllSettledTuple([
      () => rawReceiptCashCandidates(rawSince, upperBound),
      () => since < rawCutoff
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
    ]);

    // Preserve the legacy fold order: native raw groups were folded above,
    // then validated receipt candidates, then historical rollups.
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
          isAnalytics || isReceiptCash || candidate.costUsd == null ? 0 : 1,
        unpricedEventCount:
          isAnalytics || isReceiptCash || candidate.costUsd != null ? 0 : 1,
        unclassifiedCostEventCount: 0,
        totalCostUsd:
          isAnalytics || isReceiptCash ? 0 : candidate.costUsd ?? 0,
        receiptCashPaidUsd: isReceiptCash ? candidate.costUsd ?? 0 : 0,
        estimatedApiEquivalentUsd: isAnalytics ? candidate.costUsd ?? 0 : 0,
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
        totalCostUsd: isAnalytics || isReceiptCash ? 0 : rollup.totalCostUsd,
        receiptCashPaidUsd: isReceiptCash ? rollup.totalCostUsd : 0,
        estimatedApiEquivalentUsd: isAnalytics ? rollup.totalCostUsd : 0,
        totalRequests: rollup.totalRequests,
        totalQuantity: rollup.totalQuantity,
        limit: rollup.maxLimit,
        limitWindow: rollup.limitWindow,
        latestAt: rollup.latestOccurredAt.toISOString(),
      });
    }

    return {
      rawEventCount: scannedRawEventCount + receiptCandidates.length,
      rollupEventCount: rollups.reduce((sum, rollup) => sum + rollup.eventCount, 0),
    };
  };
  const { rawEventCount, rollupEventCount } =
    await withExclusiveExternalUsageLegacyMaterialization(loadLegacyMaterial);

  const tokenRows = await loadAnalyticsTokenRows(rawSince, upperBound);
  const derivedBySource = deriveAnalyticsTokenUsdBySource(tokenRows);
  const sourcesWithReportedEstimate = new Set<string>();
  for (const group of groups.values()) {
    if (group.estimatedApiEquivalentUsd > 0) {
      sourcesWithReportedEstimate.add(
        analyticsEstimateSourceKey(group.provider, group.sourceApp)
      );
    }
  }
  const appliedDerived = new Set<string>();
  for (const group of groups.values()) {
    if (group.metricType !== "usage" || group.unit !== "token") continue;
    if (!shouldDeriveAnalyticsTokenEstimate(group)) continue;
    const sourceKey = analyticsEstimateSourceKey(group.provider, group.sourceApp);
    if (sourcesWithReportedEstimate.has(sourceKey)) continue;
    if (appliedDerived.has(sourceKey)) continue;
    const extra = derivedBySource.get(sourceKey)?.usd;
    if (extra && extra > 0) {
      group.estimatedApiEquivalentUsd += extra;
      appliedDerived.add(sourceKey);
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
    eventCount: rawEventCount + rollupEventCount,
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
  return withExclusiveExternalUsageLegacyMaterialization(async () => {
    const [rawGroups, rollups] = await awaitAllSettledTuple([
      () => prisma.externalUsageEvent.groupBy({
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
      () => monthStart < rawCutoff
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
  });
}

type ReceiptCashEventLikeWithCost = Parameters<typeof receiptCashProviderId>[0];

// MTD provider totals and project attribution share one raw+rollup scan and
// memo.  Keep each expensive family serialized while allowing one summary and
// one MTD compute to run concurrently.  The reader pool caps native children;
// the legacy lease separately serializes parent-process Prisma arrays through
// their fold.
const EXTERNAL_USAGE_AGGREGATION_LEASES_SYMBOL = Symbol.for(
  "usage-monitor.external-usage-aggregation-leases.v1"
);

type ExternalUsageAggregationFamily = "summary" | "mtd" | "legacy";
type ExternalUsageAggregationLeaseRegistry = Record<
  ExternalUsageAggregationFamily,
  Promise<void>
>;

function externalUsageAggregationLeaseRegistry(): ExternalUsageAggregationLeaseRegistry {
  const registry = globalThis as unknown as Record<symbol, unknown>;
  const current = registry[
    EXTERNAL_USAGE_AGGREGATION_LEASES_SYMBOL
  ] as ExternalUsageAggregationLeaseRegistry | undefined;
  if (current) return current;

  const leases: ExternalUsageAggregationLeaseRegistry = {
    summary: Promise.resolve(),
    mtd: Promise.resolve(),
    legacy: Promise.resolve(),
  };
  registry[EXTERNAL_USAGE_AGGREGATION_LEASES_SYMBOL] = leases;
  return leases;
}

async function withExclusiveExternalUsageAggregation<T>(
  family: ExternalUsageAggregationFamily,
  work: () => Promise<T>
): Promise<T> {
  const leases = externalUsageAggregationLeaseRegistry();
  const previous = leases[family];
  let release!: () => void;
  leases[family] = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

function withExclusiveExternalUsageSummaryAggregation<T>(
  work: () => Promise<T>
): Promise<T> {
  return withExclusiveExternalUsageAggregation("summary", work);
}

function withExclusiveExternalUsageMtdAggregation<T>(
  work: () => Promise<T>
): Promise<T> {
  return withExclusiveExternalUsageAggregation("mtd", work);
}

function withExclusiveExternalUsageLegacyMaterialization<T>(
  work: () => Promise<T>
): Promise<T> {
  return withExclusiveExternalUsageAggregation("legacy", work);
}

async function awaitAllSettledTuple<T extends readonly unknown[]>(
  operations: { [Index in keyof T]: () => PromiseLike<T[Index]> }
): Promise<T> {
  // Wait for all sibling fetches so an early rejection cannot release the
  // legacy lease while another Prisma result is still materializing.  Preserve
  // the first original rejection after every operation has settled.
  let firstError: unknown;
  let hasError = false;
  const results = await Promise.all(
    operations.map((operation) => {
      const reject = (error: unknown) => {
        if (!hasError) {
          hasError = true;
          firstError = error;
        }
        return { status: "rejected" as const };
      };
      try {
        return Promise.resolve(operation()).then(
          (value) => ({ status: "fulfilled" as const, value }),
          reject
        );
      } catch (error) {
        return Promise.resolve(reject(error));
      }
    })
  );
  if (hasError) throw firstError;
  return results.map((result) =>
    result.status === "fulfilled" ? result.value : undefined
  ) as unknown as T;
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
 * Return a narrow superset of possible raw receipt-cash rows.  Full identity
 * validation still happens through isReceiptCashEvent so a malformed
 * receipt-like row remains ordinary cost.
 *
 * The main aggregate excludes this fixed-shape superset without an id list,
 * then the caller adds every invalid candidate back individually.  That avoids
 * an unbounded SQLite `NOT IN (?, ...)` parameter list while excluding valid
 * receipts before SUM (so receipt subtraction cannot introduce float drift).
 * Receipt identity metadata stays out of the general raw event scan.
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
 * computeProjectBudgetStatus share the same ~11s scan within TTL.
 */
async function loadMonthToDateExternalCostMaterial(
  monthStart: Date,
  rawCutoff: Date,
  now: Date
): Promise<{
  byProvider: Map<string, ProviderPushedCost>;
  attribution: ExternalCostAttributionRow[];
}> {
  // Under vitest, skip the process memo so mocked scan sequences and
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

  return withExclusiveExternalUsageMtdAggregation(async () => {
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

interface MonthToDateRawGroup {
  provider: string;
  sourceApp: string;
  service: string | null;
  label: string | null;
  projectId: string | null;
  metricType: string;
  _sum: { costUsd: number | null };
  _count: { _all: number; costUsd: number };
}

/**
 * The raw half of the month-to-date external-cost aggregate: exactly the
 * rows the old single groupBy folded (same window, same status-metric
 * exclusion, same non-receipt-candidate complement), grouped by
 * (provider, sourceApp, service, label, projectId, metricType) with
 * SUM(costUsd) / COUNT(*) / COUNT(costUsd) — computed in a bounded-heap,
 * read-only child so the aggregate cannot stall the event loop.
 */
async function scanMonthToDateRawGroups(
  rawSince: Date,
  now: Date
): Promise<MonthToDateRawGroup[]> {
  const rows = await querySqliteUsageAggregate<Array<{
    provider: string;
    sourceApp: string;
    service: string | null;
    label: string | null;
    projectId: string | null;
    metricType: string;
    totalCostUsd: number | null;
    eventCount: number;
    pricedEventCount: number;
  }>>("mtd", rawSince, now);
  return rows.map((row) => ({
    provider: row.provider,
    sourceApp: row.sourceApp,
    service: row.service,
    label: row.label,
    projectId: row.projectId,
    metricType: row.metricType,
    _sum: { costUsd: row.pricedEventCount > 0 ? Number(row.totalCostUsd ?? 0) : null },
    _count: { _all: Number(row.eventCount), costUsd: Number(row.pricedEventCount) },
  }));
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

  const mtdScanStartedAt = performance.now();
  const rawGroups = await (async () => {
    try {
      // Wait for the bounded native aggregate before taking the shared legacy
      // result lease, so it cannot block a summary while holding that lease.
      return await scanMonthToDateRawGroups(rawSince, now);
    } catch (error) {
      logSlowScanTimingIfNeeded("[external-events-mtd-scan]", mtdScanStartedAt);
      throw error;
    }
  })();

  const byProvider = new Map<string, ProviderPushedCost>();
  const attributionMap = new Map<string, ExternalCostAttributionRow>();
  const reportedEstimateBySource = new Map<string, number>();

  const addProvider = (
    provider: string,
    sourceApp: string,
    service: string | null,
    label: string | null,
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
    if (isSubscriptionAnalyticsTelemetry({ sourceApp, service, provider, metricType, label })) {
      bucket.estimatedApiEquivalentUsd += cost;
      const sourceKey = analyticsEstimateSourceKey(provider, sourceApp);
      reportedEstimateBySource.set(
        sourceKey,
        (reportedEstimateBySource.get(sourceKey) ?? 0) + cost
      );
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
    label: string | null,
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
    if (isSubscriptionAnalyticsTelemetry({ sourceApp, service, provider, metricType, label })) return;
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
    addProvider(row.provider, row.sourceApp, row.service, row.label, row.metricType, cost, counts);
    addAttribution(
      row.provider,
      row.sourceApp,
      row.service,
      row.label,
      row.projectId,
      row.metricType,
      cost,
      counts
    );
  }
  await withExclusiveExternalUsageLegacyMaterialization(async () => {
    try {
      const [receiptCandidates, rollups] = await awaitAllSettledTuple([
        () => rawReceiptCashCandidates(rawSince, now),
        () => monthStart < rawCutoff
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

      // Preserve the old fold order: native raw groups, receipt candidates,
      // then historical rollups.  Do not retain either Prisma result array
      // beyond this shared heap-limited section.
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
          candidate.label,
          candidate.metricType,
          cost,
          counts
        );
        addAttribution(
          candidate.provider,
          candidate.sourceApp,
          candidate.service,
          candidate.label,
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
          rollup.label,
          rollup.metricType,
          rollup.totalCostUsd,
          counts
        );
        addAttribution(
          rollup.provider,
          rollup.sourceApp,
          rollup.service,
          rollup.label,
          rollup.projectId,
          rollup.metricType,
          rollup.totalCostUsd,
          counts
        );
      }
      logSlowScanTimingIfNeeded("[external-events-mtd-scan]", mtdScanStartedAt, {
        rawGroups: rawGroups.length,
        rollupRows: rollups.length,
      });
    } catch (error) {
      logSlowScanTimingIfNeeded("[external-events-mtd-scan]", mtdScanStartedAt);
      throw error;
    }
  });

  const tokenRows = await loadAnalyticsTokenRows(rawSince, now);
  const derivedBySource = deriveAnalyticsTokenUsdBySource(tokenRows);
  for (const [sourceKey, { bucketKey, usd: extra }] of derivedBySource) {
    if (!(extra > 0)) continue;
    if ((reportedEstimateBySource.get(sourceKey) ?? 0) > 0) continue;
    const bucket = byProvider.get(bucketKey) ?? emptyProviderPushedCost();
    bucket.estimatedApiEquivalentUsd += extra;
    byProvider.set(bucketKey, bucket);
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
