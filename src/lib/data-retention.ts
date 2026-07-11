import crypto from "crypto";
import { prisma } from "@/lib/prisma";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_SNAPSHOT_RETENTION_DAYS = 45;
const DEFAULT_EXTERNAL_EVENT_RETENTION_DAYS = 90;
const DEFAULT_TOMBSTONE_RETENTION_DAYS = 180;
const DEFAULT_BATCH_SIZE = 1000;
const DEFAULT_RETENTION_INTERVAL_HOURS = 6;

interface UsageSnapshotRow {
  id: string;
  providerId: string;
  fetchedAt: Date;
  balance: number | null;
  totalCost: number | null;
  totalRequests: number | null;
  credits: number | null;
}

interface SnapshotRollupValues {
  providerId: string;
  day: Date;
  sampleCount: number;
  firstFetchedAt: Date;
  lastFetchedAt: Date;
  latestBalance: number | null;
  latestTotalCost: number | null;
  latestTotalRequests: number | null;
  latestCredits: number | null;
  minBalance: number | null;
  maxBalance: number | null;
  maxTotalCost: number | null;
  maxTotalRequests: number | null;
}

interface ExternalUsageEventRow {
  id: string;
  idempotencyKey: string;
  sourceApp: string;
  environment: string | null;
  provider: string;
  service: string | null;
  label: string | null;
  keyRef: string | null;
  billingMode: string;
  metricType: string;
  quantity: number | null;
  unit: string | null;
  costUsd: number | null;
  requests: number | null;
  credits: number | null;
  limit: number | null;
  limitWindow: string | null;
  tier: string | null;
  confidence: string;
  projectId: string | null;
  occurredAt: Date;
}

interface ExternalRollupValues {
  day: Date;
  groupKey: string;
  sourceApp: string;
  environment: string | null;
  provider: string;
  service: string | null;
  label: string | null;
  keyRef: string | null;
  billingMode: string;
  metricType: string;
  unit: string | null;
  limitWindow: string | null;
  tier: string | null;
  confidence: string;
  projectId: string | null;
  eventCount: number;
  totalCostUsd: number;
  totalRequests: number;
  totalQuantity: number;
  totalCredits: number;
  maxLimit: number | null;
  latestOccurredAt: Date;
}

export interface DataRetentionTableResult {
  scanned: number;
  pruned: number;
  rollupsTouched: number;
}

export interface DataRetentionResult {
  startedAt: string;
  finishedAt: string;
  snapshotRetentionDays: number;
  externalEventRetentionDays: number;
  tombstoneRetentionDays: number;
  usageSnapshots: DataRetentionTableResult;
  externalUsageEvents: DataRetentionTableResult & { tombstonesWritten: number };
  tombstonesPruned: number;
  compacted: boolean;
  compactionError?: string;
}

export interface ScheduledRetentionSkipped {
  skipped: true;
  reason: "in_flight" | "interval";
}

function readPositiveIntEnv(names: string[], fallback: number, min = 1, max = 100_000): number {
  for (const name of names) {
    const raw = process.env[name]?.trim();
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.min(Math.max(Math.trunc(parsed), min), max);
    }
  }
  return fallback;
}

function retentionCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * MS_PER_DAY);
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function monthStartUtc(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function getSnapshotRawCutoff(now = new Date()): Date {
  const days = readPositiveIntEnv(
    ["USAGE_SNAPSHOT_RAW_RETENTION_DAYS", "USAGE_SNAPSHOT_RETENTION_DAYS"],
    DEFAULT_SNAPSHOT_RETENTION_DAYS
  );
  return retentionCutoff(now, days);
}

export function getExternalEventRawCutoff(now = new Date()): Date {
  const days = readPositiveIntEnv(
    ["EXTERNAL_USAGE_EVENT_RAW_RETENTION_DAYS", "EXTERNAL_USAGE_EVENT_RETENTION_DAYS"],
    DEFAULT_EXTERNAL_EVENT_RETENTION_DAYS
  );
  const cutoff = retentionCutoff(now, days);
  const currentMonth = monthStartUtc(now);
  return cutoff < currentMonth ? cutoff : currentMonth;
}

function minDate(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

function maxDate(left: Date, right: Date): Date {
  return left.getTime() >= right.getTime() ? left : right;
}

function minNullable(left: number | null, right: number | null): number | null {
  if (left == null) return right;
  if (right == null) return left;
  return Math.min(left, right);
}

function maxNullable(left: number | null, right: number | null): number | null {
  if (left == null) return right;
  if (right == null) return left;
  return Math.max(left, right);
}

function shouldRunVacuum(): boolean {
  const raw = process.env.DATA_RETENTION_DISABLE_VACUUM?.trim().toLowerCase();
  return raw !== "1" && raw !== "true" && raw !== "yes";
}

function groupHash(parts: Array<string | null>): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(parts.map((part) => part ?? "")))
    .digest("hex");
}

