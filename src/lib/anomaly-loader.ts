import { prisma } from "@/lib/prisma";
import {
  type AnomalyConfig,
  type AnomalyResult,
  type SpendPoint,
  dailyIncrementsFromCumulative,
  detectSeriesAnomaly,
  resolveAnomalyConfig,
} from "@/lib/anomaly-detection";
import { loadMtdDailyVariableUsageByProviderId } from "@/lib/daily-usage-series";
import { isSubscriptionAnalyticsTelemetry } from "@/lib/external-usage-events";
import { resolveProviderIdentity } from "@/lib/provider-identity";
import { isReceiptCashEvent } from "@/lib/receipt-cash";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Per-provider cap on scanned scalar rows (S3: was one GLOBAL cap across all
// providers, so a single high-frequency poller silently starved every other
// provider's baseline). Keeps this memory-light on the hot budget path even
// for high-frequency pollers (only 4 scalar columns are selected — never the
// rawData blob that caused the #392 OOM).
const PER_PROVIDER_MAX_SNAPSHOT_ROWS = 20_000;
// Bound on the prior-month ExternalUsageEventDailyRollup scan (S5/S1a). Daily
// rollup rows are already aggregated per (day, groupKey), so this covers a
// very long tail of producers before truncating.
const MAX_ROLLUP_ROWS = 50_000;
const STATUS_METRIC_TYPES = ["quota_sync", "credit_balance"] as const;
const SUBSCRIPTION_METRIC_TYPE = "subscription";

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface SnapshotScalarRow {
  providerId: string;
  fetchedAt: Date;
  totalCost: number | null;
  totalRequests: number | null;
}

interface DayPeak {
  cost: number | null;
  requests: number | null;
}

interface PriorWindowRollupRow {
  day: Date;
  provider: string;
  projectId: string | null;
  sourceApp: string;
  service: string | null;
  label: string | null;
  metricType: string;
  billingMode: string;
  totalCostUsd: number;
}

/**
 * Prior-month daily variable-cost totals from ExternalUsageEventDailyRollup.
 *
 * S5: the push channel's anomaly baseline used to be MTD-only, so push-primary
 * providers could not anomaly-alert before ~day 9 of a month (minHistoryPoints
 * complete days had to accumulate first). Daily rollups survive raw-event
 * retention, so the trailing `windowDays` of the prior month are loaded from
 * ExternalUsageEventDailyRollup (read-only — the rollup pipeline itself lives
 * in data-retention.ts) and prepended to the MTD series, exactly like the
 * snapshot channel's cross-month window.
 *
 * The same filters as the MTD push-channel series apply: no status metrics,
 * no subscription charges, no prepaid receipt cash, no Claude Code
 * API-equivalent analytics estimates.
 *
 * Returns both per-provider (identity-resolved) and per-project daily totals
 * from ONE bounded scan so the provider and project loaders share it.
 */
async function loadPriorWindowDailyCost(input: {
  windowStart: Date;
  monthStart: Date;
  providers: readonly { id: string; name: string }[];
}): Promise<{
  byProviderId: Map<string, Map<string, number>>;
  byProjectId: Map<string, Map<string, number>>;
}> {
  const byProviderId = new Map<string, Map<string, number>>();
  const byProjectId = new Map<string, Map<string, number>>();

  const rows = (await prisma.externalUsageEventDailyRollup.findMany({
    where: {
      day: { gte: input.windowStart, lt: input.monthStart },
      metricType: { notIn: [...STATUS_METRIC_TYPES, SUBSCRIPTION_METRIC_TYPE] },
      totalCostUsd: { gt: 0 },
    },
    orderBy: { day: "asc" },
    take: MAX_ROLLUP_ROWS,
    select: {
      day: true,
      provider: true,
      projectId: true,
      sourceApp: true,
      service: true,
      label: true,
      metricType: true,
      billingMode: true,
      totalCostUsd: true,
    },
  })) as PriorWindowRollupRow[];

  if (rows.length === MAX_ROLLUP_ROWS) {
    console.warn(
      `[anomaly-loader] prior-month rollup baseline truncated at ${MAX_ROLLUP_ROWS} rows; ` +
        "some provider/project baselines may be incomplete"
    );
  }

  const identityCandidates = input.providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    identityPriority: 0,
  }));

  const addTo = (map: Map<string, Map<string, number>>, key: string, day: string, value: number) => {
    let days = map.get(key);
    if (!days) {
      days = new Map();
      map.set(key, days);
    }
    days.set(day, (days.get(day) ?? 0) + value);
  };

  for (const row of rows) {
    if (!(row.totalCostUsd > 0)) continue;
    if (isSubscriptionAnalyticsTelemetry(row)) continue;
    if (
      isReceiptCashEvent({
        sourceApp: row.sourceApp,
        service: row.service,
        label: row.label,
        metricType: row.metricType,
        billingMode: row.billingMode,
      })
    ) {
      continue;
    }
    const day = utcDayKey(row.day);
    if (row.projectId) {
      addTo(byProjectId, row.projectId, day, row.totalCostUsd);
    }
    const owner = resolveProviderIdentity(row.provider, identityCandidates);
    if (owner) {
      addTo(byProviderId, owner.id, day, row.totalCostUsd);
    }
  }

  return { byProviderId, byProjectId };
}

