"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { budgetViewSchema, formatBudgetMicros, type FleetBudgetView } from "@/lib/fleet-budget/view";

const SENTENCE_GAP = "  ";

export default function FleetBudgetCard() {
  const [data, setData] = useState<FleetBudgetView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const request = useRef<AbortController | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reload = useCallback(async () => {
    request.current?.abort();
    clearTimeout(deadline.current);
    const current = new AbortController();
    request.current = current;
    setLoading(true);
    setError(false);
    const timer = setTimeout(() => {
      current.abort();
      if (request.current === current) {
        setData(null); setError(true); setLoading(false);
      }
    }, 10_000);
    deadline.current = timer;
    try {
      const response = await fetch("/api/fleet-budget-status", { cache: "no-store", signal: current.signal });
      if (!response.ok) throw new Error("Budget unavailable");
      const parsed = budgetViewSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("Invalid budget response");
      if (!current.signal.aborted) setData(parsed.data);
    } catch {
      if (!current.signal.aborted) { setData(null); setError(true); }
    } finally {
      clearTimeout(timer);
      if (!current.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    return () => { request.current?.abort(); clearTimeout(deadline.current); };
  }, [reload]);

  const snapshot = data?.snapshot;
  const state = snapshot?.blocked ? "DeepSeek Blocked" : !data?.enabled ? "Not Activated" : !data.admissionEnabled ? "Admission Paused" : "Admission Enabled";
  return (
    <section aria-labelledby="fleet-budget-heading" aria-busy={loading} className="whitespace-pre-wrap rounded-2xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="fleet-budget-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Fleet Daily Budget</h2>
        <button type="button" disabled={loading} onClick={() => void reload()} className="min-h-11 rounded-lg border border-gray-300 px-3 text-sm font-medium disabled:opacity-50 dark:border-gray-600">
          {loading ? "Loading…" : error ? "Retry Budget" : "Refresh Budget"}
        </button>
      </div>
      {loading ? <p role="status" className="mt-3 text-sm text-gray-500">Loading fleet budget…</p> : error || !snapshot ? (
        <p role="alert" className="mt-3 text-sm text-amber-700 dark:text-amber-300">Budget data could not be loaded.{SENTENCE_GAP}No spend figures are available.</p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-full bg-gray-100 px-3 py-1 font-medium dark:bg-gray-700">{state}</span>
            <span className="text-gray-500 dark:text-gray-400">{snapshot.day} · America/Chicago</span>
            <span className="text-gray-500 dark:text-gray-400">Updated {new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(new Date(data.generatedAt))}</span>
          </div>
          {snapshot.blocked && <p role="alert" className="mt-3 text-sm text-amber-700 dark:text-amber-300">A cost-bound violation needs review.{SENTENCE_GAP}New DeepSeek calls remain blocked across daily resets.</p>}
          {!data.enabled && <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">Budget admission is off.{SENTENCE_GAP}Any recorded costs and outstanding requests remain visible.</p>}
          {!snapshot.configured && <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">No budget-controlled requests have been recorded for this Chicago day.</p>}
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Settled Policy Spend", formatBudgetMicros(snapshot.settledPolicyMicros)],
              ["Reserved Policy Spend", formatBudgetMicros(snapshot.reservedPolicyMicros)],
              ["MiniMax Routing Threshold", formatBudgetMicros(snapshot.softLimitMicros)],
              ["DeepSeek Daily Ceiling", formatBudgetMicros(snapshot.hardLimitMicros)],
            ].map(([label, value]) => <div key={label} className="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40"><dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt><dd className="mt-1 break-words text-xl font-semibold tabular-nums">{value}</dd></div>)}
          </dl>
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">Policy spend includes DeepSeek only.{SENTENCE_GAP}MiniMax has zero routing weight; its financial usage is shown separately below.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {snapshot.providerCosts.map((row) => (
              <div key={row.provider} className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                <h3 className="font-semibold">{row.provider === "deepseek" ? "DeepSeek" : "MiniMax"}</h3>
                <dl className="mt-2 space-y-2 text-sm">
                  <div className="flex flex-wrap justify-between gap-2"><dt className="text-gray-500 dark:text-gray-400">Known Estimate</dt><dd className="tabular-nums">{formatBudgetMicros(row.knownEstimatedCostMicros)}</dd></div>
                  <div className="flex flex-wrap justify-between gap-2"><dt className="text-gray-500 dark:text-gray-400">Provider Reported · Unverified</dt><dd className="tabular-nums">{formatBudgetMicros(row.knownProviderReportedCostMicros)}</dd></div>
                  <div className="flex flex-wrap justify-between gap-2"><dt className="text-gray-500 dark:text-gray-400">Outstanding Requests</dt><dd>{row.outstandingCalls}</dd></div>
                  {row.outstandingCalls > 0 && <div className="flex flex-wrap justify-between gap-2"><dt className="text-gray-500 dark:text-gray-400">Outstanding Upper Bound</dt><dd className="tabular-nums">{formatBudgetMicros(row.outstandingMaximumCostMicros)}</dd></div>}
                </dl>
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{row.estimatedCalls}/{row.settledCalls} settled calls estimated; {row.providerReportedCalls}/{row.settledCalls} have a provider cost report.{row.outstandingCalls > 0 ? `${SENTENCE_GAP}Final costs for outstanding requests are unknown.` : ""}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">Estimates and provider reports are not verified bills.{SENTENCE_GAP}This view does not authorize a provider call.</p>
        </>
      )}
    </section>
  );
}
