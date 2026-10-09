"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useTheme } from "next-themes";
import { formatCurrency } from "@/lib/format";

/** Brand accent (matches --um-accent / favicon orange). SVG stroke attrs need a resolved color. */
export const SPEND_BURN_ACCENT = "#f97316";

/** Prefer CSS var when the host supports it (e.g. HTML style props). */
export const SPEND_BURN_ACCENT_CSS = "var(--um-accent)";

export interface SpendPace {
  daysInMonth: number;
  currentDay: number;
  spent: number;
  projected: number;
  budget: number | null;
}

export interface SpendPaceInput {
  month: string;
  generatedAt?: string | Date | null;
  spent: number;
  projected: number;
  budget: number | null;
  now?: Date;
}

/** Linear MTD pace model (honest estimate, not daily history). */
export function buildSpendPace(input: SpendPaceInput): SpendPace | null {
  const spent = Number(input.spent);
  const projectedRaw = Number(input.projected);
  if (!Number.isFinite(spent) || !Number.isFinite(projectedRaw)) return null;

  const match = /^(\d{4})-(\d{2})$/.exec(input.month);
  if (!match) return null;
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (!Number.isInteger(year) || monthNumber < 1 || monthNumber > 12) return null;

  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  if (!Number.isFinite(daysInMonth) || daysInMonth < 28) return null;

  const generated =
    input.generatedAt == null
      ? input.now ?? new Date()
      : typeof input.generatedAt === "string"
        ? new Date(input.generatedAt)
        : input.generatedAt;

  let currentDay = daysInMonth;
  if (generated instanceof Date && Number.isFinite(generated.getTime())) {
    if (
      generated.getUTCFullYear() === year &&
      generated.getUTCMonth() + 1 === monthNumber
    ) {
      currentDay = generated.getUTCDate();
    } else if (generated.getTime() < Date.UTC(year, monthNumber - 1, 1)) {
      currentDay = 1;
    }
  }
  currentDay = Math.min(Math.max(currentDay, 1), daysInMonth);

  const budgetRaw = input.budget;
  const budget =
    budgetRaw != null && Number.isFinite(budgetRaw) && budgetRaw > 0
      ? budgetRaw
      : null;

  return {
    daysInMonth,
    currentDay,
    spent: Math.max(0, spent),
    projected: Math.max(projectedRaw, spent, 0),
    budget,
  };
}

export function buildPaceChartRows(pace: SpendPace): Array<{
  day: number;
  toDate: number | null;
  projection: number | null;
  ideal: number | null;
}> {
  const rows = [];
  const dailySpend = pace.currentDay > 0 ? pace.spent / pace.currentDay : 0;
  const idealDaily =
    pace.budget != null && pace.daysInMonth > 0 ? pace.budget / pace.daysInMonth : null;
  for (let day = 1; day <= pace.daysInMonth; day += 1) {
    const toDate = day <= pace.currentDay ? dailySpend * day : null;
    const remaining = Math.max(pace.daysInMonth - pace.currentDay, 1);
    const projection =
      day >= pace.currentDay
        ? pace.spent + ((pace.projected - pace.spent) * (day - pace.currentDay)) / remaining
        : null;
    rows.push({
      day,
      toDate,
      projection: day === pace.currentDay ? pace.spent : projection,
      ideal: idealDaily != null ? idealDaily * day : null,
    });
  }
  return rows;
}

export function derivePaceFromBudgetStatus(
  body: {
    month?: string;
    generatedAt?: string;
    providers?: Array<{
      spentUsd?: number;
      projectedEomUsd?: number;
      monthlyBudgetUsd?: number | null;
    }>;
    summary?: { totalSpentUsd?: number; totalBudgetUsd?: number };
  } | null | undefined,
  now: Date = new Date()
): SpendPace | null {
  if (!body || typeof body !== "object") return null;
  const month =
    typeof body.month === "string" && /^\d{4}-\d{2}/.test(body.month)
      ? body.month.slice(0, 7)
      : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const providers = Array.isArray(body.providers) ? body.providers : [];
  let spent = body.summary?.totalSpentUsd;
  if (spent == null || !Number.isFinite(spent)) {
    spent = providers.reduce((sum, p) => sum + (Number(p.spentUsd) || 0), 0);
  }
  let projected = providers.reduce(
    (sum, p) => sum + (Number(p.projectedEomUsd) || 0),
    0
  );
  if (!(projected > 0) && spent > 0) {
    const day = now.getUTCDate();
    const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    projected = day > 0 ? (spent / day) * dim : spent;
  }
  let budget: number | null =
    body.summary?.totalBudgetUsd != null &&
    Number.isFinite(body.summary.totalBudgetUsd) &&
    body.summary.totalBudgetUsd > 0
      ? body.summary.totalBudgetUsd
      : null;
  if (budget == null) {
    const summed = providers.reduce((sum, p) => {
      const b = p.monthlyBudgetUsd;
      return sum + (b != null && Number.isFinite(b) && b > 0 ? b : 0);
    }, 0);
    budget = summed > 0 ? summed : null;
  }
  return buildSpendPace({
    month,
    generatedAt: body.generatedAt ?? now.toISOString(),
    spent,
    projected,
    budget,
    now,
  });
}

