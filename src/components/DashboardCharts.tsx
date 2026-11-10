"use client";

import { useMemo } from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { useTheme } from "next-themes";
import { formatCurrency } from "@/lib/format";
import SpendBurnChart, { SPEND_BURN_ACCENT } from "@/components/SpendBurnChart";
import SpendHistoryChart from "@/components/SpendHistoryChart";
import type { DailySpendSeriesPoint, ExternalUsageGroup } from "@/components/ExternalTelemetryPanel";
import {
  historyRangeLabel,
  isCurrentCalendarMonth,
  type TimeframeOption,
} from "@/hooks/useDashboardData";

export interface ChartFamilySlice {
  displayName: string;
  projectedEomUsd: number | null;
  exact?: boolean;
}

export interface FamilyBreakdownSlice {
  name: string;
  value: number;
}

export function shapeFamilyProjectedBreakdown(
  families: ChartFamilySlice[] | undefined | null
): { slices: FamilyBreakdownSlice[]; excludedIncomplete: number } {
  const rows = families ?? [];
  let excludedIncomplete = 0;
  const slices: FamilyBreakdownSlice[] = [];
  for (const p of rows) {
    if (p.exact === false || p.projectedEomUsd == null || p.projectedEomUsd <= 0) {
      if (p.exact === false || p.projectedEomUsd == null) excludedIncomplete += 1;
      continue;
    }
    slices.push({ name: p.displayName, value: p.projectedEomUsd });
  }
  slices.sort((a, b) => b.value - a.value);
  return { slices, excludedIncomplete };
}

/**
 * Actual spend-by-provider for the selected chart range (not a projection).
 * Fed by the range-scoped `/api/usage-events` groups, keyed on the resolved
 * display name so the same provider's rows merge into one slice.
 */
export function shapeRangeSpendBreakdown(
  groups: ExternalUsageGroup[] | undefined | null
): { slices: FamilyBreakdownSlice[] } {
  const rows = groups ?? [];
  const byName = new Map<string, number>();
  for (const group of rows) {
    if (!(group.totalCostUsd > 0)) continue;
    const name = group.matchedProvider?.displayName || group.provider;
    byName.set(name, (byName.get(name) ?? 0) + group.totalCostUsd);
  }
  const slices = Array.from(byName.entries()).map(([name, value]) => ({ name, value }));
  slices.sort((a, b) => b.value - a.value);
  return { slices };
}

interface DashboardChartsProps {
  families?: ChartFamilySlice[];
  /** @deprecated use families */
  providers?: ChartFamilySlice[];
  spentUsd?: number;
  projectedEomUsd?: number;
  monthlyBudgetUsd?: number | null;
  /** Selected chart/history range. Drives which burn-chart mode renders —
   * MTD pace projection for the current calendar month, actual daily
   * history for everything else. Omit to keep the legacy MTD-only view. */
  timeframe?: TimeframeOption;
  /** Range-scoped daily cost series (from usageSummary.dailySeries), used
   * when timeframe is not the current calendar month. */
  dailySeries?: DailySpendSeriesPoint[];
  /** Range-scoped provider spend groups (from usageSummary.groups), used for
   * the pie breakdown when timeframe is not the current calendar month. */
  groups?: ExternalUsageGroup[];
  /** True while the range-scoped fetch is in flight. */
  rangeLoading?: boolean;
}

const COLORS = [
  SPEND_BURN_ACCENT,
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f59e0b",
  "#ef4444",
  "#10b981",
  "#6366f1",
];

export default function DashboardCharts({
  families,
  providers,
  spentUsd,
  projectedEomUsd,
  monthlyBudgetUsd,
  timeframe,
  dailySeries,
  groups,
  rangeLoading,
}: DashboardChartsProps) {
  const { resolvedTheme } = useTheme();
  // No timeframe prop → legacy MTD-only callers keep exactly today's view.
  // Otherwise: current calendar month keeps the MTD pace projection (per the
  // product rule — budgets/pace are always MTD); any other range shows
  // actual daily history for that range instead of a projection.
  const isCurrentMonth = timeframe == null || isCurrentCalendarMonth(timeframe);
  const rangeLabel = timeframe ? historyRangeLabel(timeframe) : "";

  const { slices: familySlices, excludedIncomplete } = useMemo(
    () => shapeFamilyProjectedBreakdown(families ?? providers),
    [families, providers]
  );
  const { slices: rangeSlices } = useMemo(
    () => shapeRangeSpendBreakdown(groups),
    [groups]
  );
  const slices = isCurrentMonth ? familySlices : rangeSlices;
  const pieTitle = isCurrentMonth ? "Projected Cost Breakdown" : "Spend by Provider";
  const pieCaption = isCurrentMonth
    ? `Exact family projections only${
        excludedIncomplete > 0 ? ` · ${excludedIncomplete} incomplete/ambiguous excluded` : ""
      }`
    : rangeLabel;

  return (
    <div className="space-y-6">
      {isCurrentMonth ? (
        <SpendBurnChart
          spentUsd={spentUsd}
          projectedEomUsd={projectedEomUsd}
          monthlyBudgetUsd={monthlyBudgetUsd}
        />
      ) : (
        <SpendHistoryChart
          dailySeries={dailySeries}
          loading={!!rangeLoading}
          rangeLabel={rangeLabel}
        />
      )}

      {slices.length > 0 && (
        <div className="rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {pieTitle}
          </h3>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            {pieCaption}
          </p>
          <div className="mt-3 h-56">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} debounce={50}>
              <PieChart>
                <Pie
                  data={slices}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={78}
                  paddingAngle={2}
                  dataKey="value"
                  nameKey="name"
                >
                  {slices.map((entry, index) => (
                    <Cell
                      key={`${entry.name}-${index}`}
                      fill={COLORS[index % COLORS.length]}
                      stroke={resolvedTheme === "dark" ? "#1f2937" : "#ffffff"}
                      strokeWidth={2}
                    />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value) => formatCurrency(Number(value))}
                  contentStyle={{
                    backgroundColor: resolvedTheme === "dark" ? "#1f2937" : "#ffffff",
                    borderColor: resolvedTheme === "dark" ? "#374151" : "#e5e7eb",
                    color: resolvedTheme === "dark" ? "#f3f4f6" : "#111827",
                    borderRadius: "0.5rem",
                  }}
                />
                <Legend wrapperStyle={{ fontSize: "13px" }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
