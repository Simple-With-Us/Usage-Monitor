"use client";

import React, { useEffect, useState } from "react";
import { Gauge, Clock } from "lucide-react";
import {
  EXPECTED_QUOTA_PROVIDERS,
  antigravityDisplayLabel,
  quotaProviderKey,
  quotaProviderLabel,
  quotaProviderVia,
} from "@/lib/quota-windows";

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
}

export interface NormalizedGroup {
  provider: string;
  providerLabel: string;
  via: string | null;
  windows: NormalizedWindow[];
}

/**
 * Provider row logos keyed by canonical providerKey — NEVER by matching text
 * inside a window's label. Antigravity routes several vendors' models under
 * its own subscription (its non-Gemini pool, which the Antigravity CLI calls
 * "Claude and GPT models" and this card shows as "Third-Party Models", is not
 * the user's Claude plan), so the per-row logo must come from the group's
 * providerKey alone, not from anything the window happens to be labelled.
 */
const PROVIDER_LOGOS: Record<string, string> = {
  anthropic: "/logos/claude.svg",
  openai: "/logos/openai.svg",
  "google-antigravity": "/logos/antigravity.svg",
  xai: "/logos/grok.svg",
  // minimax intentionally omitted: no shipped logo asset yet, so it renders
  // the text-badge fallback in ProviderLogo instead of a mismatched image.
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

function normalizeWindow(
  raw: unknown,
  fallbackVia: string | null,
  fallbackId: string
): NormalizedWindow {
  const rec = asRecord(raw);
  const remainingPercent = asNumber(rec.remainingPercent);
  const remainingUnknown = rec.remainingUnknown === true || remainingPercent == null;
  const via = asString(rec.via) ?? fallbackVia;
  const label = asString(rec.label) ?? "Quota window";
  return {
    id: asString(rec.id) ?? fallbackId,
    // The API already maps Antigravity's "Claude and GPT models" bucket to
    // "Third-Party Models"; repeating it here keeps an older cached or
    // proxied response from showing the legacy name.
    label: via === "antigravity" ? antigravityDisplayLabel(label) : label,
    window: asString(rec.window),
    remainingPercent,
    remainingUnknown,
    status: normalizeStatus(rec.status, remainingUnknown),
    resetAt: asString(rec.resetAt),
    via,
  };
}

/**
 * Build one section per provider. Prefers the API's own `providerGroups` (in
 * the order it returned them). Falls back to grouping the flat `windows`
 * array client-side by `providerKey ?? provider` for an older server
 * response, and always includes the five expected providers even when
 * nothing has been reported yet. Tolerant of missing/malformed fields so a
 * partial or unexpected payload never crashes the card.
 */
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
        normalizeWindow(rawWindow, via, `${provider}-${windowIndex}`)
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

export function defaultProviderGroups(): NormalizedGroup[] {
  return EXPECTED_QUOTA_PROVIDERS.map((provider) => ({
    provider,
    providerLabel: quotaProviderLabel(provider),
    via: quotaProviderVia(provider),
    windows: [],
  }));
}

export function formatCountdown(resetAtStr: string | null, nowMs: number): string {
  if (!resetAtStr) return "Rolling refresh";
  const target = new Date(resetAtStr).getTime();
  const diffMs = target - nowMs;
  if (diffMs <= 0) return "Refreshing now";

  const diffSec = Math.floor(diffMs / 1000);
  const hours = Math.floor(diffSec / 3600);
  const minutes = Math.floor((diffSec % 3600) / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remHours = hours % 24;
    return `Resets in ${days}d ${remHours}h`;
  }
  if (hours > 0) {
    return `Resets in ${hours}h ${minutes}m`;
  }
  return `Resets in ${minutes}m`;
}

export function quotaTone(
  status: QuotaWindowStatus,
  percent: number | null
): {
  bar: string;
  badge: string;
  label: string;
} {
  if (status === "unknown" || percent == null) {
    return {
      bar: "bg-gray-300 dark:bg-gray-600",
      badge: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
      label: "Not reported",
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

export function QuotaWindowCard({ win, nowMs }: { win: NormalizedWindow; nowMs: number }) {
  const percent = win.remainingUnknown ? null : win.remainingPercent;
  const tone = quotaTone(win.status, percent);
  const countdown = formatCountdown(win.resetAt, nowMs);

  return (
    <div className="p-4 rounded-lg border border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30 flex flex-col justify-between">
      <div>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-tight">
              {win.label}
            </h4>
            <p className="text-[11px] text-gray-500 dark:text-gray-400">
              {win.window ? <span className="uppercase font-medium">{win.window}</span> : null}
              {win.via === "antigravity" ? (
                <span className="text-gray-500 dark:text-gray-400">
                  {win.window ? " · " : ""}via Antigravity
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
            <span className="text-gray-500 dark:text-gray-400 flex items-center gap-1 font-mono text-[11px]">
              <Clock className="h-3 w-3" />
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
      </div>
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
  const [groups, setGroups] = useState<NormalizedGroup[]>(() => defaultProviderGroups());
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // Recompute ticking countdowns every 10 seconds.
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
        const data: unknown = await res.json();
        const nextGroups = buildProviderGroups(data);
        if (!unmounted) setGroups(nextGroups);
      } catch {
        // Keep the default/last-known groups; a fetch failure must never
        // crash this card or leave it stuck rendering nothing.
      }
    };

    fetchQuota();
    return () => {
      unmounted = true;
    };
  }, []);

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
        {groups.map((group) => (
          <ProviderSection key={group.provider} group={group} nowMs={nowMs} />
        ))}
      </div>
    </div>
  );
}
