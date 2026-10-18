import {
  deriveTokenCostUsd,
  getModelPricing,
  hasLongContextTier,
  longContextThresholdTokens,
  type TokenBreakdown,
} from "@/lib/pricing/model-pricing";

// ---------------------------------------------------------------------------
// PAYG-equivalent cost estimate for one AiRequest row (UM-1610)
// ---------------------------------------------------------------------------
// AiRequest.costUsd is only what the harness reported (Claude Code's
// `cost_usd` on api_request logs).  Rows that carry tokens but no reported
// cost (Codex, and Claude Code rows that came from a trace span alone) are
// priced here from the bundled LiteLLM catalog instead.
//
// Contract:
//   - Computed at READ time, never stored.  The reported column is therefore
//     never overwritten or conflated, a reported cost that arrives later (the
//     logs row merging into a trace-only row) wins automatically, and a pricing
//     snapshot refresh reprices history.
//   - Reported always wins: a row with `costUsd != null` is never estimated.
//   - Diagnostic only.  AiRequest never feeds cash, budgets or alerts.
//
// Token semantics (set by the mappers, see ai-request-mapper.ts):
//   - inputTokens is UNCACHED input for both harnesses (Codex's mapper has
//     already subtracted cached and cache-write tokens).
//   - outputTokens already includes reasoning tokens (Claude thinking, Codex
//     reasoning), so reasoningTokens is never priced a second time.
//   - cacheWriteTokens is the 5m + 1h total.  When the split columns exist they
//     price at their own rates;  an unsplit total prices at the 5m rate, which is
//     a lower bound when 1h entries were written.
//
// Unlike generic ingest (derive-ingest-cost.ts) a request knows its exact
// prompt size, so the long-context tier is applied when the catalog entry has
// one and the prompt (input + cache read + cache write) exceeds its threshold.
// ---------------------------------------------------------------------------

export interface AiRequestCostInput {
  servedModel: string | null;
  requestedModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite5mTokens?: number | null;
  cacheWrite1hTokens?: number | null;
  costUsd: number | null;
}

export type AiRequestCostSource = "reported" | "derived" | "unpriced" | "none";

export interface AiRequestCostResult {
  /**
   * reported: the harness gave a cost.  derived: estimated here from tokens.
   * unpriced: tokens but the model is not in the catalog.  none: no tokens.
   */
  source: AiRequestCostSource;
  /** The reported figure or the estimate;  null for unpriced and none. */
  costUsd: number | null;
  /** Catalog key used for a derived estimate. */
  pricingKey?: string;
  /** Derived only: the catalog lacks a rate for a token type that was used. */
  incomplete?: boolean;
}

function positive(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function tokenBreakdown(row: AiRequestCostInput): TokenBreakdown {
  const write5m = positive(row.cacheWrite5mTokens);
  const write1h = positive(row.cacheWrite1hTokens);
  const writeTotal = positive(row.cacheWriteTokens);
  // Any part of the total the split does not account for prices at the 5m rate.
  const unsplit = Math.max(0, writeTotal - write5m - write1h);
  return {
    input: positive(row.inputTokens),
    output: positive(row.outputTokens),
    cacheRead: positive(row.cacheReadTokens),
    cacheCreation: write5m + unsplit,
    cacheCreation1h: write1h,
  };
}

export function classifyAiRequestCost(row: AiRequestCostInput): AiRequestCostResult {
  if (row.costUsd != null) return { source: "reported", costUsd: row.costUsd };

  const tokens = tokenBreakdown(row);
  const billed =
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.cacheRead ?? 0) +
    (tokens.cacheCreation ?? 0) +
    (tokens.cacheCreation1h ?? 0);
  if (billed <= 0) return { source: "none", costUsd: null };

  // Served model first: a served id the catalog does not know must not hide a
  // priceable requested model.
  let resolved: ReturnType<typeof getModelPricing> = null;
  for (const candidate of [row.servedModel, row.requestedModel]) {
    if (!candidate) continue;
    resolved = getModelPricing(candidate);
    if (resolved) break;
  }
  if (!resolved) return { source: "unpriced", costUsd: null };

  const prompt =
    (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheCreation ?? 0) + (tokens.cacheCreation1h ?? 0);
  const longContext =
    hasLongContextTier(resolved.pricing) && prompt > longContextThresholdTokens(resolved.pricing);
  const derived = deriveTokenCostUsd(resolved.pricing, tokens, { longContext });
  return {
    source: "derived",
    costUsd: derived.costUsd,
    pricingKey: resolved.key,
    incomplete: !derived.complete,
  };
}
