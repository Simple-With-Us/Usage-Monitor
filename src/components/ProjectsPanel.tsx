import React from "react";
import Link from "next/link";
import type { ProviderCostCoverage } from "@/components/ProviderCard";
import { formatCurrency } from "@/lib/format";

export interface ProjectBudgetStatus {
  id: string;
  name: string;
  description: string | null;
  monthlyBudgetUsd: number | null;
  spentUsd: number;
  projectedEomUsd?: number;
  spendCoverage: ProviderCostCoverage;
  pricedEventCount: number;
  unpricedEventCount: number;
  unclassifiedCostEventCount: number;
  incompleteAllocatedProviderCount: number;
  directUsd?: number;
  allocatedUsd?: number;
  remainingUsd: number | null;
  percentUsed: number | null;
  status: "ok" | "warning" | "exceeded" | "unconfigured";
}

interface ProjectsPanelProps {
  projects: ProjectBudgetStatus[];
  summary?: {
    totalSpentUsd: number;
    unbudgetedSpentUsd: number;
    unassignedSpentUsd: number;
  } | null;
}

function formatUsd(value: number): string {
  return formatCurrency(value);
}

export default function ProjectsPanel({ projects, summary }: ProjectsPanelProps) {
  if (projects.length === 0 && !(summary?.unassignedSpentUsd)) {
    return null;
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Projects</h2>
        <Link
          href="/settings?tab=projects"
          className="text-xs font-medium text-blue-600 dark:text-blue-400"
        >
          Manage projects
        </Link>
      </div>
      {(summary?.unassignedSpentUsd ?? 0) > 0 && (
        <div
          role="status"
          className="border-b border-amber-200 bg-amber-50 px-6 py-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
        >
          {formatUsd(summary!.unassignedSpentUsd)} of provider spend is not assigned to a project.
          {" "}
          <Link href="/settings?tab=projects" className="font-semibold underline underline-offset-2">
            Review allocations
          </Link>
        </div>
      )}
      <div className="divide-y divide-gray-100 dark:divide-gray-700">
        {projects.map((project) => {
          const rawUsagePercent =
            project.percentUsed != null ? project.percentUsed * 100 : null;
          // A manual subscription refund (negative costUsd) can push spend, and
          // therefore percentUsed, below zero. Clamp to [0, 100]: CSS silently
          // drops a negative width, and an aria-valuenow below aria-valuemin=0
          // violates ARIA, so the raw value must never reach either attribute.
          const usagePercent =
            rawUsagePercent != null
              ? Math.max(0, Math.min(rawUsagePercent, 100))
              : null;
          const spendCoverage = project.spendCoverage ?? "unknown";
          const hasKnownSpend =
            spendCoverage === "complete" || spendCoverage === "partial";
          const unpricedEventCount =
            (project.unpricedEventCount ?? 0) +
            (project.unclassifiedCostEventCount ?? 0);
          return (
            <div key={project.id} className="px-6 py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {project.name}
                  </p>
                  {project.description && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {project.description}
                    </p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {hasKnownSpend
                      ? `${formatUsd(project.spentUsd)}${spendCoverage === "partial" ? " known" : ""}`
                      : spendCoverage === "legacy_unknown"
                        ? "Historical cost unknown"
                        : "Cost not reported"}
                  </p>
                  {hasKnownSpend && (project.directUsd != null || project.allocatedUsd != null) && (
                    <p className="text-[10px] text-gray-500 dark:text-gray-400">
                      {formatUsd(project.directUsd ?? 0)} direct
                      {" · "}
                      {formatUsd(project.allocatedUsd ?? 0)} allocated
                    </p>
                  )}
                  {unpricedEventCount > 0 && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-300">
                      {unpricedEventCount} unpriced event{unpricedEventCount === 1 ? "" : "s"}
                    </p>
                  )}
                  {(project.incompleteAllocatedProviderCount ?? 0) > 0 && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-300">
                      {project.incompleteAllocatedProviderCount} allocated provider cost
                      {project.incompleteAllocatedProviderCount === 1 ? "" : "s"} incomplete
                    </p>
                  )}
                  {project.monthlyBudgetUsd != null && (
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      of {formatUsd(project.monthlyBudgetUsd)}
                    </p>
                  )}
                </div>
              </div>
              {usagePercent != null && hasKnownSpend && (
                <div className="mt-3">
                  <div
                    role="progressbar"
                    aria-label={`${project.name} ${spendCoverage === "partial" ? "known " : ""}monthly budget used`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={usagePercent}
                    className="h-2 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden"
                  >
                    <div
                      className={`h-full ${
                        usagePercent >= 90
                          ? "bg-red-500 dark:bg-red-600"
                          : usagePercent >= 70
                            ? "bg-amber-500 dark:bg-amber-600"
                            : "bg-emerald-500 dark:bg-emerald-600"
                      }`}
                      style={{ width: `${usagePercent}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