function applySnapshotRow(group: SnapshotRollupValues, row: UsageSnapshotRow): void {
  group.sampleCount += 1;
  group.firstFetchedAt = minDate(group.firstFetchedAt, row.fetchedAt);
  if (row.fetchedAt.getTime() >= group.lastFetchedAt.getTime()) {
    group.lastFetchedAt = row.fetchedAt;
    group.latestBalance = row.balance;
    group.latestTotalCost = row.totalCost;
    group.latestTotalRequests = row.totalRequests;
    group.latestCredits = row.credits;
  }
  group.minBalance = minNullable(group.minBalance, row.balance);
  group.maxBalance = maxNullable(group.maxBalance, row.balance);
  group.maxTotalCost = maxNullable(group.maxTotalCost, row.totalCost);
  group.maxTotalRequests = maxNullable(group.maxTotalRequests, row.totalRequests);
}

function groupSnapshotRows(rows: UsageSnapshotRow[]): SnapshotRollupValues[] {
  const groups = new Map<string, SnapshotRollupValues>();
  for (const row of rows) {
    const day = startOfUtcDay(row.fetchedAt);
    const key = `${row.providerId}:${day.toISOString()}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        providerId: row.providerId,
        day,
        sampleCount: 0,
        firstFetchedAt: row.fetchedAt,
        lastFetchedAt: row.fetchedAt,
        latestBalance: null,
        latestTotalCost: null,
        latestTotalRequests: null,
        latestCredits: null,
        minBalance: null,
        maxBalance: null,
        maxTotalCost: null,
        maxTotalRequests: null,
      };
      groups.set(key, group);
    }
    applySnapshotRow(group, row);
  }
  return Array.from(groups.values());
}

function mergeSnapshotRollup(
  existing: SnapshotRollupValues | null,
  incoming: SnapshotRollupValues
): SnapshotRollupValues {
  if (!existing) return incoming;
  const incomingIsLatest =
    incoming.lastFetchedAt.getTime() >= existing.lastFetchedAt.getTime();
  return {
    providerId: incoming.providerId,
    day: incoming.day,
    sampleCount: existing.sampleCount + incoming.sampleCount,
    firstFetchedAt: minDate(existing.firstFetchedAt, incoming.firstFetchedAt),
    lastFetchedAt: maxDate(existing.lastFetchedAt, incoming.lastFetchedAt),
    latestBalance: incomingIsLatest ? incoming.latestBalance : existing.latestBalance,
    latestTotalCost: incomingIsLatest ? incoming.latestTotalCost : existing.latestTotalCost,
    latestTotalRequests: incomingIsLatest
      ? incoming.latestTotalRequests
      : existing.latestTotalRequests,
    latestCredits: incomingIsLatest ? incoming.latestCredits : existing.latestCredits,
    minBalance: minNullable(existing.minBalance, incoming.minBalance),
    maxBalance: maxNullable(existing.maxBalance, incoming.maxBalance),
    maxTotalCost: maxNullable(existing.maxTotalCost, incoming.maxTotalCost),
    maxTotalRequests: maxNullable(existing.maxTotalRequests, incoming.maxTotalRequests),
  };
}

function externalGroupKey(row: ExternalUsageEventRow): string {
  return groupHash([
    row.sourceApp,
    row.environment,
    row.provider,
    row.service,
    row.label,
    row.keyRef,
    row.billingMode,
    row.metricType,
    row.unit,
    row.limitWindow,
    row.tier,
    row.confidence,
    // projectId joins the rollup identity so per-project cost never merges
    // across projects. NOTE: appending a dimension changes every group's hash,
    // so rollup rows written before this shipped won't merge with new ones — a
    // one-time reindex, acceptable because per-project attribution is new.
    row.projectId,
  ]);
}

function applyExternalRow(group: ExternalRollupValues, row: ExternalUsageEventRow): void {
  group.eventCount += 1;
  const isStatus = row.metricType === "quota_sync" || row.metricType === "credit_balance";
  
  if (!isStatus) {
    group.totalCostUsd += row.costUsd ?? 0;
    group.totalRequests += row.requests ?? 0;
    group.totalQuantity += row.quantity ?? 0;
    group.totalCredits += row.credits ?? 0;
  } else {
    // For status metrics, just take the latest value seen as the "total" for display purposes
    if (row.occurredAt.getTime() >= group.latestOccurredAt.getTime()) {
      group.totalCostUsd = row.costUsd ?? 0;
      group.totalRequests = row.requests ?? 0;
      group.totalQuantity = row.quantity ?? 0;
      group.totalCredits = row.credits ?? 0;
    }
  }
  
  group.maxLimit = maxNullable(group.maxLimit, row.limit);
  group.latestOccurredAt = maxDate(group.latestOccurredAt, row.occurredAt);
}

function groupExternalRows(rows: ExternalUsageEventRow[]): ExternalRollupValues[] {
  const groups = new Map<string, ExternalRollupValues>();
  for (const row of rows) {
    const day = startOfUtcDay(row.occurredAt);
    const groupKey = externalGroupKey(row);
    const key = `${day.toISOString()}:${groupKey}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        day,
        groupKey,
        sourceApp: row.sourceApp,
        environment: row.environment,
        provider: row.provider,
        service: row.service,
        label: row.label,
        keyRef: row.keyRef,
        billingMode: row.billingMode,
        metricType: row.metricType,
        unit: row.unit,
        limitWindow: row.limitWindow,
        tier: row.tier,
        confidence: row.confidence,
        projectId: row.projectId,
        eventCount: 0,
        totalCostUsd: 0,
        totalRequests: 0,
        totalQuantity: 0,
        totalCredits: 0,
        maxLimit: null,
        latestOccurredAt: row.occurredAt,
      };
      groups.set(key, group);
    }
    applyExternalRow(group, row);
  }
  return Array.from(groups.values());
}

