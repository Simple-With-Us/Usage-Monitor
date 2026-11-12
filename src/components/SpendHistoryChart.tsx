"use client";

import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useTheme } from "next-themes";
import { formatCurrency } from "@/lib/format";
import { SPEND_BURN_ACCENT } from "@/components/SpendBurnChart";
import type { DailySpendSeriesPoint } from "@/components/ExternalTelemetryPanel";

export interface HistoryChartRow {
  day: string;
  totalCostUsd: number;
}

/**
 * Sort + coerce a raw dailySeries payload into chart rows. Kept pure (no
 * theme/formatting) so range-vs-range differences and the empty/loading
 * gates are testable without rendering Recharts.
 */
export function buildHistoryChartRows(
  series: DailySpendSeriesPoint[] | undefined | null
): HistoryChartRow[] {
  const rows = (series ?? [])
    .filter(
      (point): point is DailySpendSeriesPoint =>
        !!point && typeof point.day === "string"
    )
    .map((point) => ({
      day: point.day,
      totalCostUsd: Number(point.totalCostUsd) || 0,
    }));
  rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return rows;
}

interface SpendHistoryChartProps {
  dailySeries?: DailySpendSeriesPoint[];
  /** True while the range-scoped fetch is in flight. */
  loading?: boolean;
  /** Honest range label (e.g. "Past 30 days") — never a month name unless
   * the selection actually is that calendar month. */
  rangeLabel: string;
  className?: string;
}

/**
 * Range-scoped burn chart: actual daily spend history for the selected
 * chart range. Unlike SpendBurnChart, this never draws a projection/EOM
 * line — it only ever shows history that has already happened.
 */
export default function SpendHistoryChart({
  dailySeries,
  loading = false,
  rangeLabel,
  className = "",
}: SpendHistoryChartProps) {
  const { resolvedTheme } = useTheme();
  const rows = useMemo(() => buildHistoryChartRows(dailySeries), [dailySeries]);
  const isDark = resolvedTheme === "dark";
  const grid = isDark ? "#374151" : "#e5e7eb";
  const axis = isDark ? "#d1d5db" : "#4b5563";
  const total = rows.reduce((sum, row) => sum + row.totalCostUsd, 0);

  if (rows.length === 0) {
    return (
      <div
        role="status"
        aria-busy={loading}
        className={`rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800 ${className}`}
      >
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          Spend — {rangeLabel}
        </h3>
        {loading ? (
          <div className="mt-3 h-48 animate-pulse rounded-xl bg-gray-100 dark:bg-gray-700" />
        ) : (
          <p className="mt-6 py-4 text-center text-sm text-gray-500 dark:text-gray-400">
            No usage events in this range.
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label={`Daily spend — ${rangeLabel}`}
      aria-busy={loading}
      className={`rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800 sm:p-6 ${
        loading ? "opacity-60 transition-opacity" : ""
      } ${className}`}
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Spend — {rangeLabel}
          </h3>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Daily history — not a projection
          </p>
        </div>
        <div className="text-right text-xs text-gray-500 dark:text-gray-400">
          <p>Total {formatCurrency(total)}</p>
        </div>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%" minWidth={0} debounce={50}>
          <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={grid} strokeDasharray="3 3" />
            <XAxis
              dataKey="day"
              tick={{ fill: axis, fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: grid }}
            />
            <YAxis
              tick={{ fill: axis, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => formatCurrency(Number(v))}
              width={64}
            />
            <Tooltip
              formatter={(value) => [formatCurrency(Number(value)), "Spend"]}
              labelFormatter={(day) => day}
              contentStyle={{
                backgroundColor: isDark ? "#111827" : "#ffffff",
                borderColor: isDark ? "#374151" : "#e5e7eb",
                borderRadius: "0.5rem",
                color: isDark ? "#f3f4f6" : "#111827",
              }}
            />
            <Area
              type="monotone"
              dataKey="totalCostUsd"
              stroke={SPEND_BURN_ACCENT}
              fill={SPEND_BURN_ACCENT}
              fillOpacity={0.18}
              strokeWidth={2}
              name="totalCostUsd"
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
