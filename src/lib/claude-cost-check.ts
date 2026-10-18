// Claude Code cost cross-check: independently re-derives API-equivalent cost
// from ingested token.usage rows (model x token-type x LiteLLM catalog price)
// and compares it against Claude Code's own claude_code.cost.usage estimate.
//
// Why (ccusage lesson, github.com/ccusage/ccusage): never trust a single cost
// signal. ccusage prefers recorded cost but derives token-priced cost as a
// fallback; we go one step further and treat the derived figure purely as a
// drift detector for the recorded one. Both figures are analytics-only
// API-equivalent estimates — cash spend still comes from receipts/subscriptions
// (see budget-status.ts) and this module never feeds budget math.

import {
  canonicalTokenType,
  deriveTokenCostUsd,
  getModelPricing,
  hasLongContextTier,
  longContextThresholdTokens,
  PRICING_SNAPSHOT_META,
} from "@/lib/pricing/model-pricing";

export interface ClaudeTokenEventRow {
  /** Model name (keyRef), may be null. */
  model: string | null;
  /** claude-code token type: input | output | cacheRead | cacheCreation |
   * cacheCreation1h (also the cacheWrite* aliases) | unknown */
  tokenType: string;
  quantity: number;
  /** Number of ingested rows behind `quantity` (each row is one exporter
   * flush covering one or more requests).  Only used to choose the
   * long-prompt tier for models that have one (Claude Haiku 5.5). */
  rows?: number;
  provider?: string;
  sourceApp?: string;
}

export interface ClaudeCostEventRow {
  model: string | null;
  costUsd: number;
  provider?: string;
  sourceApp?: string;
}

export interface ModelCostCheck {
  model: string;
  pricingKey: string | null;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    /** Cache writes at the 5m rate (also rows with no TTL split). */
    cacheCreation: number;
    /** Cache writes known to be 1h TTL. */
    cacheCreation1h: number;
    unknown: number;
  };
  /** "unpriced" when the model resolves to no catalog row: derivedCostUsd is
   * then 0 and must not be read as a real estimate. */
  pricingStatus: "priced" | "unpriced" | "no-tokens";
  /** Token x catalog price, API-equivalent USD.  Cache writes without a TTL
   * split are priced at the 5m rate, so this is a LOWER BOUND when the
   * producer wrote 1h entries (Claude Code does for some sessions). */
  derivedCostUsd: number;
  /** Same derivation with every untyped cache write priced at the 1h rate:
   * the upper end of the band `reportedCostUsd` should fall in. */
  derivedCostUpperBoundUsd: number;
  /** True when the long-prompt tier was applied (average prompt per ingested
   * row over the model's threshold). */
  longPromptTier: boolean;
  /** False when some tokens could not be priced (unknown model or missing
   * rate) — derivedCostUsd then under-counts. */
  derivationComplete: boolean;
  /** Claude Code's own claude_code.cost.usage estimate, summed. */
  reportedCostUsd: number;
  /** derived - reported (positive = our derivation is higher). */
  deltaUsd: number;
  /** delta / max(reported, epsilon), null when both are ~0. */
  deltaPct: number | null;
}

export interface ClaudeCostCheckReport {
  pricing: {
    source: string;
    fetchedAt: string;
    upstreamSha256: string;
  };
  models: ModelCostCheck[];
  totals: {
    derivedCostUsd: number;
    reportedCostUsd: number;
    deltaUsd: number;
    deltaPct: number | null;
    unpricedModelCount: number;
  };
}


