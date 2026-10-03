import {
  DEFAULT_PROVIDER_MANIFEST,
  type ResolvedProviderConfig,
  type ResolvedProviderManifest,
  normalizeProviderKey,
  resolveProviderManifest,
} from "@/lib/provider-manifest";

export type QuotaWindowStatus = "available" | "near_cap" | "exhausted" | "unknown";

export interface QuotaEventLike {
  provider: string;
  service?: string | null;
  label?: string | null;
  credits?: number | null;
  limit?: number | null;
  occurredAt: Date | string;
  metadata?: unknown;
}

export interface SkipModelType {
  instanceId: string;
  model: string;
}

export interface QuotaWindow {
  id: string;
  provider: string;
  /** Canonical provider key the window is grouped under (see ResolvedProviderManifest.aliasToKey). */
  providerKey: string;
  /** Human label for the provider, e.g. "Claude".  Additive; safe to ignore. */
  providerLabel: string;
  /**
   * Set to "antigravity" when the window comes from Antigravity's own routing
   * buckets rather than the named vendor's subscription.  Antigravity's CLI
   * names its non-Gemini pool "Claude and GPT models" (shown as "Third-Party
   * Models", see antigravityDisplayLabel); that is NOT the user's Claude plan.
   */
  via: string | null;
  sourceApp: string | null;
  /** Stable identity of the machine that produced this window, when supplied. */
  producerInstanceId?: string;
  /** Optional human-readable machine name supplied by the producer. */
  machine?: string;
  modelId: string | null;
  modelType: string | null;
  label: string;
  remainingPercent: number | null;
  remainingUnknown: boolean;
  isExhausted: boolean;
  resetAt: string | null;
  window: string | null;
  status: QuotaWindowStatus;
  skip: boolean;
  skipReason: string | null;
  occurredAt: string;
  source: string | null;
}

/** One provider's subscription quota windows.  Additive to the v1 response. */
export interface QuotaProviderGroup {
  provider: string;
  providerLabel: string;
  via: string | null;
  /** True for the providers the dashboard always shows a row for. */
  expected: boolean;
  /** Display order (lower first).  Optional; additive. */
  sortOrder?: number;
  /** Icon-asset hint.  Optional; apps fall back to a neutral mark when absent. */
  iconHint?: string;
  /** Quota-window display terms (only what's not derivable from windows[]). */
  terms?: {
    defaultWindowLabel?: string;
  };
  windows: QuotaWindow[];
}

export interface QuotaWindowsResponse {
  generatedAt: string;
  windows: QuotaWindow[];
  skipModelTypes: SkipModelType[];
  /**
   * Windows grouped by provider, with an entry for every expected provider even
   * when it has reported nothing yet (empty `windows`).  A provider that is
   * missing should be visible, not silently absent.
   *
   * `sortOrder`, `iconHint`, and `terms` are sourced from the backend
   * provider-manifest (PROVIDER_MANIFEST_JSON Infisical knob, merged on top of
   * compiled defaults).  Apps may use them as a primary display signal so a
   * new provider can be added with no app release.
   */
  providerGroups: QuotaProviderGroup[];
}

const ANTIGRAVITY_INSTANCE = "antigravity";

/**
 * Display name for Antigravity's shared non-Gemini model pool.  The CLI calls
 * the pool "Claude and GPT models"; that raw name is still what the collector
 * stores in `metadata.modelGroup` and what older ingested events carry in
 * `label`, so it is only ever rewritten at display time.  Mirrors
 * `antigravityGroupDisplayName` in scripts/lib/quota-event.mjs and
 * `AntigravityQuotaGroups` in the macOS app.
 */
export const ANTIGRAVITY_THIRD_PARTY_LABEL = "Third-Party Models";

