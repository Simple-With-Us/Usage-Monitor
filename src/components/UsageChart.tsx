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
      <div className="flex items-center justify-center h-64 bg-gray-50 rounded-xl border border-dashed border-gray-300">
        <p className="text-gray-400 text-sm">No usage data yet</p>
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
      className="min-w-0 bg-white rounded-xl border border-gray-200 p-3 sm:p-4"
    >
      <h3 className="text-sm font-semibold text-gray-700 mb-4">
        Usage Over Time
      </h3>
      <ResponsiveContainer width="100%" height={300} minWidth={0} debounce={50}>
        <AreaChart accessibilityLayer data={data} margin={{ top: 5, right: 5, left: -12, bottom: 5 }}>
          <defs>
            <linearGradient id={`${gradientPrefix}-balance`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} />
              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
            <linearGradient id={`${gradientPrefix}-cost`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.15} />
              <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
            </linearGradient>
            <linearGradient id={`${gradientPrefix}-credits`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#a855f7" stopOpacity={0.15} />
              <stop offset="95%" stopColor="#a855f7" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" />
          <XAxis
            dataKey="timestamp"
            tick={{ fontSize: 12, fill: "#9ca3af" }}
            tickLine={false}
            axisLine={{ stroke: "#e5e7eb" }}
            minTickGap={28}
            tickFormatter={(timestamp: number) =>
              new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })
            }
          />
          <YAxis
            yAxisId="usd"
            width="auto"
            tick={{ fontSize: 12, fill: "#9ca3af" }}
            tickLine={false}
            axisLine={{ stroke: "#e5e7eb" }}
            tickFormatter={(v: number) => `$${v}`}
          />
          {hasCredits && (
            <YAxis
              yAxisId="credits"
              orientation="right"
              width="auto"
              tick={{ fontSize: 11, fill: "#a855f7" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(value: number) => new Intl.NumberFormat("en-US", { notation: "compact" }).format(value)}
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
              if (key === "balance") return [`$${numericValue.toFixed(2)}`, "Balance"];
              if (key === "reported cost") return [`$${numericValue.toFixed(2)}`, "Reported cost"];
              if (key === "credits") return [numericValue.toLocaleString(), "Credits"];
              return [numericValue, name];
            }}
          />
          <Area
            type="monotone"
            dataKey="balance"
            yAxisId="usd"
            stroke="#3b82f6"
            strokeWidth={2}
            fill={`url(#${gradientPrefix}-balance)`}
            name="Balance"
          />
          <Area
            type="monotone"
            dataKey="cost"
            yAxisId="usd"
            stroke="#f59e0b"
            strokeWidth={2}
            fill={`url(#${gradientPrefix}-cost)`}
            name="Reported cost"
          />
          {hasCredits && (
            <Area
              type="monotone"
              dataKey="credits"
              yAxisId="credits"
              stroke="#a855f7"
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
