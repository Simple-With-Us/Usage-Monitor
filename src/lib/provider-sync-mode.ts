import { canonicalProviderKey } from "@/lib/provider-identity";

/**
 * Providers with no successful poll path — usage/cost is push, subscription,
 * or owner-entered only. Never describe these as "stale".
 */
const MANUAL_SYNC_PROVIDER_KEYS = new Set([
  "voyage",
  "roic",
  "fmp",
  "finnhub",
  "alphavantage",
  "marketstack",
  "tiingo",
  "massive",
  "fred",
  "quiver-quant",
  "robinhood",
]);

export type ProviderSyncMode = "poll" | "manual";

/**
 * How this provider gets usage into the monitor.
 * - `poll`: adapter can refresh snapshots; age is "last sync".
 * - `manual`: never pollable — label as Manually only, not stale.
 */
export function resolveProviderSyncMode(input: {
  name: string;
  type?: string | null;
}): ProviderSyncMode {
  const type = input.type?.trim().toLowerCase() ?? "";
  if (type === "generic" || type === "push") return "manual";
  if (type === "custom") return "poll";
  const key = canonicalProviderKey(input.name);
  if (MANUAL_SYNC_PROVIDER_KEYS.has(key)) return "manual";
  return "poll";
}

/** Cap how long a pollable provider may go without a due fetch (60 minutes). */
export const MAX_POLL_FRESHNESS_MS = 60 * 60 * 1000;

/**
 * Effective poll due interval: configured interval, but pollable providers
 * never wait longer than MAX_POLL_FRESHNESS_MS so "stale" becomes "refresh".
 */
export function effectivePollDueIntervalMs(refreshIntervalMin: number): number {
  const configured = Math.max(1, refreshIntervalMin) * 60 * 1000;
  return Math.min(configured, MAX_POLL_FRESHNESS_MS);
}

/** Last-sync column / caption for Overview and provider lists. */
export function formatProviderSyncLabel(input: {
  syncMode: ProviderSyncMode;
  latestFetchedAt: string | null | undefined;
  nowMs: number;
  formatRelative: (iso: string | null, nowMs: number) => string;
}): string {
  if (input.syncMode === "manual") {
    // Even if a legacy snapshot exists, never-pollable sources are manual.
    return "Manually only";
  }
  if (!input.latestFetchedAt) return "Never synced";
  return input.formatRelative(input.latestFetchedAt, input.nowMs);
}
