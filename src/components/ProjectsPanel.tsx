import React from "react";
import Link from "next/link";

export interface ProjectBudgetStatus {
  id: string;
  name: string;
  description: string | null;
  monthlyBudgetUsd: number | null;
  spentUsd: number;
  directUsd?: number;
  allocatedUsd?: number;
  remainingUsd: number | null;
  percentUsed: number | null;
  status: "ok" | "warning" | "exceeded" | "unconfigured";
}

interface ProjectsPanelProps {
  projects: ProjectBudgetStatus[];
}

export default function ProjectsPanel({ projects }: ProjectsPanelProps) {
  if (projects.length === 0) {
    return null;
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-800">Projects</h2>
        <Link href="/settings?tab=projects" className="text-xs font-medium text-blue-600">
          Manage projects
        </Link>
      </div>
      <div className="divide-y divide-gray-100">
        {projects.map((project) => {
          const usagePercent = project.percentUsed != null ? project.percentUsed * 100 : null;
          return (
            <div key={project.id} className="px-6 py-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-gray-900">{project.name}</p>
                  {project.description && (
                    <p className="text-xs text-gray-500 mt-0.5">{project.description}</p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-semibold text-gray-900">
                    {new Intl.NumberFormat("en-US", {
                      style: "currency",
                      currency: "USD",
                    }).format(project.spentUsd)}
                  </p>
                  {(project.directUsd != null || project.allocatedUsd != null) && (
                    <p className="text-[10px] text-gray-500">
                      {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(project.directUsd ?? 0)} direct
                      {" · "}
                      {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(project.allocatedUsd ?? 0)} allocated
                    </p>
                  )}
                  {project.monthlyBudgetUsd != null && (
                    <p className="text-xs text-gray-500">
                      of {new Intl.NumberFormat("en-US", {
                        style: "currency",
                        currency: "USD",
                      }).format(project.monthlyBudgetUsd)}
                    </p>
                  )}
                </div>
              </div>
              {usagePercent != null && (
                <div className="mt-3">
                  <div
                    role="progressbar"
                    aria-label={`${project.name} monthly budget used`}
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
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
