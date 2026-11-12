"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  PLATFORM_CATEGORY_LABELS,
  type PlatformCategory,
  type PlatformState,
  type PlatformStatusCard,
  type PlatformStatusPayload,
} from "@/lib/platform-status/types";

const REFRESH_INTERVAL_MS = 60_000;

/**
 * The house sentence gap, written for HTML.
 *
 * House style is two spaces between sentences, but HTML collapses a literal
 * double space down to one, so the gap is a non-breaking space followed by an
 * ordinary space: the NBSP survives collapsing and the ordinary space keeps
 * the pair breakable at the end of a line.  Same construction as the JSX
 * `{"\u00a0"}` + space form used in OperationsOverview.tsx.
 */
const SENTENCE_GAP = "\u00a0 ";

/**
 * Restore the sentence gap in server-supplied prose.
 *
 * Probe headlines are written with two literal spaces between sentences (the
 * same house rule, applied server-side).  Rendered into HTML as-is those two
 * spaces collapse to one, so swap every run of plain spaces for the NBSP form
 * before display.  A string with no double space comes back untouched, and the
 * transform is idempotent because an NBSP is not a plain space.
 */
export function withSentenceGaps(text: string): string {
  return text.replace(/ {2,}/g, SENTENCE_GAP);
}

/**
 * Lead-in for the unconfigured-card hint.
 *
 * Deliberately neutral about how the listed variables relate to each other.
 * `requiredEnv` is a flat list of names and the contract does not say whether a
 * platform needs all of them (App Store Connect needs the issuer ID *and* the
 * key ID *and* the private key) or any one of them, so the copy must not claim
 * either.  It names the variables and stops there.
 */
export const REQUIRED_ENV_LEAD_IN = "Set the environment variables this card uses:";

/** Color the R2 fill bar by closeness to the 10 GB free-tier cap (90% is the guard). */
export function usageBarTone(pct: number): "ok" | "watch" | "over" {
  if (pct >= 90) return "over";
  if (pct >= 50) return "watch";
  return "ok";
}

function UsageBar({ pct }: { pct: number }) {
  const width = Math.min(Math.max(pct, 0), 100);
  const tone = usageBarTone(pct);
  const fill =
    tone === "over" ? "bg-red-500" : tone === "watch" ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div
      className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700"
      role="meter"
      aria-label="Free-tier storage used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(width)}
    >
      <div className={`h-full rounded-full ${fill}`} style={{ width: `${width}%` }} />
    </div>
  );
}

/** Separator between env var names.  A comma asserts nothing; "or"/"and" would. */
export const REQUIRED_ENV_SEPARATOR = ", ";

/**
 * The slice of `document` the poll loop reads.  Narrow and injectable so the
 * visibility gating can be unit-tested without a DOM.
 */