/**
 * S7: drop the CURRENT UTC day from a daily series before detection.
 *
 * The observed point used to be "today's peak-so-far" — a PARTIAL day compared
 * against full-day baselines. That causes false negatives just after midnight
 * (a continuing spike's tiny partial day looks calm) and can false-positive on
 * morning-heavy providers. Evaluating yesterday's COMPLETE day instead matches
 * the alert text ("on {day}") and is simpler; today's partial day stays in the
 * underlying data and becomes tomorrow's complete observed day.
 */
function withoutToday(series: readonly SpendPoint[], todayKey: string): SpendPoint[] {
  return series.filter((point) => point.day !== todayKey);
}

export interface LoadSpendAnomaliesOptions {
  /**
   * Test/ops knob for the per-provider snapshot scan cap
   * (PER_PROVIDER_MAX_SNAPSHOT_ROWS default).
   */
  maxSnapshotRowsPerProvider?: number;
}

/**
 * Build per-provider daily incremental cost & request series from raw poll
 * snapshots and run the detector on the latest COMPLETE day of each.
 *
 * Poll snapshots carry a CUMULATIVE month-to-date `totalCost` / `totalRequests`
 * sampled every refresh interval. We collapse them to one cumulative peak per
 * (provider, UTC day) and difference them into per-day increments (see
 * `dailyIncrementsFromCumulative`, which resets at month boundaries and clamps
 * corrections). The detector then compares the most recent complete day
 * against a robust baseline of the preceding days.
 *
 * Returns providerId → anomalies (cost and/or requests). Providers with too
 * little history simply produce no entry. Disabled config returns an empty map.
 */
