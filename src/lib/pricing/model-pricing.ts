// Model-pricing lookup + token-cost derivation backed by a bundled snapshot
// of the LiteLLM model_prices_and_context_window.json catalog
// (src/lib/pricing/model-pricing.snapshot.json — regenerate with
// `npm run pricing:update`, see scripts/update-model-pricing.mjs).
//
// Design follows ccusage's pricing architecture (verified against
// github.com/ccusage/ccusage, 2026-07-29):
//   - Bundled, provenance-stamped snapshot instead of a runtime fetch — the
//     read path never depends on GitHub, and pricing changes land as
//     reviewable diffs.
//   - Provider-prefixed model-name candidates: producers report everything
//     from bare `claude-sonnet-4-5` to `openrouter/anthropic/claude-sonnet-4.5`,
//     so lookup tries progressive prefix stripping before a bounded fuzzy
//     match.
//   - Derived cost is a CROSS-CHECK/fallback, never authoritative cash:
//     recorded provider cost always wins (budget-status.ts already enforces
//     that ordering; this module only estimates from tokens).
//
// Known limitation (shared with ccusage): the long-context premium tiers
// (`*_above_200k_tokens`; the threshold is `long_context_threshold_tokens`,
// default 200k) require per-request context size, which neither Claude Code
// OTLP points nor generic ingest events carry. Callers may pass `longContext`
// (alias `above200k`) explicitly; otherwise base rates are used and
// long-context usage is under-priced by the premium delta.
//
// Anthropic specifics (platform.claude.com/docs/en/about-claude/pricing,
// verified 2026-10-17): Claude 4.6+ models bill the full 1M context at the
// standard rate, so a `[1m]` suffix (Claude Code's 1M-context marker) is
// stripped and carries no premium.  Claude Haiku 5.5 is the exception: a
// request whose prompt is over 100k tokens pays 5x the prices.  Cache writes
// have two TTLs (5m = 1.25x input, 1h = 2x input); token rows without a TTL
// split are priced at the 5m rate, which is a LOWER BOUND when the producer
// actually wrote 1h entries (Claude Code does for some sessions).  The Batch
// API is a flat 50% off every category; no producer reports batch usage, so
// it is not modeled.

import { isDeepSeekPaygModel } from "./deepseek-payg";
import snapshot from "./model-pricing.snapshot.json";

export interface ModelPricingEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  cache_creation_input_token_cost_above_1hr?: number;
  /** Prompt-length threshold (tokens) above which the `*_above_200k_tokens`
   * rates apply.  Defaults to 200_000 when absent (Claude Haiku 5.5 sets
   * 100_000, despite the field names). */
  long_context_threshold_tokens?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
  cache_creation_input_token_cost_above_1hr_above_200k_tokens?: number;
  litellm_provider?: string;
  mode?: string;
  max_input_tokens?: number;
}

interface PricingSnapshot {
  meta: {
    source: string;
    fetchedAt: string;
    upstreamSha256: string;
    modelCount: number;
  };
  pricing: Record<string, ModelPricingEntry>;
}

const CATALOG = (snapshot as PricingSnapshot).pricing;

/** Live OpenRouter Gemini 3.7 rates (2026-08-14).  The LiteLLM snapshot dump
 *  is not rewritten; these keys are what ingest derivation actually looks up. */
const GEMINI_37_FLASH: ModelPricingEntry = {
  input_cost_per_token: 3.75e-7,
  output_cost_per_token: 1.875e-6,
  cache_read_input_token_cost: 3.75e-8,
  cache_creation_input_token_cost: 2.08333333333333e-8,
  litellm_provider: "gemini",
  mode: "chat",
};

const GEMINI_37_FLASH_BATCH: ModelPricingEntry = {
  input_cost_per_token: 1.875e-7,
  output_cost_per_token: 9.375e-7,
  cache_read_input_token_cost: 1.875e-8,
  cache_creation_input_token_cost: 2.08333333333333e-8,
  litellm_provider: "gemini",
  mode: "chat",
};

