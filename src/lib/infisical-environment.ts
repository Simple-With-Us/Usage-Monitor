/**
 * The only Infisical environment Usage-Monitor reads.
 *
 * Owner directive (2026-10-10): prod is the only environment.  The `dev` and
 * `staging` environments of the usage-monitor Infisical project are being
 * retired, so every selector resolves to `prod`.  A request for any other slug
 * (an `INFISICAL_ENV` or `UM_INFISICAL_ENV` override) is refused: it logs one
 * warning per variable and is ignored.  It never throws, because the selectors
 * run in the startup path and in periodic probes, and a throw there would take
 * the container down or blank a status card.
 */
export const INFISICAL_ENVIRONMENT = "prod" as const;

const warnedVariables = new Set<string>();

/**
 * Resolve an Infisical environment slug from an optional override.  Always
 * returns `prod`; a non-prod `requested` value is ignored with a one-time
 * warning that names the variable (never echoes a value).
 */
export function resolveProdInfisicalEnvironment(
  requested: string | null | undefined,
  variable: string
): typeof INFISICAL_ENVIRONMENT {
  const value = requested?.trim();
  if (value && value !== INFISICAL_ENVIRONMENT && !warnedVariables.has(variable)) {
    warnedVariables.add(variable);
    console.warn(
      `[infisical] ${variable} is set to a non-prod value and is ignored: ` +
        "Usage-Monitor reads Infisical prod only.  See INFISICAL.md."
    );
  }
  return INFISICAL_ENVIRONMENT;
}

/** Test seam: forget which variables have already warned. */
export function _resetInfisicalEnvironmentWarningsForTests(): void {
  warnedVariables.clear();
}
