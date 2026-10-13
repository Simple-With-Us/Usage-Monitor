"use client";

import React, { useEffect, useId, useState } from "react";
import { ChevronDown, Gauge, Clock } from "lucide-react";
import type { QuotaSourceReading } from "@/lib/quota-groups";
import { windowKeyToDisplayLabel } from "@/lib/quota-window-display";
import {
  EXPECTED_QUOTA_PROVIDERS,
  antigravityDisplayLabel,
  quotaProviderKey,
  quotaProviderLabel,
  quotaProviderVia,
} from "@/lib/quota-windows";
import {
  quotaSourceReadingSchema,
  quotaWindowsClientResponseSchema,
} from "@/lib/quota-windows-client-schema";

const SENTENCE_GAP = "  ";

/**
 * Exact copy for a provider with no reported windows yet. Exported as a
 * single source of truth so the component test can assert on it without
 * duplicating the NBSP sentence gap by hand.
 */
const EMPTY_STATE_COPY = `No quota report yet.${SENTENCE_GAP}Install the subscription quota collector on the Mac.`;

export type QuotaWindowStatus = "available" | "near_cap" | "exhausted" | "unknown";

export interface NormalizedWindow {
  id: string;
  label: string;
  window: string | null;
  remainingPercent: number | null;
  remainingUnknown: boolean;
  status: QuotaWindowStatus;
  resetAt: string | null;
  via: string | null;
  collector?: string | null;
  source?: string | null;
  sourceApp?: string | null;
  machine?: string | null;
  occurredAt?: string | null;
}

export interface NormalizedGroup {
  provider: string;
  providerLabel: string;
  via: string | null;
  windows: NormalizedWindow[];
}

export interface MergedQuotaWindowView {
  id: string;
  provider: string;
  providerLabel: string;
  windowKey: string;
  displayName: string;
  rawKey: string;
  platformTitle: string | null;
  primary: QuotaSourceReading;
  sources: QuotaSourceReading[];
  olderSources: QuotaSourceReading[];
}

/** Reset / time-remaining copy — always high-contrast (≥ 4.5:1), never faint grey. */
export const QUOTA_TIME_REMAINING_CLASS =
  "text-xs font-semibold text-gray-950 dark:text-gray-50 shrink-0 whitespace-nowrap";

export interface MergedProviderSection {
  provider: string;
  providerLabel: string;
  windows: MergedQuotaWindowView[];
}

/** Orange Anthropic starburst — never a monochrome variant. */
const CLAUDE_LOGO_SRC = "/logos/claude.svg";

