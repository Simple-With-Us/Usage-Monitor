"use client";

import { useState } from "react";

export interface ExternalUsageGroup {
  sourceApp: string;
  environment: string | null;
  provider: string;
  service: string | null;
  projectId: string | null;
  projectName?: string | null;
  eventCount: number;
  totalCostUsd: number;
  totalRequests: number;
  totalQuantity: number;
  limit: number | null;
  limitWindow: string | null;
  latestAt: string;
}

export interface ExternalUsageSummary {
  days: number;
  totalCostUsd: number;
  totalRequests: number;
  eventCount: number;
  groups: ExternalUsageGroup[];
}

interface ExternalTelemetryPanelProps {
  usageSummary: ExternalUsageSummary;
}

export default function ExternalTelemetryPanel({ usageSummary }: ExternalTelemetryPanelProps) {
  const [showAll, setShowAll] = useState(false);
  const externalCost = usageSummary.totalCostUsd;
  const externalRequests = usageSummary.totalRequests;
  const visibleGroups = showAll ? usageSummary.groups : usageSummary.groups.slice(0, 8);

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-800">
            External App Telemetry
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Last {usageSummary.days} days from sibling app reports
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-semibold text-gray-900">
            {new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: "USD",
            }).format(externalCost)}
          </p>
          <p className="text-xs text-gray-500">
            {new Intl.NumberFormat("en-US").format(externalRequests)} requests
          </p>
        </div>
      </div>
      {usageSummary.groups.length === 0 ? (
        <div className="px-6 py-5 text-sm text-gray-500">
          No app telemetry received yet.
        </div>
      ) : (
        <div className="divide-y divide-gray-100">
          {visibleGroups.map((group) => {
            const usagePercent =
              group.limit && group.totalQuantity
                ? Math.min((group.totalQuantity / group.limit) * 100, 999)
                : null;
            return (
              <div
                key={`${group.sourceApp}-${group.environment ?? ""}-${group.provider}-${group.service ?? ""}-${group.projectId ?? ""}`}
                className="px-6 py-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      {group.sourceApp}
                      {group.environment ? ` / ${group.environment}` : ""}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {group.provider}
                      {group.service ? ` - ${group.service}` : ""}
                    </p>
                    {group.projectName && (
                      <span className="inline-flex mt-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-blue-50 text-blue-700 border border-blue-100">
                        {group.projectName}
                      </span>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-gray-900">
                      {new Intl.NumberFormat("en-US").format(
                        group.totalRequests || group.totalQuantity
                      )}
                    </p>
                    <p className="text-xs text-gray-500">
                      {group.totalCostUsd
                        ? new Intl.NumberFormat("en-US", {
                            style: "currency",
                            currency: "USD",
                          }).format(group.totalCostUsd)
                        : `${group.eventCount} events`}
                    </p>
                  </div>
                </div>
                {usagePercent != null && (
                  <div className="mt-3">
                    <div
                      role="progressbar"
                      aria-label={`${group.provider} quota usage`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.min(usagePercent, 100)}
                      className="h-2 bg-gray-100 rounded-full overflow-hidden"
                    >
                      <div
                        className={`h-full ${
                          usagePercent >= 90
                            ? "bg-red-500"
                            : usagePercent >= 70
                              ? "bg-amber-500"
                              : "bg-emerald-500"
                        }`}
                        style={{ width: `${Math.min(usagePercent, 100)}%` }}
                      />
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {usagePercent.toFixed(1)}% of{" "}
                      {new Intl.NumberFormat("en-US").format(group.limit ?? 0)}
                      {group.limitWindow ? ` per ${group.limitWindow}` : ""}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
          {usageSummary.groups.length > 8 && (
            <div className="px-6 py-3">
              <button
                type="button"
                onClick={() => setShowAll((expanded) => !expanded)}
                className="text-xs font-medium text-blue-600 hover:text-blue-800"
              >
                {showAll ? "Show fewer groups" : `Show all ${usageSummary.groups.length} groups`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