function mergeExternalRollup(
  existing: ExternalRollupValues | null,
  incoming: ExternalRollupValues
): ExternalRollupValues {
  if (!existing) return incoming;
  const isStatus = incoming.metricType === "quota_sync" || incoming.metricType === "credit_balance";
  const incomingIsLatest = incoming.latestOccurredAt.getTime() >= existing.latestOccurredAt.getTime();
  
  return {
    ...incoming,
    eventCount: existing.eventCount + incoming.eventCount,
    totalCostUsd: isStatus ? (incomingIsLatest ? incoming.totalCostUsd : existing.totalCostUsd) : existing.totalCostUsd + incoming.totalCostUsd,
    totalRequests: isStatus ? (incomingIsLatest ? incoming.totalRequests : existing.totalRequests) : existing.totalRequests + incoming.totalRequests,
    totalQuantity: isStatus ? (incomingIsLatest ? incoming.totalQuantity : existing.totalQuantity) : existing.totalQuantity + incoming.totalQuantity,
    totalCredits: isStatus ? (incomingIsLatest ? incoming.totalCredits : existing.totalCredits) : existing.totalCredits + incoming.totalCredits,
    maxLimit: maxNullable(existing.maxLimit, incoming.maxLimit),
    latestOccurredAt: maxDate(existing.latestOccurredAt, incoming.latestOccurredAt),
  };
}

async function latestSnapshotIdsByProvider(): Promise<Set<string>> {
  const providers = await prisma.provider.findMany({
    select: {
      snapshots: {
        orderBy: { fetchedAt: "desc" },
        take: 1,
        select: { id: true },
      },
    },
  });
  return new Set(providers.flatMap((provider) => provider.snapshots.map((snapshot) => snapshot.id)));
}