const PROVIDER_LOGOS: Record<string, string> = {
  anthropic: CLAUDE_LOGO_SRC,
  openai: "/logos/openai.svg",
  "google-antigravity": "/logos/antigravity.svg",
  xai: "/logos/grok.svg",
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeStatus(value: unknown, remainingUnknown: boolean): QuotaWindowStatus {
  if (
    value === "available" ||
    value === "near_cap" ||
    value === "exhausted" ||
    value === "unknown"
  ) {
    return value;
  }
  return remainingUnknown ? "unknown" : "available";
}

function quotaWindowHeading(window: string): string {
  const value = window.trim().toLowerCase();
  if (value === "5h" || value === "7d") return `${value} Window`;
  if (value === "5-hour") return "5-Hour Window";
  return `${value.charAt(0).toUpperCase()}${value.slice(1)} Window`;
}

function normalizeWindow(
  raw: unknown,
  fallbackVia: string | null,
  fallbackId: string,
): NormalizedWindow {
  const rec = asRecord(raw);
  const remainingPercent = asNumber(rec.remainingPercent);
  const remainingUnknown = rec.remainingUnknown === true || remainingPercent == null;
  const via = asString(rec.via) ?? fallbackVia;
  const label = asString(rec.label) ?? "Quota window";
  return {
    id: asString(rec.id) ?? fallbackId,
    label: via === "antigravity" ? antigravityDisplayLabel(label) : label,
    window: asString(rec.window),
    remainingPercent,
    remainingUnknown,
    status: normalizeStatus(rec.status, remainingUnknown),
    resetAt: asString(rec.resetAt),
    via,
    collector: asString(rec.collector),
    source: asString(rec.source),
    sourceApp: asString(rec.sourceApp),
    machine: asString(rec.machine),
    occurredAt: asString(rec.occurredAt),
  };
}

export function buildProviderGroups(data: unknown): NormalizedGroup[] {
  const rec = asRecord(data);
  const rawGroups = asArray(rec.providerGroups);

  if (rawGroups.length > 0) {
    return rawGroups.map((rawGroup, groupIndex) => {
      const groupRec = asRecord(rawGroup);
      const provider = asString(groupRec.provider) ?? `unknown-${groupIndex}`;
      const providerLabel = asString(groupRec.providerLabel) ?? quotaProviderLabel(provider);
      const via = asString(groupRec.via) ?? quotaProviderVia(provider);
      const windows = asArray(groupRec.windows).map((rawWindow, windowIndex) =>
        normalizeWindow(rawWindow, via, `${provider}-${windowIndex}`),
      );
      return { provider, providerLabel, via, windows };
    });
  }

  const groups = new Map<string, NormalizedGroup>();
  for (const provider of EXPECTED_QUOTA_PROVIDERS) {
    groups.set(provider, {
      provider,
      providerLabel: quotaProviderLabel(provider),
      via: quotaProviderVia(provider),
      windows: [],
    });
  }

  asArray(rec.windows).forEach((rawWindow, windowIndex) => {
    const winRec = asRecord(rawWindow);
    const provider =
      asString(winRec.providerKey) ?? quotaProviderKey(asString(winRec.provider) ?? "");
    let group = groups.get(provider);
    if (!group) {
      group = {
        provider,
        providerLabel: quotaProviderLabel(provider),
        via: quotaProviderVia(provider),
        windows: [],
      };
      groups.set(provider, group);
    }
    group.windows.push(normalizeWindow(rawWindow, group.via, `${provider}-${windowIndex}`));
  });

  return [...groups.values()];
}

function normalizeSourceReading(raw: unknown): QuotaSourceReading | null {
  const parsed = quotaSourceReadingSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}

/** Prefer additive `quotaGroups` from /api/quota-windows when present. */
export function buildMergedQuotaSections(data: unknown): MergedProviderSection[] {
  const rec = asRecord(data);
  const rawGroups = asArray(rec.quotaGroups);
  if (rawGroups.length === 0) return [];

  return rawGroups.map((rawGroup, groupIndex) => {
    const groupRec = asRecord(rawGroup);
    const provider = asString(groupRec.provider) ?? `unknown-${groupIndex}`;
    const providerLabel = asString(groupRec.providerLabel) ?? quotaProviderLabel(provider);
    const windows = asArray(groupRec.windows).map((rawWindow, windowIndex) => {
      const winRec = asRecord(rawWindow);
      const windowKey = asString(winRec.windowKey) ?? "unknown";
      const displayName = asString(winRec.displayName) ?? windowKey;
      const rawKey = asString(winRec.rawKey) ?? windowKey;
      const platformTitle = asString(winRec.platformTitle);
      const primary = normalizeSourceReading(winRec.primary);
      const sources = asArray(winRec.sources)
        .map(normalizeSourceReading)
        .filter((row): row is QuotaSourceReading => row != null);
      const resolvedPrimary = primary ?? sources[0];
      if (!resolvedPrimary) {
        return null;
      }
      const olderSources = sources.filter((row) => row.freshness === "old");
      const visibleSources = sources.filter((row) => row.freshness !== "old");
      return {
        id: `${provider}:${windowKey}:${windowIndex}`,
        provider,
        providerLabel,
        windowKey,
        displayName,
        rawKey,
        platformTitle,
        primary: resolvedPrimary,
        sources: visibleSources.length > 0 ? visibleSources : [resolvedPrimary],
        olderSources,
      };
    });
    return {
      provider,
      providerLabel,
      windows: windows.filter((row): row is MergedQuotaWindowView => row != null),
    };
  });
}

export function defaultProviderGroups(): NormalizedGroup[] {
  return EXPECTED_QUOTA_PROVIDERS.map((provider) => ({
    provider,
    providerLabel: quotaProviderLabel(provider),
    via: quotaProviderVia(provider),
    windows: [],
  }));
}

export function defaultMergedSections(): MergedProviderSection[] {
  return EXPECTED_QUOTA_PROVIDERS.map((provider) => ({
    provider,
    providerLabel: quotaProviderLabel(provider),
    windows: [],
  }));
}

export function formatCountdown(resetAtStr: string | null, nowMs: number): string {
  if (!resetAtStr) return "Rolling Refresh";
  const target = new Date(resetAtStr).getTime();
  const diffMs = target - nowMs;
  if (diffMs <= 0) return "Refreshing Now";

  const diffSec = Math.floor(diffMs / 1000);
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remHours = hours % 24;
    return `Resets In ${days}d ${remHours}h`;
  }
  if (hours > 0) {
    return `Resets In ${hours}h ${minutes}m`;
  }
  return `Resets In ${minutes}m`;
}

