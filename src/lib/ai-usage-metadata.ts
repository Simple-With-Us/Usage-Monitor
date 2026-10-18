// Canonical AI usage persistence (UM-1592).
//
// The shared v2 contract carries an optional strict `ai` block (model, seat,
// harness, tokens, timing, billing).  Until a first-class per-request store
// exists (UM-1590), ingest persists it into event metadata under the reserved
// `_ai*` keys below.  Producers that still send the pre-UM-1592 metadata keys
// (promptTokens, completionTokens, cachedTokens, cacheWriteTokens,
// cacheWriteOneHourTokens, inputTokens, outputTokens, cachedInputTokens,
// tokenType slices) are mapped onto the same keys, so every producer
// aggregates and prices the same way.
//
// The keys are reserved (RESERVED_V2_METADATA_KEYS in usage-telemetry.ts):
// producer metadata cannot set them directly; only the validated `ai` block
// or the legacy mapping here can.
//
// Token semantics match the shared contract:
//   input        uncached input only
//   output       all billed output, reasoning included
//   cacheRead    prompt-cache reads
//   cacheWrite5m 5-minute (or TTL-unknown) cache writes
//   cacheWrite1h 1-hour cache writes
//   reasoning    informational subset of output; never priced on its own

import type { AiUsage } from "@jaywedgeworth22/congress-trading-shared";

import type { AiRequestInput } from "@/lib/otlp/ai-request-mapper";
import { canonicalTokenType, isOneHourCacheTtl } from "@/lib/pricing/model-pricing";

type MetadataValue = string | number | boolean | null;
type Metadata = Record<string, MetadataValue>;

export const AI_METADATA_KEYS = {
  modelRequested: "_aiModelRequested",
  modelServed: "_aiModelServed",
  harness: "_aiHarness",
  seat: "_aiSeat",
  tokensInput: "_aiTokensInput",
  tokensOutput: "_aiTokensOutput",
  tokensCacheRead: "_aiTokensCacheRead",
  tokensCacheWrite5m: "_aiTokensCacheWrite5m",
  tokensCacheWrite1h: "_aiTokensCacheWrite1h",
  tokensReasoning: "_aiTokensReasoning",
  durationMs: "_aiDurationMs",
  ttftMs: "_aiTtftMs",
  billingMode: "_aiBillingMode",
  costSource: "_aiCostSource",
  /** "block" when the producer sent the typed `ai` block, "legacy" when mapped from old keys. */
  source: "_aiSource",
} as const;

export const AI_METADATA_KEY_LIST: readonly string[] = Object.values(AI_METADATA_KEYS);

export interface CanonicalAiTokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  reasoning?: number;
}

const TOKEN_KEY_BY_FIELD: Record<keyof CanonicalAiTokens, string> = {
  input: AI_METADATA_KEYS.tokensInput,
  output: AI_METADATA_KEYS.tokensOutput,
  cacheRead: AI_METADATA_KEYS.tokensCacheRead,
  cacheWrite5m: AI_METADATA_KEYS.tokensCacheWrite5m,
  cacheWrite1h: AI_METADATA_KEYS.tokensCacheWrite1h,
  reasoning: AI_METADATA_KEYS.tokensReasoning,
};

/**
 * Collector / OTLP `tokenType` slice name -> canonical token field.  Names
 * resolve through the pricing module's `canonicalTokenType` (UM-1591), so
 * `cacheWrite1h`, `cacheCreation1h` and friends land in the 1-hour bucket and
 * a plain `cacheCreation` is a 5-minute (TTL unknown) write unless metadata
 * `cacheTtl` / `ttl` says 1 hour.
 */
