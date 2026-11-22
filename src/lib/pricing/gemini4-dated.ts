// Gemini 4 Argon / Carbon effective-dated pricing.
//
// Google's introductory rates for gemini-4-argon and gemini-4-carbon run
// through Nov 30, 2026; from Dec 1, 2026 the list rates double:
//   introductory (through 2026-11-30): input $2.00, output $10.00,
//     cached input $0.10 per 1M tokens
//   from 2026-12-01: input $4.00, output $20.00, cached input $0.20 per 1M
//
// The bundled LiteLLM snapshot carries the Argon rows at the introductory
// rates only and has no Carbon rows at all, so a flat lookup would keep
// pricing December events at November rates.  Like DeepSeek PAYG
// (deepseek-payg.ts), these models are therefore priced per event from
// occurredAt here, and getModelPricing returns null for them so a date-less
// caller never applies one period's rates to the other period.
//
// The boundary is the UTC instant 2026-12-01T00:00:00Z: an event at or after
// it pays the doubled rates, an event before it pays the introductory rates.
//
// The vertex_ai/gemini-4-argon-cyber-permissive variant is a distinct model
// id with its own snapshot row (already at the doubled rates); it is NOT
// part of this schedule and keeps resolving through the catalog.
//
// No cache-write rate is published in this schedule.  Cache-creation tokens
// are priced at the cached-input rate and the result is marked incomplete,
// mirroring deepseek-payg.ts's treatment of its unpublished cache-write
// rate: the dollar figure never pretends those tokens were ordinary input.

import type { ModelPricingEntry } from "./model-pricing";

/** UTC instant the doubled rates take effect: 2026-12-01T00:00:00Z. */
export const GEMINI_4_DOUBLED_FROM_MS = Date.UTC(2026, 11, 1);

const DATED_MODEL_IDS = new Set(["gemini-4-argon", "gemini-4-carbon"]);

/** Published USD per 1M tokens for both periods of the schedule. */
const USD_PER_MILLION = {
  introductory: { input: 2, output: 10, cacheRead: 0.1 },
  doubled: { input: 4, output: 20, cacheRead: 0.2 },
} as const;

export type Gemini4RatePeriod = keyof typeof USD_PER_MILLION;

/** The dated model id for a producer-reported name, or null when the name
 * is not one of the two effective-dated Gemini 4 models.  Matching is on the
 * basename so provider-prefixed ids (`gemini/gemini-4-argon`,
 * `vertex_ai/gemini-4-argon`, `google/gemini-4-carbon`) all resolve, while
 * distinct variants such as `gemini-4-argon-cyber-permissive` do not. */
export function gemini4DatedModelId(model: string): string | null {
  const basename = model.trim().toLowerCase().split("/").pop() || "";
  return DATED_MODEL_IDS.has(basename) ? basename : null;
}

export function isGemini4DatedModel(model: string): boolean {
  return gemini4DatedModelId(model) != null;
}

/** Which period of the schedule a timestamp falls in.  An invalid date is
 * reported as introductory by this helper, but the pricing entry point
 * below refuses to price an invalid date at all. */
export function gemini4RatePeriod(occurredAt: Date): Gemini4RatePeriod {
  return occurredAt.getTime() >= GEMINI_4_DOUBLED_FROM_MS ? "doubled" : "introductory";
}

/** Catalog-shaped pricing entry for a dated Gemini 4 model on a given date,
 * or null when the model is not on this schedule or the date is invalid. */
export function gemini4PricingForDate(
  model: string,
  occurredAt: Date,
): ModelPricingEntry | null {
  if (!isGemini4DatedModel(model)) return null;
  if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) return null;
  const rates = USD_PER_MILLION[gemini4RatePeriod(occurredAt)];
  return {
    input_cost_per_token: rates.input / 1_000_000,
    output_cost_per_token: rates.output / 1_000_000,
    cache_read_input_token_cost: rates.cacheRead / 1_000_000,
    litellm_provider: "gemini",
    mode: "chat",
  };
}

export interface Gemini4DatedEvent {
  model: string;
  occurredAt: Date;
  label?: string | null;
  quantity?: number | null;
}

export interface Gemini4DatedSum {
  costUsd: number;
  /** False when a token could not be priced from a published rate: an
   * unknown label, an invalid event date, or cache-creation tokens (priced
   * at the cached-input rate because the schedule publishes no cache-write
   * rate). */
  complete: boolean;
  seenQuantity: number;
}

type PricedLabel = "input" | "output" | "cacheRead" | "cacheCreation" | "inputUnsplit" | "other";

function classifyTokenLabel(label: string): PricedLabel {
  const lower = label.toLowerCase();
  if (lower.includes("inputunsplit")) return "inputUnsplit";
  if (
    lower.includes("cacheread") ||
    lower.includes("cache_read") ||
    lower.includes("cache_hit")
  ) {
    return "cacheRead";
  }
  if (
    lower.includes("cachecreation") ||
    lower.includes("cache_creation") ||
    lower.includes("cache_write")
  ) {
    return "cacheCreation";
  }
  if (lower.includes("output")) return "output";
  if (lower.includes("input")) return "input";
  return "other";
}

/**
 * Price one usage row at the rates in effect on the event's date.
 *
 * Cache hit vs miss is taken from the event label: `token:cacheRead` is the
 * published cached-input rate and `token:input` is the full input rate.
 * `token:cacheCreation` has no published rate in this schedule, so it is
 * priced at the cached-input rate and marked incomplete.  `token:inputUnsplit`
 * does not say how many tokens were cache hits, so it is priced as input and
 * marked incomplete.  Any other label is left out of the sum and marked
 * incomplete.
 */
export function priceGemini4UsageEvent(event: Gemini4DatedEvent): Gemini4DatedSum | null {
  if (!isGemini4DatedModel(event.model)) return null;
  const quantity = Number(event.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { costUsd: 0, complete: true, seenQuantity: 0 };
  }
  const entry = gemini4PricingForDate(event.model, event.occurredAt);
  if (!entry) return { costUsd: 0, complete: false, seenQuantity: quantity };

  const kind = classifyTokenLabel(event.label || "");
  if (kind === "cacheRead") {
    return {
      costUsd: quantity * (entry.cache_read_input_token_cost ?? 0),
      complete: true,
      seenQuantity: quantity,
    };
  }
  if (kind === "output") {
    return {
      costUsd: quantity * (entry.output_cost_per_token ?? 0),
      complete: true,
      seenQuantity: quantity,
    };
  }
  if (kind === "input") {
    return {
      costUsd: quantity * (entry.input_cost_per_token ?? 0),
      complete: true,
      seenQuantity: quantity,
    };
  }
  if (kind === "cacheCreation") {
    return {
      costUsd: quantity * (entry.cache_read_input_token_cost ?? 0),
      complete: false,
      seenQuantity: quantity,
    };
  }
  if (kind === "inputUnsplit") {
    return {
      costUsd: quantity * (entry.input_cost_per_token ?? 0),
      complete: false,
      seenQuantity: quantity,
    };
  }
  return { costUsd: 0, complete: false, seenQuantity: quantity };
}

export function sumGemini4DatedEvents(
  events: readonly Gemini4DatedEvent[],
): Gemini4DatedSum {
  let costUsd = 0;
  let complete = true;
  let seenQuantity = 0;
  for (const event of events) {
    const priced = priceGemini4UsageEvent(event);
    if (!priced) continue;
    costUsd += priced.costUsd;
    seenQuantity += priced.seenQuantity;
    if (!priced.complete) complete = false;
  }
  return { costUsd, complete, seenQuantity };
}
