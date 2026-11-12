"use client";

import { useId } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { formatCompactNumber, formatCurrency, formatNumber } from "@/lib/format";

interface Snapshot {
  id: string;
  fetchedAt: string;
  balance: number | null;
  totalCost: number | null;
  totalRequests: number | null;
  credits: number | null;
}

interface UsageChartProps {
  snapshots: Snapshot[];
}

export default function UsageChart({ snapshots }: UsageChartProps) {
  const gradientPrefix = useId().replace(/:/g, "");

  if (snapshots.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-gray-300 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
        <p className="text-sm text-gray-600 dark:text-gray-300">No usage data yet</p>
      </div>
    );
  }

  const hasCredits = snapshots.some((s) => s.credits != null);

  const data = snapshots.map((s) => ({
    timestamp: new Date(s.fetchedAt).getTime(),
    balance: s.balance ?? undefined,
    cost: s.totalCost ?? undefined,
    credits: s.credits ?? undefined,
  }));

  return (
    <div
      role="region"
      aria-label="Provider balance, reported cost, and credits over time"
      className="min-w-0 rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800 sm:p-4"
    >
      <h3 className="mb-4 text-sm font-semibold text-gray-700 dark:text-gray-200">
        Usage Over Time
      </h3>
      <ResponsiveContainer width="100%" height={300} minWidth={0} debounce={50}>
        <AreaChart accessibilityLayer data={data} margin={{ top: 5, right: 5, left: -12, bottom: 5 }}>
          <defs>
            <linearGradient id={`${gradientPrefix}-balance`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--chart-balance)" stopOpacity={0.2} />
              <stop offset="95%" stopColor="var(--chart-balance)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id={`${gradientPrefix}-cost`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--chart-cost)" stopOpacity={0.2} />
              <stop offset="95%" stopColor="var(--chart-cost)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id={`${gradientPrefix}-credits`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--chart-credits)" stopOpacity={0.2} />
              <stop offset="95%" stopColor="var(--chart-credits)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
          <XAxis
            dataKey="timestamp"
            tick={{ fontSize: 12, fill: "var(--chart-axis)" }}
            tickLine={false}
            axisLine={{ stroke: "var(--chart-grid)" }}
            minTickGap={28}
            tickFormatter={(timestamp: number) =>
              new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })
            }
          />
          <YAxis
            yAxisId="usd"
            width="auto"
            tick={{ fontSize: 12, fill: "var(--chart-axis)" }}
            tickLine={false}
            axisLine={{ stroke: "var(--chart-grid)" }}
            tickFormatter={(v: number) => `$${v}`}
          />
          {hasCredits && (
            <YAxis
              yAxisId="credits"
              orientation="right"
              width="auto"
              tick={{ fontSize: 11, fill: "var(--chart-credits)" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => formatCompactNumber(value)}
            />
          )}
          <Tooltip
            isAnimationActive="auto"
            contentStyle={{
              borderRadius: "8px",
              border: "1px solid var(--chart-grid)",
              backgroundColor: "var(--chart-tooltip-bg)",
              color: "var(--chart-tooltip-text)",
              boxShadow: "0 4px 6px -1px rgba(0,0,0,0.1)",
            }}
            itemStyle={{ color: "var(--chart-tooltip-text)" }}
            labelStyle={{ color: "var(--chart-tooltip-text)" }}
            labelFormatter={(timestamp) => new Date(Number(timestamp)).toLocaleString()}
            formatter={(value, name) => {
              const numericValue = Number(value);
              const key = String(name).toLowerCase();
              if (key === "balance") return [formatCurrency(numericValue), "Balance"];
              if (key === "reported cost") return [formatCurrency(numericValue), "Reported cost"];
              if (key === "credits") return [formatNumber(numericValue), "Credits"];
              return [numericValue, name];
            }}
          />
          <Area
            type="monotone"
            dataKey="balance"
            yAxisId="usd"
            stroke="var(--chart-balance)"
            strokeWidth={2}
            fill={`url(#${gradientPrefix}-balance)`}
            name="Balance"
          />
          <Area
            type="monotone"
            dataKey="cost"
            yAxisId="usd"
            stroke="var(--chart-cost)"
            strokeWidth={2}
            fill={`url(#${gradientPrefix}-cost)`}
            name="Reported cost"
          />
          {hasCredits && (
            <Area
              type="monotone"
              dataKey="credits"
              yAxisId="credits"
              stroke="var(--chart-credits)"
              strokeWidth={2}
              fill={`url(#${gradientPrefix}-credits)`}
              name="Credits"
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
