"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { ExternalUsageSummary } from "@/components/ExternalTelemetryPanel";
import type { ProjectBudgetStatus } from "@/components/ProjectsPanel";
import type { SubscriptionRow } from "@/components/SubscriptionsPanel";

export interface ProjectBudgetResponse {
  projects: ProjectBudgetStatus[];
  summary: {
    totalSpentUsd: number;
    unbudgetedSpentUsd: number;
    unassignedSpentUsd: number;
  };
}

export type TimeframeOption =
  | "1d"
  | "7d"
  | "30d"
  | "90d"
  | "180d"
  | "365d"
  | "all"
  | `month:${string}`  // e.g. "month:2026-08" — calendar month
  | `year:${string}`;  // e.g. "year:2026" — calendar year

export function isCalendarMonth(tf: TimeframeOption): tf is `month:${string}` {
  return (tf as string).startsWith("month:");
}

export function isCalendarYear(tf: TimeframeOption): tf is `year:${string}` {
  return (tf as string).startsWith("year:");
}

export function isRollingPeriod(tf: TimeframeOption): boolean {
  return !isCalendarMonth(tf) && !isCalendarYear(tf);
}

/** Return the current UTC calendar month token, e.g. "month:2026-08". */
export function currentMonthToken(): TimeframeOption {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `month:${y}-${m}` as TimeframeOption;
}

function parseMonthToken(tf: string): { year: number; month: number } | null {
  const match = tf.match(/^month:(\d{4})-(\d{2})$/);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
}

function parseYearToken(tf: string): number | null {
  const match = tf.match(/^year:(\d{4})$/);
  if (!match) return null;
  return Number(match[1]);
}

/**
 * Build the /api/usage-events URL for a given timeframe.
 * Rolling periods use ?days=N; calendar months/years use ?from=&to=.
 */
export function buildUsageEventsUrl(
  tf: TimeframeOption,
  projectId?: string | null
): string {
  const projectSuffix = projectId ? `&projectId=${encodeURIComponent(projectId)}` : "";

  if (isCalendarMonth(tf)) {
    const parsed = parseMonthToken(tf as string);
    if (!parsed) return `/api/usage-events?days=30${projectSuffix}`;
    const { year, month } = parsed;
    const from = `${year}-${String(month).padStart(2, "0")}-01`;
    // Last day of month via day-0 trick
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const to = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    return `/api/usage-events?from=${from}&to=${to}${projectSuffix}`;
  }

  if (isCalendarYear(tf)) {
    const year = parseYearToken(tf as string);
    if (!year) return `/api/usage-events?days=365${projectSuffix}`;
    return `/api/usage-events?from=${year}-01-01&to=${year}-12-31${projectSuffix}`;
  }

  // Rolling period
  const days = timeframeToDays(tf);
  if (days >= 3650) return `/api/usage-events?days=all${projectSuffix}`;
  return `/api/usage-events?days=${days}${projectSuffix}`;
}

/**
 * Human-readable label for a history/chart range (picker + UI).
 * Always describes the selected token — never substitutes MTD month for rolling.
 */
