/**
 * Read-only Datadog estimated-usage snapshot for the Free-tier live card.
 *
 * Queries datadog.estimated_usage.* so the 5-host / log / APM conversion trap
 * is visible inside Usage Monitor.  Never ships UM's own logs into Datadog.
 * Requires DD_API_KEY + DD_APP_KEY (or DATADOG_* aliases).  Fail-closed.
 */

import { DEFAULT_DD_SITE, parseDatadogSite } from "@/lib/datadog-options";
import { fetchJson } from "@/lib/adapters/helpers";

export const DATADOG_HOST_CAP = 5;
export const DATADOG_LLM_SPAN_MONTHLY_CAP = 40_000;

const QUERY_TIMEOUT_MS = 8_000;
const QUERY_MAX_BYTES = 64 * 1024;

export interface DatadogUsageSnapshot {
  configured: true;
  site: string;
  hosts: number | null;
  containers: number | null;
  logsIngestedEvents: number | null;
  apmIngestedSpans: number | null;
  fetchedAt: string;
  consoleUrl: string;
}

export interface DatadogUsageUnconfigured {
  configured: false;
}

export type DatadogUsageResult = DatadogUsageSnapshot | DatadogUsageUnconfigured;

function readApiKey(): string | null {
  const value = process.env.DD_API_KEY?.trim() || process.env.DATADOG_API_KEY?.trim();
  return value || null;
}

function readAppKey(): string | null {
  const value = process.env.DD_APP_KEY?.trim() || process.env.DATADOG_APP_KEY?.trim();
  return value || null;
}

export function isDatadogUsageConfigured(): boolean {
  return Boolean(readApiKey() && readAppKey());
}

function lastPoint(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const series = (payload as { series?: unknown }).series;
  if (!Array.isArray(series) || series.length === 0) return null;
  const first = series[0];
  if (!first || typeof first !== "object") return null;
  const pointlist = (first as { pointlist?: unknown }).pointlist;
  if (!Array.isArray(pointlist) || pointlist.length === 0) return null;
  for (let i = pointlist.length - 1; i >= 0; i -= 1) {
    const point = pointlist[i];
    if (!Array.isArray(point) || point.length < 2) continue;
    const value = point[1];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

async function queryMetric(query: string, site: string, apiKey: string, appKey: string): Promise<number | null> {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 3600;
  const url =
    `https://api.${site}/api/v1/query?from=${from}&to=${to}&query=${encodeURIComponent(query)}`;
  const response = await fetchJson(
    url,
    {
      method: "GET",
      headers: {
        "DD-API-KEY": apiKey,
        "DD-APPLICATION-KEY": appKey,
        accept: "application/json",
      },
    },
    {
      timeoutMs: QUERY_TIMEOUT_MS,
      maxResponseBytes: QUERY_MAX_BYTES,
      security: "trusted",
    }
  );
  if (!response.ok) {
    throw new Error(`Datadog query failed (${response.status})`);
  }
  return lastPoint(response.data);
}

export async function fetchDatadogUsage(): Promise<DatadogUsageResult> {
  const apiKey = readApiKey();
  const appKey = readAppKey();
  if (!apiKey || !appKey) return { configured: false };

  const site = parseDatadogSite(process.env.DD_SITE, DEFAULT_DD_SITE);
  const hosts = await queryMetric("avg:datadog.estimated_usage.hosts{*}", site, apiKey, appKey);
  const containers = await queryMetric("avg:datadog.estimated_usage.containers{*}", site, apiKey, appKey);
  const logsIngestedEvents = await queryMetric(
    "sum:datadog.estimated_usage.logs.ingested_events{*}",
    site,
    apiKey,
    appKey
  );
  const apmIngestedSpans = await queryMetric(
    "sum:datadog.estimated_usage.apm.ingested_spans{*}",
    site,
    apiKey,
    appKey
  );

  return {
    configured: true,
    site,
    hosts,
    containers,
    logsIngestedEvents,
    apmIngestedSpans,
    fetchedAt: new Date().toISOString(),
    consoleUrl: `https://${site === "datadoghq.com" ? "app.datadoghq.com" : site}/dash/list`,
  };
}