export async function loadSpendAnomaliesByProviderId(
  now: Date = new Date(),
  config: AnomalyConfig = resolveAnomalyConfig(),
  /**
   * Optional already-loaded providers so budget-status does not pay a second
   * `provider.findMany` (cache-dedupe asserts a single call per compute).
   */
  knownProviders?: readonly { id: string; name: string }[],
  options?: LoadSpendAnomaliesOptions
): Promise<Map<string, AnomalyResult[]>> {
  const results = new Map<string, AnomalyResult[]>();
  if (!config.enabled) return results;

  // +2 days of slack: one so the earliest kept day still has a prior day to
  // diff against, one so "today" (dropped from the observed point, S7) still
  // leaves yesterday as a complete observed day on a full baseline.
  const windowStart = new Date(now.getTime() - (config.windowDays + 2) * MS_PER_DAY);

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const todayKey = utcDayKey(now);
  const maxSnapshotRowsPerProvider = Math.max(
    1,
    Math.trunc(options?.maxSnapshotRowsPerProvider ?? PER_PROVIDER_MAX_SNAPSHOT_ROWS)
  );

  const resolvedProviders = knownProviders
    ? [...knownProviders]
    : await prisma.provider.findMany({
        select: { id: true, name: true },
      });

  // S3: scan snapshots PER PROVIDER with a per-provider cap instead of one
  // global cap across the fleet. A provider moved to high-frequency polling
  // now truncates only its own baseline (loudly) instead of silently starving
  // every other provider. Sequential queries keep the single-connection
  // SQLite pool predictable on this hot path.
  const byProvider = new Map<string, Map<string, DayPeak>>();
  for (const provider of resolvedProviders) {
    const rows = (await prisma.usageSnapshot.findMany({
      where: { providerId: provider.id, fetchedAt: { gte: windowStart, lte: now } },
      orderBy: { fetchedAt: "desc" },
      take: maxSnapshotRowsPerProvider,
      select: {
        providerId: true,
        fetchedAt: true,
        totalCost: true,
        totalRequests: true,
      },
    })) as SnapshotScalarRow[];
    if (rows.length === maxSnapshotRowsPerProvider) {
      console.warn(
        `[anomaly-loader] snapshot baseline truncated for provider "${provider.name}" ` +
          `at ${maxSnapshotRowsPerProvider} rows; its anomaly baseline may be incomplete ` +
          "(consider a lower poll frequency or a larger window)"
      );
    }
    for (const row of rows) {
      const day = utcDayKey(row.fetchedAt);
      let days = byProvider.get(row.providerId);
      if (!days) {
        days = new Map();
        byProvider.set(row.providerId, days);
      }
      const peak = days.get(day) ?? { cost: null, requests: null };
      if (row.totalCost != null) peak.cost = Math.max(peak.cost ?? row.totalCost, row.totalCost);
      if (row.totalRequests != null) {
        peak.requests = Math.max(peak.requests ?? row.totalRequests, row.totalRequests);
      }
      days.set(day, peak);
    }
  }

  // Wave J / E11: push-primary providers have no useful snapshot series —
  // load MTD variable daily costs from ExternalUsageEvent as a second channel.
  // S5: plus the trailing windowDays of the PRIOR month from daily rollups so
  // the baseline crosses the month boundary like the snapshot channel.
  const [pushDailyByProviderId, priorWindow] = await Promise.all([
    loadMtdDailyVariableUsageByProviderId(monthStart, now, resolvedProviders),
    loadPriorWindowDailyCost({
      windowStart: new Date(monthStart.getTime() - config.windowDays * MS_PER_DAY),
      monthStart,
      providers: resolvedProviders,
    }),
  ]);

  for (const [providerId, days] of byProvider) {
    const dayKeys = [...days.keys()].sort();
    const anomalies: AnomalyResult[] = [];

    const costCumulative = dayKeys
      .filter((day) => day !== todayKey && days.get(day)?.cost != null)
      .map((day) => ({ day, cumulative: days.get(day)!.cost as number }));
    if (costCumulative.length >= 2) {
      const anomaly = detectSeriesAnomaly(
        dailyIncrementsFromCumulative(costCumulative),
        "cost",
        config
      );
      if (anomaly) anomalies.push({ ...anomaly, providerId });
    }

    const reqCumulative = dayKeys
      .filter((day) => day !== todayKey && days.get(day)?.requests != null)
      .map((day) => ({ day, cumulative: days.get(day)!.requests as number }));
    if (reqCumulative.length >= 2) {
      const anomaly = detectSeriesAnomaly(
        dailyIncrementsFromCumulative(reqCumulative),
        "requests",
        config
      );
      if (anomaly) anomalies.push({ ...anomaly, providerId });
    }

    if (anomalies.length > 0) results.set(providerId, anomalies);
  }

  // Push channel: attach cost anomalies for providers that only (or also)
  // report via ExternalUsageEvent. Skip when snapshot already produced a cost
  // anomaly for that provider id so we do not double-notify. Do not prefilter
  // on "two positive days" — cold zero/near-zero baselines are suppressed in
  // detectAnomaly via minPositiveBaselineDays (integration day-one B2 traffic).
  for (const [providerId, daily] of pushDailyByProviderId) {
    const series: SpendPoint[] = [];
    const priorDays = priorWindow.byProviderId.get(providerId);
    if (priorDays) {
      for (const day of [...priorDays.keys()].sort()) {
        series.push({ day, value: priorDays.get(day) as number });
      }
    }
    for (let i = 0; i < daily.length; i += 1) {
      series.push({
        day: utcDayKey(new Date(monthStart.getTime() + i * MS_PER_DAY)),
        value: daily[i] as number,
      });
    }
    // S7: evaluate the latest COMPLETE day, not today's partial day.
    const complete = withoutToday(series, todayKey);
    if (complete.length < 2) continue;
    const anomaly = detectSeriesAnomaly(complete, "cost", config);
    if (!anomaly) continue;
    const existing = results.get(providerId) ?? [];
    if (existing.some((a) => a.metric === "cost")) continue;
    existing.push({ ...anomaly, providerId });
    results.set(providerId, existing);
  }

  return results;
}

