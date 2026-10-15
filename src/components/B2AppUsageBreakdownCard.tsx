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
import type { B2AppUsageBreakdownPayload, B2AppId } from "@/lib/b2-app-usage-types";

type ChartMode = "storage" | "download" | "classC";
type ChartStyle = "donut" | "bar";

const COLORS = ["#0ea5e9", "#8b5cf6", "#14b8a6", "#f59e0b", "#94a3b8"];

export default function B2AppUsageBreakdownCard() {
  const [data, setData] = useState<B2AppUsageBreakdownPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ChartMode>("storage");
  const [style, setStyle] = useState<ChartStyle>("donut");

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
            aria-label="Chart style"
            className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-900"
            value={style}
            onChange={(e) => setStyle(e.target.value as ChartStyle)}
          >
            <option value="donut">Donut</option>
            <option value="bar">Bar</option>
          </select>
        </div>
      </div>

      {slices.length > 1 ? (
        <div className="h-56 px-2 pb-2">
          <ResponsiveContainer width="100%" height="100%">
            {style === "donut" ? (
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
