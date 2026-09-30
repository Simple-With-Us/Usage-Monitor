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
  /** Canonical provider key the window is grouped under (see PROVIDER_ALIASES). */
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
  /** True for the five providers the dashboard always shows a row for. */
  expected: boolean;
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
   */
  providerGroups: QuotaProviderGroup[];
}

const ANTIGRAVITY_INSTANCE = "antigravity";

/**
 * Canonical provider keys for subscription quota reporting, in display order.
 * The dashboard renders a row for every one of these, reported or not.
 */
export const EXPECTED_QUOTA_PROVIDERS = [
  "anthropic",
  "openai",
  "google-antigravity",
  "xai",
  "minimax",
  "grok-bot",
] as const;

/** Event `provider` values that should collapse onto one canonical key. */
const PROVIDER_ALIASES: Record<string, string> = {
  anthropic: "anthropic",
  "claude-code": "anthropic",
  claude: "anthropic",
  openai: "openai",
  "openai-codex": "openai",
  codex: "openai",
  google: "google-antigravity",
  "google-antigravity": "google-antigravity",
  antigravity: "google-antigravity",
  "antigravity-cli": "google-antigravity",
  xai: "xai",
  "grok-build": "xai",
  grok: "xai",
  minimax: "minimax",
  "minimax-code": "minimax",
  "grok-bot": "grok-bot",
  gbu: "grok-bot",
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Claude",
  openai: "Codex",
  "google-antigravity": "Antigravity",
  xai: "Grok",
  minimax: "MiniMax",
  "grok-bot": "Grok Bot",
};

/** Collapse an event `provider` onto the key its windows are grouped under. */
export function quotaProviderKey(provider: string): string {
  const raw = String(provider ?? "").trim().toLowerCase();
  return PROVIDER_ALIASES[raw] ?? raw;
}

/** Human label for a provider key.  Falls back to the raw slug. */
export function quotaProviderLabel(provider: string): string {
  const key = quotaProviderKey(provider);
  return PROVIDER_LABELS[key] ?? (key || "Unknown");
}

/**
 * Antigravity routes to several vendors' models under its own subscription, so
 * its buckets must never be presented as the user's Claude or ChatGPT plan.
 */
export function quotaProviderVia(provider: string): string | null {
  return quotaProviderKey(provider) === "google-antigravity" ? "antigravity" : null;
}

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

export function projectQuotaWindows(
  events: QuotaEventLike[],
  now = new Date(),
): QuotaWindowsResponse {
  const latest = new Map<string, QuotaWindow>();
  for (const event of events) {
    const meta = asRecord(event.metadata);
    const modelId = asString(meta.modelId);
    const bucketId = asString(meta.bucketId);
    // Display label only: stored events keep their original label, so rows
    // ingested before the rename read "Third-Party Models" too.  Normalized
    // before the series key so an old and a new reading of the same bucket
    // still collapse onto one series.
    const label =
      quotaProviderVia(event.provider) === "antigravity"
        ? antigravityDisplayLabel(event.label)
        : event.label;
    const series = modelId ?? bucketId ?? `${event.provider}:${label ?? ""}`;
    if (latest.has(series)) continue;

    const limit = typeof event.limit === "number" && event.limit > 0 ? event.limit : 100;
    const omitted = asBoolean(meta.remainingUnknown) || event.credits == null;
    const remainingPercent = omitted
      ? 0
      : Math.round((Number(event.credits) / limit) * 10_000) / 100;
    const isExhausted =
      asBoolean(meta.isExhausted) || omitted || remainingPercent <= 0;
    const remainingUnknown = false;
    const status = quotaStatus({ remainingPercent, remainingUnknown, isExhausted });
    latest.set(series, {
      id: series,
      provider: event.provider,
      providerKey: quotaProviderKey(event.provider),
      providerLabel: quotaProviderLabel(event.provider),
      via: quotaProviderVia(event.provider),
      sourceApp: event.service ?? null,
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
    });
  }

  const windows = [...latest.values()];
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
    providerGroups: groupWindowsByProvider(windows),
  };
}

/**
 * Group windows by canonical provider.  Every expected provider gets a group
 * even with no windows, so the dashboard can show "no quota report yet" instead
 * of quietly omitting the provider.
 */
export function groupWindowsByProvider(windows: QuotaWindow[]): QuotaProviderGroup[] {
  const groups = new Map<string, QuotaProviderGroup>();
  for (const provider of EXPECTED_QUOTA_PROVIDERS) {
    groups.set(provider, {
      provider,
      providerLabel: quotaProviderLabel(provider),
      via: quotaProviderVia(provider),
      expected: true,
      windows: [],
    });
  }
  for (const window of windows) {
    const key = window.providerKey;
    let group = groups.get(key);
    if (!group) {
      group = {
        provider: key,
        providerLabel: quotaProviderLabel(key),
        via: quotaProviderVia(key),
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
