// LLM burn windows: ccusage's headline feature (5-hour billing-block burn +
// projection), generalized to EVERY LLM platform that lands in
// ExternalUsageEvent — not just Claude.
//
// Generalization notes (owner directive 2026-07-30: "do so for all llm
// platforms and not just claude"):
//   - Claude's 5-hour subscription block is one instance of the universal
//     question "how fast am I burning right now, and what does that pace
//     imply?" A TRAILING window (default 5h, ccusage's block length) answers
//     it for any provider without needing per-plan window-limit config, which
//     we do not have for non-Claude platforms.
//   - Any provider with token-unit usage events or cost events participates,
//     data-driven — claude-code OTLP (anthropic), generic pushed telemetry
//     (openai, xai, deepseek, gemini, …), and anything future producers add.
//   - Cost basis follows ccusage's recorded-wins ordering: estimateUsd =
//     max(reportedCostUsd, derivedCostUsd) so the two signals never double
//     count. derivedCostUsd = tokens x the bundled LiteLLM catalog (works for
//     every priced platform, not just Anthropic). Both figures are
//     analytics-only API-equivalent estimates — cash spend still comes from
//     receipts/subscriptions/poll snapshots (budget-status.ts) and this
//     module never feeds budget math.
//   - Token events without a token:<type> label are priced at the model's
//     INPUT rate as a floor and flagged derivation-incomplete, the same
//     contract as pricing/derive-ingest-cost.ts (never over-estimate).
//
// Pace math: month boundaries are UTC (budget-status.ts's monthStartUtc
// convention). paceRatio compares MTD estimate against the budget prorated
// to the elapsed fraction of the month; projectedMonthEndUsd is a plain
// linear extrapolation and is withheld in the first ~2% of a month, where
// the tiny denominator makes it noise.

import {
  canonicalTokenType,
  type CanonicalTokenType,
  deriveTokenCostUsd,
  getModelPricing,
  PRICING_SNAPSHOT_META,
} from "@/lib/pricing/model-pricing";

export const DEFAULT_WINDOW_HOURS = 5;
export const MAX_WINDOW_HOURS = 24;
/** Burn rates divide by elapsed activity, clamped to at least this many
 * minutes so a single fresh event doesn't read as an absurd hourly rate. */
export const MIN_ACTIVE_MINUTES = 15;
/** Linear month-end projection needs a meaningful elapsed base. */
const MIN_MONTH_FRACTION_FOR_PROJECTION = 0.02;
/** paceRatio bands: <1.0 on pace, <WATCH over-budget drift, >= WATCH over. */
export const PACE_WATCH_RATIO = 1.1;


export interface LlmBurnTokenGroup {
  provider: string;
  /** Model name (keyRef); null when the producer didn't report one. */
  model: string | null;
  /** claude-code style token type (input/output/cacheRead/cacheCreation);
   * anything else must be passed as "unknown". */
  tokenType: string;
  quantity: number;
}

export interface LlmBurnCostGroup {
  provider: string;
  costUsd: number;
}

export interface LlmBurnActivityGroup {
  provider: string;
  firstOccurredAt: Date;
  lastOccurredAt: Date;
  eventCount: number;
}

export interface LlmBurnBudgetRow {
  /** Provider.name — matched case-insensitively in JS (Prisma's
   * mode:"insensitive" is Postgres-only; this app runs SQLite). */
  providerName: string;
  monthlyBudgetUsd: number | null;
}

export interface LlmBurnTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  unknown: number;
  total: number;
}

export interface LlmBurnWindowReport {
  hours: number;
  tokens: LlmBurnTokenTotals;
  /** tokens x LiteLLM catalog; under-counts when derivationComplete=false. */
  derivedCostUsd: number;
  derivationComplete: boolean;
  /** Producer-reported cost (cost events + usage events carrying costUsd). */
  reportedCostUsd: number;
  /** max(reported, derived) — recorded-wins, never double-counted. */
  estimateUsd: number;
  eventCount: number;
  /** Elapsed minutes from the window's first event to now, clamped to
   * [MIN_ACTIVE_MINUTES, hours*60]; 0 when the window had no events. */
  activeMinutes: number;
  tokensPerHour: number;
  usdPerHour: number;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
}

export type LlmBurnPaceStatus = "no-budget" | "on-pace" | "watch" | "over-pace";

export interface LlmBurnProviderReport {
  provider: string;
  window: LlmBurnWindowReport;
  monthToDate: {
    estimateUsd: number;
    reportedCostUsd: number;
    derivedCostUsd: number;
  };
  budget: {
    monthlyBudgetUsd: number | null;
    /** Budget prorated to the elapsed month fraction; null without budget. */
    expectedByNowUsd: number | null;
    /** estimate / expectedByNow; 1.0 = exactly on pace. */
    paceRatio: number | null;
    /** estimate / elapsedFraction — linear extrapolation, null early-month. */
    projectedMonthEndUsd: number | null;
    status: LlmBurnPaceStatus;
  };
}

