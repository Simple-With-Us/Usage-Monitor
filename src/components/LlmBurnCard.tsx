"use client";

import { useEffect, useState } from "react";
import { formatCompactNumber, formatCurrency } from "@/lib/format";

interface BurnTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  unknown: number;
  total: number;
}

type PaceStatus = "no-budget" | "on-pace" | "watch" | "over-pace";

interface BurnProvider {
  provider: string;
  window: {
    hours: number;
    tokens: BurnTokens;
    derivedCostUsd: number;
    derivationComplete: boolean;
    reportedCostUsd: number;
    estimateUsd: number;
    eventCount: number;
    activeMinutes: number;
    tokensPerHour: number;
    usdPerHour: number;
    firstOccurredAt: string | null;
    lastOccurredAt: string | null;
  };
  monthToDate: {
    estimateUsd: number;
    reportedCostUsd: number;
    derivedCostUsd: number;
  };
  budget: {
    monthlyBudgetUsd: number | null;
    expectedByNowUsd: number | null;
    paceRatio: number | null;
    projectedMonthEndUsd: number | null;
    status: PaceStatus;
  };
}

interface LlmBurnResponse {
  ok: boolean;
  generatedAt: string;
  windowHours: number;
  monthStart: string;
  pricing: { source: string; fetchedAt: string; upstreamSha256: string };
  providers: BurnProvider[];
  quietProviders: BurnProvider[];
}

const usd = (amount: number) => formatCurrency(amount);
const compact = (value: number) => formatCompactNumber(value);

const REFRESH_MS = 120_000;
const MAX_ROWS = 8;

function paceTone(status: PaceStatus): { chip: string; label: string } {
  switch (status) {
    case "on-pace":
      return {
        chip: "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
        label: "on pace",
      };
    case "watch":
      return {
        chip: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
        label: "watch",
      };
    case "over-pace":
      return {
        chip: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
        label: "over pace",
      };
    default:
      return {
        chip: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
        label: "no budget",
      };
  }
}

function providerDisplayName(provider: string): string {
  return provider
    .split(/[-_]/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/**
 * ccusage-style burn windows generalized to every LLM platform: trailing
 * 5-hour token/cost burn, live burn rate, and month-to-date budget pace with
 * a linear month-end projection. All cost figures are analytics-only
 * API-equivalent estimates (producer-reported or token x LiteLLM catalog),
 * never cash spend. Renders nothing when no LLM telemetry exists. Refreshes
 * every 2 minutes; the rate is time-sensitive by design.
 */
export default function LlmBurnCard() {
  const [data, setData] = useState<LlmBurnResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/llm-burn")
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          if (!cancelled) setData(json);
        })
        .catch(() => {
          if (!cancelled) setData(null);
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!data || !data.ok) return null;
  const visible = data.providers.slice(0, MAX_ROWS);
  if (visible.length === 0 && data.quietProviders.length === 0) return null;

  const snapshotDate = new Date(data.pricing.fetchedAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            LLM Burn Windows
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Trailing {data.windowHours}h burn &amp; month-to-date budget pace · all platforms
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Window total
          </p>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {usd(data.providers.reduce((sum, p) => sum + p.window.estimateUsd, 0))}
          </p>
        </div>
      </div>
      {visible.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse responsive-table">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
                <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Provider
                </th>
                <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider text-right">
                  {data.windowHours}h tokens
                </th>
                <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider text-right">
                  {data.windowHours}h est. cost
                </th>
                <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider text-right">
                  Burn / hr
                </th>
                <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider text-right">
                  MTD est.
                </th>
                <th className="px-6 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider text-right">
                  Budget pace
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {visible.map((provider) => {
                const tone = paceTone(provider.budget.status);
                return (
                  <tr key={provider.provider} className="hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                    <td className="px-6 py-3" data-label="Provider">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {providerDisplayName(provider.provider)}
                      </p>
                      <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                        {provider.window.eventCount} events
                        {provider.window.derivationComplete ? "" : " · partial pricing"}
                      </p>
                    </td>
                    <td className="px-6 py-3 text-right" data-label={`${data.windowHours}h tokens`}>
                      <p className="text-sm text-gray-900 dark:text-gray-100">
                        {compact(provider.window.tokens.total)}
                      </p>
                    </td>
                    <td className="px-6 py-3 text-right" data-label={`${data.windowHours}h est. cost`}>
                      <p className="text-sm text-gray-900 dark:text-gray-100">
                        {usd(provider.window.estimateUsd)}
                      </p>
                    </td>
                    <td className="px-6 py-3 text-right" data-label="Burn / hr">
                      <p className="text-sm text-gray-900 dark:text-gray-100">
                        {usd(provider.window.usdPerHour)}
                      </p>
                      <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                        {compact(Math.round(provider.window.tokensPerHour))} tok/hr
                      </p>
                    </td>
                    <td className="px-6 py-3 text-right" data-label="MTD est.">
                      <p className="text-sm text-gray-900 dark:text-gray-100">
                        {usd(provider.monthToDate.estimateUsd)}
                      </p>
                    </td>
                    <td className="px-6 py-3 text-right" data-label="Budget pace">
                      <span
                        className={`inline-flex px-2 py-0.5 text-[10px] font-medium rounded-full ${tone.chip}`}
                      >
                        {tone.label}
                      </span>
                      <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">
                        {provider.budget.projectedMonthEndUsd != null &&
                        provider.budget.monthlyBudgetUsd != null
                          ? `proj. ${usd(provider.budget.projectedMonthEndUsd)} of ${usd(
                              provider.budget.monthlyBudgetUsd
                            )}`
                          : provider.budget.monthlyBudgetUsd != null
                          ? `budget ${usd(provider.budget.monthlyBudgetUsd)}`
                          : "—"}
                      </p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="px-6 py-3 border-t border-gray-100 dark:border-gray-700">
        <p className="text-[10px] text-gray-500 dark:text-gray-400">
          For comparison only.{"\u00A0 "}The figure uses the reported cost when one exists, otherwise a public list price refreshed {snapshotDate}.{"\u00A0 "}It is not part of cash spend.{"\u00A0 "}Pace compares the month so far with the budget for this point in the month.{"\u00A0 "}The month-end figure is a straight-line estimate
          {data.quietProviders.length > 0
            ? ` · quiet this window: ${data.quietProviders
                .slice(0, 4)
                .map((p) => providerDisplayName(p.provider))
                .join(", ")}${data.quietProviders.length > 4 ? ` +${data.quietProviders.length - 4} more` : ""}`
            : ""}
          {data.providers.length > visible.length
            ? ` · showing top ${visible.length} of ${data.providers.length} active providers`
            : ""}
          .
        </p>
      </div>
    </div>
  );
}
