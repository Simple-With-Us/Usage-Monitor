import {
  projectQuotaPlanMetadata,
  quotaDetectedPlanName,
  quotaMetadataRecord,
  type QuotaPlanMetadata,
} from "@/lib/quota-plan-metadata";
import {
  antigravityPlatformCardTitle,
  antigravityQuotaPool,
  normalizeQuotaWindowKey,
  quotaWindowDisplayName,
  rollupQuotaWindowKey,
} from "@/lib/quota-window-display";
import {
  normalizeProviderKey,
  type ResolvedProviderManifest,
  resolveProviderManifest,
} from "@/lib/provider-manifest";
import { quotaEventReportedAtIso } from "@/lib/quota-ingest-metadata";
import type { QuotaEventLike } from "@/lib/quota-windows";
import { antigravityDisplayLabel, quotaProviderLabel } from "@/lib/quota-windows";

export const QUOTA_FRESH_MS = 30 * 60 * 1000;
export const QUOTA_STALE_VISIBLE_MS = 6 * 60 * 60 * 1000;
export const QUOTA_EXPIRED_MS = 48 * 60 * 60 * 1000;

export type QuotaSourceFreshness = "fresh" | "stale" | "old";

export interface QuotaSourceReading {
  planMetadata?: QuotaPlanMetadata;
  planName?: string;
  source: string;
  sourceLabel: string;
  machine: string | null;
  collector: string | null;
  remainingPercent: number | null;
  remainingUnknown: boolean;
  isExhausted: boolean;
  resetAt: string | null;
  reportedAt: string;
  freshness: QuotaSourceFreshness;
  /** Model or raw window key — tooltip / source detail only, never a card label. */
  detail?: string | null;
}

export interface QuotaGroupWindow {
  windowKey: string;
  displayName: string;
  rawKey: string;
  /** Antigravity-only card title, e.g. "Antigravity · Gemini". */
  platformTitle: string | null;
  primary: QuotaSourceReading;
  sources: QuotaSourceReading[];
}

