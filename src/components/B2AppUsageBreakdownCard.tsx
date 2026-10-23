"use client";

import { useEffect, useMemo, useState } from "react";
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Database } from "lucide-react";
import type {
  B2AppUsageBreakdownPayload,
  B2AppId,
  B2AppUsageDailyPoint,
  B2AppUsageSlice,
} from "@/lib/b2-app-usage-types";

type ChartMode = "storage" | "download" | "classC";
type ChartView = "daily" | "donut" | "bar";
type DailyMetric = "download" | "classC";

const COLORS = ["#0ea5e9", "#8b5cf6", "#14b8a6", "#f59e0b", "#94a3b8"];

/**
 * The daily stacked bars reuse the quota-bar palette from `QuotaUsageBar`
 * (FleetQuotaMatrixCard): the used portion is red, the headroom left under
 * the daily free cap is emerald.  Every app gets its own red-family shade so
 * a day reads as a stack of apps instead of one anonymous blob.
 */
export const DAILY_SEGMENT_CLASSES = [
  "bg-red-500",
  "bg-red-600",
  "bg-red-700",
  "bg-red-400",
  "bg-red-800",
];

/** Headroom left under the cap — same emerald as `QuotaUsageBar`. */
export const DAILY_REMAINING_CLASS = "bg-emerald-600 dark:bg-emerald-500";

export interface DailySegment {
  id: string;
  label: string;
  value: number;
  /** Share of the rendered bar (0..1). */
  fraction: number;
  colorClass: string;
}

export interface DailyRow {
  date: string;
  total: number;
  cap: number;
  remaining: number;
  overCap: boolean;
  segments: DailySegment[];
  ariaLabel: string;
}

export interface DailyLegendEntry {
  id: string;
  label: string;
  colorClass: string;
}

export interface DailyView {
  rows: DailyRow[];
  legend: DailyLegendEntry[];
}

function formatGb(value: number): string {
  return `${Number(value.toFixed(1)).toLocaleString("en-US")} GB`;
}

function formatClassC(value: number): string {
  return `${Math.round(value).toLocaleString("en-US")} Class C txns`;
}

function formatMetricValue(value: number, metric: DailyMetric): string {
  return metric === "download" ? formatGb(value) : formatClassC(value);
}

/**
 * Build the daily stacked-bar rows from the payload's `dailySeries`.
 *
 * Newest day first.  Each bar is scaled against the daily free cap: under the
 * cap the used portion is the app segments and the remainder up to the cap is
 * emerald headroom; over the cap the bar fills 100% (segments keep their
 * relative proportions) and the row is flagged as over cap.
 */
export function buildDailyView(
  dailySeries: B2AppUsageDailyPoint[],
  apps: B2AppUsageSlice[],
  metric: DailyMetric,
  cap: number
): DailyView {
  const labelById = new Map<string, string>();
  for (const app of apps) labelById.set(app.id, app.label);

  const days = [...(dailySeries ?? [])]
    .filter((day) => Boolean(day?.date))
    .sort((a, b) => b.date.localeCompare(a.date));

  // Stable per-app shade: assign in payload order first, then anything the
  // daily series knows about but the app list does not.
  const usedIds: string[] = [];
  for (const day of days) {
    for (const appId of Object.keys(day.byApp ?? {})) {
      if (!usedIds.includes(appId)) usedIds.push(appId);
    }
  }
  usedIds.sort((a, b) => {
    const ai = apps.findIndex((app) => app.id === a);
    const bi = apps.findIndex((app) => app.id === b);
    return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
  });

  const colorById = new Map<string, string>();
  usedIds.forEach((id, index) => {
    colorById.set(id, DAILY_SEGMENT_CLASSES[index % DAILY_SEGMENT_CLASSES.length]);
  });

  const rows: DailyRow[] = days.map((day) => {
    const entries = Object.entries(day.byApp ?? {})
      .map(([appId, usage]) => ({
        id: appId,
        label: labelById.get(appId) ?? appId,
        value:
          metric === "download"
            ? usage?.downloadedGb ?? 0
            : usage?.classCTransactions ?? 0,
      }))
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value);

    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    const overCap = total > 0 && total > cap;
    const scale = Math.max(total, cap, 0);
    const segments: DailySegment[] = entries.map((entry) => ({
      ...entry,
      fraction: scale > 0 ? entry.value / scale : 0,
      colorClass: colorById.get(entry.id) ?? DAILY_SEGMENT_CLASSES[0],
    }));

    const remaining = Math.max(0, cap - total);
    const appPart = entries
      .map((entry) => `${entry.label} ${formatMetricValue(entry.value, metric)}`)
      .join(", ");
    const ariaLabel = overCap
      ? `${day.date}: ${appPart}, ${formatMetricValue(total - cap, metric)} over the ${formatMetricValue(cap, metric)} free cap`
      : appPart
        ? `${day.date}: ${appPart}, ${formatMetricValue(remaining, metric)} left of ${formatMetricValue(cap, metric)} free cap`
        : `${day.date}: no usage, ${formatMetricValue(cap, metric)} free cap`;

    return { date: day.date, total, cap, remaining, overCap, segments, ariaLabel };
  });

  const legend: DailyLegendEntry[] = usedIds
    .filter((id) =>
      days.some((day) => {
        const usage = day.byApp?.[id as B2AppId];
        if (!usage) return false;
        return metric === "download"
          ? (usage.downloadedGb ?? 0) > 0
          : (usage.classCTransactions ?? 0) > 0;
      }),
    )
    .map((id) => ({
      id,
      label: labelById.get(id) ?? id,
      colorClass: colorById.get(id) ?? DAILY_SEGMENT_CLASSES[0],
    }));

  return { rows, legend };
}