export interface VisibilityTarget {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Poll `onTick` on an interval, but only while the page is actually visible.
 *
 * A background tab firing a full platform sweep every minute burns vendor API
 * quota for a render nobody can see, so ticks are skipped outright while the
 * document is hidden and a single catch-up tick fires the moment it becomes
 * visible again — the page a viewer comes back to is fresh, not a minute stale.
 *
 * Returns the cleanup: it stops the timer and drops the listener, so an
 * unmount leaves nothing behind.
 */
export function startVisiblePolling(
  onTick: () => void,
  intervalMs: number,
  target: VisibilityTarget | null,
): () => void {
  const isHidden = () => target?.visibilityState === "hidden";
  let wasHidden = isHidden();

  const timer = setInterval(() => {
    if (isHidden()) return;
    onTick();
  }, intervalMs);

  const handleVisibilityChange = () => {
    const hidden = isHidden();
    if (wasHidden && !hidden) onTick();
    wasHidden = hidden;
  };

  target?.addEventListener("visibilitychange", handleVisibilityChange);

  return () => {
    clearInterval(timer);
    target?.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}

/** Section order on the page.  Mirrors the registry's probe order. */
const CATEGORY_ORDER: PlatformCategory[] = [
  "hosting",
  "edge",
  "storage",
  "observability",
  "developer",
  "messaging",
  "payments",
  "secrets",
];

function stateLabel(state: PlatformState): string {
  return {
    healthy: "Healthy",
    receiving: "Receiving",
    degraded: "Degraded",
    stale: "Stale",
    unavailable: "Unavailable",
    unreachable: "Unreachable",
    unconfigured: "Not configured",
  }[state];
}

function stateClasses(state: PlatformState): string {
  if (state === "healthy" || state === "receiving") {
    return "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
  }
  if (state === "degraded" || state === "stale") {
    return "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
  }
  if (state === "unavailable" || state === "unreachable") {
    return "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300";
  }
  return "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300";
}

function StatePill({ state }: { state: PlatformState }) {
  return (
    <span className={`shrink-0 rounded-full px-2 py-1 text-xs font-medium ${stateClasses(state)}`}>
      {stateLabel(state)}
    </span>
  );
}

function PlatformCardView({ platform }: { platform: PlatformStatusCard }) {
  const muted = !platform.configured;
  return (
    <section
      aria-labelledby={`platform-${platform.id}-heading`}
      className={`flex flex-col rounded-xl border p-4 ${
        muted
          ? "border-dashed border-gray-200 bg-gray-50/60 dark:border-gray-700 dark:bg-gray-900/40"
          : "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3
          id={`platform-${platform.id}-heading`}
          className={`text-sm font-semibold ${
            muted
              ? "text-gray-500 dark:text-gray-400"
              : "text-gray-900 dark:text-gray-100"
          }`}
        >
          {platform.name}
        </h3>
        <StatePill state={platform.state} />
      </div>

      {platform.headline ? (
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          {withSentenceGaps(platform.headline)}
        </p>
      ) : null}

      {platform.configured && platform.metrics.length > 0 ? (
        <dl className="mt-3 space-y-4">
          {platform.metrics.map((entry) => (
            <div key={entry.label} className="flex items-center justify-between gap-3 text-sm">
              <dt className="text-gray-500 dark:text-gray-400">{entry.label}</dt>
              <dd className="flex min-w-0 flex-col items-stretch">
                <span className="whitespace-nowrap text-right font-medium text-gray-900 dark:text-gray-100">
                  {entry.value}
                  {entry.hint ? (
                    <span className="ml-1 font-normal text-xs text-gray-500 dark:text-gray-400">
                      {entry.hint}
                    </span>
                  ) : null}
                </span>
                {typeof entry.usagePct === "number" ? <UsageBar pct={entry.usagePct} /> : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {muted && platform.requiredEnv.length > 0 ? (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {REQUIRED_ENV_LEAD_IN}{" "}
          {platform.requiredEnv.map((name, index) => (
            <span key={name}>
              {index > 0 ? REQUIRED_ENV_SEPARATOR : ""}
              <code className="rounded bg-gray-200 px-1 py-0.5 font-mono text-[11px] dark:bg-gray-700">
                {name}
              </code>
            </span>
          ))}
          .
        </p>
      ) : null}

      <div className="mt-auto flex items-center justify-between gap-2 pt-3">
        {platform.consoleUrl ? (
          <a
            href={platform.consoleUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-300"
          >
            Open console
          </a>
        ) : (
          <span />
        )}
        {platform.error ? (
          <span className="font-mono text-[11px] text-gray-500 dark:text-gray-400">
            {platform.error}
          </span>
        ) : null}
      </div>
    </section>
  );
}

export default function PlatformsPageClient() {
  const [data, setData] = useState<PlatformStatusPayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/platform-status", {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error(`status_${response.status}`);
      const payload = (await response.json()) as PlatformStatusPayload;
      setData(payload);
      setError("");
    } catch (cause) {
      if ((cause as Error)?.name === "AbortError") return;
      setError("Platform status could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const stopPolling = startVisiblePolling(
      () => void load(),
      REFRESH_INTERVAL_MS,
      typeof document === "undefined" ? null : document,
    );
    return () => {
      controller.abort();
      stopPolling();
    };
  }, [load]);

  const summary = data?.summary;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Platforms</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Live status for every platform the fleet runs on.{"\u00a0"} Not part of your
            spend totals.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Refresh
        </button>
      </div>

      {summary ? (
        <p className="text-sm text-gray-600 dark:text-gray-300">
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {summary.healthy} healthy
          </span>{" "}
          · {summary.degraded} need attention · {summary.configured} configured ·{" "}
          {summary.unconfigured} not configured
          {data?.stale ? " · showing cached data" : ""}
        </p>
      ) : null}

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}

      {loading && !data ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Loading platform status…</p>
      ) : null}

      {CATEGORY_ORDER.map((category) => {
        const platforms = (data?.platforms ?? []).filter((p) => p.category === category);
        if (platforms.length === 0) return null;
        return (
          <section key={category} aria-labelledby={`category-${category}`} className="space-y-3">
            <h2
              id={`category-${category}`}
              className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
            >
              {PLATFORM_CATEGORY_LABELS[category]}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {platforms.map((platform) => (
                <PlatformCardView key={platform.id} platform={platform} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
