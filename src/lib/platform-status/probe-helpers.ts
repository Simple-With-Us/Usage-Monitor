/**
 * Shared helpers for platform probes.
 *
 * Every probe uses these rather than calling `fetch` directly: `requestJson`
 * routes through the adapter HTTP stack, which already enforces HTTPS-only
 * URLs, SSRF-safe address resolution, response size bounds and timeouts.
 */

import { fetchJson } from "@/lib/adapters/helpers";
import type { PlatformMetric, PlatformProbeResult } from "./types";

/** Probes are status checks, not data pulls — keep them short. */
export const PROBE_TIMEOUT_MS = 8_000;
/** Status endpoints are small; refuse anything that is not. */
export const PROBE_MAX_RESPONSE_BYTES = 256 * 1024;

/** First non-empty trimmed value among the given env var names. */
export function envValue(...names: string[]): string | null {
  for (const name of names) {
    const raw = process.env[name];
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  }
  return null;
}

/** Whether any of the given env var names is set to a non-empty value. */
export function hasEnv(...names: string[]): boolean {
  return envValue(...names) !== null;
}

export interface ProbeResponse {
  ok: boolean;
  status: number;
  data: unknown;
  headers: Headers;
}

/**
 * Perform a bounded, SSRF-safe JSON request for a probe.
 *
 * `security` defaults to "trusted" because probe URLs are compile-time
 * constants in this repo.  Pass "untrusted" for any operator-configurable
 * host (e.g. a self-hosted Coolify base URL).
 */
export async function requestJson(
  url: string,
  init?: RequestInit,
  options?: {
    security?: "trusted" | "untrusted";
    timeoutMs?: number;
    maxResponseBytes?: number;
  }
): Promise<ProbeResponse> {
  return fetchJson(url, init, {
    timeoutMs: options?.timeoutMs ?? PROBE_TIMEOUT_MS,
    maxResponseBytes: options?.maxResponseBytes ?? PROBE_MAX_RESPONSE_BYTES,
    security: options?.security ?? "trusted",
  });
}

/** Map an HTTP status onto the machine-readable `error` code on a card. */
export function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_error";
  return `http_${status}`;
}

/**
 * Normalize a thrown error into a probe result.  Probes call this in their
 * catch block so a network blip renders as "unreachable" rather than blanking
 * the card.
 */
export function failureResult(error: unknown, headline: string): PlatformProbeResult {
  const message = error instanceof Error ? error.message : String(error);
  const timedOut = /abort|timeout|timed out/i.test(message);
  return {
    state: "unreachable",
    headline,
    metrics: [],
    error: timedOut ? "timeout" : "unreachable",
  };
}

/** Probe result for a well-formed response that reported an upstream failure. */
export function upstreamFailure(status: number, headline: string): PlatformProbeResult {
  return {
    state: status === 401 || status === 403 ? "unavailable" : "degraded",
    headline,
    metrics: [],
    error: httpErrorCode(status),
  };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Formatting — probes render display strings so clients stay dumb.
// ---------------------------------------------------------------------------

export function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Unavailable";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let amount = Math.max(0, value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit >= 3 ? 1 : 0)} ${units[unit]}`;
}

/** Like {@link formatBytes} but drops a trailing `.0` so 10 GiB reads "10 GB". */
export function formatBytesCompact(value: number | null): string {
  return formatBytes(value).replace(/\.0 /g, " ");
}

export function formatCount(value: number | null, singular: string, plural?: string): string {
  if (value === null) return "Unavailable";
  const word = value === 1 ? singular : (plural ?? `${singular}s`);
  return `${value.toLocaleString("en-US")} ${word}`;
}

export function formatPercent(value: number | null, fractionDigits = 0): string {
  if (value === null || !Number.isFinite(value)) return "Unavailable";
  return `${value.toFixed(fractionDigits)}%`;
}

/** "3m ago" / "2d ago" from an ISO timestamp or epoch seconds. */
export function formatAge(value: string | number | null): string {
  if (value === null) return "Never";
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(ms)) return "Unavailable";
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function metric(
  label: string,
  value: string,
  hint?: string,
  usagePct?: number
): PlatformMetric {
  return {
    label,
    value,
    ...(hint ? { hint } : {}),
    ...(typeof usagePct === "number" && Number.isFinite(usagePct) ? { usagePct } : {}),
  };
}
