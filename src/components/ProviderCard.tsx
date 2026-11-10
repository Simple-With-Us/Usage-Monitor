"use client";

import Link from "next/link";
import BalanceBadge from "./BalanceBadge";
import { isExternalBillingStale, type ExternalBillingRecord } from "./ExternalBillingDetails";
import ProviderIntegrationInfo, { publicConfigFieldNames } from "./ProviderIntegrationInfo";
import { usageUnitLabelForProvider } from "@/lib/provider-definitions";
import { costCoverageHelpText } from "@/lib/cost-coverage-help";
import {
  formatCurrency,
  formatNumber,
  projectedStatusLabel,
  type ProviderBudgetIntel,
} from "@/lib/format";
export type ProviderCostCoverage =
  | "complete"
  | "partial"
  | "unknown"
  | "legacy_unknown";

/**
 * A specific, adapter-named reason totalCost may be understated (e.g. a
 * provider's usage-based billing endpoint is unreachable while its fixed
 * subscription cost is still known). Distinct from ProviderCostCoverage
 * above - that describes pushed-telemetry pricing completeness - so this
 * gets its own badge rather than being folded into that one.
 */
export interface ProviderCostCoverageCaveat {
  code: string;
  message: string;
}

interface ProviderCardProps {
  id: string;
  name: string;
  displayName: string;
  type: string;
  isActive: boolean;
  config?: Record<string, unknown>;
  secretConfigMeta?: { configured: boolean; fields: string[]; readable: boolean };
  refreshIntervalMin?: number;
  label?: string | null;
  keyPreview?: string | null;
  anthropicAdminApiConfigured?: boolean;
  geminiKeyStatus?: {
    state: "valid" | "invalid" | "unreadable" | "unavailable" | "unchecked" | "not_configured";
    httpStatus: number | null;
    availableModelCount: number | null;
    checkedAt: string | null;
  } | null;
  geminiBillingStatus?: {
    state: "ready" | "pending" | "error" | "configuration_changed" | "unchecked" | "not_configured";
    errorCode: string | null;
    httpStatus: number | null;
    retryable: boolean;
    checkedAt: string | null;
  } | null;
  estimatedMonthlyCostUsd?: number;
  projectedEomUsd?: number;
  spentUsd?: number;
  /** S10: projected (runway) status from the budget-status DTO; badge renders only when worse than ok. */
  projectedStatus?: ProviderBudgetIntel["projectedStatus"];
  snapshotCostFetchedAt?: string | null;
  spendCoverage?: ProviderCostCoverage;
  costCoverageCaveat?: ProviderCostCoverageCaveat | null;
  pushedCostCoverage?: ProviderCostCoverage;
  pushedPricedEventCount?: number;
  pushedUnpricedEventCount?: number;
  pushedUnclassifiedCostEventCount?: number;
  externalBilling?: ExternalBillingRecord[];
  billingMode?: "actual" | "estimated" | "manual";
  alerts?: {
    severity: "critical" | "warning" | "info";
    message: string;
  }[];
  latestSnapshot: {
    balance: number | null;
    totalCost: number | null;
    totalRequests: number | null;
    credits: number | null;
    fetchedAt: string;
  } | null;
}

const typeColors: Record<string, string> = {
  openai: "bg-emerald-500",
  anthropic: "bg-amber-500",
  "google-ai": "bg-blue-500",
  google_ai: "bg-blue-500",
  pinecone: "bg-indigo-500",
  cloudflare: "bg-orange-500",
  deepseek: "bg-teal-500",
  xai: "bg-slate-500",
  mistral: "bg-rose-500",
  openrouter: "bg-fuchsia-500",
  llamaindex: "bg-violet-500",
  voyage: "bg-purple-500",
  sentry: "bg-red-500",
  langfuse: "bg-cyan-500",
  twilio: "bg-red-600",
  resend: "bg-sky-500",
  pushover: "bg-lime-500",
  apify: "bg-orange-600",
  firecrawl: "bg-red-600",
  stripe: "bg-indigo-600",
  robinhood: "bg-green-500",
  alpaca: "bg-gray-600",
  github: "bg-slate-700",
  vercel: "bg-gray-900",
  render: "bg-indigo-500",
};

const creditBasedProviders = new Set([
  "llamaindex", "voyage", "langfuse", "apify", "firecrawl",
]);