/** CodeCaps menu-bar style countdown (e.g. `1h 39m`, `6d 15h`). */
export function formatCountdownCompact(resetAtStr: string | null, nowMs: number): string {
  if (!resetAtStr) return "—";
  const target = new Date(resetAtStr).getTime();
  const diffMs = target - nowMs;
  if (diffMs <= 0) return "now";

  const diffSec = Math.floor(diffMs / 1000);
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remHours = hours % 24;
    return `${days}d ${remHours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/** Jay-approved window tag beside the bar (`5-hour`, `7-day`, `1-month`, …). */
export function windowRowTagLabel(windowKey: string, displayName: string): string {
  const canonical = new Set(["5-hour", "7-day", "1-month", "plan"]);
  if (canonical.has(displayName)) return displayName;
  if (/^\d+-(hour|day|month)$/.test(displayName) && !displayName.startsWith("other")) {
    return displayName;
  }
  if (displayName && !displayName.startsWith("other-limit")) {
    return displayName;
  }
  return windowKeyToDisplayLabel(windowKey);
}

/** Rounded percent pill matching CodeCaps pastel green / salmon. */
export function quotaPercentPillClasses(
  source: QuotaSourceReading,
): string {
  const base = "inline-flex items-center justify-center min-w-[2.75rem] px-1.5 py-0.5 text-xs font-semibold tabular-nums rounded-md";
  if (source.freshness !== "fresh") {
    return `${base} bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300`;
  }
  if (source.remainingUnknown || source.remainingPercent == null) {
    return `${base} bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300`;
  }
  if (source.isExhausted || source.remainingPercent <= 0) {
    return `${base} bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300`;
  }
  if (source.remainingPercent <= 20) {
    return `${base} bg-orange-100 text-orange-900 dark:bg-orange-950/40 dark:text-orange-200`;
  }
  return `${base} bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200`;
}

function formatAgeShort(ageMs: number): string {
  const sec = Math.max(0, Math.floor(ageMs / 1000));
  if (sec < 60) return `${sec} Sec Ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} Min Ago`;
  const hours = Math.floor(min / 60);
  if (hours < 48) return `${hours} Hour${hours === 1 ? "" : "s"} Ago`;
  const days = Math.floor(hours / 24);
  return `${days} Day${days === 1 ? "" : "s"} Ago`;
}

export function formatFreshnessLabel(
  source: QuotaSourceReading,
  nowMs: number,
): string {
  const ageMs = nowMs - Date.parse(source.reportedAt);
  const ageLabel = formatAgeShort(ageMs);
  if (source.freshness === "fresh") return `Updated ${ageLabel}`;
  return `Stale · ${ageLabel}`;
}

export function formatSourceOptionLabel(source: QuotaSourceReading, nowMs: number): string {
  const parts = [source.sourceLabel];
  if (source.machine) parts.push(source.machine);
  parts.push(formatAgeShort(nowMs - Date.parse(source.reportedAt)));
  return parts.join(" · ");
}

export function quotaTone(
  status: QuotaWindowStatus,
  percent: number | null,
): {
  bar: string;
  badge: string;
  label: string;
} {
  if (status === "unknown" || percent == null) {
    return {
      bar: "bg-gray-300 dark:bg-gray-600",
      badge: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
      label: "Not Reported",
    };
  }
  if (status === "exhausted" || percent <= 0) {
    return {
      bar: "bg-rose-500",
      badge: "bg-rose-50 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
      label: "Exhausted",
    };
  }
  if (percent >= 50) {
    return {
      bar: "bg-emerald-500",
      badge: "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
      label: "Available",
    };
  }
  if (percent >= 20) {
    return {
      bar: "bg-amber-500",
      badge: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
      label: "Moderate Quota",
    };
  }
  return {
    bar: "bg-rose-500",
    badge: "bg-rose-50 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
    label: "Near Quota Cap",
  };
}

export function quotaPercentTextClass(
  source: QuotaSourceReading,
): string {
  if (source.freshness !== "fresh") {
    return "text-gray-500 dark:text-gray-400";
  }
  if (source.remainingUnknown || source.remainingPercent == null) {
    return "text-gray-500 dark:text-gray-400";
  }
  if (source.isExhausted || source.remainingPercent <= 0) {
    return "text-rose-600 dark:text-rose-400";
  }
  if (source.remainingPercent <= 20) {
    return "text-amber-600 dark:text-amber-400";
  }
  return "text-green-700 dark:text-green-400";
}

/** Plain percent label for the bar (e.g. `73%`, no "remaining" copy). */
export function formatQuotaPercentLabel(percent: number | null, remainingUnknown: boolean): string {
  if (remainingUnknown || percent == null) return "—";
  const clamped = Math.min(100, Math.max(0, percent));
  const rounded = Math.round(clamped * 10) / 10;
  const text = rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1);
  return `${text}%`;
}

function windowDurationMs(windowKey: string): number | null {
  if (windowKey === "5h") return 5 * 3_600_000;
  if (windowKey === "7d" || windowKey === "7d:opus") return 7 * 86_400_000;
  if (windowKey === "weekly") return 7 * 86_400_000;
  if (windowKey === "monthly") return 30 * 86_400_000;
  const match = /^(\d+)h$/.exec(windowKey);
  if (match) return Number(match[1]) * 3_600_000;
  const dayMatch = /^(\d+)d$/.exec(windowKey);
  if (dayMatch) return Number(dayMatch[1]) * 86_400_000;
  return null;
}

export function QuotaUsageBar({
  remainingPercent,
  remainingUnknown,
  resetAt,
  windowKey,
  nowMs,
  stale,
}: {
  remainingPercent: number | null;
  remainingUnknown: boolean;
  resetAt: string | null;
  windowKey: string;
  nowMs: number;
  stale: boolean;
}) {
  const remaining = remainingUnknown || remainingPercent == null
    ? null
    : Math.min(100, Math.max(0, remainingPercent));
  const used = remaining == null ? null : 100 - remaining;

  let elapsedMarker: number | null = null;
  if (resetAt) {
    const resetMs = Date.parse(resetAt);
    const duration = windowDurationMs(windowKey);
    if (Number.isFinite(resetMs) && duration) {
      const start = resetMs - duration;
      const elapsed = (nowMs - start) / duration;
      elapsedMarker = Math.min(1, Math.max(0, elapsed));
    }
  }

  const opacity = stale ? "opacity-70" : "";

  return (
    <div
      className={`relative w-full h-2.5 rounded-sm overflow-visible bg-gray-200 dark:bg-gray-700 ${opacity}`}
    >
      {used != null && remaining != null ? (
        <div className="flex h-full w-full rounded-sm overflow-hidden">
          <div className="h-full bg-red-500" style={{ width: `${used}%` }} />
          <div className="h-full bg-teal-800 dark:bg-teal-700 flex-1" />
        </div>
      ) : (
        <div className="h-full w-full rounded-sm bg-gray-300 dark:bg-gray-600" />
      )}
      {elapsedMarker != null ? (
        <div
          className="absolute -top-0.5 bottom-[-2px] w-[2px] bg-black dark:bg-gray-950 z-10"
          style={{ left: `calc(${elapsedMarker * 100}% - 1px)` }}
          aria-hidden
        />
      ) : null}
    </div>
  );
}

export function ProviderLogo({
  providerKey,
  providerLabel,
}: {
  providerKey: string;
  providerLabel: string;
}) {
  const src = PROVIDER_LOGOS[providerKey];
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={`${providerLabel} logo`}
        className="w-7 h-7 object-contain rounded-md p-0.5 bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-700 shadow-2xs shrink-0"
        width={28}
        height={28}
      />
    );
  }
  const initials = providerLabel.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "?";
  return (
    <div
      role="img"
      aria-label={`${providerLabel} logo placeholder`}
      className="w-7 h-7 flex items-center justify-center rounded-md bg-gray-100 dark:bg-gray-700 border border-gray-100 dark:border-gray-700 shadow-2xs shrink-0 text-[10px] font-semibold text-gray-600 dark:text-gray-300"
    >
      {initials}
    </div>
  );
}

function QuotaSourceSelect({
  selectId,
  sources,
  selectedSourceKey,
  onChange,
  nowMs,
  showLabel = false,
}: {
  selectId: string;
  sources: QuotaSourceReading[];
  selectedSourceKey: string;
  onChange: (key: string) => void;
  nowMs: number;
  showLabel?: boolean;
}) {
  const sourceValue = (source: QuotaSourceReading) => `${source.source}::${source.reportedAt}`;
  if (sources.length <= 1) return null;

  return (
    <div className="relative mb-1.5">
      <label
        htmlFor={selectId}
        className={
          showLabel
            ? "block text-[10px] font-medium text-gray-600 dark:text-gray-300 mb-0.5"
            : "sr-only"
        }
      >
        Source
      </label>
      <select
        id={selectId}
        className="w-full appearance-none rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-900 text-[11px] py-1 pl-2 pr-7 text-gray-800 dark:text-gray-100"
        value={selectedSourceKey}
        onChange={(event) => onChange(event.target.value)}
      >
        {sources.map((source) => (
          <option key={sourceValue(source)} value={sourceValue(source)}>
            {formatSourceOptionLabel(source, nowMs)}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-500"
        aria-hidden
      />
    </div>
  );
}

export function QuotaMergedWindowSlot({
  view,
  nowMs,
  showSourceSelect,
}: {
  view: MergedQuotaWindowView;
  nowMs: number;
  showSourceSelect: boolean;
}) {
  const selectId = useId();
  const sourceValue = (source: QuotaSourceReading) => `${source.source}::${source.reportedAt}`;
  const [selectedSourceKey, setSelectedSourceKey] = useState(sourceValue(view.primary));
  const [showOlder, setShowOlder] = useState(false);

  const active =
    view.sources.find((row) => sourceValue(row) === selectedSourceKey) ?? view.primary;
  const percent = active.remainingUnknown ? null : active.remainingPercent;
  const windowTag = windowRowTagLabel(view.windowKey, view.displayName);
  const countdown = formatCountdownCompact(active.resetAt, nowMs);
  const freshness = formatFreshnessLabel(active, nowMs);
  const tooltipParts = [view.rawKey, active.detail, freshness].filter(Boolean).join(" · ");
  const unavailable =
    active.remainingUnknown || percent == null;

  return (
    <div className="flex flex-col min-w-[9.5rem] flex-1 basis-40 max-w-md">
      {showSourceSelect ? (
        <QuotaSourceSelect
          selectId={selectId}
          sources={view.sources}
          selectedSourceKey={selectedSourceKey}
          onChange={setSelectedSourceKey}
          nowMs={nowMs}
        />
      ) : null}

      <div
        className="flex items-center gap-2"
        title={tooltipParts || undefined}
      >
        <span className="w-[3.25rem] shrink-0 text-xs font-semibold text-gray-900 dark:text-gray-100 tabular-nums leading-tight">
          {windowTag}
        </span>
        {unavailable ? (
          <span className="flex-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">
            unavailable
          </span>
        ) : (
          <div className="flex-1 min-w-[4.5rem]">
            <QuotaUsageBar
              remainingPercent={active.remainingPercent}
              remainingUnknown={active.remainingUnknown}
              resetAt={active.resetAt}
              windowKey={view.windowKey}
              nowMs={nowMs}
              stale={active.freshness !== "fresh"}
            />
          </div>
        )}
        <span
          className={quotaPercentPillClasses(active)}
          aria-label={
            percent == null ? "Remaining percent not reported" : `${percent} percent remaining`
          }
        >
          {formatQuotaPercentLabel(percent, active.remainingUnknown)}
        </span>
        <span className={`${QUOTA_TIME_REMAINING_CLASS} min-w-[3.75rem] text-right`}>
          {countdown}
        </span>
      </div>

      {view.olderSources.length > 0 ? (
        <div className="mt-1">
          <button
            type="button"
            className="text-[10px] font-medium text-gray-600 dark:text-gray-300 underline"
            onClick={() => setShowOlder((open) => !open)}
            aria-expanded={showOlder}
          >
            {showOlder ? "Hide Older Sources" : "Older Sources"}
          </button>
          {showOlder ? (
            <ul className="mt-1 space-y-0.5 text-[10px] text-gray-500 dark:text-gray-400">
              {view.olderSources.map((source) => (
                <li key={`${source.source}:${source.reportedAt}`}>
                  {formatSourceOptionLabel(source, nowMs)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** @deprecated Name kept for tests; renders one CodeCaps-style window slot. */
export function QuotaMergedWindowCard({
  view,
  nowMs,
}: {
  view: MergedQuotaWindowView;
  nowMs: number;
}) {
  const rowTitle = view.platformTitle;
  return (
    <div className="flex flex-col gap-1 py-1">
      {rowTitle ? (
        <p className="text-xs font-semibold text-gray-900 dark:text-gray-100">{rowTitle}</p>
      ) : null}
      <QuotaMergedWindowSlot view={view} nowMs={nowMs} showSourceSelect />
    </div>
  );
}

function windowSortOrder(windowKey: string): number {
  if (windowKey === "5h") return 0;
  if (windowKey === "7d" || windowKey === "7d:opus") return 1;
  if (windowKey === "monthly") return 2;
  return 3;
}

function groupMergedWindowsForRows(windows: MergedQuotaWindowView[]): MergedQuotaWindowView[][] {
  const byRow = new Map<string, MergedQuotaWindowView[]>();
  for (const view of windows) {
    const key = view.platformTitle ?? "";
    const list = byRow.get(key) ?? [];
    list.push(view);
    byRow.set(key, list);
  }
  return [...byRow.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => [...group].sort((a, b) => windowSortOrder(a.windowKey) - windowSortOrder(b.windowKey)));
}

export function QuotaWindowCard({ win, nowMs }: { win: NormalizedWindow; nowMs: number }) {
  const percent = win.remainingUnknown ? null : win.remainingPercent;
  const tone = quotaTone(win.status, percent);
  const countdown = formatCountdown(win.resetAt, nowMs);
  const reportedAt = win.occurredAt && Number.isFinite(new Date(win.occurredAt).getTime())
    ? new Date(win.occurredAt).toLocaleString("en-US", { hour12: true })
    : "Unknown";
  const source = win.source ?? "Unknown";
  const windowHeading = win.label
    .replace(/\b5-hour window\b/i, "5-Hour Window")
    .replace(/\b(5h|7d|weekly|monthly) window\b/i, (_match, period: string) => {
      const normalized = period.toLowerCase();
      return `${normalized === "weekly" || normalized === "monthly" ? normalized[0].toUpperCase() + normalized.slice(1) : normalized} Window`;
    })
    .replace(/^weekly$/i, "Weekly")
    .replace(/^included plan$/i, "Included Plan");
  const collector = win.collector && win.collector !== win.source ? win.collector : null;
  const service = win.sourceApp && win.sourceApp !== win.source ? win.sourceApp : null;

  return (
    <div className="p-4 rounded-lg border border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30 flex flex-col justify-between">
      <div>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-tight">
              {windowHeading}
            </h4>
            <p className="text-[11px] text-gray-500 dark:text-gray-400">
              {win.window && !/\bwindow$/i.test(windowHeading) ? (
                <span className="font-medium">{quotaWindowHeading(win.window)}</span>
              ) : null}
              {win.via === "antigravity" ? (
                <span className="text-gray-500 dark:text-gray-400">
                  {win.window && !/\bwindow$/i.test(windowHeading) ? " · " : ""}via Antigravity
                </span>
              ) : null}
            </p>
          </div>
          <span className={`px-2 py-0.5 text-[10px] font-semibold rounded-full ${tone.badge}`}>
            {tone.label}
          </span>
        </div>

        <div className="mt-4">
          <div className="flex justify-between items-baseline text-xs mb-1.5">
            <span className="font-semibold text-gray-900 dark:text-gray-100">
              {percent == null ? "Remaining not reported" : `${percent.toFixed(1)}% remaining`}
            </span>
            <span className={`${QUOTA_TIME_REMAINING_CLASS} flex items-center gap-1`}>
              <Clock className="h-3.5 w-3.5 shrink-0 text-gray-900 dark:text-gray-100" aria-hidden />
              {countdown}
            </span>
          </div>
          <div className="w-full h-2.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className={`h-full ${tone.bar} transition-all duration-500 rounded-full`}
              style={{ width: `${percent == null ? 0 : Math.min(100, Math.max(0, percent))}%` }}
            />
          </div>
        </div>
        <p className="mt-2 break-all text-[10px] text-gray-500 dark:text-gray-400">
          Source: {source}{collector ? ` · Collector: ${collector}` : ""}{service ? ` · Service: ${service}` : ""}{win.machine ? ` · Machine: ${win.machine}` : ""} · Reported: {reportedAt}
        </p>
      </div>
    </div>
  );
}

function collectProviderSourceOptions(windows: MergedQuotaWindowView[]): QuotaSourceReading[] {
  const seen = new Set<string>();
  const options: QuotaSourceReading[] = [];
  for (const view of windows) {
    for (const source of view.sources) {
      const key = `${source.source}::${source.reportedAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push(source);
    }
  }
  options.sort((a, b) => Date.parse(b.reportedAt) - Date.parse(a.reportedAt));
  return options;
}

