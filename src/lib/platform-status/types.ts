/**
 * Platform status contract — the shared shape every platform probe returns.
 *
 * This is the "all platforms" companion to `server-metrics.ts` (which is
 * host-centric: one Hetzner box + its Coolify apps).  Where server-metrics
 * answers "how is the box doing", this answers "how is every platform the
 * fleet depends on doing", one card per platform.
 *
 * Design rules every probe must honour:
 *  - Secrets never leave the server.  A probe reads credentials from env and
 *    returns only rendered, non-sensitive values.
 *  - A probe never throws.  Failures become a card with a state and an error
 *    code, so one dead upstream cannot blank the whole page.
 *  - Output is bounded: at most `MAX_PLATFORM_METRICS` metrics per card, each
 *    a short pre-formatted string.  No raw upstream payloads pass through.
 *  - Unconfigured is a first-class, non-alarming state — most people will not
 *    have every platform wired, and a missing token is not an outage.
 */

import type { OperationalState } from "@/lib/operations-health";

/** Reuse the Ops vocabulary so both surfaces render identical pills. */
export type PlatformState = OperationalState;

/** Grouping used for the section headers on the Platforms page. */
export type PlatformCategory =
  | "hosting"
  | "edge"
  | "storage"
  | "observability"
  | "developer"
  | "messaging"
  | "payments"
  | "secrets";

export const PLATFORM_CATEGORY_LABELS: Record<PlatformCategory, string> = {
  hosting: "Hosting & Compute",
  edge: "Edge & Network",
  storage: "Storage & Backups",
  observability: "Observability",
  developer: "Developer & Release",
  messaging: "Messaging & Delivery",
  payments: "Payments",
  secrets: "Secrets",
};

/** Hard cap so a chatty upstream cannot bloat the payload. */
export const MAX_PLATFORM_METRICS = 6;
/** Hard cap on any single rendered string a probe returns. */
export const MAX_PLATFORM_STRING_LENGTH = 120;

/**
 * One rendered fact about a platform.  `value` is already formatted for
 * display — probes do the unit conversion, the client just prints it.
 */
export interface PlatformMetric {
  label: string;
  value: string;
  /** Optional short qualifier, e.g. "free tier" or "last 24h". */
  hint?: string;
  /**
   * Optional 0–100 fill for a usage bar.  Present only when the value is a
   * quota (R2 storage).  Clients color the bar; they do not print this as %.
   */
  usagePct?: number;
}

/** One platform's card as rendered by web and iOS. */
export interface PlatformStatusCard {
  /** Stable kebab-case slug.  Never renamed — iOS and tests key off it. */
  id: string;
  /** Title Case display name, e.g. "Cloudflare". */
  name: string;
  category: PlatformCategory;
  /** True when credentials are present.  False means "not configured". */
  configured: boolean;
  state: PlatformState;
  /** One-line plain-language status.  Null when unconfigured. */
  headline: string | null;
  metrics: PlatformMetric[];
  /**
   * Env var names that would enable this platform.  Shown verbatim on
   * unconfigured cards so the owner knows exactly what to set.  Names only —
   * never values.
   */
  requiredEnv: string[];
  /** Where the owner manages this platform.  Rendered as a link. */
  consoleUrl: string | null;
  /** ISO timestamp of this probe's own fetch. */
  fetchedAt: string;
  /** Machine-readable failure reason, e.g. "unauthorized" or "timeout". */
  error?: string;
}

export interface PlatformStatusSummary {
  total: number;
  configured: number;
  healthy: number;
  degraded: number;
  unconfigured: number;
}

export interface PlatformStatusPayload {
  platforms: PlatformStatusCard[];
  summary: PlatformStatusSummary;
  /** True when at least one configured platform failed to report. */
  degraded: boolean;
  /** True when the payload came from cache past its TTL. */
  stale: boolean;
  cacheAgeSeconds: number;
  fetchedAt: string;
  warnings?: string[];
}

/**
 * What a probe implementation returns.  The registry supplies identity
 * (id/name/category/requiredEnv/consoleUrl) and the timestamp, so a probe
 * body only decides state and content.
 */
export interface PlatformProbeResult {
  state: PlatformState;
  headline: string | null;
  metrics: PlatformMetric[];
  error?: string;
}

/** A platform's static identity plus the two functions that drive it. */
export interface PlatformProbe {
  id: string;
  name: string;
  category: PlatformCategory;
  requiredEnv: string[];
  consoleUrl: string | null;
  /**
   * Whether credentials for this platform are present.  Must not perform
   * network work — the registry uses it to short-circuit to "unconfigured"
   * without spending a request.
   */
  isConfigured: () => boolean;
  /**
   * Fetch live status.  Only called when `isConfigured()` is true.  Must not
   * throw — the registry catches, but a probe that returns its own typed
   * failure produces a much better card.
   */
  probe: () => Promise<PlatformProbeResult>;
}

/** Truncate any probe-supplied string to the payload bound. */
export function boundString(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= MAX_PLATFORM_STRING_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_PLATFORM_STRING_LENGTH - 1)}…`;
}

/** Clamp and sanitize a probe's metric list. */
export function boundMetrics(metrics: PlatformMetric[]): PlatformMetric[] {
  return metrics.slice(0, MAX_PLATFORM_METRICS).map((metric) => ({
    label: boundString(metric.label),
    value: boundString(metric.value),
    ...(metric.hint ? { hint: boundString(metric.hint) } : {}),
    ...(typeof metric.usagePct === "number" && Number.isFinite(metric.usagePct)
      ? { usagePct: metric.usagePct }
      : {}),
  }));
}

/** The card shape used for a platform with no credentials configured. */
export function unconfiguredResult(): PlatformProbeResult {
  return { state: "unconfigured", headline: null, metrics: [] };
}
