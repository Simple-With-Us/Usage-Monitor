import { prisma } from "@/lib/prisma";
import { isSubscriptionAnalyticsTelemetry } from "@/lib/external-usage-events";
import { isReceiptCashEvent } from "@/lib/receipt-cash";
import { resolveProviderIdentity } from "@/lib/provider-identity";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Bound memory on the hot budget path (scalar fields only). */
const MAX_EVENT_ROWS = 50_000;
const STATUS_METRIC_TYPES = ["quota_sync", "credit_balance"] as const;
const SUBSCRIPTION_METRIC_TYPE = "subscription";

function utcDayIndex(date: Date, monthStart: Date): number {
  return Math.floor((date.getTime() - monthStart.getTime()) / MS_PER_DAY);
}

export type DailySeriesProviderIdentity = {
  id: string;
  name: string;
  identityPriority?: number;
};

/**
 * Wave J / E11: month-to-date *variable usage* daily series keyed by
 * **provider id**, using the same `resolveProviderIdentity` ownership as
 * budget-status pushed-cost attribution (exact name before alias).
 *
 * Excludes subscription charges, prepaid receipt cash, subscription-seat
 * API-equivalent estimates, and status metrics.
 *
 * Returns dense arrays from day 1 of the UTC month through `now`'s UTC day
 * (missing days are 0) so `forecastMonthlyUsageFromSeries` can fit a trend.
 */
export async function loadMtdDailyVariableUsageByProviderId(
  monthStart: Date,
  now: Date,
  providers: readonly DailySeriesProviderIdentity[],
  options?: { maxRows?: number }
): Promise<Map<string, number[]>> {
  const dayCount = Math.max(1, utcDayIndex(now, monthStart) + 1);
  const maxRows = Math.min(
    Math.max(options?.maxRows ?? MAX_EVENT_ROWS, 1_000),
    100_000
  );
  if (providers.length === 0) return new Map();

  const rows = await prisma.externalUsageEvent.findMany({
    where: {
      occurredAt: { gte: monthStart, lte: now },
      costUsd: { not: null },
      metricType: { notIn: [...STATUS_METRIC_TYPES] },
    },
    select: {
      provider: true,
      sourceApp: true,
      service: true,
      label: true,
      metricType: true,
      billingMode: true,
      // Receipt identity needs the FULL marker set (keyRef + unit +
      // confidence + idempotencyKey) — passing only sourceApp/service/label
      // to isReceiptCashEvent can never match and silently leaked prepaid
      // receipt deposits into the "variable usage" daily series, inflating
      // trend forecasts after every top-up (S2 regression class).
      keyRef: true,
      unit: true,
      confidence: true,
      idempotencyKey: true,
      costUsd: true,
      occurredAt: true,
    },
    orderBy: { occurredAt: "asc" },
    take: maxRows,
  });

  const identityCandidates = providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    identityPriority: provider.identityPriority ?? 0,
  }));

  const byProviderId = new Map<string, number[]>();

  for (const row of rows) {
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
        keyRef: row.keyRef,
        unit: row.unit,
        confidence: row.confidence,
        idempotencyKey: row.idempotencyKey,
      })
    ) {
      continue;
    }

    const owner = resolveProviderIdentity(row.provider, identityCandidates);
    if (!owner) continue;

    const day = utcDayIndex(row.occurredAt, monthStart);
    if (day < 0 || day >= dayCount) continue;

    let series = byProviderId.get(owner.id);
    if (!series) {
      series = Array.from({ length: dayCount }, () => 0);
      byProviderId.set(owner.id, series);
    }
    series[day] = (series[day] ?? 0) + row.costUsd;
  }

  return byProviderId;
}

/**
 * Input sample for buildSnapshotVariableDayPeaks — scalar-only (never the
 * rawData blob, see the #392 OOM notes in budget-status.ts).
 */
export interface SnapshotVariableCostSample {
  providerId: string;
  fetchedAt: Date;
  totalCost: number | null;
  fixedCostIncludedUsd: number | null;
}

/**
 * Collapse cumulative MTD poll snapshots into one VARIABLE-cost peak per
 * (providerId, UTC day) — the input shape `dailyIncrementsFromSnapshotPeaks`
 * diffs into a daily incremental series for trend-aware EOM forecasting
 * (S4). Variable = totalCost minus the fixed-cost portion the adapter
 * declared (clamped the same way budget-status clamps it), so subscription
 * / fixed fees never leak into the usage trend.
 */
export function buildSnapshotVariableDayPeaks(
  rows: readonly SnapshotVariableCostSample[]
): Map<string, Map<string, number>> {
  const byProvider = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (row.totalCost == null) continue;
    const fixed = Math.max(
      0,
      Math.min(row.fixedCostIncludedUsd ?? 0, row.totalCost)
    );
    const variable = Math.max(0, row.totalCost - fixed);
    const dayKey = row.fetchedAt.toISOString().slice(0, 10);
    let days = byProvider.get(row.providerId);
    if (!days) {
      days = new Map();
      byProvider.set(row.providerId, days);
    }
    days.set(dayKey, Math.max(days.get(dayKey) ?? 0, variable));
  }
  return byProvider;
}

/**
 * Build a dense day-1..today series from cumulative poll-snapshot peaks
 * (same peak-per-day + difference approach as anomaly-loader).
 */
export function dailyIncrementsFromSnapshotPeaks(
  dayPeaks: ReadonlyMap<string, number>,
  monthStart: Date,
  now: Date
): number[] {
  const dayCount = Math.max(1, utcDayIndex(now, monthStart) + 1);
  const cumulative: number[] = Array.from({ length: dayCount }, () => 0);
  for (const [dayKey, peak] of dayPeaks) {
    const dayDate = new Date(`${dayKey}T00:00:00.000Z`);
    if (Number.isNaN(dayDate.getTime())) continue;
    const idx = utcDayIndex(dayDate, monthStart);
    if (idx < 0 || idx >= dayCount) continue;
    cumulative[idx] = Math.max(cumulative[idx] ?? 0, peak);
  }
  // Forward-fill cumulative peaks within the month (polls may skip days).
  for (let i = 1; i < dayCount; i++) {
    cumulative[i] = Math.max(cumulative[i] ?? 0, cumulative[i - 1] ?? 0);
  }
  const increments = Array.from({ length: dayCount }, () => 0);
  for (let i = 0; i < dayCount; i++) {
    const prev = i === 0 ? 0 : (cumulative[i - 1] ?? 0);
    const curr = cumulative[i] ?? 0;
    // Month-to-date totals can drop on correction; clamp to zero for forecast.
    increments[i] = Math.max(0, curr - prev);
  }
  return increments;
}

/** Element-wise max of two same-length daily series (or the non-null one). */
export function maxDailySeries(
  a: readonly number[] | null | undefined,
  b: readonly number[] | null | undefined
): number[] | null {
  if ((!a || a.length === 0) && (!b || b.length === 0)) return null;
  if (!a || a.length === 0) return [...(b as number[])];
  if (!b || b.length === 0) return [...a];
  const len = Math.max(a.length, b.length);
  const out = Array.from({ length: len }, () => 0);
  for (let i = 0; i < len; i++) {
    out[i] = Math.max(a[i] ?? 0, b[i] ?? 0);
  }
  return out;
}
