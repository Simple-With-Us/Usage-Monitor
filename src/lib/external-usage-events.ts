import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

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
}

export interface PersistExternalUsageEventsResult {
  attempted: number;
  persisted: number;
  skippedPrunedDuplicates: number;
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
  service: string | null;
  projectId: string | null;
  eventCount: number;
  totalCostUsd: number;
  totalRequests: number;
  totalQuantity: number;
  limit: number | null;
  limitWindow: string | null;
  latestAt: string;
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

function comparableEvent(event: ExternalUsageEventInput | ExistingExternalUsageEvent) {
  const value = event as ExternalUsageEventInput & ExistingExternalUsageEvent;
  const iso = (date: Date | undefined | null) => date?.toISOString() ?? null;
  return {
    sourceApp: value.sourceApp,
    environment: value.environment ?? null,
    provider: value.provider,
    service: value.service ?? null,
    projectId: value.projectId ?? null,
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
    metadata: stableJson(value.metadata ?? null),
  };
}

function sameEvent(
  left: ExternalUsageEventInput | ExistingExternalUsageEvent,
  right: ExternalUsageEventInput | ExistingExternalUsageEvent
): boolean {
  return stableJson(comparableEvent(left)) === stableJson(comparableEvent(right));
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
    if (prior && !sameEvent(prior, event)) {
      throw new ExternalUsageIdempotencyCollisionError(event.idempotencyKey);
    }
    if (!prior) uniqueByKey.set(event.idempotencyKey, event);
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
      if (!sameEvent(existing, event)) {
        throw new ExternalUsageIdempotencyCollisionError(event.idempotencyKey);
      }
      continue;
    }
    await tx.externalUsageEvent.create({ data: toCreateData(event) });
    newEvents.push(event);
  }

  return {
    attempted: events.length,
    persisted: activeEvents.length,
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
}): string {
  return [
    group.sourceApp,
    group.environment ?? "",
    group.provider,
    group.service ?? "",
    group.projectId ?? "",
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
  existing.totalCostUsd += group.totalCostUsd;
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
  const rawEvents: Array<{
    id: string;
    sourceApp: string;
    environment: string | null;
    provider: string;
    service: string | null;
    projectId: string | null;
    quantity: number | null;
    costUsd: number | null;
    requests: number | null;
    limit: number | null;
    limitWindow: string | null;
    occurredAt: Date;
  }> = [];
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
        projectId: true,
        quantity: true,
        costUsd: true,
        requests: true,
        limit: true,
        limitWindow: true,
        occurredAt: true,
      },
    });
    rawEvents.push(...page);
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
            projectId: true,
            eventCount: true,
            totalCostUsd: true,
            totalRequests: true,
            totalQuantity: true,
            maxLimit: true,
            limitWindow: true,
            latestOccurredAt: true,
          },
        })
      : [];

  for (const event of rawEvents) {
    mergeSummaryGroup(groups, {
      sourceApp: event.sourceApp,
      environment: event.environment,
      provider: event.provider,
      service: event.service,
      projectId: event.projectId,
      eventCount: 1,
      totalCostUsd: event.costUsd ?? 0,
      totalRequests: event.requests ?? 0,
      totalQuantity: event.quantity ?? 0,
      limit: event.limit,
      limitWindow: event.limitWindow,
      latestAt: event.occurredAt.toISOString(),
    });
  }

  for (const rollup of rollups) {
    mergeSummaryGroup(groups, {
      sourceApp: rollup.sourceApp,
      environment: rollup.environment,
      provider: rollup.provider,
      service: rollup.service,
      projectId: rollup.projectId,
      eventCount: rollup.eventCount,
      totalCostUsd: rollup.totalCostUsd,
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
      rawEvents.length + rollups.reduce((sum, rollup) => sum + rollup.eventCount, 0),
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
}

export async function sumMonthToDateExternalCostByProvider(
  monthStart: Date,
  rawCutoff: Date
): Promise<Map<string, ProviderPushedCost>> {
  const rawSince = monthStart > rawCutoff ? monthStart : rawCutoff;

  const [rawGroups, rollups] = await Promise.all([
    prisma.externalUsageEvent.groupBy({
      by: ["provider", "metricType"],
      where: { 
        occurredAt: { gte: rawSince }, 
        costUsd: { not: null },
        metricType: { notIn: Array.from(STATUS_METRIC_TYPES) }
      },
      _sum: { costUsd: true },
    }),
    monthStart < rawCutoff
      ? prisma.externalUsageEventDailyRollup.findMany({
          where: {
            day: { gte: monthStart, lt: rawCutoff },
            metricType: { notIn: Array.from(STATUS_METRIC_TYPES) },
          },
          select: {
            provider: true,
            metricType: true,
            totalCostUsd: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const totals = new Map<string, ProviderPushedCost>();
  const add = (provider: string, metricType: string, cost: number) => {
    const key = provider.toLowerCase();
    const bucket = totals.get(key) ?? { usagePushed: 0, subscriptionPushed: 0 };
    if (metricType === SUBSCRIPTION_METRIC_TYPE) {
      bucket.subscriptionPushed += cost;
    } else {
      bucket.usagePushed += cost;
    }
    totals.set(key, bucket);
  };

  for (const row of rawGroups) {
    add(row.provider, row.metricType, row._sum.costUsd ?? 0);
  }
  for (const rollup of rollups) {
    add(rollup.provider, rollup.metricType, rollup.totalCostUsd);
  }
  return totals;
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
  const rawSince = monthStart > rawCutoff ? monthStart : rawCutoff;

  const [rawGroups, rollups] = await Promise.all([
    prisma.externalUsageEvent.groupBy({
      by: ["provider", "sourceApp", "projectId", "metricType"],
      where: { 
        occurredAt: { gte: rawSince }, 
        costUsd: { not: null },
        metricType: { notIn: Array.from(STATUS_METRIC_TYPES) }
      },
      _sum: { costUsd: true },
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
            projectId: true,
            metricType: true,
            totalCostUsd: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const rows = new Map<string, ExternalCostAttributionRow>();
  const add = (
    provider: string,
    sourceApp: string,
    projectId: string | null,
    metricType: string,
    cost: number
  ) => {
    const key = `${provider.toLowerCase()}|${sourceApp.toLowerCase()}|${projectId ?? ""}|${metricType}`;
    const existing = rows.get(key);
    if (existing) {
      existing.costUsd += cost;
    } else {
      rows.set(key, { provider, sourceApp, projectId, metricType, costUsd: cost });
    }
  };

  for (const row of rawGroups) {
    add(row.provider, row.sourceApp, row.projectId, row.metricType, row._sum.costUsd ?? 0);
  }
  for (const rollup of rollups) {
    add(
      rollup.provider,
      rollup.sourceApp,
      rollup.projectId,
      rollup.metricType,
      rollup.totalCostUsd
    );
  }
  return Array.from(rows.values());
}

export async function syncStatusToUsageSnapshot(events: ExternalUsageEventInput[]): Promise<void> {
  const statusEvents = events.filter((e) => STATUS_METRIC_TYPES.has(e.metricType));
  if (statusEvents.length === 0) return;

  const providerNames = new Set(statusEvents.map((e) => e.provider.toLowerCase()));
  const allProviders = await prisma.provider.findMany({
    select: { id: true, name: true },
  });
  const providers = allProviders.filter((p) => providerNames.has(p.name.toLowerCase()));

  const providerIdByName = new Map(providers.map((p) => [p.name.toLowerCase(), p.id]));

  for (const event of statusEvents) {
    const providerId = providerIdByName.get(event.provider.toLowerCase());
    if (!providerId) continue;

    const data: Prisma.UsageSnapshotCreateInput = {
      provider: { connect: { id: providerId } },
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