// "Claude and GPT models", "Claude & GPT models", "Claude/GPT", ... as a
// label prefix.  The lookahead stops it rewriting a longer model name such as
// "Claude and GPT-OSS", and leaves a trailing "(weekly)" / "(5h)" intact.
const LEGACY_THIRD_PARTY_LABEL =
  /^\s*claude\s*(?:and|&|\/|\+|,)\s*gpt(?:[\s-]*models?)?(?=\s|\(|$)/i;

/**
 * Map the legacy Antigravity "Claude and GPT models" label (new or already
 * ingested) onto "Third-Party Models".  Any other label passes through.
 * Callers gate this on the window being an Antigravity routing bucket.
 */
export function antigravityDisplayLabel<T extends string | null | undefined>(label: T): T {
  if (typeof label !== "string") return label;
  return label.replace(LEGACY_THIRD_PARTY_LABEL, ANTIGRAVITY_THIRD_PARTY_LABEL) as T;
}

const CLAUDE_GPT_MODELS = [
  "claude-opus-4-6-thinking",
  "claude-sonnet-4-6",
  "gpt-oss-120b-medium",
];

const GEMINI_MODELS = [
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "gemini-3-flash",
];

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
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

export function quotaStatus(input: {
  remainingPercent: number | null;
  remainingUnknown: boolean;
  isExhausted: boolean;
}): QuotaWindowStatus {
  if (input.isExhausted || (input.remainingPercent != null && input.remainingPercent <= 0)) {
    return "exhausted";
  }
  // antigravity-usage prints N/A when remainingPercentage is omitted.
  // Owner 2026-09-04: that means none remains.
  if (input.remainingUnknown || input.remainingPercent == null) return "exhausted";
  if (input.remainingPercent < 20) return "near_cap";
  return "available";
}

function skipTargetsFor(window: QuotaWindow): SkipModelType[] {
  if (!window.skip) return [];
  // skipModelTypes drives Antigravity instance routing only.  Claude/Codex/
  // Grok/MiniMax subscription windows must never emit an antigravity skip.
  if (window.via !== "antigravity") return [];
  if (window.modelId) {
    return [{ instanceId: ANTIGRAVITY_INSTANCE, model: window.modelId }];
  }
  const group = `${window.label} ${window.provider}`.toLowerCase();
  // "third-party" is the display label for this pool; claude/gpt still match
  // the raw CLI name and any per-model label.
  if (
    group.includes("third-party") ||
    group.includes("third party") ||
    group.includes("claude") ||
    group.includes("gpt")
  ) {
    return CLAUDE_GPT_MODELS.map((model) => ({ instanceId: ANTIGRAVITY_INSTANCE, model }));
  }
  if (group.includes("gemini")) {
    return GEMINI_MODELS.map((model) => ({ instanceId: ANTIGRAVITY_INSTANCE, model }));
  }
  return [];
}

/**
 * Compute the Antigravity via marker for a canonical key.  Reads the
 * resolved manifest so an admin can add a new antigravity-routed provider
 * via Infisical without a code change.  Falls back to the historical
 * `google-antigravity` heuristic when the manifest hasn't marked a provider.
 */
function viaFor(
  canonicalKey: string,
  manifest: ResolvedProviderManifest,
): string | null {
  const cfg = manifest.byKey.get(canonicalKey);
  if (cfg?.terms?.via) return cfg.terms.via;
  if (canonicalKey === "google-antigravity") return "antigravity";
  return null;
}

/** Canonical provider key the window is grouped under. */
export function quotaProviderKey(
  provider: string,
  manifest?: ResolvedProviderManifest,
): string {
  const resolved = manifest ?? resolveProviderManifest(null);
  return normalizeProviderKey(provider, resolved);
}

/** Human label for a provider key.  Falls back to the raw slug. */
export function quotaProviderLabel(
  provider: string,
  manifest?: ResolvedProviderManifest,
): string {
  const resolved = manifest ?? resolveProviderManifest(null);
  const key = normalizeProviderKey(provider, resolved);
  const cfg = resolved.byKey.get(key);
  if (cfg) return cfg.label;
  return key || "Unknown";
}

/** Antigravity via marker; backward-compatible public API. */
export function quotaProviderVia(
  provider: string,
  manifest?: ResolvedProviderManifest,
): string | null {
  const resolved = manifest ?? resolveProviderManifest(null);
  const key = normalizeProviderKey(provider, resolved);
  return viaFor(key, resolved);
}

export function projectQuotaWindows(
  events: QuotaEventLike[],
  now = new Date(),
  manifest?: ResolvedProviderManifest,
): QuotaWindowsResponse {
  const resolved = manifest ?? resolveProviderManifest(null);

  const latest = new Map<string, { window: QuotaWindow; series: string }>();
  for (const event of events) {
    const meta = asRecord(event.metadata);
    const modelId = asString(meta.modelId);
    const bucketId = asString(meta.bucketId);
    const producerInstanceId = asString(meta._producerInstanceId);
    const machine = asString(meta.machine);
    // Display label only: stored events keep their original label, so rows
    // ingested before the rename read "Third-Party Models" too.  Normalized
    // before the series key so an old and a new reading of the same bucket
    // still collapse onto one series.
    const eventCanonicalKey = normalizeProviderKey(event.provider, resolved);
    const label =
      viaFor(eventCanonicalKey, resolved) === "antigravity"
        ? antigravityDisplayLabel(event.label)
        : event.label;
    const series = modelId ?? bucketId ?? `${event.provider}:${label ?? ""}`;
    // Preserve historical IDs exactly when provenance is absent.  For
    // attributed windows, encode the identity and series as a JSON tuple so
    // delimiters inside either value cannot make two machines share a key.
    const id = producerInstanceId ? JSON.stringify([producerInstanceId, series]) : series;
    const dedupeKey = producerInstanceId
      ? JSON.stringify(["producer", producerInstanceId, series])
      : JSON.stringify(["legacy", series]);
    if (latest.has(dedupeKey)) continue;

    const limit = typeof event.limit === "number" && event.limit > 0 ? event.limit : 100;
    const omitted = asBoolean(meta.remainingUnknown) || event.credits == null;
    const remainingPercent = omitted
      ? 0
      : Math.round((Number(event.credits) / limit) * 10_000) / 100;
    const isExhausted =
      asBoolean(meta.isExhausted) || omitted || remainingPercent <= 0;
    const remainingUnknown = false;
    const status = quotaStatus({ remainingPercent, remainingUnknown, isExhausted });
    latest.set(dedupeKey, {
      series,
      window: {
        id,
        provider: event.provider,
        providerKey: eventCanonicalKey,
        providerLabel: (() => {
          const cfg = resolved.byKey.get(eventCanonicalKey);
          return cfg?.label ?? (eventCanonicalKey || "Unknown");
        })(),
        via: viaFor(eventCanonicalKey, resolved),
        sourceApp: event.service ?? null,
        ...(producerInstanceId ? { producerInstanceId } : {}),
        ...(machine ? { machine } : {}),
        modelId,
        modelType: modelId,
        label: label ?? modelId ?? event.provider,
        remainingPercent,
        remainingUnknown,
        isExhausted,
        resetAt: asString(meta.resetAt),
        window: asString(meta.quotaWindow),
        status,
        skip: status === "exhausted",
        skipReason:
          status === "exhausted"
            ? `${label ?? modelId ?? "model"} remaining ${remainingPercent ?? 0}%`
            : null,
        occurredAt: iso(event.occurredAt),
        source: asString(meta.source),
      },
    });
  }

  const projected = [...latest.values()];
  // Legacy IDs are intentionally unchanged, including arbitrary bucket IDs.
  // Reserve them before assigning machine IDs so a legacy bucket that happens
  // to equal a serialized tuple cannot collide with a producer-attributed row.
  const usedIds = new Set(
    projected
      .filter(({ window }) => !window.producerInstanceId)
      .map(({ window }) => window.id),
  );
  const windows = projected.map(({ window, series }) => {
    if (!window.producerInstanceId) return window;

    let id = JSON.stringify([window.producerInstanceId, series]);
    let suffix = 0;
    while (usedIds.has(id)) {
      id = JSON.stringify(["producer", window.producerInstanceId, series, suffix]);
      suffix += 1;
    }
    usedIds.add(id);
    window.id = id;
    return window;
  });
  const skipModelTypes: SkipModelType[] = [];
  const seenSkip = new Set<string>();
  for (const window of windows) {
    for (const target of skipTargetsFor(window)) {
      const key = `${target.instanceId}:${target.model}`;
      if (seenSkip.has(key)) continue;
      seenSkip.add(key);
      skipModelTypes.push(target);
    }
  }

  return {
    generatedAt: now.toISOString(),
    windows,
    skipModelTypes,
    providerGroups: groupWindowsByProvider(windows, resolved),
  };
}

/**
 * Group windows by canonical provider.  Every expected provider gets a group
 * even with no windows, so the dashboard can show "no quota report yet"
 * instead of quietly omitting the provider.  Carries the backend manifest's
 * display fields (`sortOrder`, `iconHint`, `terms`) onto each group so apps
 * can render without hardcoded provider lists.
 */
/**
 * Canonical provider keys for subscription quota reporting, in display order.
 * Re-exported for backward compatibility; the live source is the resolved
 * provider-manifest (see src/lib/provider-manifest.ts).  This array stays the
 * frozen list of compiled-in defaults so existing callers keep working.
 */
export const EXPECTED_QUOTA_PROVIDERS: readonly string[] = Object.freeze(
  DEFAULT_PROVIDER_MANIFEST.providers.map((p) => p.key),
);

export function groupWindowsByProvider(
  windows: QuotaWindow[],
  manifest?: ResolvedProviderManifest,
): QuotaProviderGroup[] {
  const resolved = manifest ?? resolveProviderManifest(null);

  const groups = new Map<string, QuotaProviderGroup>();
  for (const cfg of resolved.providers) {
    groups.set(cfg.key, manifestGroupFromConfig(cfg));
  }
  for (const window of windows) {
    const key = window.providerKey;
    let group = groups.get(key);
    if (!group) {
      // A window arrived for a key not in the resolved manifest — surface
      // it as a non-expected group so the user still sees the data.
      group = {
        provider: key,
        providerLabel: window.providerLabel || key,
        via: window.via,
        expected: false,
        windows: [],
      };
      groups.set(key, group);
    }
    group.windows.push(window);
  }
  for (const group of groups.values()) {
    group.windows.sort((a, b) => a.label.localeCompare(b.label));
  }
  return [...groups.values()];
}

function manifestGroupFromConfig(cfg: ResolvedProviderConfig): QuotaProviderGroup {
  const group: QuotaProviderGroup = {
    provider: cfg.key,
    providerLabel: cfg.label,
    via: cfg.terms?.via ?? (cfg.key === "google-antigravity" ? "antigravity" : null),
    expected: cfg.expected,
    sortOrder: cfg.sortOrder,
    iconHint: cfg.iconHint,
    windows: [],
  };
  if (cfg.terms?.defaultWindowLabel) {
    group.terms = { defaultWindowLabel: cfg.terms.defaultWindowLabel };
  }
  return group;
}