function resolveActiveSource(
  view: MergedQuotaWindowView,
  selectedSourceKey: string,
): QuotaSourceReading {
  const sourceValue = (source: QuotaSourceReading) => `${source.source}::${source.reportedAt}`;
  return view.sources.find((row) => sourceValue(row) === selectedSourceKey) ?? view.primary;
}

export function MergedProviderSection({
  section,
  nowMs,
}: {
  section: MergedProviderSection;
  nowMs: number;
}) {
  const rowGroups = groupMergedWindowsForRows(section.windows);
  const sectionSourceSelectId = useId();
  const sourceOptions = collectProviderSourceOptions(section.windows);
  const sourceValue = (source: QuotaSourceReading) => `${source.source}::${source.reportedAt}`;
  const defaultSourceKey =
    sourceOptions[0] != null ? sourceValue(sourceOptions[0]) : "";
  const [selectedSourceKey, setSelectedSourceKey] = useState(defaultSourceKey);

  return (
    <section className="border-b border-gray-100 dark:border-gray-700 last:border-b-0 pb-4 last:pb-0">
      <div className="flex items-center gap-2.5 mb-2">
        <ProviderLogo providerKey={section.provider} providerLabel={section.providerLabel} />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {section.providerLabel}
        </h3>
      </div>
      {section.windows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{EMPTY_STATE_COPY}</p>
      ) : (
        <div className="flex flex-col gap-2 pl-9 sm:pl-10">
          {sourceOptions.length > 1 ? (
            <QuotaSourceSelect
              selectId={sectionSourceSelectId}
              sources={sourceOptions}
              selectedSourceKey={selectedSourceKey || defaultSourceKey}
              onChange={setSelectedSourceKey}
              nowMs={nowMs}
              showLabel
            />
          ) : null}
          {rowGroups.map((group, groupIndex) => {
            const rowTitle = group[0]?.platformTitle;
            return (
              <div key={`${section.provider}-row-${groupIndex}`} className="flex flex-col gap-1">
                {rowTitle ? (
                  <p className="text-xs font-semibold text-gray-900 dark:text-gray-100">{rowTitle}</p>
                ) : null}
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                  {group.map((view) => (
                    <QuotaMergedWindowSlotInner
                      key={view.id}
                      view={view}
                      active={resolveActiveSource(view, selectedSourceKey || defaultSourceKey)}
                      nowMs={nowMs}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function QuotaMergedWindowSlotInner({
  view,
  active,
  nowMs,
}: {
  view: MergedQuotaWindowView;
  active: QuotaSourceReading;
  nowMs: number;
}) {
  const percent = active.remainingUnknown ? null : active.remainingPercent;
  const windowTag = windowRowTagLabel(view.windowKey, view.displayName);
  const countdown = formatCountdownCompact(active.resetAt, nowMs);
  const freshness = formatFreshnessLabel(active, nowMs);
  const tooltipParts = [view.rawKey, active.detail, freshness].filter(Boolean).join(" · ");
  const unavailable = active.remainingUnknown || percent == null;

  return (
    <div
      className="flex items-center gap-2 min-w-[9.5rem] flex-1 basis-40 max-w-md"
      title={tooltipParts || undefined}
    >
      <span className="w-[3.25rem] shrink-0 text-xs font-semibold text-gray-900 dark:text-gray-100 tabular-nums leading-tight">
        {windowTag}
      </span>
      {unavailable ? (
        <span className="flex-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">
          unavailable
        </span>
      ) : (
        <div className="flex-1 min-w-[4.5rem]">
          <QuotaUsageBar
            remainingPercent={active.remainingPercent}
            remainingUnknown={active.remainingUnknown}
            resetAt={active.resetAt}
            windowKey={view.windowKey}
            nowMs={nowMs}
            stale={active.freshness !== "fresh"}
          />
        </div>
      )}
      <span
        className={quotaPercentPillClasses(active)}
        aria-label={percent == null ? "Remaining percent not reported" : `${percent} percent remaining`}
      >
        {formatQuotaPercentLabel(percent, active.remainingUnknown)}
      </span>
      <span className={`${QUOTA_TIME_REMAINING_CLASS} min-w-[3.75rem] text-right`}>
        {countdown}
      </span>
    </div>
  );
}

export function ProviderSection({ group, nowMs }: { group: NormalizedGroup; nowMs: number }) {
  return (
    <section>
      <div className="flex items-center gap-2.5 mb-3">
        <ProviderLogo providerKey={group.provider} providerLabel={group.providerLabel} />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {group.providerLabel}
        </h3>
      </div>
      {group.windows.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">{EMPTY_STATE_COPY}</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {group.windows.map((win) => (
            <QuotaWindowCard key={win.id} win={win} nowMs={nowMs} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function FleetQuotaMatrixCard() {
  const [mergedSections, setMergedSections] = useState<MergedProviderSection[]>(() =>
    defaultMergedSections(),
  );
  const [legacyGroups, setLegacyGroups] = useState<NormalizedGroup[] | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let unmounted = false;
    const fetchQuota = async () => {
      try {
        const res = await fetch("/api/quota-windows", { cache: "no-store" });
        if (!res.ok) return;
        const raw: unknown = await res.json();
        const parsed = quotaWindowsClientResponseSchema.safeParse(raw);
        if (!parsed.success) return;
        const data = parsed.data;
        const merged = buildMergedQuotaSections(data);
        if (!unmounted) {
          if (merged.length > 0) {
            setMergedSections(merged);
            setLegacyGroups(null);
          } else {
            setLegacyGroups(buildProviderGroups(data));
            setMergedSections(defaultMergedSections());
          }
        }
      } catch {
        // Keep the default/last-known groups.
      }
    };

    fetchQuota();
    return () => {
      unmounted = true;
    };
  }, []);

  const useLegacy = legacyGroups != null;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden shadow-sm">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700">
        <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
          <Gauge className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          Subscription Quotas
        </h2>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          Remaining percentage and reset countdown for each subscription plan the Mac
          collectors report.
        </p>
      </div>

      <div className="p-6 flex flex-col gap-6">
        {useLegacy
          ? legacyGroups.map((group) => (
              <ProviderSection key={group.provider} group={group} nowMs={nowMs} />
            ))
          : mergedSections.map((section) => (
              <MergedProviderSection key={section.provider} section={section} nowMs={nowMs} />
            ))}
      </div>
    </div>
  );
}
