"use client";

import { useEffect, useState } from "react";
import CardUnavailableNotice from "@/components/CardUnavailableNotice";

interface SentryProjectHealth {
  projectSlug: string;
  displayName: string;
  unresolvedCount: number;
  hasMore: boolean;
  issuesUrl: string;
  dashboardUrl?: string;
  datadogUrl?: string;
  error?: string;
}

interface SentryHealthResponse {
  configured: boolean;
  org?: string;
  fleetDashboardUrl?: string;
  projects?: SentryProjectHealth[];
  fetchedAt?: string;
}

// Small read-only card summarizing open Sentry issue counts per tracked
// project, with deep links back into Sentry. Renders nothing at all when
// Sentry isn't configured (SENTRY_READ_TOKEN/SENTRY_ORG unset) so this is
// invisible by default rather than showing an empty/broken card. A failed
// request is NOT the same state: it renders an explicit unavailable notice,
// because a health card that disappears reads as "nothing wrong".
export default function SentryHealthCard() {
  const [data, setData] = useState<SentryHealthResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/sentry-health")
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        return res.json();
      })
      .then((json: SentryHealthResponse) => {
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
        title="Sentry health unavailable."
        detail="Open issue counts could not be loaded."
        onRetry={() => setReloadCount((count) => count + 1)}
      />
    );
  }

  if (!data || !data.configured || !data.projects) return null;

  const totalOpen = data.projects.reduce((sum, p) => sum + p.unresolvedCount, 0);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden shadow-sm">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
              Observability & Error Health
            </h2>
            {data.fleetDashboardUrl && (
              <a
                href={data.fleetDashboardUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-0.5"
              >
                Fleet Dashboard ↗
              </a>
            )}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Sentry {data.org} · Last 14 days
          </p>
        </div>
        <div className="text-right shrink-0">
          <p
            className={`text-sm font-semibold ${
              totalOpen > 0
                ? "text-amber-600 dark:text-amber-400"
                : "text-gray-900 dark:text-gray-100"
            }`}
          >
            {totalOpen} open issues
          </p>
        </div>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-gray-700">
        {data.projects.map((project) => (
          <div
            key={project.projectSlug}
            className="flex items-center justify-between gap-4 px-6 py-3 hover:bg-gray-50 dark:hover:bg-gray-900/40 transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                {project.displayName}
              </span>
              <div className="flex items-center gap-1.5 text-xs">
                {project.dashboardUrl && (
                  <a
                    href={project.dashboardUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs px-1.5 py-0.5 rounded border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/50"
                    title="Open Sentry Dashboard"
                  >
                    Dashboard
                  </a>
                )}
                {project.datadogUrl && (
                  <a
                    href={project.datadogUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs px-1.5 py-0.5 rounded border border-purple-200 dark:border-purple-800 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-950/50"
                    title="Open Datadog APM"
                  >
                    Datadog
                  </a>
                )}
              </div>
            </div>
            <div className="shrink-0">
              {project.error ? (
                <span className="text-xs text-gray-500 dark:text-gray-400">unavailable</span>
              ) : (
                <a
                  href={project.issuesUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={`text-xs font-medium px-2 py-1 rounded-full transition-opacity hover:opacity-80 inline-block ${
                    project.unresolvedCount > 0
                      ? "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                      : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                  }`}
                >
                  {project.unresolvedCount}
                  {project.hasMore ? "+" : ""} unresolved ↗
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