/** xAI public list prices (docs.x.ai/developers/pricing, 2026-08-21).  The
 *  July LiteLLM snapshot has no grok-4.5/4.6 keys; Grok Build reports
 *  `grok-4.6-build`.  Cache-write uses the input rate (xAI does not list a
 *  separate write price).  Long-context (>=200k) doubles. */
const GROK_46: ModelPricingEntry = {
  input_cost_per_token: 2e-6,
  output_cost_per_token: 6e-6,
  cache_read_input_token_cost: 5e-7,
  cache_creation_input_token_cost: 2e-6,
  input_cost_per_token_above_200k_tokens: 4e-6,
  output_cost_per_token_above_200k_tokens: 12e-6,
  cache_read_input_token_cost_above_200k_tokens: 1e-6,
  cache_creation_input_token_cost_above_200k_tokens: 4e-6,
  litellm_provider: "xai",
  mode: "chat",
  max_input_tokens: 500_000,
};

const GROK_45: ModelPricingEntry = {
  input_cost_per_token: 2e-6,
  output_cost_per_token: 6e-6,
  cache_read_input_token_cost: 3e-7,
  cache_creation_input_token_cost: 2e-6,
  input_cost_per_token_above_200k_tokens: 4e-6,
  output_cost_per_token_above_200k_tokens: 12e-6,
  cache_read_input_token_cost_above_200k_tokens: 6e-7,
  cache_creation_input_token_cost_above_200k_tokens: 4e-6,
  litellm_provider: "xai",
  mode: "chat",
  max_input_tokens: 500_000,
};

/** xAI public list prices (docs.x.ai/docs/models — Text API Pricing, 2026-10-15). */
const GROK_47: ModelPricingEntry = {
  input_cost_per_token: 2e-6,
  output_cost_per_token: 6e-6,
  cache_read_input_token_cost: 5e-7,
  cache_creation_input_token_cost: 2e-6,
  input_cost_per_token_above_200k_tokens: 4e-6,
  output_cost_per_token_above_200k_tokens: 12e-6,
  cache_read_input_token_cost_above_200k_tokens: 1e-6,
  cache_creation_input_token_cost_above_200k_tokens: 4e-6,
  litellm_provider: "xai",
  mode: "chat",
  max_input_tokens: 500_000,
};

const GEMINI_36_FLASH: ModelPricingEntry = {
  input_cost_per_token: 3.75e-7,
  output_cost_per_token: 1.875e-6,
  cache_read_input_token_cost: 3.75e-8,
  cache_creation_input_token_cost: 2.08333333333333e-8,
  litellm_provider: "gemini",
  mode: "chat",
};

const GEMINI_25_PRO: ModelPricingEntry = {
  input_cost_per_token: 1.25e-6,
  output_cost_per_token: 5e-6,
  cache_read_input_token_cost: 3.125e-7,
  cache_creation_input_token_cost: 1.25e-7,
  litellm_provider: "gemini",
  mode: "chat",
};

/** Claude Haiku 5.5 long-prompt tier (prompts over 100,000 tokens pay 5x),
 *  platform.claude.com/docs/en/about-claude/pricing, 2026-10-17.  Layered on
 *  the snapshot's base row (see CATALOG_PATCHES) because LiteLLM has no tier
 *  fields for it. */
const CLAUDE_HAIKU_5_5_LONG_PROMPT_PATCH: ModelPricingEntry = {
  long_context_threshold_tokens: 100_000,
  input_cost_per_token_above_200k_tokens: 0.5e-6,
  output_cost_per_token_above_200k_tokens: 2.5e-6,
  cache_read_input_token_cost_above_200k_tokens: 0.05e-6,
  cache_creation_input_token_cost_above_200k_tokens: 0.625e-6,
  cache_creation_input_token_cost_above_1hr_above_200k_tokens: 1e-6,
};

/** Fields layered over a snapshot row.  The Anthropic base rates themselves
 *  come from the snapshot (LiteLLM caught up with the 5.5 / Fable 5.1 models
 *  on 2026-10-18 and matches Anthropic's pricing page; model-pricing.test.ts
 *  pins the page values so a bad refresh fails CI). */