export interface LlmBurnReport {
  generatedAt: string;
  windowHours: number;
  monthStart: string;
  monthElapsedFraction: number;
  pricing: {
    source: string;
    fetchedAt: string;
    upstreamSha256: string;
  };
  providers: LlmBurnProviderReport[];
  /** Providers with MTD estimate but no window activity — surfaced so the UI
   * can say "quiet right now" rather than hiding them. */
  quietProviders: LlmBurnProviderReport[];
}

export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function monthEndUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function emptyTotals(): LlmBurnTokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, unknown: 0, total: 0 };
}

interface TokenAccumulator {
  tokens: LlmBurnTokenTotals;
  derivedCostUsd: number;
  derivationComplete: boolean;
  /** model -> token sums, so pricing resolves per model (provider prefixes
   * and date suffixes differ per model name). "" = producer reported none. */
  models: Map<string, { typed: Record<CanonicalTokenType, number>; unknown: number }>;
}

/** Accumulates token groups into per-provider totals with per-model pricing. */
function aggregateTokens(
  groups: LlmBurnTokenGroup[]
): Map<string, Omit<TokenAccumulator, "models">> {
  const byProvider = new Map<string, TokenAccumulator>();

  for (const group of groups) {
    if (!Number.isFinite(group.quantity) || group.quantity <= 0) continue;
    let entry = byProvider.get(group.provider);
    if (!entry) {
      entry = {
        tokens: emptyTotals(),
        derivedCostUsd: 0,
        derivationComplete: true,
        models: new Map(),
      };
      byProvider.set(group.provider, entry);
    }
    const type: CanonicalTokenType | "unknown" = canonicalTokenType(group.tokenType) ?? "unknown";
    // 1h cache writes are shown in the cacheCreation display bucket but priced
    // at the 1h rate (typed.cacheCreation1h below).
    entry.tokens[type === "cacheCreation1h" ? "cacheCreation" : type] += group.quantity;
    entry.tokens.total += group.quantity;

    const modelKey = group.model?.trim() || "";
    let model = entry.models.get(modelKey);
    if (!model) {
      model = {
        typed: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0 },
        unknown: 0,
      };
      entry.models.set(modelKey, model);
    }
    if (type === "unknown") model.unknown += group.quantity;
    else model.typed[type] += group.quantity;
  }

  const result = new Map<string, Omit<TokenAccumulator, "models">>();
  for (const [provider, entry] of byProvider) {
    for (const [modelName, sums] of entry.models) {
      const priced =
        sums.typed.input + sums.typed.output + sums.typed.cacheRead + sums.typed.cacheCreation +
          sums.typed.cacheCreation1h + sums.unknown >
        0;
      const resolved = modelName ? getModelPricing(modelName) : null;
      if (!resolved) {
        // No model or model not in the catalog: tokens count, cost derives 0.
        if (priced) entry.derivationComplete = false;
        continue;
      }
      const derived = deriveTokenCostUsd(resolved.pricing, sums.typed);
      entry.derivedCostUsd += derived.costUsd;
      if (!derived.complete) entry.derivationComplete = false;
      // Unknown-type tokens: input-rate floor, never over (same contract as
      // derive-ingest-cost.ts).
      if (sums.unknown > 0) {
        const floor = deriveTokenCostUsd(resolved.pricing, { input: sums.unknown });
        entry.derivedCostUsd += floor.costUsd;
        entry.derivationComplete = false;
      }
    }
    result.set(provider, {
      tokens: entry.tokens,
      derivedCostUsd: entry.derivedCostUsd,
      derivationComplete: entry.derivationComplete,
    });
  }
  return result;
}

function aggregateCosts(groups: LlmBurnCostGroup[]): Map<string, number> {
  const byProvider = new Map<string, number>();
  for (const group of groups) {
    if (!Number.isFinite(group.costUsd) || group.costUsd === 0) continue;
    byProvider.set(group.provider, (byProvider.get(group.provider) ?? 0) + group.costUsd);
  }
  return byProvider;
}

