"use client";

import { useEffect, useState } from "react";
import CardUnavailableNotice from "@/components/CardUnavailableNotice";
import { formatCompactNumber, formatCurrency } from "@/lib/format";

const SENTENCE_GAP = "\u00a0 ";

interface ModelCostCheck {
  model: string;
  pricingKey: string | null;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    unknown: number;
  };
  derivedCostUsd: number;
  derivationComplete: boolean;
  reportedCostUsd: number;
  deltaUsd: number;
  deltaPct: number | null;
}

interface ProviderReport {
  provider: string;
  sourceApp: string;
  estimateUsd: number;
  models: ModelCostCheck[];
  totals: {
    derivedCostUsd: number;
    reportedCostUsd: number;
    deltaPct: number | null;
    unpricedModelCount: number;
  };
}

interface ApiEquivalentResponse {
  ok: boolean;
  days: number;
  pricing: { source: string; fetchedAt: string; upstreamSha256: string };
  providers: ProviderReport[];
  totals: {
    derivedCostUsd: number;
    reportedCostUsd: number;
    estimateUsd: number;
    deltaPct: number | null;
    unpricedModelCount: number;
  };
}

const usd = (amount: number) => formatCurrency(amount);
const compact = (value: number) => formatCompactNumber(value);

function knownCost(amount: number, unpricedModelCount: number): string {
  if (unpricedModelCount === 0) return usd(amount);
  return amount > 0 ? `${usd(amount)} known+` : "Unknown";
}

function totalTokens(model: ModelCostCheck): number {
  return (
    model.tokens.input +
    model.tokens.output +
    model.tokens.cacheRead +
    model.tokens.cacheCreation +
    model.tokens.unknown
  );
}

function driftTone(model: ModelCostCheck): { chip: string; label: string } {
  if (!model.derivationComplete) {
    return {
      chip: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
      label: model.pricingKey ? "partial" : "unpriced",
    };
  }
  if (model.reportedCostUsd <= 0) {
    return {
      chip: "bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
      label: "catalog estimate",
    };
  }
  const pct = model.deltaPct == null ? 0 : Math.abs(model.deltaPct);
  if (pct < 0.05) {
    return {
      chip: "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
      label: "in agreement",
    };
  }
  if (pct < 0.15) {
    return {
      chip: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
      label: "drifting",
    };
  }
  return {
    chip: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
    label: "diverged",
  };
}

function seatLabel(sourceApp: string): string {
  switch (sourceApp) {
    case "claude-code":
      return "Claude Code (Monet)";
    case "grok-build":
    case "grok-cli":
      return "Grok Build";
    case "openai-codex":
    case "codex-cli":
      return "Codex CLI";
    case "antigravity-cli":
    case "antigravity-statusline":
    case "antigravity-ide":
    case "google-antigravity":
      return "Google Antigravity";
    case "github-copilot":
    case "copilot-cli":
      return "Copilot CLI";
    case "deepseek-dsh":
    case "deepseek-harness":
      return "DeepSeek Harness";
    case "cursor-agent":
    case "cursor-cloud":
      return "Cursor Cloud";
    default:
      return sourceApp;
  }
}

/**
 * API-equivalent cost for every subscription seat that has model + token
 * telemetry. Catalog derivation vs a producer-reported estimate when one
 * exists. Neither figure is cash.
 */
