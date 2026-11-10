// DeepSeek PAYG for deepseek-flash, deepseek-v4-flash, and deepseek-v4-pro.
// Official table: https://api-docs.deepseek.com/quick_start/pricing
// (checked 2026-09-24).  Rates are USD per 1M tokens.  Off-peak is half of peak.
//
// Peak windows are half-open [01:00, 04:00) and [06:00, 10:00) UTC, Monday
// through Friday.  The published wording is "01:00 - 04:00 and 06:00 - 10:00".
// That is a 3-hour block plus a 4-hour block (7 peak hours per weekday, 35 per
// week): hour-of-day 1, 2, 3 and 6, 7, 8, 9.  04:00:00 and 10:00:00 UTC are
// off-peak, as is the 04:00–06:00 gap.  Saturday and Sunday are off-peak for
// every hour.
//
// The same page also treats Chinese public holidays as off-peak for the whole
// day.  This module does not ship a holiday calendar, so a weekday peak-window
// hour that falls on a Chinese public holiday is priced as peak.
//
// Flat LiteLLM snapshot rows for these models are stale single rates.  Callers
// without an event timestamp must not use them.  getModelPricing stays null.

export type DeepSeekPaygFamily = "flash" | "pro";

type TokenRates = { hit: number; miss: number; output: number };

/** Published USD per 1M tokens.  Off-peak is exactly half of peak. */
const USD_PER_MILLION: Record<DeepSeekPaygFamily, { off: TokenRates; peak: TokenRates }> = {
  flash: {
    off: { hit: 0.003, miss: 0.15, output: 0.6 },
    peak: { hit: 0.006, miss: 0.3, output: 1.2 },
  },
  pro: {
    off: { hit: 0.022, miss: 0.66, output: 1.98 },
    peak: { hit: 0.044, miss: 1.32, output: 3.96 },
  },
};

export interface DeepSeekPaygEvent {
  model: string;
  occurredAt: Date;
  label?: string | null;
  quantity?: number | null;
}

export interface DeepSeekPaygSum {
  costUsd: number;
  /** False when a token could not be priced from a published rate, or when
   * cache-write / unsplit input used the conservative cache-miss fallback. */
  complete: boolean;
  seenQuantity: number;
}

export function deepSeekPaygFamily(model: string): DeepSeekPaygFamily | null {
  const basename = model.trim().toLowerCase().split("/").pop() || "";
  if (!basename) return null;
  // Legacy ids deepseek-v4-flash and deepseek-v4-flash-vision-exp are served
  // and billed as Flash.  deepseek-flash is the current Flash model name.
  if (
    basename === "deepseek-flash" ||
    basename.startsWith("deepseek-flash-") ||
    basename === "deepseek-v4-flash" ||
    basename.startsWith("deepseek-v4-flash-")
  ) {
    return "flash";
  }
  if (basename === "deepseek-v4-pro" || basename.startsWith("deepseek-v4-pro-")) {
    return "pro";
  }
  return null;
}

export function isDeepSeekPaygModel(model: string): boolean {
  return deepSeekPaygFamily(model) != null;
}

export function isDeepSeekPeakUtc(occurredAt: Date): boolean {
  if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) return false;
  const day = occurredAt.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = occurredAt.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
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
 * Price one usage row.
 *
 * Cache hit vs miss is taken from the event label when the collector split
 * them: `token:cacheRead` is the published cache-hit rate, and `token:input`
 * is the published cache-miss rate.  DSH `inputTokens` is already the uncached
 * input count, so that label is a miss rather than a blended input.
 *
 * DeepSeek publishes no cache-write rate.  `token:cacheCreation` (and
 * `token:inputUnsplit`, which does not say how many tokens were cache hits)
 * is priced at the cache-miss rate and marked incomplete.  Miss is the higher
 * uncached-input rate, so the dollar figure does not pretend those tokens
 * were cache hits.  Any other label is left out of the sum and marked
 * incomplete.
 */
export function priceDeepSeekUsageEvent(event: DeepSeekPaygEvent): DeepSeekPaygSum | null {
  const family = deepSeekPaygFamily(event.model);
  if (!family) return null;
  const quantity = Number(event.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { costUsd: 0, complete: true, seenQuantity: 0 };
  }
  if (!(event.occurredAt instanceof Date) || Number.isNaN(event.occurredAt.getTime())) {
    return { costUsd: 0, complete: false, seenQuantity: quantity };
  }

  const rates = USD_PER_MILLION[family][isDeepSeekPeakUtc(event.occurredAt) ? "peak" : "off"];
  const kind = classifyTokenLabel(event.label || "");
  const missCost = (quantity * rates.miss) / 1_000_000;
  if (kind === "cacheRead") {
    return { costUsd: (quantity * rates.hit) / 1_000_000, complete: true, seenQuantity: quantity };
  }
  if (kind === "output") {
    return {
      costUsd: (quantity * rates.output) / 1_000_000,
      complete: true,
      seenQuantity: quantity,
    };
  }
  if (kind === "input") {
    return { costUsd: missCost, complete: true, seenQuantity: quantity };
  }
  if (kind === "cacheCreation" || kind === "inputUnsplit") {
    return { costUsd: missCost, complete: false, seenQuantity: quantity };
  }
  return { costUsd: 0, complete: false, seenQuantity: quantity };
}

export function sumDeepSeekPaygEvents(events: readonly DeepSeekPaygEvent[]): DeepSeekPaygSum {
  let costUsd = 0;
  let complete = true;
  let seenQuantity = 0;
  for (const event of events) {
    const priced = priceDeepSeekUsageEvent(event);
    if (!priced) continue;
    costUsd += priced.costUsd;
    seenQuantity += priced.seenQuantity;
    if (!priced.complete) complete = false;
  }
  return { costUsd, complete, seenQuantity };
}