/** Pure report builder — rows in, report out. No I/O, fully unit-testable. */
export function buildLlmBurnReport(input: {
  now: Date;
  windowHours?: number;
  windowTokenGroups: LlmBurnTokenGroup[];
  windowCostGroups: LlmBurnCostGroup[];
  windowActivity: LlmBurnActivityGroup[];
  mtdTokenGroups: LlmBurnTokenGroup[];
  mtdCostGroups: LlmBurnCostGroup[];
  budgets: LlmBurnBudgetRow[];
}): LlmBurnReport {
  const now = input.now;
  const windowHours = Math.min(
    Math.max(Math.trunc(input.windowHours ?? DEFAULT_WINDOW_HOURS), 1),
    MAX_WINDOW_HOURS
  );
  const monthStart = monthStartUtc(now);
  const monthEnd = monthEndUtc(now);
  const monthElapsedFraction =
    (now.getTime() - monthStart.getTime()) / (monthEnd.getTime() - monthStart.getTime());

  const windowTokens = aggregateTokens(input.windowTokenGroups);
  const windowCosts = aggregateCosts(input.windowCostGroups);
  const mtdTokens = aggregateTokens(input.mtdTokenGroups);
  const mtdCosts = aggregateCosts(input.mtdCostGroups);

  const activityByProvider = new Map<string, LlmBurnActivityGroup>();
  for (const activity of input.windowActivity) {
    activityByProvider.set(activity.provider, activity);
  }

  const budgetByLowerName = new Map<string, number>();
  for (const budget of input.budgets) {
    if (budget.monthlyBudgetUsd != null && budget.monthlyBudgetUsd > 0) {
      budgetByLowerName.set(budget.providerName.toLowerCase(), budget.monthlyBudgetUsd);
    }
  }

  const providerNames = new Set<string>([
    ...windowTokens.keys(),
    ...windowCosts.keys(),
    ...mtdTokens.keys(),
    ...mtdCosts.keys(),
  ]);

  const providers: LlmBurnProviderReport[] = [];

  for (const provider of providerNames) {
    const wTokens = windowTokens.get(provider);
    const wReported = windowCosts.get(provider) ?? 0;
    const wDerived = wTokens?.derivedCostUsd ?? 0;
    const wEstimate = Math.max(wReported, wDerived);

    const mTokens = mtdTokens.get(provider);
    const mReported = mtdCosts.get(provider) ?? 0;
    const mDerived = mTokens?.derivedCostUsd ?? 0;
    const mEstimate = Math.max(mReported, mDerived);

    const activity = activityByProvider.get(provider);
    let activeMinutes = 0;
    if (activity) {
      const elapsedMs = now.getTime() - activity.firstOccurredAt.getTime();
      activeMinutes = Math.min(
        Math.max(elapsedMs / 60_000, MIN_ACTIVE_MINUTES),
        windowHours * 60
      );
    }

    const tokenTotal = wTokens?.tokens.total ?? 0;
    const budgetUsd = budgetByLowerName.get(provider.toLowerCase()) ?? null;
    const expectedByNowUsd = budgetUsd != null ? budgetUsd * monthElapsedFraction : null;
    const paceRatio =
      expectedByNowUsd != null && expectedByNowUsd > 0 ? mEstimate / expectedByNowUsd : null;
    const projectedMonthEndUsd =
      budgetUsd != null && monthElapsedFraction >= MIN_MONTH_FRACTION_FOR_PROJECTION
        ? mEstimate / monthElapsedFraction
        : null;
    const status: LlmBurnPaceStatus =
      budgetUsd == null
        ? "no-budget"
        : paceRatio == null || paceRatio < 1
        ? "on-pace"
        : paceRatio < PACE_WATCH_RATIO
        ? "watch"
        : "over-pace";

    providers.push({
      provider,
      window: {
        hours: windowHours,
        tokens: wTokens?.tokens ?? emptyTotals(),
        derivedCostUsd: wDerived,
        derivationComplete: wTokens?.derivationComplete ?? true,
        reportedCostUsd: wReported,
        estimateUsd: wEstimate,
        eventCount: activity?.eventCount ?? 0,
        activeMinutes,
        tokensPerHour: activeMinutes > 0 ? (tokenTotal / activeMinutes) * 60 : 0,
        usdPerHour: activeMinutes > 0 ? (wEstimate / activeMinutes) * 60 : 0,
        firstOccurredAt: activity?.firstOccurredAt.toISOString() ?? null,
        lastOccurredAt: activity?.lastOccurredAt.toISOString() ?? null,
      },
      monthToDate: {
        estimateUsd: mEstimate,
        reportedCostUsd: mReported,
        derivedCostUsd: mDerived,
      },
      budget: {
        monthlyBudgetUsd: budgetUsd,
        expectedByNowUsd,
        paceRatio,
        projectedMonthEndUsd,
        status,
      },
    });
  }

  const sortKey = (p: LlmBurnProviderReport) =>
    Math.max(p.window.estimateUsd, p.monthToDate.estimateUsd / 30);
  providers.sort((a, b) => sortKey(b) - sortKey(a));

  const hasWindowActivity = (p: LlmBurnProviderReport) =>
    p.window.eventCount > 0 || p.window.estimateUsd > 0 || p.window.tokens.total > 0;

  return {
    generatedAt: now.toISOString(),
    windowHours,
    monthStart: monthStart.toISOString(),
    monthElapsedFraction,
    pricing: {
      source: PRICING_SNAPSHOT_META.source,
      fetchedAt: PRICING_SNAPSHOT_META.fetchedAt,
      upstreamSha256: PRICING_SNAPSHOT_META.upstreamSha256,
    },
    providers: providers.filter(hasWindowActivity),
    quietProviders: providers.filter((p) => !hasWindowActivity(p) && p.monthToDate.estimateUsd > 0),
  };
}

/** Extract the claude-code token type from an event label (`token:input` ->
 * `input`); anything else is "unknown" and priced at the input-rate floor. */
export function tokenTypeFromLabel(label: string | null): string {
  return label?.startsWith("token:") ? label.slice("token:".length) : "unknown";
}