function legacyTokenField(
  tokenType: string,
  metadata: Metadata
): keyof CanonicalAiTokens | null {
  const canonical = canonicalTokenType(tokenType);
  if (canonical === "input" || canonical === "output" || canonical === "cacheRead") return canonical;
  if (canonical === "cacheCreation1h") return "cacheWrite1h";
  if (canonical === "cacheCreation") {
    return isOneHourCacheTtl(metadata.cacheTtl) || isOneHourCacheTtl(metadata.ttl)
      ? "cacheWrite1h"
      : "cacheWrite5m";
  }
  return null;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown, max = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function putTokens(out: Metadata, tokens: CanonicalAiTokens): boolean {
  let any = false;
  for (const field of Object.keys(TOKEN_KEY_BY_FIELD) as Array<keyof CanonicalAiTokens>) {
    const value = tokens[field];
    if (value == null) continue;
    out[TOKEN_KEY_BY_FIELD[field]] = value;
    any = true;
  }
  return any;
}

/** Project a validated shared-contract `ai` block onto the reserved metadata keys. */
export function aiBlockMetadata(ai: AiUsage): Metadata {
  const out: Metadata = {};
  if (ai.model?.requested) out[AI_METADATA_KEYS.modelRequested] = ai.model.requested;
  if (ai.model?.served) out[AI_METADATA_KEYS.modelServed] = ai.model.served;
  if (ai.harness) out[AI_METADATA_KEYS.harness] = ai.harness;
  if (ai.seat) out[AI_METADATA_KEYS.seat] = ai.seat;
  if (ai.tokens) putTokens(out, ai.tokens);
  if (ai.durationMs != null) out[AI_METADATA_KEYS.durationMs] = ai.durationMs;
  if (ai.ttftMs != null) out[AI_METADATA_KEYS.ttftMs] = ai.ttftMs;
  if (ai.billingMode) out[AI_METADATA_KEYS.billingMode] = ai.billingMode;
  if (ai.costSource) out[AI_METADATA_KEYS.costSource] = ai.costSource;
  out[AI_METADATA_KEYS.source] = "block";
  return out;
}

export interface LegacyAiMappingEvent {
  unit?: string;
  quantity?: number;
  /** Collectors and the OTLP mapper label token slices `token:<type>`. */
  label?: string;
  metadata?: Metadata;
}

function legacyTokenType(event: LegacyAiMappingEvent): string | undefined {
  const fromMetadata = event.metadata?.tokenType;
  if (typeof fromMetadata === "string") return fromMetadata;
  if (event.label?.startsWith("token:")) return event.label.slice("token:".length);
  return undefined;
}

/**
 * Map pre-UM-1592 producer metadata onto canonical tokens.  Returns null when
 * the event carries no recognisable AI token data.
 *
 * - A `tokenType` slice (metadata.tokenType or label `token:<type>`; collectors,
 *   OTLP mapper, BotFleet) is ONE token type whose count is the event `quantity`.  BotFleet slices also repeat the
 *   whole turn's inputTokens/outputTokens on every slice, so turn-level keys
 *   are deliberately ignored on a slice; reading them would count the turn
 *   once per slice.
 * - Otherwise turn-level keys apply.  Every producer's prompt figure
 *   (promptTokens, inputTokens) INCLUDES cache reads and writes, so the
 *   cache counts are subtracted to get uncached input.
 */
export function legacyAiTokens(event: LegacyAiMappingEvent): CanonicalAiTokens | null {
  const metadata = event.metadata ?? {};
  const tokenType = legacyTokenType(event);
  if (tokenType !== undefined) {
    const field = legacyTokenField(tokenType, metadata);
    const quantity = nonNegativeNumber(event.quantity);
    if (!field || event.unit !== "token" || quantity == null || quantity <= 0) return null;
    const slice: CanonicalAiTokens = { [field]: quantity };
    // Collectors (DSH) put the reasoning share of output on the output slice.
    const sliceReasoning = nonNegativeNumber(metadata.reasoningTokens);
    if (field === "output" && sliceReasoning != null) slice.reasoning = sliceReasoning;
    return slice;
  }

  const prompt = nonNegativeNumber(metadata.promptTokens) ?? nonNegativeNumber(metadata.inputTokens);
  const completion =
    nonNegativeNumber(metadata.completionTokens) ?? nonNegativeNumber(metadata.outputTokens);
  const cacheRead =
    nonNegativeNumber(metadata.cachedTokens) ?? nonNegativeNumber(metadata.cachedInputTokens);
  const cacheWrite5m = nonNegativeNumber(metadata.cacheWriteTokens);
  const cacheWrite1h = nonNegativeNumber(metadata.cacheWriteOneHourTokens);
  const reasoning = nonNegativeNumber(metadata.reasoningTokens);
  if (
    prompt == null &&
    completion == null &&
    cacheRead == null &&
    cacheWrite5m == null &&
    cacheWrite1h == null
  ) {
    return null;
  }

  const tokens: CanonicalAiTokens = {};
  if (prompt != null) {
    tokens.input = Math.max(0, prompt - (cacheRead ?? 0) - (cacheWrite5m ?? 0) - (cacheWrite1h ?? 0));
  }
  if (completion != null) tokens.output = completion;
  if (cacheRead != null) tokens.cacheRead = cacheRead;
  if (cacheWrite5m != null) tokens.cacheWrite5m = cacheWrite5m;
  if (cacheWrite1h != null) tokens.cacheWrite1h = cacheWrite1h;
  if (reasoning != null) tokens.reasoning = reasoning;
  return tokens;
}

/** Legacy metadata -> reserved canonical keys, or null when there is no AI token data. */
export function legacyAiMetadata(event: LegacyAiMappingEvent): Metadata | null {
  const tokens = legacyAiTokens(event);
  if (!tokens) return null;
  const out: Metadata = {};
  putTokens(out, tokens);
  const metadata = event.metadata ?? {};
  const model = nonEmptyString(metadata.model);
  if (model) out[AI_METADATA_KEYS.modelServed] = model;
  const duration = nonNegativeNumber(metadata.durationMs) ?? nonNegativeNumber(metadata.latencyMs);
  if (duration != null) out[AI_METADATA_KEYS.durationMs] = duration;
  const ttft = nonNegativeNumber(metadata.ttftMs);
  if (ttft != null) out[AI_METADATA_KEYS.ttftMs] = ttft;
  // Collector context keys already spelled the canonical way (DSH, Clutch).
  const harness = nonEmptyString(metadata.harness, 80);
  if (harness) out[AI_METADATA_KEYS.harness] = harness;
  const seat = nonEmptyString(metadata.seat, 80);
  if (seat) out[AI_METADATA_KEYS.seat] = seat;
  const billingMode = metadata.billingMode;
  if (billingMode === "subscription" || billingMode === "payg" || billingMode === "free") {
    out[AI_METADATA_KEYS.billingMode] = billingMode;
  }
  out[AI_METADATA_KEYS.source] = "legacy";
  return out;
}

/**
 * The canonical AI metadata for one ingested event: the typed `ai` block when
 * present (it wins outright), else the legacy mapping, else nothing.
 * `metadata` must already be the cleaned producer metadata.
 */
export function canonicalAiMetadata(event: LegacyAiMappingEvent & { ai?: AiUsage }): Metadata | null {
  if (event.ai) return aiBlockMetadata(event.ai);
  return legacyAiMetadata(event);
}

/** Read canonical tokens back out of persisted metadata, or null when none are present. */
export function readCanonicalAiTokens(
  metadata: Metadata | undefined | null
): CanonicalAiTokens | null {
  if (!metadata) return null;
  const tokens: CanonicalAiTokens = {};
  let any = false;
  for (const field of Object.keys(TOKEN_KEY_BY_FIELD) as Array<keyof CanonicalAiTokens>) {
    const value = nonNegativeNumber(metadata[TOKEN_KEY_BY_FIELD[field]]);
    if (value == null) continue;
    tokens[field] = value;
    any = true;
  }
  return any ? tokens : null;
}

/** The model to price a canonical AI event by: served, then requested. */
export function readCanonicalAiModel(metadata: Metadata | undefined | null): string | undefined {
  if (!metadata) return undefined;
  return (
    nonEmptyString(metadata[AI_METADATA_KEYS.modelServed]) ??
    nonEmptyString(metadata[AI_METADATA_KEYS.modelRequested])
  );
}

/** True when metadata already carries the canonical projection (any `_ai*` source stamp). */
export function hasCanonicalAiMetadata(metadata: unknown): boolean {
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    AI_METADATA_KEYS.source in (metadata as Record<string, unknown>)
  );
}

