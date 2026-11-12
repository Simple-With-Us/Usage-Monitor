export function calculateEomForecast(
  spentUsd: number,
  fixedAccruedUsd: number,
  now: Date
): number {
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();

  // Calculate precise fractional day of the month for more accurate forecasting early in the month
  const currentDay = now.getUTCDate() + (now.getUTCHours() / 24) + (now.getUTCMinutes() / 1440);

  // Avoid division by zero at the exact start of the month
  if (currentDay < 0.1) {
    return spentUsd;
  }

  // The usage portion is what grows linearly. Fixed costs don't grow.
  const usageUsd = Math.max(0, spentUsd - fixedAccruedUsd);
  const forecastedUsage = (usageUsd / currentDay) * daysInMonth;

  return fixedAccruedUsd + forecastedUsage;
}

/**
 * Non-linear end-of-month forecasting.
 *
 * The naive `calculateEomForecast` above extrapolates the average daily rate so
 * far (spentSoFar / dayOfMonth) flat to month end. That is blind to TREND: if
 * daily spend is accelerating it under-projects, and if it front-loaded early
 * then went quiet it over-projects.
 *
 * `forecastMonthlyUsageFromSeries` fits a RECENCY-WEIGHTED linear trend to the
 * per-day incremental usage rate and integrates that trend over the remaining
 * days, capturing curvature (a rising/falling daily rate) where the data
 * supports it. It DEGRADES to the exact linear behaviour when history is too
 * short, and clamps the trend projection to a conservative multiple of the
 * linear projection so a noisy slope can never produce a runaway forecast.
 *
 * All existing consumers keep calling `calculateEomForecast`; this is additive.
 */

export interface SeriesForecastOptions {
  /** Minimum COMPLETE elapsed days required before trend fitting kicks in. */
  minTrendDays?: number;
  /** Exponential recency weighting half-life, in days. */
  halfLifeDays?: number;
  /** Lower clamp on trend projection as a multiple of the linear projection. */
  minFactor?: number;
  /** Upper clamp on trend projection as a multiple of the linear projection. */
  maxFactor?: number;
}

const DEFAULT_SERIES_FORECAST_OPTIONS: Required<SeriesForecastOptions> = {
  minTrendDays: 5,
  halfLifeDays: 5,
  minFactor: 1 / 3,
  maxFactor: 3,
};

function fractionalDayOfMonth(now: Date): number {
  return now.getUTCDate() + now.getUTCHours() / 24 + now.getUTCMinutes() / 1440;
}