const CATALOG_PATCHES: Record<string, ModelPricingEntry> = {
  "claude-haiku-5-5": CLAUDE_HAIKU_5_5_LONG_PROMPT_PATCH,
};

const GPT_56_LUNA: ModelPricingEntry = {
  input_cost_per_token: 0.2e-6,
  output_cost_per_token: 1.2e-6,
  cache_read_input_token_cost: 0.02e-6,
  litellm_provider: "openai",
  mode: "chat",
};

const GPT_56_TERRA: ModelPricingEntry = {
  input_cost_per_token: 2e-6,
  output_cost_per_token: 12e-6,
  cache_read_input_token_cost: 0.2e-6,
  litellm_provider: "openai",
  mode: "chat",
};

const GPT_56_SOL: ModelPricingEntry = {
  input_cost_per_token: 4e-6,
  output_cost_per_token: 20e-6,
  cache_read_input_token_cost: 0.4e-6,
  litellm_provider: "openai",
  mode: "chat",
};

/** OpenAI standard API rates, 2026-09-13.  Codex OAuth usage remains a
 * subscription signal; this price is API-equivalent analytics only. */
const GPT_6_ASTRA: ModelPricingEntry = {
  input_cost_per_token: 1e-5,
  output_cost_per_token: 5e-5,
  cache_read_input_token_cost: 1e-6,
  litellm_provider: "openai",
  mode: "chat",
};

/** MiniMax M3 pay-as-you-go list rates (platform.minimax.io/docs/pricing/overview,
 *  2026-10-17; "permanent 50% off" price).  Prompts over 512k input tokens pay
 *  2x.  No cache-write charge for M3 (prompt-caching page). */
const MINIMAX_M3: ModelPricingEntry = {
  input_cost_per_token: 0.3e-6,
  output_cost_per_token: 1.2e-6,
  cache_read_input_token_cost: 0.06e-6,
  long_context_threshold_tokens: 512_000,
  input_cost_per_token_above_200k_tokens: 0.6e-6,
  output_cost_per_token_above_200k_tokens: 2.4e-6,
  cache_read_input_token_cost_above_200k_tokens: 0.12e-6,
  litellm_provider: "minimax",
  mode: "chat",
  max_input_tokens: 1_000_000,
};

const RUNTIME_PRICING_OVERRIDES: Record<string, ModelPricingEntry> = {
  "minimax-m3": MINIMAX_M3,
  "minimax/minimax-m3": MINIMAX_M3,
  "gemini-3.7-flash": GEMINI_37_FLASH,
  "gemini-3.7-flash:batch": GEMINI_37_FLASH_BATCH,
  "gemini-3.6-flash": GEMINI_36_FLASH,
  "gemini-2.5-pro": GEMINI_25_PRO,
  "gpt-5.6-luna": GPT_56_LUNA,
  "gpt-5.6-terra": GPT_56_TERRA,
  "gpt-5.6-sol": GPT_56_SOL,
  "gpt-6-astra": GPT_6_ASTRA,
  "grok-4.6": GROK_46,
  "grok-4.6-build": GROK_46,
  "xai/grok-4.6": GROK_46,
  "xai/grok-4.6-build": GROK_46,
  "grok-4.5": GROK_45,
  "grok-4.5-build": GROK_45,
  "xai/grok-4.5": GROK_45,
  "xai/grok-4.5-build": GROK_45,
  "grok-4.7": GROK_47,
  "xai/grok-4.7": GROK_47,
};

// Codex Spark has no published standard API rate.  DeepSeek Flash / V4 Pro
// are not in this set: they have published peak and off-peak rates, priced
// per event in deepseek-payg.ts.  Their LiteLLM snapshot rows are a single
// stale rate and must not be used as a weekday average.
// MiniMax-M3.1-Flash-Preview (and its -thinking variant) is plan-only: no
// pay-as-you-go API price is published (2026-10-17).
const EXPLICITLY_UNPRICED_MODELS = new Set([
  "gpt-5.3-codex-spark",
  "minimax-m3.1-flash-preview",
]);