/** Pure aggregation — rows in, report out. No I/O, fully unit-testable. */
export function buildClaudeCostCheck(
  tokenEvents: ClaudeTokenEventRow[],
  costEvents: ClaudeCostEventRow[]
): ClaudeCostCheckReport {
  const byModel = new Map<string, ModelCostCheck>();
  const rowCounts = new Map<string, number>();

  const ensure = (model: string | null): ModelCostCheck => {
    const key = model?.trim() || "(no model)";
    let entry = byModel.get(key);
    if (!entry) {
      entry = {
        model: key,
        pricingKey: null,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, unknown: 0 },
        pricingStatus: "no-tokens",
        derivedCostUsd: 0,
        derivedCostUpperBoundUsd: 0,
        longPromptTier: false,
        derivationComplete: true,
        reportedCostUsd: 0,
        deltaUsd: 0,
        deltaPct: null,
      };
      byModel.set(key, entry);
    }
    return entry;
  };

  for (const event of tokenEvents) {
    if (!Number.isFinite(event.quantity) || event.quantity <= 0) continue;
    const entry = ensure(event.model);
    const tokenType = canonicalTokenType(event.tokenType);
    if (tokenType) {
      entry.tokens[tokenType] += event.quantity;
      if (event.rows && event.rows > 0) rowCounts.set(entry.model, Math.max(rowCounts.get(entry.model) ?? 0, event.rows));
    } else {
      entry.tokens.unknown += event.quantity;
      entry.derivationComplete = false;
    }
  }

  for (const event of costEvents) {
    if (!Number.isFinite(event.costUsd) || event.costUsd <= 0) continue;
    ensure(event.model).reportedCostUsd += event.costUsd;
  }

  for (const entry of byModel.values()) {
    if (entry.model !== "(no model)") {
      const resolved = getModelPricing(entry.model);
      const tokenTotal =
        entry.tokens.input + entry.tokens.output + entry.tokens.cacheRead +
        entry.tokens.cacheCreation + entry.tokens.cacheCreation1h;
      if (resolved) {
        entry.pricingKey = resolved.key;
        entry.pricingStatus = "priced";
        // Long-prompt tier (Haiku 5.5: prompts over 100k pay 5x).  Per-request
        // size is not recorded; an exporter flush covers >= 1 request, so the
        // per-row average is an upper bound on the per-request prompt.  Use
        // the tier only when that average clears the threshold.
        const rows = rowCounts.get(entry.model) ?? 0;
        const promptTokens = entry.tokens.input + entry.tokens.cacheRead +
          entry.tokens.cacheCreation + entry.tokens.cacheCreation1h;
        const longPrompt =
          hasLongContextTier(resolved.pricing) &&
          rows > 0 &&
          promptTokens / rows > longContextThresholdTokens(resolved.pricing);
        entry.longPromptTier = longPrompt;
        const breakdown = {
          input: entry.tokens.input,
          output: entry.tokens.output,
          cacheRead: entry.tokens.cacheRead,
          cacheCreation: entry.tokens.cacheCreation,
          cacheCreation1h: entry.tokens.cacheCreation1h,
        };
        const derived = deriveTokenCostUsd(resolved.pricing, breakdown, { longContext: longPrompt });
        entry.derivedCostUsd = derived.costUsd;
        entry.derivedCostUpperBoundUsd = deriveTokenCostUsd(
          resolved.pricing,
          {
            ...breakdown,
            cacheCreation: 0,
            cacheCreation1h: entry.tokens.cacheCreation + entry.tokens.cacheCreation1h,
          },
          { longContext: longPrompt }
        ).costUsd;
        if (!derived.complete) entry.derivationComplete = false;
      } else if (tokenTotal > 0) {
        entry.pricingStatus = "unpriced";
        entry.derivationComplete = false;
      }
    }
    if (entry.derivedCostUpperBoundUsd < entry.derivedCostUsd) {
      entry.derivedCostUpperBoundUsd = entry.derivedCostUsd;
    }
    entry.deltaUsd = entry.derivedCostUsd - entry.reportedCostUsd;
    const basis = Math.max(entry.reportedCostUsd, entry.derivedCostUsd);
    entry.deltaPct = basis > 1e-9 ? entry.deltaUsd / basis : null;
  }

  const models = [...byModel.values()].sort(
    (a, b) =>
      Math.max(b.derivedCostUsd, b.reportedCostUsd) - Math.max(a.derivedCostUsd, a.reportedCostUsd)
  );

  return finishClaudeCostCheck(models);
}