function daysInUtcMonth(now: Date): number {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * Project total usage for the current month from a per-day incremental usage
 * series (chronological; `dailyUsage[i]` is the spend on day i+1 of the month,
 * the final element being today, possibly partial). Returns projected total
 * usage for the whole month (NOT including any fixed cost).
 *
 * Pure and deterministic — the only clock input is the explicit `now`.
 */
export function forecastMonthlyUsageFromSeries(
  dailyUsage: readonly number[],
  now: Date,
  options: SeriesForecastOptions = {}
): number {
  const opts = { ...DEFAULT_SERIES_FORECAST_OPTIONS, ...options };
  const daysInMonth = daysInUtcMonth(now);
  const currentDay = fractionalDayOfMonth(now);
  const usageSoFar = dailyUsage.reduce((sum, v) => sum + Math.max(0, v), 0);

  if (currentDay < 0.1) return usageSoFar;

  const remainingSpan = Math.max(0, daysInMonth - currentDay);
  const linearRate = usageSoFar / currentDay;
  const linearRemaining = linearRate * remainingSpan;

  // Fit the trend on COMPLETE days only; the partial current day would drag the
  // slope down artificially. Complete day count is floor(currentDay).
  const completeDays = Math.min(dailyUsage.length, Math.floor(currentDay));
  if (completeDays < opts.minTrendDays || remainingSpan <= 0) {
    // Linear fallback == the legacy behaviour.
    return usageSoFar + linearRemaining;
  }

  // Recency-weighted least squares on (dayIndex, dailyRate).
  const decay = Math.pow(0.5, 1 / opts.halfLifeDays);
  let sw = 0;
  let swx = 0;
  let swy = 0;
  let swxx = 0;
  let swxy = 0;
  for (let i = 0; i < completeDays; i++) {
    const x = i + 1; // day-of-month index
    const y = Math.max(0, dailyUsage[i]);
    const w = Math.pow(decay, completeDays - 1 - i); // most recent day → weight 1
    sw += w;
    swx += w * x;
    swy += w * y;
    swxx += w * x * x;
    swxy += w * x * y;
  }
  const denom = sw * swxx - swx * swx;
  let a: number;
  let b: number;
  if (Math.abs(denom) < 1e-9) {
    // Degenerate (e.g. all weight on one point): flat at the weighted mean.
    a = swy / sw;
    b = 0;
  } else {
    b = (sw * swxy - swx * swy) / denom;
    a = (swy - b * swx) / sw;
  }

  // Integrate the fitted daily rate r(d) = a + b·d from `currentDay` to month
  // end. Guard the intercept so a steep negative slope can't imply negative
  // spend across the whole tail.
  const integral =
    a * remainingSpan + (b * (daysInMonth * daysInMonth - currentDay * currentDay)) / 2;

  const lowerClamp = linearRemaining * opts.minFactor;
  const upperClamp = linearRemaining * opts.maxFactor;
  const trendRemaining = Math.min(Math.max(integral, Math.max(0, lowerClamp)), upperClamp);

  return usageSoFar + trendRemaining;
}

/**
 * Backward-compatible-shaped EOM forecast (fixed cost + projected usage) that
 * uses the non-linear series projection when a daily series is available and
 * degrades to the linear `calculateEomForecast` when it is not. Mirrors
 * `calculateEomForecast`'s return contract: fixed accrued cost plus projected
 * variable usage.
 */
/**
 * Budget runout projection (S9): the day the cumulative forecast crosses the
 * monthly budget — "budget exhausts ~Aug 22 at current burn".
 *
 * Derived from the already-computed MTD spend and EOM projection, so it
 * inherits whichever forecast produced `projectedEomUsd` (linear or the
 * recency-weighted trend). The burn rate is the AVERAGE projected daily
 * growth left in the month; the crossing day is where MTD + burn·d reaches
 * the budget. Returns nulls when there is no configured budget or the
 * projection never crosses it.
 *
 * Pure and deterministic — the only clock input is the explicit `now`.
 */
export interface BudgetRunoutProjection {
  /** Instant the cumulative forecast crosses the budget; `now` when already exhausted; null when never projected to cross. */
  runoutDate: Date | null;
  /** Fractional days (1-decimal) from `now` until exhaustion; 0 when already exhausted; null when never projected. */
  daysUntilBudgetExhausted: number | null;
}

const MS_PER_DAY_RUNOUT = 24 * 60 * 60 * 1000;

export function projectBudgetRunout(input: {
  spentUsd: number;
  projectedEomUsd: number;
  monthlyBudgetUsd: number | null;
  now: Date;
}): BudgetRunoutProjection {
  const { spentUsd, projectedEomUsd, monthlyBudgetUsd, now } = input;
  const never: BudgetRunoutProjection = {
    runoutDate: null,
    daysUntilBudgetExhausted: null,
  };
  if (monthlyBudgetUsd == null || !(monthlyBudgetUsd > 0)) return never;
  if (!Number.isFinite(spentUsd) || !Number.isFinite(projectedEomUsd)) return never;
  if (spentUsd >= monthlyBudgetUsd) {
    return { runoutDate: new Date(now.getTime()), daysUntilBudgetExhausted: 0 };
  }
  const remainingSpan = Math.max(0, daysInUtcMonth(now) - fractionalDayOfMonth(now));
  if (remainingSpan <= 0) return never;
  const dailyBurn = (projectedEomUsd - spentUsd) / remainingSpan;
  if (!(dailyBurn > 0)) return never;
  const days = (monthlyBudgetUsd - spentUsd) / dailyBurn;
  return {
    runoutDate: new Date(now.getTime() + days * MS_PER_DAY_RUNOUT),
    daysUntilBudgetExhausted: Math.round(days * 10) / 10,
  };
}

export function calculateEomForecastFromSeries(
  dailyUsage: readonly number[] | null | undefined,
  fixedAccruedUsd: number,
  now: Date,
  options: SeriesForecastOptions & {
    /** When series is empty, linear-extrapolate this usage total (Wave J / E11). */
    usageSoFarFallback?: number;
  } = {}
): number {
  if (!dailyUsage || dailyUsage.length === 0) {
    // No series → reproduce the legacy linear forecast exactly. Callers that
    // already know MTD usage must pass usageSoFarFallback; defaulting to 0
    // would silently under-forecast variable spend.
    const usageSoFar = options.usageSoFarFallback ?? 0;
    return calculateEomForecast(fixedAccruedUsd + usageSoFar, fixedAccruedUsd, now);
  }
  return fixedAccruedUsd + forecastMonthlyUsageFromSeries(dailyUsage, now, options);
}