function isExplicitlyUnpricedAlias(model: string): boolean {
  const lower = model.trim().toLowerCase();
  const basename = lower.split("/").pop() || lower;
  if (EXPLICITLY_UNPRICED_MODELS.has(lower) || EXPLICITLY_UNPRICED_MODELS.has(basename)) {
    return true;
  }
  return [...EXPLICITLY_UNPRICED_MODELS].some((key) => basename.startsWith(`${key}-`));
}

function catalogEntry(key: string): ModelPricingEntry | undefined {
  const base = RUNTIME_PRICING_OVERRIDES[key] ?? CATALOG[key];
  const patch = CATALOG_PATCHES[key];
  return base && patch ? { ...base, ...patch } : base;
}

/** Provenance of the bundled catalog — surfaced in API responses and UI so a
 * derived cost can always be traced to an exact upstream pricing revision. */
export const PRICING_SNAPSHOT_META = (snapshot as PricingSnapshot).meta;

export interface TokenBreakdown {
  input?: number;
  output?: number;
  cacheRead?: number;
  /** Cache-write tokens at the 5-minute rate.  Also the bucket for rows with
   * no TTL split (legacy `cacheCreation`), so it is a lower bound when the
   * producer really wrote 1h entries. */
  cacheCreation?: number;
  /** Cache-write tokens known to be 1-hour TTL (`cacheCreation1h`). */
  cacheCreation1h?: number;
}

export type CanonicalTokenType =
  | "input"
  | "output"
  | "cacheRead"
  | "cacheCreation"
  | "cacheCreation1h";

/**
 * Map a producer's token-type string to the canonical pricing bucket, or null
 * when it is not a known type.  Names are coordinated with UM-1592 (canonical
 * `ai.tokens` block): `cacheCreation` is the legacy 5m/unspecified write,
 * `cacheCreation5m` / `cacheWrite5m` are explicit 5m, and `cacheCreation1h` /
 * `cacheWrite1h` / `cacheWriteOneHour` are 1h writes.
 */
export function canonicalTokenType(raw: string | null | undefined): CanonicalTokenType | null {
  if (!raw) return null;
  switch (raw.trim().toLowerCase()) {
    case "input":
      return "input";
    case "output":
      return "output";
    case "cacheread":
      return "cacheRead";
    case "cachecreation":
    case "cachecreation5m":
    case "cachewrite":
    case "cachewrite5m":
      return "cacheCreation";
    case "cachecreation1h":
    case "cachewrite1h":
    case "cachewriteonehour":
    case "cachewriteonehourtokens":
      return "cacheCreation1h";
    default:
      return null;
  }
}

/** True when a metadata TTL value (`cacheTtl`, `ttl`) denotes the 1h cache. */
export function isOneHourCacheTtl(value: unknown): boolean {
  if (typeof value === "number") return value >= 3600;
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return v === "1h" || v === "60m" || v === "3600" || v === "3600s" || v === "1hr";
}

export interface DerivedTokenCost {
  costUsd: number;
  /** False when a token type had a positive count but the catalog entry has
   * no rate for it — costUsd then UNDER-counts and must not be treated as a
   * complete estimate. */
  complete: boolean;
}

// Provider path segments seen in the wild (LiteLLM keys, OpenRouter ids,
// Claude Code model attributes). Stripped progressively during lookup.
const PROVIDER_PREFIXES = [
  "anthropic",
  "openrouter",
  "bedrock",
  "vertex_ai",
  "vertex-ai",
  "gemini",
  "azure",
  "azure_ai",
  "openai",
  "xai",
  "mistral",
  "groq",
  "deepseek",
  "cohere",
  "voyage",
  "cloudflare",
];

const lookupCache = new Map<string, string | null>();