interface SpendBurnChartProps {
  spentUsd?: number;
  projectedEomUsd?: number;
  monthlyBudgetUsd?: number | null;
  month?: string;
  generatedAt?: string | null;
  className?: string;
}

export default function SpendBurnChart({
  spentUsd,
  projectedEomUsd,
  monthlyBudgetUsd,
  month,
  generatedAt,
  className = "",
}: SpendBurnChartProps) {
  const { resolvedTheme } = useTheme();
  const hasOverride =
    spentUsd != null &&
    Number.isFinite(spentUsd) &&
    projectedEomUsd != null &&
    Number.isFinite(projectedEomUsd);

  const [fetched, setFetched] = useState<SpendPace | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (hasOverride) return;
    let cancelled = false;
    fetch("/api/budget-status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return;
        setFetched(derivePaceFromBudgetStatus(body));
      })
      .catch(() => {
        if (!cancelled) setError("Could not load pace");
      });
    return () => {
      cancelled = true;
    };
  }, [hasOverride]);

  const pace = useMemo(() => {
    if (hasOverride) {
      const now = new Date();
      const m =
        month && month.length >= 7
          ? month.slice(0, 7)
          : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      return buildSpendPace({
        month: m,
        generatedAt: generatedAt ?? now.toISOString(),
        spent: spentUsd as number,
        projected: projectedEomUsd as number,
        budget: monthlyBudgetUsd ?? null,
        now,
      });
    }
    return fetched;
  }, [hasOverride, month, generatedAt, spentUsd, projectedEomUsd, monthlyBudgetUsd, fetched]);

  const rows = useMemo(() => (pace ? buildPaceChartRows(pace) : []), [pace]);
  const isDark = resolvedTheme === "dark";
  const grid = isDark ? "#374151" : "#e5e7eb";
  const axis = isDark ? "#d1d5db" : "#4b5563";

  if (error) {
    return (
      <div
        className={`rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800 ${className}`}
      >
        <p className="text-sm text-gray-500">{error}</p>
      </div>
    );
  }

  if (!pace || rows.length === 0) {
    return (
      <div
        role="status"
        className={`rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800 ${className}`}
      >
        <div className="h-48 animate-pulse rounded-xl bg-gray-100 dark:bg-gray-700" />
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="Month-to-date spend pace estimate"
      className={`rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800 sm:p-6 ${className}`}
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Month Pace</h3>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Linear estimate — not daily history · Day {pace.currentDay} of {pace.daysInMonth}
          </p>
        </div>
        <div className="text-right text-xs text-gray-500 dark:text-gray-400">
          <p>
            Spent {formatCurrency(pace.spent)}
            {pace.budget != null && ` · Budget ${formatCurrency(pace.budget)}`}
          </p>
          <p>Projected {formatCurrency(pace.projected)}</p>
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
              formatter={(value, name) => [
                formatCurrency(Number(value)),
                name === "toDate"
                  ? "MTD path"
                  : name === "projection"
                    ? "Projection"
                    : "Even-spend ideal",
              ]}
              labelFormatter={(day) => `Day ${day}`}
              contentStyle={{
                backgroundColor: isDark ? "#111827" : "#ffffff",
                borderColor: isDark ? "#374151" : "#e5e7eb",
                borderRadius: "0.5rem",
                color: isDark ? "#f3f4f6" : "#111827",
              }}
            />
            {pace.budget != null && (
              <ReferenceLine
                y={pace.budget}
                stroke="#f59e0b"
                strokeDasharray="4 4"
                label={{ value: "Budget", fill: axis, fontSize: 10, position: "insideTopRight" }}
              />
            )}
            {pace.budget != null && (
              <Line
                type="monotone"
                dataKey="ideal"
                stroke={isDark ? "#6b7280" : "#9ca3af"}
                strokeWidth={1.5}
                strokeDasharray="3 3"
                dot={false}
                name="ideal"
                isAnimationActive={false}
              />
            )}
            <Area
              type="monotone"
              dataKey="toDate"
              stroke={SPEND_BURN_ACCENT}
              fill={SPEND_BURN_ACCENT}
              fillOpacity={0.18}
              strokeWidth={2}
              name="toDate"
              connectNulls={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="projection"
              stroke={SPEND_BURN_ACCENT}
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              name="projection"
              connectNulls={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