/**
 * S1a: per-project daily cost anomaly detection.
 *
 * Groups daily variable cost by ExternalUsageEvent.projectId (the first-class
 * project dimension set at ingest) for the current UTC month from raw events,
 * prepends the trailing `windowDays` of the prior month from daily rollups
 * (same cross-month baseline as the push channel), drops today's partial day
 * (S7), and runs the same MAD detector. Returns projectId → anomalies.
 *
 * Only directly projectId-tagged spend is covered: provider poll spend and the
 * legacy sourceApp-name fallback are provider-level data and have no per-day
 * per-project series, so they are intentionally out of scope here.
 */
export async function loadSpendAnomaliesByProjectId(
  now: Date = new Date(),
  config: AnomalyConfig = resolveAnomalyConfig(),
  knownProjects?: readonly { id: string; name: string }[]
): Promise<Map<string, AnomalyResult[]>> {
  const results = new Map<string, AnomalyResult[]>();
  if (!config.enabled) return results;

  const resolvedProjects = knownProjects
    ? [...knownProjects]
    : await prisma.project.findMany({ select: { id: true, name: true } });
  if (resolvedProjects.length === 0) return results;
  const projectIds = new Set(resolvedProjects.map((project) => project.id));

  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const todayKey = utcDayKey(now);
  const providers = await prisma.provider.findMany({
    select: { id: true, name: true },
  });

  const [rows, priorWindow] = await Promise.all([
    prisma.externalUsageEvent.findMany({
      where: {
        occurredAt: { gte: monthStart, lte: now },
        projectId: { not: null },
        costUsd: { not: null },
        metricType: { notIn: [...STATUS_METRIC_TYPES] },
      },
      orderBy: { occurredAt: "asc" },
      take: MAX_ROLLUP_ROWS,
      select: {
        projectId: true,
        sourceApp: true,
        service: true,
        label: true,
        metricType: true,
        billingMode: true,
        costUsd: true,
        occurredAt: true,
      },
    }),
    loadPriorWindowDailyCost({
      windowStart: new Date(monthStart.getTime() - config.windowDays * MS_PER_DAY),
      monthStart,
      providers,
    }),
  ]);
  if (rows.length === MAX_ROLLUP_ROWS) {
    console.warn(
      `[anomaly-loader] project MTD event scan truncated at ${MAX_ROLLUP_ROWS} rows; ` +
        "some project baselines may be incomplete"
    );
  }

  const byProjectId = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!row.projectId || !projectIds.has(row.projectId)) continue;
    if (row.costUsd == null || !(row.costUsd > 0)) continue;
    if (row.metricType === SUBSCRIPTION_METRIC_TYPE) continue;
    if (isSubscriptionAnalyticsTelemetry(row)) continue;
    if (
      isReceiptCashEvent({
        sourceApp: row.sourceApp,
        service: row.service,
        label: row.label,
        metricType: row.metricType,
        billingMode: row.billingMode,
      })
    ) {
      continue;
    }
    const day = utcDayKey(row.occurredAt);
    let days = byProjectId.get(row.projectId);
    if (!days) {
      days = new Map();
      byProjectId.set(row.projectId, days);
    }
    days.set(day, (days.get(day) ?? 0) + row.costUsd);
  }

  for (const project of resolvedProjects) {
    const series: SpendPoint[] = [];
    const priorDays = priorWindow.byProjectId.get(project.id);
    if (priorDays) {
      for (const day of [...priorDays.keys()].sort()) {
        series.push({ day, value: priorDays.get(day) as number });
      }
    }
    const mtdDays = byProjectId.get(project.id);
    if (mtdDays) {
      for (const day of [...mtdDays.keys()].sort()) {
        series.push({ day, value: mtdDays.get(day) as number });
      }
    }
    const complete = withoutToday(series, todayKey);
    if (complete.length < 2) continue;
    const anomaly = detectSeriesAnomaly(complete, "cost", config);
    if (!anomaly) continue;
    const existing = results.get(project.id) ?? [];
    existing.push({ ...anomaly, projectId: project.id });
    results.set(project.id, existing);
  }

  return results;
}