export interface NormalizedModelName {
  /** Model id with any trailing `[...]` marker removed and, for Claude ids,
   * dotted versions folded to dashed (`claude-opus-5.5` -> `claude-opus-5-5`). */
  name: string;
  /** True when the producer marked the 1M-context variant (`[1m]`).  Carries
   * no price change on Claude 4.6+ (see header), but is surfaced explicitly. */
  context1m: boolean;
}

/** Strip Claude Code's `[1m]` (or any trailing `[...]`) marker and normalize
 * Claude version punctuation.  Pure; does not consult the catalog. */
export function normalizeModelName(model: string): NormalizedModelName {
  let name = model.trim();
  let context1m = false;
  const bracket = /\[([^\]]*)\]$/.exec(name);
  if (bracket) {
    context1m = bracket[1].trim().toLowerCase() === "1m";
    name = name.slice(0, bracket.index).trim();
  }
  if (/(^|\/)claude-/i.test(name)) {
    name = name.replace(/(\d)\.(\d)/g, "$1-$2");
  }
  return { name, context1m };
}

/**
 * Resolve a producer-reported model name to a catalog key, or null when the
 * model is not priced in the snapshot. Deterministic order:
 *   0. `[1m]` marker / Claude dotted-version normalization
 *   1. exact key (case-sensitive, then lowercased)
 *   2. progressive provider-prefix stripping ("openrouter/anthropic/X" ->
 *      "anthropic/X" -> "X")
 *   3. bounded fuzzy: longest catalog key (>= 8 chars) that is a strict
 *      `key + "-"` prefix of the name AND whose remainder is an alias or
 *      date suffix, never a version component.  The remainder may not start
 *      with a 1-3 digit number: `claude-opus-5-5` must not resolve to
 *      `claude-opus-5` (different prices) and `claude-fable-5-1` must not
 *      resolve to `claude-fable-5`; they are unpriced until the catalog has
 *      them.  Date suffixes (`-20251001`, `-2024-08-06`) and aliases
 *      (`-latest`) still match.
 */
export function resolvePricingKey(model: string): string | null {
  const cached = lookupCache.get(model);
  if (cached !== undefined) return cached;

  const key = resolvePricingKeyUncached(model);
  // Bound the cache; model cardinality is naturally small but a hostile or
  // buggy producer could spray unique names.
  if (lookupCache.size > 4096) lookupCache.clear();
  lookupCache.set(model, key);
  return key;
}

/** A fuzzy-prefix remainder that starts with a short number is a version
 * component of a DIFFERENT model, not an alias/date suffix. */
function isVersionLikeRemainder(remainder: string): boolean {
  return /^\d{1,3}(?:[-._]|$)/.test(remainder);
}

function resolvePricingKeyUncached(model: string): string | null {
  const trimmed = normalizeModelName(model).name;
  if (!trimmed) return null;
  if (isExplicitlyUnpricedAlias(trimmed)) return null;
  // Time-priced DeepSeek ids are in the bundled snapshot at one flat rate.
  // Returning null here keeps grouped analytics from applying that rate.
  // Agents overview prices each event from occurredAt instead.
  if (isDeepSeekPaygModel(trimmed)) return null;
  if (catalogEntry(trimmed)) return trimmed;

  const lower = trimmed.toLowerCase();
  if (catalogEntry(lower)) return lower;

  const withoutBuild = lower.replace(/-build$/, "");
  if (withoutBuild !== lower && catalogEntry(withoutBuild)) return withoutBuild;
  if (catalogEntry(`xai/${lower}`)) return `xai/${lower}`;
  if (withoutBuild !== lower && catalogEntry(`xai/${withoutBuild}`)) {
    return `xai/${withoutBuild}`;
  }

  if (trimmed.includes("/")) {
    const segments = trimmed.split("/");
    for (let i = 1; i < segments.length; i++) {
      const remainder = segments.slice(i).join("/");
      if (catalogEntry(remainder)) return remainder;
      const remainderLower = remainder.toLowerCase();
      if (catalogEntry(remainderLower)) return remainderLower;
      // Also try stripping just recognized provider segments even when
      // intermediate segments remain (e.g. "openrouter/anthropic/X" -> "X").
      const withoutProviders = segments
        .filter((s) => !PROVIDER_PREFIXES.includes(s.toLowerCase()))
        .join("/");
      if (withoutProviders && catalogEntry(withoutProviders)) return withoutProviders;
    }
  }

  let best: string | null = null;
  for (const key of [...Object.keys(RUNTIME_PRICING_OVERRIDES), ...Object.keys(CATALOG)]) {
    if (key.length < 8 || key.includes("/")) continue;
    const prefix = `${key.toLowerCase()}-`;
    if (!lower.startsWith(prefix)) continue;
    if (isVersionLikeRemainder(lower.slice(prefix.length))) continue;
    if (best === null || key.length > best.length) best = key;
  }
  return best;
}