export function timeframeDisplayLabel(tf: TimeframeOption): string {
  switch (tf as string) {
    case "1d":
      return "Past 24 hours";
    case "7d":
      return "Past 7 days";
    case "30d":
      return "Past 30 days";
    case "90d":
      return "Past 90 days";
    case "180d":
      return "Past 180 days";
    case "365d":
      return "Past 12 months";
    case "all":
      return "All time";
  }
  if (isCalendarMonth(tf)) {
    const parsed = parseMonthToken(tf as string);
    if (!parsed) return tf as string;
    if (tf === currentMonthToken()) return "This month";
    const date = new Date(Date.UTC(parsed.year, parsed.month - 1, 1));
    return date.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  if (isCalendarYear(tf)) {
    const year = parseYearToken(tf as string);
    return year ? String(year) : (tf as string);
  }
  return tf as string;
}

/** Alias for chart/telemetry surfaces — same as timeframeDisplayLabel. */
export function historyRangeLabel(tf: TimeframeOption): string {
  return timeframeDisplayLabel(tf);
}

/** Compact label for the active "More" chip (e.g. "Jul 2026", "2025", "All"). */
export function timeframeShortLabel(tf: TimeframeOption): string {
  switch (tf as string) {
    case "1d":
      return "24h";
    case "7d":
      return "7d";
    case "30d":
      return "30d";
    case "90d":
      return "90d";
    case "180d":
      return "180d";
    case "365d":
      return "12m";
    case "all":
      return "All";
  }
  if (isCalendarMonth(tf)) {
    const parsed = parseMonthToken(tf as string);
    if (!parsed) return "Month";
    if (tf === currentMonthToken()) return "This month";
    const date = new Date(Date.UTC(parsed.year, parsed.month - 1, 1));
    return date.toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  if (isCalendarYear(tf)) {
    const year = parseYearToken(tf as string);
    return year ? String(year) : "Year";
  }
  return "More";
}

/** True when `tf` is the primary-rail "This month" selection (current UTC month). */
export function isCurrentCalendarMonth(tf: TimeframeOption): boolean {
  return isCalendarMonth(tf) && tf === currentMonthToken();
}

/** True when `tf` is one of the primary chips (This month / 30d / 90d / 180d / 365d / 7d). */
export function isPrimaryHistoryChip(tf: TimeframeOption): boolean {
  if (tf === "30d" || tf === "90d" || tf === "180d" || tf === "365d" || tf === "7d") return true;
  return isCurrentCalendarMonth(tf);
}

/**
 * MTD budget surfaces only — always the current UTC calendar month name.
 * Do not use for chart/history range display (use historyRangeLabel).
 */
export function mtdSpendLabel(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * @deprecated Prefer mtdSpendLabel() for budgets or historyRangeLabel(tf) for charts.
 * Rolling/year/all → current month name (budget truth). Calendar month → that month.
 */
export function spendPeriodLabel(tf: TimeframeOption): string {
  if (isCalendarMonth(tf)) {
    const parsed = parseMonthToken(tf as string);
    if (!parsed) return mtdSpendLabel();
    const date = new Date(Date.UTC(parsed.year, parsed.month - 1, 1));
    return date.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  return mtdSpendLabel();
}

/**
 * Generate an array of calendar-month TimeframeOptions, newest first.
 * count=13 gives the current month + the previous 12.
 */
export function generateMonthOptions(
  count = 13
): Array<{ token: TimeframeOption; label: string }> {
  const options: Array<{ token: TimeframeOption; label: string }> = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    // Subtract i months from the current UTC month
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const y = date.getUTCFullYear();
    const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
    const token: TimeframeOption = `month:${y}-${mo}` as TimeframeOption;
    const label = date.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    options.push({ token, label });
  }
  return options;
}

/**
 * Generate an array of calendar-year TimeframeOptions, newest first.
 */
export function generateYearOptions(
  count = 3
): Array<{ token: TimeframeOption; label: string }> {
  const currentYear = new Date().getUTCFullYear();
  return Array.from({ length: count }, (_, i) => {
    const year = currentYear - i;
    return { token: `year:${year}` as TimeframeOption, label: String(year) };
  });
}

export function timeframeToDays(tf: TimeframeOption): number {
  switch (tf) {
    case "1d":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "180d":
      return 180;
    case "365d":
      return 365;
    case "all":
      return 3650;
    default:
      // calendar-month / year — approximate to avoid NaN downstream
      return 30;
  }
}

/** Must exceed the per-request AbortSignal.timeout (30s) so normal timeouts win first. */
export const DASHBOARD_LOAD_WATCHDOG_MS = 35_000;

/**
 * Full-page skeleton only before the first fetch settles *and* we have nothing
 * to show. Once providers are on screen, later loading/refresh flags must not
 * blank the dashboard (that was the flash-then-stuck-skeleton bug).
 */
export function shouldShowDashboardSkeleton(opts: {
  loading: boolean;
  providerCount: number;
}): boolean {
  return opts.loading && opts.providerCount === 0;
}

/**
 * Compose a timeout signal with an optional external (unmount) signal.
 * Feature-detect AbortSignal.any — older WebKit throws if called bare, and a
 * sync throw *outside* fetchJson's try used to reject before the route timeout
 * path could run.
 */
export function combineAbortSignals(
  timeout: AbortSignal,
  external?: AbortSignal | null
): AbortSignal {
  if (external == null) return timeout;
  if (typeof AbortSignal.any !== "function") return timeout;
  try {
    return AbortSignal.any([timeout, external]);
  } catch {
    return timeout;
  }
}

async function fetchJson<T>(url: string, label: string, signal?: AbortSignal): Promise<T> {
  // 30s matches main (#816); compose with unmount abort so remounts cannot
  // inherit a stuck in-flight request.
  try {
    const timeout =
      typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(30_000)
        : undefined;
    const combined =
      timeout != null ? combineAbortSignals(timeout, signal) : signal;
    const response = await fetch(url, {
      cache: "no-store",
      ...(combined != null ? { signal: combined } : {}),
    });
    if (response.status === 401 && typeof window !== "undefined" && window.location.pathname !== "/login") {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      throw new Error("Session expired. Redirecting to login...");
    }
    if (!response.ok) {
      const contentType = response.headers.get("content-type") || "";
      // Cloudflare managed challenges return HTML 403; surface a clear retry
      // instead of a generic parse/empty-body failure.
      if (contentType.includes("text/html")) {
        throw new Error(
          `Failed to fetch ${label} (HTTP ${response.status}). A network challenge may be blocking API requests — tap Retry, or reload the page.`
        );
      }
      const body = await response.json().catch(() => ({}));
      throw new Error(
        (body as { error?: string }).error || `Failed to fetch ${label}`
      );
    }
    return (await response.json()) as T;
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : "";
    const message = err instanceof Error ? err.message : String(err ?? "");
    if (
      name === "AbortError" ||
      name === "TimeoutError" ||
      message.toLowerCase().includes("aborted") ||
      message.toLowerCase().includes("timed out")
    ) {
      throw new Error(`Connection timed out loading ${label}. Please click Retry.`);
    }
    throw err;
  }
}

const AUTO_REFRESH_INTERVAL_MS = 60_000;
const FOCUS_REFRESH_THROTTLE_MS = 15_000;

export function useDashboardData() {
  const [timeframe, setTimeframe] = useState<TimeframeOption>("30d");
  const [providers, setProviders] = useState<any[]>([]);
  const [usageSummary, setUsageSummary] = useState<ExternalUsageSummary | null>(null);
  const [projects, setProjects] = useState<ProjectBudgetStatus[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [projectSummary, setProjectSummary] = useState<ProjectBudgetResponse["summary"] | null>(null);
  const [portfolioOpen, setPortfolioOpen] = useState(false);
  const [portfolioLoaded, setPortfolioLoaded] = useState(false);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [portfolioError, setPortfolioError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const loadedOnce = useRef(false);
  const hasProviderData = useRef(false);
  const isFetchingRef = useRef(false);
  const pendingForegroundRef = useRef(false);
  const pendingBackgroundRef = useRef(false);
  const lastSuccessAtRef = useRef(0);
  const portfolioFetchInFlightRef = useRef(false);
  const fetchGenerationRef = useRef(0);
  const fetchStartedAtRef = useRef(0);
  const unmountAbortRef = useRef<AbortController | null>(null);
  const staleRefreshStartedRef = useRef(false);

  const fetchProviders = useCallback(async (opts?: { background?: boolean }) => {
    const background = opts?.background === true;

    // Coalesce overlapping calls onto the in-flight request instead of
    // flipping loading/refreshing UI and returning with nobody owning cleanup.
    // If the lock looks orphaned (no settle past the request timeout), clear it
    // so a Retry / resume can start a real fetch again.
    if (isFetchingRef.current) {
      const startedAt = fetchStartedAtRef.current;
      const orphaned =
        startedAt > 0 && Date.now() - startedAt > DASHBOARD_LOAD_WATCHDOG_MS;
      if (!orphaned) {
        if (background) pendingBackgroundRef.current = true;
        else pendingForegroundRef.current = true;
        if (!background && loadedOnce.current) {
          setRefreshing(true);
        }
        return;
      }
      isFetchingRef.current = false;
      pendingForegroundRef.current = false;
      pendingBackgroundRef.current = false;
    }
    isFetchingRef.current = true;
    fetchStartedAtRef.current = Date.now();
    const generation = ++fetchGenerationRef.current;

    // Initial useState(true) covers the first paint. Never set loading back to
    // true after that — blanking the page after data appeared is the flash bug.
    if (!background && loadedOnce.current) {
      setRefreshing(true);
    }
    if (!background) {
      setError("");
      setWarnings([]);
    }

    const signal = unmountAbortRef.current?.signal;

    try {
      const [providersResult, subscriptionsResult] = await Promise.allSettled([
        fetchJson<unknown[]>("/api/providers?view=dashboard", "providers", signal),
        fetchJson<SubscriptionRow[]>("/api/subscriptions", "paid services", signal),
      ]);

      // Stale generation after unmount/remount — do not touch UI state.
      if (generation !== fetchGenerationRef.current) return;

      const nextWarnings: string[] = [];
      if (providersResult.status === "fulfilled") {
        setProviders(providersResult.value);
        hasProviderData.current = true;
        setError("");
      } else if (!hasProviderData.current) {
        setError(
          providersResult.reason instanceof Error
            ? providersResult.reason.message
            : "Failed to load providers"
        );
      } else {
        nextWarnings.push("Provider data could not be refreshed; showing the last successful result.");
      }

      if (subscriptionsResult.status === "fulfilled") {
        setSubscriptions(subscriptionsResult.value);
      } else {
        nextWarnings.push("Tracked subscriptions are temporarily unavailable.");
      }

      setWarnings(nextWarnings);
      if (providersResult.status === "fulfilled") {
        setLastUpdatedAt(new Date().toISOString());
        lastSuccessAtRef.current = Date.now();
        if (!staleRefreshStartedRef.current) {
          staleRefreshStartedRef.current = true;
          void fetch("/api/providers/refresh-stale", { method: "POST" })
            .then(async (res) => {
              if (!res.ok) return;
              const body = (await res.json().catch(() => null)) as {
                refreshed?: number;
              } | null;
              if ((body?.refreshed ?? 0) > 0) {
                void fetchProviders({ background: true });
              }
            })
            .catch(() => {
              /* refresh is best-effort; the 15-minute poll still runs */
            });
        }
      }
    } finally {
      // Only the live generation may release the coalesce lock or touch UI.
      // Clearing isFetching on a stale finally races a remounted in-flight
      // fetch and can start overlapping requests. Freeze/hang recovery is the
      // watchdog + bfcache/visibility handlers below.
      if (generation === fetchGenerationRef.current) {
        loadedOnce.current = true;
        setLoading(false);
        setRefreshing(false);
        isFetchingRef.current = false;

        const needForeground = pendingForegroundRef.current;
        const needBackground = pendingBackgroundRef.current;
        pendingForegroundRef.current = false;
        pendingBackgroundRef.current = false;
        if (needForeground) {
          void fetchProviders();
        } else if (needBackground) {
          void fetchProviders({ background: true });
        }
      }
    }
  }, []);

  const fetchPortfolioData = useCallback(async (overrideTimeframe?: TimeframeOption) => {
    const activeTimeframe = overrideTimeframe ?? timeframe;
    const usageEventsUrl = buildUsageEventsUrl(activeTimeframe);
    if (portfolioFetchInFlightRef.current) return;
    portfolioFetchInFlightRef.current = true;
    setPortfolioLoading(true);
    setPortfolioError("");
    const failures: string[] = [];
    try {
      // Independent endpoints — neither writes state the other reads, so pay
      // max(latency) rather than the sum. Same pattern as fetchProviders above.
      const [usageResult, projectsResult] = await Promise.allSettled([
        fetchJson<ExternalUsageSummary>(
          usageEventsUrl,
          "app telemetry",
          unmountAbortRef.current?.signal
        ),
        fetchJson<ProjectBudgetResponse>(
          "/api/projects?includeSummary=1",
          "projects",
          unmountAbortRef.current?.signal
        ),
      ]);
      if (usageResult.status === "fulfilled") {
        setUsageSummary(usageResult.value);
      } else {
        failures.push("External app telemetry is temporarily unavailable.");
      }
      if (projectsResult.status === "fulfilled") {
        setProjects(projectsResult.value.projects);
        setProjectSummary(projectsResult.value.summary);
      } else {
        failures.push("Project budgets are temporarily unavailable.");
      }
      setPortfolioError(failures.join(" "));
      setPortfolioLoaded(failures.length === 0);
    } finally {
      setPortfolioLoading(false);
      portfolioFetchInFlightRef.current = false;
    }
  }, [timeframe]);

  const refreshDashboard = useCallback(async () => {
    // Disjoint state, independent in-flight guards, and neither rejects — so
    // these can overlap instead of stacking two round trips.
    await Promise.all([
      fetchProviders(),
      portfolioOpen ? fetchPortfolioData() : Promise.resolve(),
    ]);
  }, [fetchPortfolioData, fetchProviders, portfolioOpen]);

  // Initial load + abort in-flight work on unmount so a remount cannot inherit
  // a stuck isFetching guard from a discarded instance.
  useEffect(() => {
    const controller = new AbortController();
    unmountAbortRef.current = controller;
    void fetchProviders();
    return () => {
      fetchGenerationRef.current += 1;
      isFetchingRef.current = false;
      pendingForegroundRef.current = false;
      pendingBackgroundRef.current = false;
      controller.abort();
      if (unmountAbortRef.current === controller) {
        unmountAbortRef.current = null;
      }
    };
  }, [fetchProviders]);

  // bfcache restore: page was frozen mid-fetch with no React unmount cleanup.
  // Only act on event.persisted so the initial pageshow cannot double-fetch.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      isFetchingRef.current = false;
      fetchStartedAtRef.current = 0;
      pendingForegroundRef.current = false;
      pendingBackgroundRef.current = false;
      void fetchProviders({ background: loadedOnce.current });
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [fetchProviders]);

  // If a prior attempt settled without providers (error UI) and the tab becomes
  // visible again, clear any orphaned coalesce lock so Retry/focus can proceed.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) return;
      if (hasProviderData.current) return;
      if (!loadedOnce.current) return;
      const startedAt = fetchStartedAtRef.current;
      const orphaned =
        isFetchingRef.current &&
        startedAt > 0 &&
        Date.now() - startedAt > DASHBOARD_LOAD_WATCHDOG_MS;
      if (orphaned) {
        isFetchingRef.current = false;
        fetchStartedAtRef.current = 0;
        pendingForegroundRef.current = false;
        pendingBackgroundRef.current = false;
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // Last-resort watchdog: if the initial skeleton is still up past the request
  // timeout, force an error+Retry UI. Covers hung fetches where AbortSignal
  // never fires (background tabs, broken signal composition, CF-held sockets)
  // and orphaned isFetching coalesce locks.
  useEffect(() => {
    if (!loading || hasProviderData.current) return;
    const id = window.setTimeout(() => {
      if (hasProviderData.current) return;
      isFetchingRef.current = false;
      fetchStartedAtRef.current = 0;
      pendingForegroundRef.current = false;
      pendingBackgroundRef.current = false;
      loadedOnce.current = true;
      setLoading(false);
      setRefreshing(false);
      setError((prev) =>
        prev ||
        "Dashboard load timed out. Please click Retry."
      );
    }, DASHBOARD_LOAD_WATCHDOG_MS);
    return () => window.clearTimeout(id);
  }, [loading]);

  // Auto-refresh on interval + focus/visibility
  useEffect(() => {
    const refreshIfDue = () => {
      if (document.hidden) return;
      if (Date.now() - lastSuccessAtRef.current < FOCUS_REFRESH_THROTTLE_MS) return;
      fetchProviders({ background: true });
    };

    const handleIntervalTick = () => {
      if (document.hidden) return;
      fetchProviders({ background: true });
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) refreshIfDue();
    };

    const intervalId = window.setInterval(handleIntervalTick, AUTO_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshIfDue);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshIfDue);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchProviders]);

  // Range-scoped fetch (usage events + project budgets) for the chart /
  // telemetry section. Runs on mount and whenever `timeframe` changes
  // (fetchPortfolioData's identity changes with it — see its useCallback
  // deps above), regardless of whether the portfolio panel is expanded.
  // The chart-range control sits above the chart unconditionally, so
  // selecting a new range must never be a no-op just because the section
  // happens to be collapsed. One grouped query + one project query — cheap
  // enough to always run.
  useEffect(() => {
    void fetchPortfolioData();
  }, [fetchPortfolioData]);

  // Poll for fresher portfolio/chart data only while the section is open —
  // no point refreshing data nobody can see. The fetch above already covers
  // the initial load and every timeframe change.
  useEffect(() => {
    if (!portfolioOpen) return;
    const interval = window.setInterval(() => {
      if (!document.hidden) void fetchPortfolioData();
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [fetchPortfolioData, portfolioOpen]);

  const openAttentionPanel = useCallback(() => {
    window.requestAnimationFrame(() => {
      document.getElementById("attention")?.scrollIntoView({ block: "start" });
    });
  }, []);

  // Hash-based attention navigation
  useEffect(() => {
    const openIfAttentionHash = () => {
      if (window.location.hash !== "#attention") return;
      openAttentionPanel();
    };
    openIfAttentionHash();
    window.addEventListener("hashchange", openIfAttentionHash);
    return () => window.removeEventListener("hashchange", openIfAttentionHash);
  }, [loading, openAttentionPanel]);

  return {
    timeframe,
    setTimeframe,
    providers,
    usageSummary,
    projects,
    subscriptions,
    projectSummary,
    portfolioOpen,
    setPortfolioOpen,
    portfolioLoaded,
    portfolioLoading,
    portfolioError,
    loading,
    refreshing,
    error,
    warnings,
    lastUpdatedAt,
    fetchProviders,
    fetchPortfolioData,
    refreshDashboard,
    openAttentionPanel,
  };
}