export default function ProviderCard({
  id,
  displayName,
  name,
  type,
  isActive,
  config,
  secretConfigMeta,
  refreshIntervalMin = 60,
  label,
  keyPreview,
  anthropicAdminApiConfigured,
  geminiKeyStatus,
  geminiBillingStatus,
  estimatedMonthlyCostUsd = 0,
  projectedEomUsd = 0,
  spentUsd,
  projectedStatus,
  snapshotCostFetchedAt,
  spendCoverage,
  costCoverageCaveat,
  pushedUnpricedEventCount = 0,
  pushedUnclassifiedCostEventCount = 0,
  externalBilling = [],
  billingMode = "manual",
  alerts = [],
  latestSnapshot,
}: ProviderCardProps) {
  const dotColor =
    typeColors[name.toLowerCase()] ?? "bg-purple-500";
  const usageUnitLabel = usageUnitLabelForProvider(name, type);

  const isCreditBased = creditBasedProviders.has(name.toLowerCase());
  const hasCredits = latestSnapshot?.credits != null;
  const openAlerts = alerts.filter((alert) => alert.severity !== "info");
  const hasCritical = openAlerts.some((alert) => alert.severity === "critical");
  const connectedBilling = externalBilling[0];
  const resolvedSpendCoverage: ProviderCostCoverage =
    spendCoverage ??
    (spentUsd != null || latestSnapshot?.totalCost != null ? "complete" : "unknown");
  const knownSpendUsd =
    spentUsd ?? latestSnapshot?.totalCost ?? estimatedMonthlyCostUsd;
  const unpricedEventCount =
    pushedUnpricedEventCount + pushedUnclassifiedCostEventCount;
  const staleBillingCount = externalBilling.filter((record) =>
    isExternalBillingStale(
      record,
      Math.min(24 * 60 * 60 * 1_000, Math.max(60 * 60 * 1_000, refreshIntervalMin * 3 * 60 * 1_000))
    )
  ).length;

  const formatUsd = (amount: number) => formatCurrency(amount);

  const paceLabel = projectedStatusLabel(projectedStatus);

  const cardDetailTitle = [
    label,
    keyPreview,
    latestSnapshot ? `Latest snapshot: ${new Date(latestSnapshot.fetchedAt).toLocaleString()}` : null,
  ]
    .filter(Boolean)
    .join("\n") || undefined;

  return (
    <div
      className="provider-card relative block rounded-xl border border-gray-200 bg-white p-4 sm:p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-md dark:border-gray-700 dark:bg-gray-800 dark:hover:border-gray-600"
      title={cardDetailTitle}
    >
      <div className="flex items-center gap-3 mb-2.5">
        <div className={`w-3 h-3 rounded-full ${dotColor} flex-shrink-0`} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-lg font-semibold text-gray-900 dark:text-gray-100">
            <Link href={`/providers/${id}`} className="after:absolute after:inset-0">
              {displayName}
            </Link>
          </h3>
          {geminiKeyStatus && (
            <p
              className={`mt-0.5 text-xs font-medium ${
                geminiKeyStatus.state === "valid"
                  ? "text-emerald-700 dark:text-emerald-300"
                  : geminiKeyStatus.state === "invalid" ||
                      geminiKeyStatus.state === "unreadable" ||
                      geminiKeyStatus.state === "not_configured"
                    ? "text-red-700 dark:text-red-300"
                    : "text-amber-700 dark:text-amber-300"
              }`}
            >
              {geminiKeyStatus.state === "valid"
                ? "Gemini key verified"
                : geminiKeyStatus.state === "invalid"
                  ? "Gemini key rejected"
                  : geminiKeyStatus.state === "unreadable"
                    ? "Gemini key unreadable"
                  : geminiKeyStatus.state === "not_configured"
                    ? "Gemini key missing"
                    : geminiKeyStatus.state === "unavailable"
                      ? "Gemini key check unavailable"
                    : "Gemini key unchecked"}
            </p>
          )}
          {geminiBillingStatus && (
            <p
              className={`mt-0.5 text-xs font-medium ${
                geminiBillingStatus.state === "ready"
                  ? "text-emerald-700 dark:text-emerald-300"
                  : geminiBillingStatus.state === "error"
                    ? "text-red-700 dark:text-red-300"
                    : geminiBillingStatus.state === "not_configured"
                      ? "text-gray-500 dark:text-gray-400"
                      : "text-amber-700 dark:text-amber-300"
              }`}
            >
              {geminiBillingStatus.state === "ready"
                ? "Google billing ready"
                : geminiBillingStatus.state === "pending"
                  ? "Google billing pending"
                  : geminiBillingStatus.state === "error"
                    ? "Google billing failed"
                    : geminiBillingStatus.state === "configuration_changed"
                      ? "Google billing config changed"
                    : geminiBillingStatus.state === "not_configured"
                      ? "Google billing not configured"
                      : "Google billing unchecked"}
            </p>
          )}
        </div>
        <div className="ml-auto flex flex-col items-end gap-1 flex-shrink-0">
          <div className="flex items-center gap-1">
            <ProviderIntegrationInfo
              providerName={name}
              providerType={type}
              displayName={displayName}
              instanceState={{
                isActive,
                primaryCredentialConfigured:
                  Boolean(keyPreview) ||
                  (geminiKeyStatus != null &&
                    geminiKeyStatus.state !== "not_configured"),
                keyPreview,
                anthropicAdminApiConfigured,
                publicConfigFields: publicConfigFieldNames(config),
                protectedConfigFields: secretConfigMeta?.fields ?? [],
                protectedConfigReadable: secretConfigMeta?.readable,
                lastSnapshotAt: latestSnapshot?.fetchedAt ?? null,
                externalBillingRecordCount: externalBilling.length,
                externalBillingSources: [...new Set(externalBilling.map((record) => record.source))].sort(),
                geminiKeyStatus,
                geminiBillingStatus,
              }}
            />
            <span className="rounded bg-gray-50 px-2 py-0.5 text-xs font-medium uppercase text-gray-600 dark:bg-gray-700 dark:text-gray-300">
              {type}
            </span>
          </div>
          {openAlerts.length > 0 && (
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded ${
                hasCritical
                  ? "bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300"
                  : "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
              }`}
            >
              {openAlerts.length} alert{openAlerts.length === 1 ? "" : "s"}
            </span>
          )}
          {paceLabel && (
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded ${
                projectedStatus === "exceeded"
                  ? "bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300"
                  : "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
              }`}
            >
              {paceLabel}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">Balance</p>
          <BalanceBadge amount={latestSnapshot?.balance ?? null} />
        </div>
        <div>
          <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">Latest provider report</p>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {latestSnapshot?.totalCost != null ? (
              <span className="font-medium text-amber-600 dark:text-amber-300">
                {formatUsd(latestSnapshot.totalCost)}
              </span>
            ) : (
              "--"
            )}
          </p>
        </div>
        {(isCreditBased || hasCredits) && (
          <div>
            <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">Credits</p>
            <p className="text-sm font-medium text-purple-600 dark:text-purple-300">
              {formatNumber(latestSnapshot?.credits ?? null)}
            </p>
          </div>
        )}
        <div>
          <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">{usageUnitLabel}</p>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {formatNumber(latestSnapshot?.totalRequests ?? null)}
          </p>
        </div>
        <div
          className={(isCreditBased || hasCredits) ? "col-span-2" : ""}
          title={[
            `Billing mode: ${billingMode}`,
            snapshotCostFetchedAt
              ? `Cost snapshot fetched ${new Date(snapshotCostFetchedAt).toLocaleString()}`
              : null,
            ...openAlerts.map((a) => `Alert: ${a.message}`),
            resolvedSpendCoverage === "partial" && unpricedEventCount > 0
              ? `${unpricedEventCount} unpriced event${unpricedEventCount === 1 ? "" : "s"}`
              : null,
            costCoverageCaveat?.message
              ? `Coverage gap: ${costCoverageCaveat.message}`
              : null,
          ].filter(Boolean).join("\n") || undefined}
        >
          <p
            className="mb-1 text-xs text-gray-500 dark:text-gray-400"
            title={
              resolvedSpendCoverage === "complete"
                ? undefined
                : costCoverageHelpText(resolvedSpendCoverage)
            }
          >
            {resolvedSpendCoverage === "complete"
              ? "Tracked MTD / projected EOM"
              : resolvedSpendCoverage === "partial"
                ? "Known MTD / known-cost projection"
                : "Tracked MTD / projection"}
          </p>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {resolvedSpendCoverage === "unknown" || resolvedSpendCoverage === "legacy_unknown" ? (
              <>
                Cost not reported{" "}
                <span className="font-normal text-gray-500 dark:text-gray-400">
                  / Projection unavailable
                </span>
                {unpricedEventCount > 0 && (
                  <span className="block text-xs font-normal text-gray-500 dark:text-gray-400">
                    {unpricedEventCount} usage event{unpricedEventCount === 1 ? "" : "s"} without cost
                  </span>
                )}
              </>
            ) : (
              <>
                {formatUsd(knownSpendUsd)}
                {resolvedSpendCoverage === "partial" ? " known" : ""}{" "}
                <span className="font-normal text-gray-500 dark:text-gray-400">
                  / {formatUsd(projectedEomUsd)}
                  {resolvedSpendCoverage === "partial" ? " from known costs" : ""}
                </span>
              </>
            )}
          </p>
        </div>
      </div>

      {connectedBilling && (
        <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
          <span className="font-semibold">Provider-reported:</span>{" "}
          {externalBilling.length} record{externalBilling.length === 1 ? "" : "s"} · {connectedBilling.serviceName || connectedBilling.planName || connectedBilling.kind}
          {connectedBilling.status ? ` · ${connectedBilling.status}` : ""}
          {staleBillingCount > 0 ? ` · ${staleBillingCount} stale` : ""}
        </div>
      )}

      {costCoverageCaveat && (
        <div className="mt-3 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-800 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-200">
          <span className="font-semibold">Cost coverage gap:</span>{" "}
          {costCoverageCaveat.message}
        </div>
      )}

      {openAlerts[0] && (
        <p
          className={`mt-3 text-xs rounded-lg px-3 py-2 ${
            openAlerts[0].severity === "critical"
              ? "bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300"
              : "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
          }`}
        >
          {openAlerts[0].message}
        </p>
      )}
    </div>
  );
}