/** Metadata without the canonical `_ai*` projection (null when nothing else remains). */
export function withoutCanonicalAiMetadata(metadata: unknown): unknown {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return metadata;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (!AI_METADATA_KEY_LIST.includes(key)) rest[key] = value;
  }
  return Object.keys(rest).length > 0 ? rest : null;
}

/** Every model to try pricing a canonical AI event by, in order: served, then requested. */
export function readCanonicalAiModelCandidates(metadata: Metadata | undefined | null): string[] {
  if (!metadata) return [];
  const out: string[] = [];
  for (const key of [AI_METADATA_KEYS.modelServed, AI_METADATA_KEYS.modelRequested]) {
    const model = nonEmptyString(metadata[key]);
    if (model && !out.includes(model)) out.push(model);
  }
  return out;
}

const INT_MAX = 2_147_483_647;

function intColumn(value: unknown): number | undefined {
  const n = nonNegativeNumber(value);
  return n == null ? undefined : Math.min(Math.round(n), INT_MAX);
}

export interface AiRequestSourceEvent {
  idempotencyKey: string;
  sourceApp: string;
  project?: string;
  costUsd?: number;
  occurredAt: Date;
  metadata?: Metadata;
}

/**
 * The per-request AiRequest row (UM-1590 store) for one ingested usage event
 * that carried the typed `ai` block.  Legacy-mapped rows are not per-request
 * (collectors post token slices and window totals), so they get none.  The
 * dedupe key is the event's own idempotency key, so a replay is a duplicate.
 */