export default function ApiEquivalentCostCard() {
  const [data, setData] = useState<ApiEquivalentResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/api-equivalent-cost?days=30")
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        return res.json();
      })
      .then((json: ApiEquivalentResponse) => {
        if (cancelled) return;
        setData(json);
        setFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setData(null);
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadCount]);

  if (failed) {
    return (
      <CardUnavailableNotice
        title="API-equivalent cost unavailable."
        detail="Token x list-price estimates for subscription seats could not be loaded."
        onRetry={() => setReloadCount((count) => count + 1)}
      />
    );
  }

  if (!data || !data.ok || data.providers.length === 0) return null;

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
            API-Equivalent Cost
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Last {data.days} {data.days === 1 ? "day" : "days"} · tokens × public API list
            price if the same work were PAYG.{SENTENCE_GAP}Not what the subscription billed.
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Combined estimate
          </p>
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {knownCost(data.totals.estimateUsd, data.totals.unpricedModelCount)}
          </p>
        </div>
      </div>
      {data.providers.map((seat) => {
        const visibleModels = seat.models.slice(0, 6);
        return (
          <div key={`${seat.provider}|${seat.sourceApp}`} className="border-b border-gray-100 dark:border-gray-700 last:border-b-0">
            <div className="px-6 py-3 flex items-baseline justify-between gap-3 bg-gray-50 dark:bg-gray-900/40">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {seatLabel(seat.sourceApp)}
                <span className="ml-2 text-[10px] font-normal uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  {seat.provider}
                </span>
              </p>
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {knownCost(seat.estimateUsd, seat.totals.unpricedModelCount)}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse responsive-table">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    <th className="px-6 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Model
                    </th>
                    <th className="px-6 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider text-right">
                      Tokens
                    </th>
                    <th className="px-6 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider text-right">
                      Derived
                    </th>
                    <th className="px-6 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider text-right">
                      Reported
                    </th>
                    <th className="px-6 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider text-right">
                      Drift
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {visibleModels.map((model) => {
                    const tone = driftTone(model);
                    return (
                      <tr key={model.model} className="hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                        <td className="px-6 py-3" data-label="Model">
                          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                            {model.model}
                          </p>
                          <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                            {model.pricingKey
                              ? model.pricingKey === model.model
                                ? "priced"
                                : `priced as ${model.pricingKey}`
                              : "not in pricing catalog"}
                          </p>
                        </td>
                        <td className="px-6 py-3 text-right" data-label="Tokens">
                          <p className="text-sm text-gray-900 dark:text-gray-100">
                            {compact(totalTokens(model))}
                          </p>
                        </td>
                        <td className="px-6 py-3 text-right" data-label="Derived">
                          <p className="text-sm text-gray-900 dark:text-gray-100">
                            {model.derivationComplete
                              ? usd(model.derivedCostUsd)
                              : model.derivedCostUsd > 0
                                ? `${usd(model.derivedCostUsd)} known+`
                                : "Unknown"}
                          </p>
                        </td>
                        <td className="px-6 py-3 text-right" data-label="Reported">
                          <p className="text-sm text-gray-900 dark:text-gray-100">
                            {model.reportedCostUsd > 0 ? usd(model.reportedCostUsd) : "—"}
                          </p>
                        </td>
                        <td className="px-6 py-3 text-right" data-label="Drift">
                          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                            {model.reportedCostUsd <= 0 || model.deltaPct == null
                              ? "—"
                              : `${model.deltaPct >= 0 ? "+" : ""}${(model.deltaPct * 100).toFixed(1)}%`}
                          </p>
                          <span
                            className={`inline-flex mt-1 px-2 py-0.5 text-[10px] font-medium rounded-full ${tone.chip}`}
                          >
                            {tone.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      <div className="px-6 py-3 bg-gray-50/50 dark:bg-gray-900/20 border-t border-gray-100 dark:border-gray-700">
        <p className="text-[10px] text-gray-500 dark:text-gray-400">
          Estimates use the bundled LiteLLM catalog plus xAI list prices refreshed {snapshotDate}.
          {SENTENCE_GAP}Includes exact Antigravity CLI status-line counters, Claude Code OTLP,
          Codex CLI, Grok Build, Copilot CLI, and DeepSeek Harness sessions.
          {SENTENCE_GAP}Excludes end-user production app traffic (routed through OpenRouter).
          {data.totals.unpricedModelCount > 0
            ? `${SENTENCE_GAP}${data.totals.unpricedModelCount} incompletely priced model${data.totals.unpricedModelCount === 1 ? "" : "s"} under-count derivation.`
            : ""}
        </p>
      </div>
    </div>
  );
}