/** Catalog entry for a model, or null when unpriced. */
export function getModelPricing(model: string): {
  key: string;
  pricing: ModelPricingEntry;
} | null {
  const key = resolvePricingKey(model);
  if (!key || isExplicitlyUnpricedAlias(key)) return null;
  const pricing = catalogEntry(key);
  if (!pricing) return null;
  return { key, pricing };
}

function pickRate(
  base: number | undefined,
  longContext: number | undefined,
  useLongContext: boolean
): number | undefined {
  if (useLongContext && longContext != null) return longContext;
  return base;
}

/** Prompt-length threshold above which the long-context rates apply. */
export function longContextThresholdTokens(pricing: ModelPricingEntry): number {
  return pricing.long_context_threshold_tokens ?? 200_000;
}

/** True when the entry has a long-context tier at all. */
export function hasLongContextTier(pricing: ModelPricingEntry): boolean {
  return pricing.input_cost_per_token_above_200k_tokens != null;
}

/**
 * Derive an API-equivalent USD cost from a token breakdown. Returns null when
 * the model is unpriced. `complete` is false when a present token type has no
 * catalog rate (cost then under-counts).
 *
 * `longContext` selects the long-prompt tier (`above200k` is the legacy
 * alias).  1h cache writes use `cache_creation_input_token_cost_above_1hr`;
 * when the entry has none they fall back to the 5m rate and the result is
 * flagged incomplete.
 */
export function deriveTokenCostUsd(
  pricing: ModelPricingEntry,
  tokens: TokenBreakdown,
  opts: { above200k?: boolean; longContext?: boolean } = {}
): DerivedTokenCost {
  const long = opts.longContext === true || opts.above200k === true;
  let costUsd = 0;
  let complete = true;

  const add = (count: number | undefined, rate: number | undefined) => {
    if (!count || count <= 0) return;
    if (rate == null) {
      complete = false;
      return;
    }
    costUsd += count * rate;
  };

  add(
    tokens.input,
    pickRate(pricing.input_cost_per_token, pricing.input_cost_per_token_above_200k_tokens, long)
  );
  add(
    tokens.output,
    pickRate(pricing.output_cost_per_token, pricing.output_cost_per_token_above_200k_tokens, long)
  );
  add(
    tokens.cacheRead,
    pickRate(pricing.cache_read_input_token_cost, pricing.cache_read_input_token_cost_above_200k_tokens, long)
  );
  const write5m = pickRate(
    pricing.cache_creation_input_token_cost,
    pricing.cache_creation_input_token_cost_above_200k_tokens,
    long
  );
  add(tokens.cacheCreation, write5m);
  const write1h = pickRate(
    pricing.cache_creation_input_token_cost_above_1hr,
    pricing.cache_creation_input_token_cost_above_1hr_above_200k_tokens,
    long
  );
  if (tokens.cacheCreation1h && tokens.cacheCreation1h > 0 && write1h == null) {
    // No 1h rate published: floor at the 5m rate, but say the figure is a floor.
    add(tokens.cacheCreation1h, write5m);
    complete = false;
  } else {
    add(tokens.cacheCreation1h, write1h);
  }

  return { costUsd, complete };
}