async function pruneUsageSnapshots(
  cutoff: Date,
  batchSize: number,
  preserveSnapshotIds: Set<string>
): Promise<DataRetentionTableResult> {
  const result: DataRetentionTableResult = { scanned: 0, pruned: 0, rollupsTouched: 0 };

  while (true) {
    const rows = await prisma.usageSnapshot.findMany({
      where: {
        fetchedAt: { lt: cutoff },
        ...(preserveSnapshotIds.size > 0 ? { id: { notIn: Array.from(preserveSnapshotIds) } } : {}),
      },
      orderBy: { fetchedAt: "asc" },
      take: batchSize,
      select: {
        id: true,
        providerId: true,
        fetchedAt: true,
        balance: true,
        totalCost: true,
        totalRequests: true,
        credits: true,
      },
    });
    if (rows.length === 0) break;

    const groups = groupSnapshotRows(rows);
    const ids = rows.map((row) => row.id);
    await prisma.$transaction(async (tx) => {
      for (const group of groups) {
        const existing = await tx.usageSnapshotDailyRollup.findUnique({
          where: { providerId_day: { providerId: group.providerId, day: group.day } },
          select: {
            providerId: true,
            day: true,
            sampleCount: true,
            firstFetchedAt: true,
            lastFetchedAt: true,
            latestBalance: true,
            latestTotalCost: true,
            latestTotalRequests: true,
            latestCredits: true,
            minBalance: true,
            maxBalance: true,
            maxTotalCost: true,
            maxTotalRequests: true,
          },
        });
        const merged = mergeSnapshotRollup(existing, group);
        await tx.usageSnapshotDailyRollup.upsert({
          where: { providerId_day: { providerId: group.providerId, day: group.day } },
          create: merged,
          update: {
            sampleCount: merged.sampleCount,
            firstFetchedAt: merged.firstFetchedAt,
            lastFetchedAt: merged.lastFetchedAt,
            latestBalance: merged.latestBalance,
            latestTotalCost: merged.latestTotalCost,
            latestTotalRequests: merged.latestTotalRequests,
            latestCredits: merged.latestCredits,
            minBalance: merged.minBalance,
            maxBalance: merged.maxBalance,
            maxTotalCost: merged.maxTotalCost,
            maxTotalRequests: merged.maxTotalRequests,
          },
        });
      }
      await tx.usageSnapshot.deleteMany({ where: { id: { in: ids } } });
    });

    result.scanned += rows.length;
    result.pruned += rows.length;
    result.rollupsTouched += groups.length;
    if (rows.length < batchSize) break;
  }
  return result;
}

async function pruneExternalUsageEvents(
  cutoff: Date,
  batchSize: number
): Promise<DataRetentionTableResult & { tombstonesWritten: number }> {
  const result = { scanned: 0, pruned: 0, rollupsTouched: 0, tombstonesWritten: 0 };

  while (true) {
    // Selection and grouping must share the write transaction with rollup and
    // deletion. Ingest retries can backfill a previously-null projectId; if
    // selection happened before this transaction, retention could aggregate
    // the old attribution and then delete the newly-attributed raw row.
    const batch = await prisma.$transaction(async (tx) => {
      const rows = await tx.externalUsageEvent.findMany({
        where: { occurredAt: { lt: cutoff } },
        orderBy: { occurredAt: "asc" },
        take: batchSize,
        select: {
          id: true,
          idempotencyKey: true,
          sourceApp: true,
          environment: true,
          provider: true,
          service: true,
          label: true,
          keyRef: true,
          billingMode: true,
          metricType: true,
          quantity: true,
          unit: true,
          costUsd: true,
          requests: true,
          credits: true,
          limit: true,
          limitWindow: true,
          tier: true,
          confidence: true,
          projectId: true,
          occurredAt: true,
        },
      });
      if (rows.length === 0) {
        return { scanned: 0, pruned: 0, rollupsTouched: 0, tombstonesWritten: 0 };
      }

      const groups = groupExternalRows(rows);
      const ids = rows.map((row) => row.id);
      const prunedAt = new Date();
      for (const group of groups) {
        const existing = await tx.externalUsageEventDailyRollup.findUnique({
          where: { day_groupKey: { day: group.day, groupKey: group.groupKey } },
          select: {
            day: true,
            groupKey: true,
            sourceApp: true,
            environment: true,
            provider: true,
            service: true,
            label: true,
            keyRef: true,
            billingMode: true,
            metricType: true,
            unit: true,
            limitWindow: true,
            tier: true,
            confidence: true,
            projectId: true,
            eventCount: true,
            totalCostUsd: true,
            totalRequests: true,
            totalQuantity: true,
            totalCredits: true,
            maxLimit: true,
            latestOccurredAt: true,
          },
        });
        const merged = mergeExternalRollup(existing, group);
        await tx.externalUsageEventDailyRollup.upsert({
          where: { day_groupKey: { day: group.day, groupKey: group.groupKey } },
          create: merged,
          update: {
            eventCount: merged.eventCount,
            totalCostUsd: merged.totalCostUsd,
            totalRequests: merged.totalRequests,
            totalQuantity: merged.totalQuantity,
            totalCredits: merged.totalCredits,
            maxLimit: merged.maxLimit,
            latestOccurredAt: merged.latestOccurredAt,
          },
        });
      }

      for (const row of rows) {
        await tx.externalUsageEventTombstone.upsert({
          where: { idempotencyKey: row.idempotencyKey },
          create: { idempotencyKey: row.idempotencyKey, occurredAt: row.occurredAt, prunedAt },
          update: {},
        });
      }
      await tx.externalUsageEvent.deleteMany({ where: { id: { in: ids } } });
      return {
        scanned: rows.length,
        pruned: rows.length,
        rollupsTouched: groups.length,
        tombstonesWritten: rows.length,
      };
    }, { timeout: 30_000 });

    if (batch.scanned === 0) break;

    result.scanned += batch.scanned;
    result.pruned += batch.pruned;
    result.rollupsTouched += batch.rollupsTouched;
    result.tombstonesWritten += batch.tombstonesWritten;
    if (batch.scanned < batchSize) break;
  }
  return result;
}

