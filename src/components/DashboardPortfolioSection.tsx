"use client";

import dynamic from "next/dynamic";
import { ChevronRight } from "lucide-react";
import PaidServicesPanel from "@/components/PaidServicesPanel";
import ExternalTelemetryPanel, { type ExternalUsageSummary } from "@/components/ExternalTelemetryPanel";
import ApiEquivalentCostCard from "@/components/ApiEquivalentCostCard";
import LlmBurnCard from "@/components/LlmBurnCard";
import ProjectsPanel, { type ProjectBudgetStatus } from "@/components/ProjectsPanel";
import SentryHealthCard from "@/components/SentryHealthCard";
import SentryUsageCard from "@/components/SentryUsageCard";
import DatadogUsageCard from "@/components/DatadogUsageCard";
import type { SubscriptionRow } from "@/components/SubscriptionsPanel";
import type { ChartFamilySlice } from "@/components/DashboardCharts";
import type { TimeframeOption } from "@/hooks/useDashboardData";

interface DashboardPortfolioSectionProps {
  portfolioOpen: boolean;
  onToggle: (open: boolean) => void;
  portfolioLoading: boolean;
  portfolioLoaded: boolean;
  portfolioError: string;
  fetchPortfolioData: () => Promise<void>;
  providers: any[];
  subscriptions: SubscriptionRow[];
  usageSummary: ExternalUsageSummary | null;
  projects: ProjectBudgetStatus[];
  projectSummary: { totalSpentUsd: number; unbudgetedSpentUsd: number; unassignedSpentUsd: number } | null;
  chartFamilies: ChartFamilySlice[];
  portfolioSummary: string;
  attentionCount: number;
  /** Selected chart/history range — drives DashboardCharts' burn-chart mode. */
  timeframe: TimeframeOption;
}

const DashboardCharts = dynamic(() => import("@/components/DashboardCharts"));

export default function DashboardPortfolioSection({
  portfolioOpen,
  onToggle,
  portfolioLoading,
  portfolioLoaded,
  portfolioError,
  fetchPortfolioData,
  providers,
  subscriptions,
  usageSummary,
  projects,
  projectSummary,
  chartFamilies,
  portfolioSummary,
  timeframe,
}: DashboardPortfolioSectionProps) {
  return (
    <details
      className="group"
      open={portfolioOpen}
      onToggle={(event) => {
        onToggle(event.currentTarget.open);
      }}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-2xl border border-gray-200 bg-white px-5 py-4 text-sm font-semibold text-gray-900 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent dark:focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 text-gray-400 transition-transform group-open:rotate-90" aria-hidden="true" />
        Charts, telemetry &amp; paid services
        <span className="ml-1 min-w-0 truncate text-xs font-normal text-gray-500 dark:text-gray-400">
          {portfolioSummary}
        </span>
      </summary>
      {portfolioOpen && (
        <div className="mt-8 space-y-8">
          {portfolioLoading && !portfolioLoaded && (
            <div role="status" className="rounded-xl border border-gray-200 bg-white px-6 py-5 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
              Loading portfolio detail…
            </div>
          )}
          {portfolioError && (
            <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              <span>{portfolioError}</span>{" "}
              <button
                type="button"
                onClick={() => void fetchPortfolioData()}
                className="font-semibold underline underline-offset-2"
              >
                Retry
              </button>
            </div>
          )}
          <PaidServicesPanel
            providers={providers}
            subscriptions={subscriptions}
            variant="dashboard"
            maxItems={6}
          />

          {/* Full-width: MTD pace / range history primary + breakdown secondary */}
          <DashboardCharts
            families={chartFamilies}
            timeframe={timeframe}
            dailySeries={usageSummary?.dailySeries}
            groups={usageSummary?.groups}
            rangeLoading={portfolioLoading}
          />

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            <div className="lg:col-span-2 space-y-8">
              {usageSummary && <ExternalTelemetryPanel usageSummary={usageSummary} />}

              <LlmBurnCard />

              <ApiEquivalentCostCard />

              {(projects.length > 0 || (projectSummary?.unassignedSpentUsd ?? 0) > 0) && (
                <ProjectsPanel projects={projects} summary={projectSummary} />
              )}
            </div>
            <div className="space-y-8">
              <SentryHealthCard />
              <SentryUsageCard />
              <DatadogUsageCard />
            </div>
          </div>

        </div>
      )}
    </details>
  );
}
