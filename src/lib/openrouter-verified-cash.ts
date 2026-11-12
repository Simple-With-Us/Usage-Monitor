/**
 * GROK3-E19: Optional verified-preferred cash mode for OpenRouter.
 *
 * When enabled and per-event verification coverage is high enough, the
 * budget-status computation substitutes OpenRouter's authoritative
 * period-level verified cost (from the reconciliation layer) for the
 * self-reported max(snapshot, pushed) variable-usage estimate.
 *
 * Default-OFF. Never changes behaviour when OPENROUTER_VERIFIED_PREFERRED_CASH
 * is unset or set to anything other than true/1/yes.
 */

/** Resolved env config for the verified-preferred-cash feature. */
export interface OpenRouterVerifiedCashConfig {
  /** True when OPENROUTER_VERIFIED_PREFERRED_CASH is true / 1 / yes. */
  enabled: boolean;
  /**
   * Minimum verifiedCoverage fraction (0..1) required before the verified
   * total is substituted. Default 0.9.
   * Configured via OPENROUTER_VERIFIED_PREFERRED_MIN_COVERAGE.
   */
  minCoverage: number;
}

/**
 * Parse the env flags for this feature. Pure — no side effects, callable
 * anywhere without imports beyond process.env.
 */
export function resolveOpenRouterVerifiedCashConfig(): OpenRouterVerifiedCashConfig {
  const raw = process.env.OPENROUTER_VERIFIED_PREFERRED_CASH?.trim().toLowerCase();
  const enabled = raw === "true" || raw === "1" || raw === "yes";

  const coverageRaw = process.env.OPENROUTER_VERIFIED_PREFERRED_MIN_COVERAGE?.trim();
  const coverageParsed = coverageRaw ? Number(coverageRaw) : NaN;
  const minCoverage =
    Number.isFinite(coverageParsed) && coverageParsed >= 0 && coverageParsed <= 1
      ? coverageParsed
      : 0.9;

  return { enabled, minCoverage };
}

export interface OpenRouterVerifiedCashInput {
  /** Canonical provider key (e.g. "openrouter"). Feature only activates for "openrouter". */
  providerCanonicalKey: string;
  /** The observed variable usage — max(snapshotVariable, pushedUsage) — computed before this call. */
  observedVariableUsageUsd: number;
  /**
   * Fraction of generation-id-carrying events for this provider that reached a
   * settled verification (match or discrepancy), in the range 0..1.
   * Null when there are no verifiable events at all this period.
   */
  verifiedCoverage: number | null;
  /**
   * Provider-authoritative verified period cost from the reconciliation layer
   * (ProviderUsageReconciliation.verifiedCostUsd). Null when no period
   * reconciliation row exists or it carries no verified figure yet.
   */
  periodVerifiedCostUsd: number | null;
  /** Feature config — pass the result of resolveOpenRouterVerifiedCashConfig(). */
  config: OpenRouterVerifiedCashConfig;
}

export interface OpenRouterVerifiedCashResult {
  /** The effective variable-usage cost to use in spentUsd = fixedAccruedUsd + usageCost. */
  usageCost: number;
  /** True when the verified period cost was substituted for the observed variable usage. */
  verifiedPreferredCashApplied: boolean;
  /** The verified cost that was applied, or null when the feature did not trigger. */
  verifiedPreferredCashUsd: number | null;
}

/**
 * Decide whether to substitute the authoritative verified period cost for the
 * self-reported observed variable usage for a given provider.
 *
 * All of the following must hold for substitution to occur:
 *   1. Feature is enabled (OPENROUTER_VERIFIED_PREFERRED_CASH=true/1/yes).
 *   2. providerCanonicalKey === "openrouter".
 *   3. verifiedCoverage is non-null and >= config.minCoverage.
 *   4. periodVerifiedCostUsd is a finite non-negative number.
 *
 * When any condition fails, observedVariableUsageUsd is returned unchanged —
 * behaviour is byte-identical to before this feature existed. Never invents
 * a zero when verification is incomplete (condition 4 guards this explicitly).
 */
export function resolveOpenRouterVerifiedCash(
  input: OpenRouterVerifiedCashInput
): OpenRouterVerifiedCashResult {
  const {
    providerCanonicalKey,
    observedVariableUsageUsd,
    verifiedCoverage,
    periodVerifiedCostUsd,
    config,
  } = input;

  if (
    config.enabled &&
    providerCanonicalKey === "openrouter" &&
    verifiedCoverage !== null &&
    verifiedCoverage >= config.minCoverage &&
    periodVerifiedCostUsd !== null &&
    Number.isFinite(periodVerifiedCostUsd) &&
    periodVerifiedCostUsd >= 0
  ) {
    return {
      usageCost: periodVerifiedCostUsd,
      verifiedPreferredCashApplied: true,
      verifiedPreferredCashUsd: periodVerifiedCostUsd,
    };
  }

  return {
    usageCost: observedVariableUsageUsd,
    verifiedPreferredCashApplied: false,
    verifiedPreferredCashUsd: null,
  };
}