function finishClaudeCostCheck(models: ModelCostCheck[]): ClaudeCostCheckReport {

  const derivedCostUsd = models.reduce((sum, m) => sum + m.derivedCostUsd, 0);
  const reportedCostUsd = models.reduce((sum, m) => sum + m.reportedCostUsd, 0);
  const deltaUsd = derivedCostUsd - reportedCostUsd;
  const basis = Math.max(reportedCostUsd, derivedCostUsd);

  return {
    pricing: {
      source: PRICING_SNAPSHOT_META.source,
      fetchedAt: PRICING_SNAPSHOT_META.fetchedAt,
      upstreamSha256: PRICING_SNAPSHOT_META.upstreamSha256,
    },
    models,
    totals: {
      derivedCostUsd,
      reportedCostUsd,
      deltaUsd,
      deltaPct: basis > 1e-9 ? deltaUsd / basis : null,
      unpricedModelCount: models.filter(
        (m) =>
          !m.derivationComplete &&
          m.tokens.input + m.tokens.output + m.tokens.cacheRead +
            m.tokens.cacheCreation + m.tokens.cacheCreation1h + m.tokens.unknown > 0
      ).length,
    },
  };
}

export interface ApiEquivalentProviderReport extends ClaudeCostCheckReport {
  provider: string;
  sourceApp: string;
  estimateUsd: number;
}

export interface ApiEquivalentCostReport {
  pricing: ClaudeCostCheckReport["pricing"];
  providers: ApiEquivalentProviderReport[];
  totals: ClaudeCostCheckReport["totals"] & { estimateUsd: number };
}

function providerBucketKey(provider: string, sourceApp: string): string {
  return `${provider.trim().toLowerCase() || "(unknown)"}|${sourceApp.trim().toLowerCase() || "(unknown)"}`;
}

/** Per-provider token x catalog vs reported estimate. Same money-safety as
 * buildClaudeCostCheck: analytics only, never cash. */
export function buildApiEquivalentCost(
  tokenEvents: ClaudeTokenEventRow[],
  costEvents: ClaudeCostEventRow[]
): ApiEquivalentCostReport {
  const tokenBuckets = new Map<string, ClaudeTokenEventRow[]>();
  const costBuckets = new Map<string, ClaudeCostEventRow[]>();
  const labels = new Map<string, { provider: string; sourceApp: string }>();

  const remember = (provider: string | undefined, sourceApp: string | undefined) => {
    const p = provider?.trim() || "(unknown)";
    const s = sourceApp?.trim() || "(unknown)";
    const key = providerBucketKey(p, s);
    labels.set(key, { provider: p, sourceApp: s });
    return key;
  };

  for (const event of tokenEvents) {
    const key = remember(event.provider, event.sourceApp);
    const list = tokenBuckets.get(key) ?? [];
    list.push(event);
    tokenBuckets.set(key, list);
  }
  for (const event of costEvents) {
    const key = remember(event.provider, event.sourceApp);
    const list = costBuckets.get(key) ?? [];
    list.push(event);
    costBuckets.set(key, list);
  }

  const providers: ApiEquivalentProviderReport[] = [];
  for (const [key, identity] of labels) {
    const report = buildClaudeCostCheck(
      tokenBuckets.get(key) ?? [],
      costBuckets.get(key) ?? []
    );
    const estimateUsd = Math.max(report.totals.derivedCostUsd, report.totals.reportedCostUsd);
    providers.push({
      provider: identity.provider,
      sourceApp: identity.sourceApp,
      ...report,
      estimateUsd,
    });
  }

  providers.sort((a, b) => b.estimateUsd - a.estimateUsd);

  const derivedCostUsd = providers.reduce((sum, p) => sum + p.totals.derivedCostUsd, 0);
  const reportedCostUsd = providers.reduce((sum, p) => sum + p.totals.reportedCostUsd, 0);
  const estimateUsd = providers.reduce((sum, p) => sum + p.estimateUsd, 0);
  const deltaUsd = derivedCostUsd - reportedCostUsd;
  const basis = Math.max(reportedCostUsd, derivedCostUsd);

  return {
    pricing:
      providers[0]?.pricing ??
      finishClaudeCostCheck([]).pricing,
    providers,
    totals: {
      derivedCostUsd,
      reportedCostUsd,
      estimateUsd,
      deltaUsd,
      deltaPct: basis > 1e-9 ? deltaUsd / basis : null,
      unpricedModelCount: providers.reduce((sum, p) => sum + p.totals.unpricedModelCount, 0),
    },
  };
}