export async function runDataRetentionMaintenance(now = new Date()): Promise<DataRetentionResult> {
  const startedAt = new Date();
  const snapshotRetentionDays = readPositiveIntEnv(
    ["USAGE_SNAPSHOT_RAW_RETENTION_DAYS", "USAGE_SNAPSHOT_RETENTION_DAYS"],
    DEFAULT_SNAPSHOT_RETENTION_DAYS
  );
  const externalEventRetentionDays = readPositiveIntEnv(
    ["EXTERNAL_USAGE_EVENT_RAW_RETENTION_DAYS", "EXTERNAL_USAGE_EVENT_RETENTION_DAYS"],
    DEFAULT_EXTERNAL_EVENT_RETENTION_DAYS
  );
  const tombstoneRetentionDays = readPositiveIntEnv(
    ["EXTERNAL_USAGE_EVENT_TOMBSTONE_RETENTION_DAYS", "USAGE_EVENT_TOMBSTONE_RETENTION_DAYS"],
    DEFAULT_TOMBSTONE_RETENTION_DAYS
  );
  const batchSize = readPositiveIntEnv(["DATA_RETENTION_BATCH_SIZE"], DEFAULT_BATCH_SIZE, 100, 10_000);

  const usageSnapshots = await pruneUsageSnapshots(
    getSnapshotRawCutoff(now),
    batchSize,
    await latestSnapshotIdsByProvider()
  );
  const externalUsageEvents = await pruneExternalUsageEvents(
    getExternalEventRawCutoff(now),
    batchSize
  );

  // Tombstones are the only durable proof that an already-rolled-up event was
  // consumed. Expiring one permits an arbitrarily late producer retry to be
  // inserted as a raw row and counted a second time. Keep them permanently;
  // the legacy retention setting remains in the result for API compatibility.
  const tombstonesPruned = 0;

  // OtlpMetricState is intentionally not age-pruned either. OTLP cumulative
  // sums have no end-of-series signal; an exporter can resume an old series,
  // and losing its checkpoint would make the next cumulative total look like
  // a fresh delta. Cleanup is unsafe without an additional durable baseline.
  const prunedRows = usageSnapshots.pruned + externalUsageEvents.pruned;
  let compacted = false;
  let compactionError: string | undefined;
  if (prunedRows > 0 && shouldRunVacuum()) {
    try {
      await prisma.$executeRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)");
      await prisma.$executeRawUnsafe("VACUUM");
      compacted = true;
    } catch (error) {
      compactionError = error instanceof Error ? error.message : "SQLite compaction failed";
    }
  }

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    snapshotRetentionDays,
    externalEventRetentionDays,
    tombstoneRetentionDays,
    usageSnapshots,
    externalUsageEvents,
    tombstonesPruned,
    compacted,
    compactionError,
  };
}

let scheduledRetentionInFlight: Promise<DataRetentionResult> | null = null;
let lastScheduledRetentionStartedAt = 0;

export async function runScheduledDataRetentionMaintenance(
  now = new Date()
): Promise<DataRetentionResult | ScheduledRetentionSkipped> {
  if (scheduledRetentionInFlight) {
    return { skipped: true, reason: "in_flight" };
  }

  const intervalHours = readPositiveIntEnv(
    ["DATA_RETENTION_INTERVAL_HOURS"],
    DEFAULT_RETENTION_INTERVAL_HOURS
  );
  const intervalMs = intervalHours * 60 * 60 * 1000;
  if (lastScheduledRetentionStartedAt && now.getTime() - lastScheduledRetentionStartedAt < intervalMs) {
    return { skipped: true, reason: "interval" };
  }

  lastScheduledRetentionStartedAt = now.getTime();
  scheduledRetentionInFlight = runDataRetentionMaintenance(now);
  try {
    return await scheduledRetentionInFlight;
  } finally {
    scheduledRetentionInFlight = null;
  }
}
