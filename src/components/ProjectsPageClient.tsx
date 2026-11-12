"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import ProjectsPanel, { type ProjectBudgetStatus } from "@/components/ProjectsPanel";
import EmptyState from "@/components/EmptyState";
import ListLoadErrorPanel from "@/components/ListLoadErrorPanel";

export default function ProjectsPageClient() {
  const [projects, setProjects] = useState<ProjectBudgetStatus[]>([]);
  const [summary, setSummary] = useState<{
    totalSpentUsd: number;
    unbudgetedSpentUsd: number;
    unassignedSpentUsd: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/projects?includeSummary=1", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load projects");
      const data = await res.json();
      if (!data || !Array.isArray(data.projects)) {
        throw new Error("Unexpected projects response");
      }
      setProjects(data.projects);
      setSummary(data.summary ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const empty =
    !loading && !error && projects.length === 0 && !(summary?.unassignedSpentUsd);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Projects</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Per-project spend vs monthly budgets. Configure projects and allocations in Settings.
          </p>
        </div>
        <Link
          href="/settings?tab=projects"
          className="inline-flex min-h-11 items-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Manage projects
        </Link>
      </div>

      {loading && projects.length === 0 ? (
        <div className="animate-pulse rounded-2xl border border-gray-200 bg-white h-48 dark:border-gray-700 dark:bg-gray-800" />
      ) : error && projects.length === 0 ? (
        <ListLoadErrorPanel
          message="Project budgets couldn't be loaded."
          detail={error}
          onRetry={() => void load()}
        />
      ) : empty ? (
        <EmptyState
          title="No projects yet"
          message="Create a project, set a monthly budget, and allocate provider spend to track cost by product."
          action={
            <Link
              href="/settings?tab=projects"
              className="inline-flex min-h-11 items-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Add a project
            </Link>
          }
        />
      ) : (
        <ProjectsPanel projects={projects} summary={summary} />
      )}
    </div>
  );
}
