"use client";

import Link from "next/link";
import BalanceBadge from "./BalanceBadge";
import { isExternalBillingStale, type ExternalBillingRecord } from "./ExternalBillingDetails";
import ProviderIntegrationInfo, { publicConfigFieldNames } from "./ProviderIntegrationInfo";

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
  estimatedMonthlyCostUsd?: number;
  projectedEomUsd?: number;
  spentUsd?: number;
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
  llamaindex: "bg-violet-500",
  voyage: "bg-purple-500",
  sentry: "bg-red-500",
  langfuse: "bg-cyan-500",
  twilio: "bg-red-600",
  resend: "bg-sky-500",
  pushover: "bg-lime-500",
  apify: "bg-orange-600",
  stripe: "bg-indigo-600",
  robinhood: "bg-green-500",
  alpaca: "bg-gray-600",
  github: "bg-slate-700",
  vercel: "bg-gray-900",
  render: "bg-indigo-500",
};

const creditBasedProviders = new Set([
  "llamaindex", "voyage", "langfuse", "apify",
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
  estimatedMonthlyCostUsd = 0,
  projectedEomUsd = 0,
  spentUsd,
  externalBilling = [],
  billingMode = "manual",
  alerts = [],
  latestSnapshot,
}: ProviderCardProps) {
  const dotColor =
    typeColors[name.toLowerCase()] ?? "bg-purple-500";

  const isCreditBased = creditBasedProviders.has(name.toLowerCase());
  const hasCredits = latestSnapshot?.credits != null;
  const openAlerts = alerts.filter((alert) => alert.severity !== "info");
  const hasCritical = openAlerts.some((alert) => alert.severity === "critical");
  const connectedBilling = externalBilling[0];

  const formatNumber = (n: number | null) => {
    if (n == null) return "--";
    return new Intl.NumberFormat("en-US").format(n);
  };

  const formatUsd = (amount: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(amount);

  return (
    <div
      className="relative block bg-white rounded-xl border border-gray-200 p-6 transition-all duration-200 hover:shadow-md hover:border-gray-300 hover:-translate-y-0.5"
    >
      <div className="flex items-center gap-3 mb-4">
        <div className={`w-3 h-3 rounded-full ${dotColor} flex-shrink-0`} />
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-semibold text-gray-900 truncate">
            <Link href={`/providers/${id}`} className="after:absolute after:inset-0">
              {displayName}
            </Link>
          </h3>
          {label && (
            <p className="text-xs text-gray-400 truncate">{label}</p>
          )}
          {keyPreview && (
            <p className="text-xs text-gray-400 truncate font-mono">{keyPreview}</p>
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
                primaryCredentialConfigured: Boolean(keyPreview),
                keyPreview,
                publicConfigFields: publicConfigFieldNames(config),
                protectedConfigFields: secretConfigMeta?.fields ?? [],
                protectedConfigReadable: secretConfigMeta?.readable,
                lastSnapshotAt: latestSnapshot?.fetchedAt ?? null,
                externalBillingRecordCount: externalBilling.length,
                externalBillingSources: [...new Set(externalBilling.map((record) => record.source))].sort(),
              }}
            />
            <span className="text-xs font-medium text-gray-400 uppercase bg-gray-50 px-2 py-0.5 rounded">
              {type}
            </span>
          </div>
          {openAlerts.length > 0 && (
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded ${
                hasCritical
                  ? "bg-red-50 text-red-700"
                  : "bg-amber-50 text-amber-700"
              }`}
            >
              {openAlerts.length} alert{openAlerts.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-gray-500 mb-1">Balance</p>
          <BalanceBadge amount={latestSnapshot?.balance ?? null} />
        </div>
        <div>
          <p className="text-xs text-gray-500 mb-1">Latest provider report</p>
          <p className="text-sm font-medium text-gray-900">
            {latestSnapshot?.totalCost != null ? (
              <BalanceBadge
                amount={-latestSnapshot.totalCost}
                className=""
              />
            ) : (
              "--"
            )}
          </p>
        </div>
        {(isCreditBased || hasCredits) && (
          <div>
            <p className="text-xs text-gray-500 mb-1">Credits</p>
            <p className="text-sm font-medium text-purple-600">
              {formatNumber(latestSnapshot?.credits ?? null)}
            </p>
          </div>
        )}
        <div>
          <p className="text-xs text-gray-500 mb-1">Requests</p>
          <p className="text-sm font-medium text-gray-900">
            {formatNumber(latestSnapshot?.totalRequests ?? null)}
          </p>
        </div>
        <div className={(isCreditBased || hasCredits) ? "col-span-2" : ""}>
          <p className="text-xs text-gray-500 mb-1">Tracked MTD / projected EOM</p>
          <p className="text-sm font-medium text-gray-900">
            {formatUsd(spentUsd ?? estimatedMonthlyCostUsd)} <span className="text-gray-400 font-normal">/ {formatUsd(projectedEomUsd)}</span>
          </p>
          <p className="text-xs uppercase text-gray-400">{billingMode}</p>
        </div>
      </div>

      {connectedBilling && (
        <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
          <span className="font-semibold">Provider-reported:</span>{" "}
          {connectedBilling.planName || connectedBilling.kind}
          {connectedBilling.status ? ` · ${connectedBilling.status}` : ""}
          {isExternalBillingStale(
            connectedBilling,
            Math.min(24 * 60 * 60 * 1_000, Math.max(60 * 60 * 1_000, refreshIntervalMin * 3 * 60 * 1_000))
          ) ? " · stale" : ""}
        </div>
      )}

      {openAlerts[0] && (
        <p
          className={`mt-3 text-xs rounded-lg px-3 py-2 ${
            openAlerts[0].severity === "critical"
              ? "bg-red-50 text-red-700"
              : "bg-amber-50 text-amber-700"
          }`}
        >
          {openAlerts[0].message}
        </p>
      )}

      {latestSnapshot && (
        <p className="mt-3 text-xs text-gray-400">
          Last updated: {new Date(latestSnapshot.fetchedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}