export function aiRequestFromUsageEvent(event: AiRequestSourceEvent): AiRequestInput | null {
  const metadata = event.metadata;
  if (!metadata || metadata[AI_METADATA_KEYS.source] !== "block") return null;
  const str = (key: string) => nonEmptyString(metadata[key], 200);
  const cacheWrite5m = intColumn(metadata[AI_METADATA_KEYS.tokensCacheWrite5m]);
  const cacheWrite1h = intColumn(metadata[AI_METADATA_KEYS.tokensCacheWrite1h]);
  const cacheWrite =
    cacheWrite5m == null && cacheWrite1h == null
      ? undefined
      : Math.min((cacheWrite5m ?? 0) + (cacheWrite1h ?? 0), INT_MAX);
  return {
    dedupeKey: `ingest:${event.idempotencyKey}`,
    kind: "complete",
    source: "ingest",
    harness: str(AI_METADATA_KEYS.harness) ?? event.sourceApp,
    seat: str(AI_METADATA_KEYS.seat),
    project: event.project,
    billingMode: str(AI_METADATA_KEYS.billingMode),
    requestedModel: str(AI_METADATA_KEYS.modelRequested),
    servedModel: str(AI_METADATA_KEYS.modelServed),
    durationMs: intColumn(metadata[AI_METADATA_KEYS.durationMs]),
    ttftMs: intColumn(metadata[AI_METADATA_KEYS.ttftMs]),
    inputTokens: intColumn(metadata[AI_METADATA_KEYS.tokensInput]),
    outputTokens: intColumn(metadata[AI_METADATA_KEYS.tokensOutput]),
    cacheReadTokens: intColumn(metadata[AI_METADATA_KEYS.tokensCacheRead]),
    cacheWriteTokens: cacheWrite,
    cacheWrite5mTokens: cacheWrite5m,
    cacheWrite1hTokens: cacheWrite1h,
    reasoningTokens: intColumn(metadata[AI_METADATA_KEYS.tokensReasoning]),
    costUsd: event.costUsd != null && Number.isFinite(event.costUsd) ? event.costUsd : undefined,
    costSource: str(AI_METADATA_KEYS.costSource),
    occurredAt: event.occurredAt,
  };
}