export default function B2AppUsageBreakdownCard() {
  const [data, setData] = useState<B2AppUsageBreakdownPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ChartMode>("download");
  const [view, setView] = useState<ChartView>("daily");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/b2-app-usage", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<B2AppUsageBreakdownPayload>;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "load_failed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const slices = useMemo(() => {
    if (!data?.apps.length) return [];
    return data.apps
      .map((app) => {
        let value = 0;
        if (mode === "storage") value = app.storageGb;
        else if (mode === "download") value = app.latestDay?.downloadedGb ?? 0;
        else value = app.latestDay?.classCTransactions ?? 0;
        return { name: app.label, value, id: app.id as B2AppId };
      })
      .filter((row) => row.value > 0);
  }, [data, mode]);

  const dailyMetric: DailyMetric = mode === "classC" ? "classC" : "download";
  const dailyCap =
    dailyMetric === "download"
      ? data?.caps.downloadGbDailyFree ?? 0
      : data?.caps.classCDailyFree ?? 0;

  const dailyView = useMemo(
    () => buildDailyView(data?.dailySeries ?? [], data?.apps ?? [], dailyMetric, dailyCap),
    [data, dailyMetric, dailyCap],
  );

  // Storage has no daily series, so it keeps the existing donut/bar view.
  const effectiveView: ChartView = mode === "storage" && view === "daily" ? "donut" : view;

  const modeLabel =
    mode === "storage"
      ? "Storage (GB)"
      : mode === "download"
        ? "Download (GB, latest day)"
        : "Class C Txns (latest day)";

  if (error) {
    return (
      <section
        aria-labelledby="b2-app-usage-heading"
        className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800"
      >
        <div className="px-5 py-4">
          <h3
            id="b2-app-usage-heading"
            className="text-sm font-semibold text-gray-900 dark:text-gray-100"
          >
            B2 Usage by Application
          </h3>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Could not load B2 breakdown ({error}).
          </p>
        </div>
      </section>
    );
  }

  if (!data) {
    return (
      <section
        aria-labelledby="b2-app-usage-heading"
        className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800"
      >
        <div className="px-5 py-4">
          <h3
            id="b2-app-usage-heading"
            className="text-sm font-semibold text-gray-900 dark:text-gray-100"
          >
            B2 Usage by Application
          </h3>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Loading…</p>
        </div>
      </section>
    );
  }

  const alertLine = [
    data.alerts.classCSpike ? "Class C spike" : null,
    data.alerts.classCNearCap ? "Class C near cap" : null,
    data.alerts.downloadNearCap ? "Download near cap" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const hasDailyHeadroom = dailyView.rows.some((row) => !row.overCap);

  return (
    <section
      aria-labelledby="b2-app-usage-heading"
      className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className="rounded-lg bg-sky-50 p-2 text-sky-600 dark:bg-sky-950/40 dark:text-sky-300"
            aria-hidden="true"
          >
            <Database className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3
              id="b2-app-usage-heading"
              className="text-sm font-semibold text-gray-900 dark:text-gray-100"
            >
              B2 Usage by Application
            </h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Shared Backblaze account · ST, CT, UM
              {data.reportDate ? ` · report ${data.reportDate}` : ""}
            </p>
            {alertLine ? (
              <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                {alertLine}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="B2 metric"
            className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-900"
            value={mode}
            onChange={(e) => setMode(e.target.value as ChartMode)}
          >
            <option value="storage">Storage</option>
            <option value="download">Download</option>
            <option value="classC">Class C</option>
          </select>
          <select
            aria-label="Chart view"
            className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-900"
            value={effectiveView}
            onChange={(e) => setView(e.target.value as ChartView)}
          >
            {mode === "storage" ? null : <option value="daily">Daily</option>}
            <option value="donut">Donut</option>
            <option value="bar">Bar</option>
          </select>
        </div>
      </div>

      {effectiveView === "daily" ? (
        dailyView.rows.length > 0 ? (
          <div className="space-y-3 px-5 pb-4">
            {dailyView.rows.map((row) => (
              <div key={row.date} role="img" aria-label={row.ariaLabel} className="space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="font-medium text-gray-800 dark:text-gray-200">{row.date}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-gray-500 dark:text-gray-400">
                      {row.overCap
                        ? `${formatMetricValue(row.total - row.cap, dailyMetric)} over`
                        : `${formatMetricValue(row.total, dailyMetric)} used`}
                    </span>
                    {row.overCap ? (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-800 dark:bg-red-950/50 dark:text-red-300">
                        Over Cap
                      </span>
                    ) : null}
                  </span>
                </div>
                <div className="relative w-full h-2.5 rounded-sm overflow-visible bg-gray-200 dark:bg-gray-700">
                  <div className="flex h-full w-full rounded-sm overflow-hidden">
                    {row.segments.map((segment) => (
                      <div
                        key={segment.id}
                        className={`h-full ${segment.colorClass}`}
                        style={{ width: `${segment.fraction * 100}%` }}
                      />
                    ))}
                    {row.overCap ? null : (
                      <div className={`h-full ${DAILY_REMAINING_CLASS} flex-1`} />
                    )}
                  </div>
                </div>
              </div>
            ))}
            <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
              {dailyView.legend.map((entry) => (
                <li key={entry.id} className="flex items-center gap-1.5">
                  <span
                    className={`h-2 w-2 rounded-sm ${entry.colorClass}`}
                    aria-hidden="true"
                  />
                  <span>{entry.label}</span>
                </li>
              ))}
              {hasDailyHeadroom ? (
                <li className="flex items-center gap-1.5">
                  <span
                    className={`h-2 w-2 rounded-sm ${DAILY_REMAINING_CLASS}`}
                    aria-hidden="true"
                  />
                  <span>Left</span>
                </li>
              ) : null}
            </ul>
          </div>
        ) : (
          <p className="px-5 pb-4 text-xs text-gray-500 dark:text-gray-400">
            {data.configured
              ? "No daily usage data yet."
              : "Configure the Backblaze monitor key to enable B2 breakdown."}
          </p>
        )
      ) : slices.length > 1 ? (
        <div className="h-56 px-2 pb-2">
          <ResponsiveContainer width="100%" height="100%">
            {effectiveView === "donut" ? (
              <PieChart>
                <Pie
                  data={slices}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="55%"
                  outerRadius="85%"
                  paddingAngle={2}
                >
                  {slices.map((_, index) => (
                    <Cell key={index} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => Number(v ?? 0).toLocaleString()} />
                <Legend />
              </PieChart>
            ) : (
              <BarChart data={slices} margin={{ left: 8, right: 8, bottom: 8 }}>
                <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-20} textAnchor="end" height={50} />
                <YAxis tick={{ fontSize: 11 }} width={40} />
                <Tooltip formatter={(v) => Number(v ?? 0).toLocaleString()} />
                <Bar dataKey="value" fill={COLORS[0]} name={modeLabel} />
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="px-5 pb-4 text-xs text-gray-500 dark:text-gray-400">
          {data.configured
            ? "Not enough data for a chart yet."
            : "Configure the Backblaze monitor key to enable B2 breakdown."}
        </p>
      )}

      <ul className="space-y-2 border-t border-gray-100 px-5 py-4 text-xs dark:border-gray-700">
        {data.apps.map((app) => (
          <li key={app.id} className="flex flex-wrap justify-between gap-2">
            <span className="font-medium text-gray-800 dark:text-gray-200">{app.label}</span>
            <span className="text-gray-500 dark:text-gray-400">
              {app.storageGb.toFixed(1)} GB stored
              {app.latestDay
                ? ` · ${app.latestDay.downloadedGb.toFixed(2)} GB dl · ${app.latestDay.classCTransactions.toLocaleString()} Class C`
                : ""}
            </span>
          </li>
        ))}
      </ul>
      {data.warnings.length > 0 ? (
        <p className="border-t border-gray-100 px-5 py-3 text-xs text-amber-700 dark:border-gray-700 dark:text-amber-300">
          {data.warnings.join(" · ")}
        </p>
      ) : null}
    </section>
  );
}