export interface QuotaProviderQuotaGroup {
  provider: string;
  providerLabel: string;
  windows: QuotaGroupWindow[];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function iso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

export function quotaSourceFreshness(
  reportedAtIso: string,
  nowMs: number,
): QuotaSourceFreshness | "expired" {
  const reportedMs = Date.parse(reportedAtIso);
  if (!Number.isFinite(reportedMs)) return "expired";
  const ageMs = nowMs - reportedMs;
  if (ageMs > QUOTA_EXPIRED_MS) return "expired";
  if (ageMs <= QUOTA_FRESH_MS) return "fresh";
  if (ageMs <= QUOTA_STALE_VISIBLE_MS) return "stale";
  return "old";
}

function sourceKindRank(source: string | null, collector: string | null): number {
  const s = (source ?? "").toLowerCase();
  const c = (collector ?? "").toLowerCase();
  if (s === "codecaps" || c === "codecaps") return 3;
  if (
    s === "api.anthropic.com" ||
    c.includes("claude-code") ||
    s.includes("claude-code") ||
    c.includes("subscription-quota-collector")
  ) {
    return 2;
  }
  return 1;
}

function humanSourceLabel(source: string | null, collector: string | null): string {
  const s = (source ?? "").toLowerCase();
  const c = (collector ?? "").toLowerCase();
  if (s === "codecaps" || c === "codecaps") return "CodeCaps";
  if (s === "api.anthropic.com") return "Anthropic API";
  if (c.includes("claude-code") || s.includes("claude-code")) return "Claude Code";
  if (c.includes("subscription-quota-collector")) return "Quota Collector";
  if (source) {
    const trimmed = source.trim();
    if (trimmed) return trimmed;
  }
  if (collector) return collector;
  return "Unknown";
}

function normalizeSourceId(source: string | null, collector: string | null): string {
  const s = (source ?? "").toLowerCase();
  const c = (collector ?? "").toLowerCase();
  if (s === "codecaps" || c === "codecaps") return "codecaps";
  if (s === "api.anthropic.com") return "api.anthropic.com";
  if (c.includes("claude-code") || s.includes("claude-code")) return "claude-code";
  if (collector) return collector.toLowerCase();
  return (source ?? "unknown").toLowerCase();
}

export interface QuotaSourceCandidate extends QuotaSourceReading {
  kindRank: number;
  reportedMs: number;
}

/**
 * Pick the primary quota source from same-window candidates (Jay-approved 2026-10-12).
 */
export function pickPrimarySource(
  candidates: QuotaSourceCandidate[],
  nowMs: number,
): QuotaSourceCandidate | null {
  const eligible = candidates.filter((row) => quotaSourceFreshness(row.reportedAt, nowMs) !== "expired");
  if (eligible.length === 0) return null;

  const fresh = eligible.filter((row) => quotaSourceFreshness(row.reportedAt, nowMs) === "fresh");

  let tierPool: QuotaSourceCandidate[];
  if (fresh.length > 0) {
    const maxRank = Math.max(...fresh.map((row) => row.kindRank));
    tierPool = fresh.filter((row) => row.kindRank === maxRank);
  } else {
    tierPool = [...eligible];
  }

  tierPool.sort((a, b) => b.reportedMs - a.reportedMs);

  let primary = tierPool[0];
  if (!primary) return null;

  const withinFiveMin = tierPool.filter(
    (row) => Math.abs(row.reportedMs - primary.reportedMs) <= 5 * 60 * 1000,
  );
  if (withinFiveMin.length > 1) {
    primary = [...withinFiveMin].sort((a, b) => {
      const aRem = a.remainingPercent ?? Number.POSITIVE_INFINITY;
      const bRem = b.remainingPercent ?? Number.POSITIVE_INFINITY;
      if (aRem !== bRem) return aRem - bRem;
      return b.reportedMs - a.reportedMs;
    })[0]!;
  }

  return primary;
}

function sourceDetail(meta: Record<string, unknown>, rawKey: string): string | null {
  const modelId = asString(meta.modelId);
  const parts = [modelId, rawKey !== "seven_day" && rawKey !== "five_hour" ? rawKey : null].filter(
    Boolean,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

function eventToCandidate(
  event: QuotaEventLike,
  nowMs: number,
  via: string | null,
  rawKey: string,
  meta: Record<string, unknown>,
): QuotaSourceCandidate | null {
  const planMetadata = projectQuotaPlanMetadata(meta);
  const detectedPlanName = quotaDetectedPlanName(planMetadata, meta);
  const modelId = asString(meta.modelId);
  const bucketId = asString(meta.bucketId);
  const label =
    via === "antigravity" ? antigravityDisplayLabel(event.label) : event.label;
  const reportedAt = quotaEventReportedAtIso(event.occurredAt, meta);
  const freshness = quotaSourceFreshness(reportedAt, nowMs);
  if (freshness === "expired") return null;

  const omitted = asBoolean(meta.remainingUnknown) || event.credits == null;
  const limit = typeof event.limit === "number" && event.limit > 0 ? event.limit : 100;
  const remainingPercent = omitted
    ? null
    : Math.round((Number(event.credits) / limit) * 10_000) / 100;
  const remainingUnknown = omitted;
  const isExhausted =
    asBoolean(meta.isExhausted) ||
    (!remainingUnknown && remainingPercent != null && remainingPercent <= 0);

  const source = asString(meta.source);
  const collector = event.sourceApp ?? null;
  const machine = asString(meta.machine) ?? asString(meta._producerInstanceId);
  const sourceId = normalizeSourceId(source, collector);

  return {
    ...(planMetadata ? { planMetadata } : {}),
    ...(detectedPlanName ? { planName: detectedPlanName } : {}),
    source: sourceId,
    sourceLabel: humanSourceLabel(source, collector),
    machine,
    collector,
    remainingPercent,
    remainingUnknown,
    isExhausted,
    resetAt: asString(meta.resetAt),
    reportedAt,
    freshness: freshness as QuotaSourceFreshness,
    detail: sourceDetail(meta, rawKey),
    kindRank: sourceKindRank(source, collector),
    reportedMs: Date.parse(reportedAt),
  };
}

function sortSourcesForDisplay(
  sources: QuotaSourceReading[],
  primary: QuotaSourceReading,
): QuotaSourceReading[] {
  const isSameAsPrimary = (row: QuotaSourceReading) =>
    row === primary ||
    (row.source === primary.source && row.reportedAt === primary.reportedAt);
  const rest = sources.filter((row) => !isSameAsPrimary(row));
  rest.sort((a, b) => Date.parse(b.reportedAt) - Date.parse(a.reportedAt));
  return [primary, ...rest];
}

interface WindowBucket {
  providerKey: string;
  candidates: QuotaSourceCandidate[];
  rawKey: string;
  windowKey: string;
  pool: ReturnType<typeof antigravityQuotaPool> | null;
}

/**
 * Folds quota events into group candidates as they arrive.
 *
 * The caller hands over each event's ALREADY parsed metadata record, so one
 * quota response decodes every metadata document exactly once and no parsed
 * record has to outlive the iteration that produced it.
 */
export interface QuotaGroupBuilder {
  /** Fold one event and its (already parsed) metadata into the candidates. */
  add(event: QuotaEventLike, meta: Record<string, unknown>): void;
  /** Assemble the provider groups from the candidates added so far. */
  finish(): QuotaProviderQuotaGroup[];
}

export function createQuotaGroupBuilder(
  now: Date,
  manifest?: ResolvedProviderManifest,
): QuotaGroupBuilder {
  const resolved = manifest ?? resolveProviderManifest(null);
  const nowMs = now.getTime();
  const byProviderWindow = new Map<string, WindowBucket>();

  const toReading = (row: QuotaSourceCandidate): QuotaSourceReading => ({
    ...(row.planMetadata ? { planMetadata: row.planMetadata } : {}),
    ...(row.planName ? { planName: row.planName } : {}),
    source: row.source,
    sourceLabel: row.sourceLabel,
    machine: row.machine,
    collector: row.collector,
    remainingPercent: row.remainingPercent,
    remainingUnknown: row.remainingUnknown,
    isExhausted: row.isExhausted,
    resetAt: row.resetAt,
    reportedAt: row.reportedAt,
    freshness: row.freshness,
    detail: row.detail ?? null,
  });

  return {
    add(event, meta) {
      const providerKey = normalizeProviderKey(event.provider, resolved);
      const via =
        resolved.byKey.get(providerKey)?.terms?.via ??
        (providerKey === "google-antigravity" ? "antigravity" : null);
      const stampedWindowKey = asString(meta.windowKey);
      const normalized = normalizeQuotaWindowKey({
        quotaWindow: asString(meta.quotaWindow),
        bucketId: asString(meta.bucketId),
        label: event.label ?? null,
        modelId: asString(meta.modelId),
      });
      const rolledKey = stampedWindowKey
        ? rollupQuotaWindowKey(stampedWindowKey)
        : rollupQuotaWindowKey(normalized.windowKey);
      const rawKey = asString(meta.rawKey) ?? normalized.rawKey;
      const pool =
        via === "antigravity"
          ? antigravityQuotaPool({
              label: event.label ?? null,
              modelId: asString(meta.modelId),
              bucketId: asString(meta.bucketId),
              modelGroup: asString(meta.modelGroup),
            })
          : null;
      const candidate = eventToCandidate(event, nowMs, via, rawKey, meta);
      if (!candidate) return;

      const groupKey = pool
        ? `${providerKey}\0${pool}\0${rolledKey}`
        : `${providerKey}\0${rolledKey}`;
      let bucket = byProviderWindow.get(groupKey);
      if (!bucket) {
        bucket = { providerKey, candidates: [], rawKey, windowKey: rolledKey, pool };
        byProviderWindow.set(groupKey, bucket);
      }
      bucket.candidates.push(candidate);
    },

    finish() {
      const providerMap = new Map<string, QuotaProviderQuotaGroup>();

      for (const [, bucket] of byProviderWindow) {
        const { providerKey, candidates, rawKey, windowKey, pool } = bucket;
        const primaryCandidate = pickPrimarySource(candidates, nowMs);
        if (!primaryCandidate) continue;

        const primary = toReading(primaryCandidate);
        // Drop the primary candidate by reference before mapping: `toReading` always
        // returns fresh objects, so filtering the mapped readings would never match.
        const sources = sortSourcesForDisplay(
          candidates.filter((row) => row !== primaryCandidate).map(toReading),
          primary,
        );

        const displayName = quotaWindowDisplayName({
          windowKey,
          rawKey,
          resetAt: primary.resetAt,
          nowMs,
        });

        let group = providerMap.get(providerKey);
        if (!group) {
          group = {
            provider: providerKey,
            providerLabel: quotaProviderLabel(providerKey, resolved),
            windows: [],
          };
          providerMap.set(providerKey, group);
        }

        group.windows.push({
          windowKey,
          displayName,
          rawKey,
          platformTitle: pool ? antigravityPlatformCardTitle(pool) : null,
          primary,
          sources,
        });
      }

      for (const group of providerMap.values()) {
        group.windows.sort((a, b) => a.displayName.localeCompare(b.displayName));
      }

      return [...providerMap.values()].sort((a, b) =>
        a.providerLabel.localeCompare(b.providerLabel),
      );
    },
  };
}

export function buildQuotaGroups(
  events: QuotaEventLike[],
  now = new Date(),
  manifest?: ResolvedProviderManifest,
): QuotaProviderQuotaGroup[] {
  const builder = createQuotaGroupBuilder(now, manifest);
  for (const event of events) {
    builder.add(event, quotaMetadataRecord(event.metadata));
  }
  return builder.finish();
}
