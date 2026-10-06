/**
 * Statistical spike / anomaly detection for per-provider daily spend.
 *
 * WHY MAD (robust) INSTEAD OF MEAN + STDEV
 * ----------------------------------------
 * A naive mean+stdev baseline has a 0% breakdown point: a single prior spike
 * inflates both the mean and (especially) the standard deviation, which then
 * *widens* the alerting band so much that the next spike is masked. For spend
 * monitoring that is exactly the failure mode we cannot tolerate — one anomaly
 * should not blind us to the following one, and yesterday's spike should not
 * silence today's.
 *
 * We therefore use the median + Median Absolute Deviation (MAD) with the
 * Iglewicz–Hoaglin modified z-score:
 *
 *   center       = median(baseline)
 *   MAD          = median(|x_i - center|)
 *   robustSigma  = 1.4826 * MAD           (consistent estimator of σ for normal data)
 *   modified z   = (observed - center) / robustSigma
 *
 * MAD has a 50% breakdown point: up to half the baseline window can be
 * outliers before the estimate is corrupted. That is the robustness the task
 * called for.
 *
 * DEGRADATION / FALSE-ALARM GUARDS
 * --------------------------------
 * - Short history: fewer than `minHistoryPoints` baseline points → no anomaly
 *   (never fire on 2 data points).
 * - Cold baseline: fewer than `minPositiveBaselineDays` with spend at/above the
 *   metric absolute floor → no anomaly (integration day-one / zero-history B2
 *   inventory must not CRITICAL-page on first real traffic).
 * - Zero-variance baseline (MAD == 0, e.g. a flat series): dividing by zero
 *   would make any deviation look like an infinite-sigma spike. We fall back to
 *   a scaled mean-absolute-deviation, and when the baseline is perfectly flat
 *   we require a material relative jump above an absolute floor instead.
 * - Absolute floor (`minObserved`): sub-dollar / sub-N-request noise never
 *   alarms, regardless of sigma.
 * - Relative-jump guard (`minRelativeJump`): the observed value must exceed the
 *   baseline center by at least this fraction. This is what keeps a
 *   near-flat-but-noisy baseline from firing on a statistically-large but
 *   economically-trivial change, biasing hard toward real spikes.
 * - Direction: by default only upward spikes are flagged (a spend drop is not a
 *   budget risk).
 */

export type AnomalyMetric = "cost" | "requests";
export type AnomalySeverity = "critical" | "warning";
export type AnomalyDirection = "up" | "both";

export type AnomalyMethod =
  | "mad"
  | "mad-fallback-mean-abs"
  | "flat-baseline-relative";

/** A single day's incremental (non-cumulative) usage. */
export interface SpendPoint {
  /** UTC day key `YYYY-MM-DD`. Sorts lexicographically = chronologically. */
  day: string;
  /** Incremental value for that day (cost in USD or request count). */
  value: number;
}

export interface AnomalyConfig {
  /** Master switch for wiring anomaly detection into the alert layer. */
  enabled: boolean;
  /** Trailing baseline window length, in days. */
  windowDays: number;
  /** Minimum baseline points (excluding the observed point) required to fire. */
  minHistoryPoints: number;
  /**
   * Minimum baseline days with spend at/above `minObserved[metric]` before any
   * anomaly can fire. Suppresses first-seen traffic off a near-zero baseline.
   */
  minPositiveBaselineDays: number;
  /** Modified-z threshold above which a warning-level anomaly fires. */
  sigmaThreshold: number;
  /** Modified-z threshold at/above which the anomaly escalates to critical. */
  criticalSigma: number;
  /** Per-metric absolute floor: observed below this never alarms. */
  minObserved: Record<AnomalyMetric, number>;
  /** Observed must exceed center by at least this fraction (0.5 = +50%). */
  minRelativeJump: number;
  /** Which direction of deviation to flag. */
  direction: AnomalyDirection;
}

export interface AnomalyResult {
  /** Set by the DB loader; the pure detector leaves it undefined. */
  providerId?: string;
  /** Set by the per-project loader (anomaly-loader) for project-scoped results. */
  projectId?: string;
  metric: AnomalyMetric;
  /** UTC day the observed value belongs to. */
  day: string;
  /** The value that tripped the detector. */
  observed: number;
  /** Robust baseline center (median of the window). */
  baselineCenter: number;
  /** Robust scale actually used (1.4826*MAD, or the fallback estimate). */
  baselineSpread: number;
  /** Lower / upper bound of the expected range at the warning threshold. */
  expectedLow: number;
  expectedHigh: number;
  /** Signed modified z-score. `Infinity` for a flat-baseline relative trip. */
  sigmas: number;
  severity: AnomalySeverity;
  method: AnomalyMethod;
  /** Number of baseline points used. */
  windowSize: number;
}

const SCALE_MAD_TO_SIGMA = 1.4826;
// For a normal distribution E|X-μ| = σ·sqrt(2/π) ≈ 0.7979σ, so σ ≈ 1.2533·MAD_mean.
const SCALE_MEANABS_TO_SIGMA = 1.2533;

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  enabled: true,
  windowDays: 14,
  minHistoryPoints: 7,
  minPositiveBaselineDays: 3,
  sigmaThreshold: 3.5,
  criticalSigma: 5,
  minObserved: { cost: 1, requests: 100 },
  minRelativeJump: 0.5,
  direction: "up",
};

function readNumberEnv(
  env: Partial<NodeJS.ProcessEnv>,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function readBoolEnv(env: Partial<NodeJS.ProcessEnv>, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw == null || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

/**
 * Resolve the anomaly detector configuration from environment variables. Every
 * knob has a conservative default; overrides are clamped to sane ranges so a
 * fat-fingered env value can never make the detector unstable.
 */
export function resolveAnomalyConfig(env: Partial<NodeJS.ProcessEnv> = process.env): AnomalyConfig {
  const sigmaThreshold = readNumberEnv(env, "ANOMALY_SIGMA_THRESHOLD", DEFAULT_ANOMALY_CONFIG.sigmaThreshold, 1, 20);
  const criticalSigma = Math.max(
    sigmaThreshold,
    readNumberEnv(env, "ANOMALY_CRITICAL_SIGMA", DEFAULT_ANOMALY_CONFIG.criticalSigma, 1, 40)
  );
  const direction = env.ANOMALY_DIRECTION?.trim().toLowerCase() === "both" ? "both" : "up";
  return {
    enabled: readBoolEnv(env, "ANOMALY_ALERTS_ENABLED", DEFAULT_ANOMALY_CONFIG.enabled),
    windowDays: Math.trunc(readNumberEnv(env, "ANOMALY_WINDOW_DAYS", DEFAULT_ANOMALY_CONFIG.windowDays, 2, 120)),
    minHistoryPoints: Math.trunc(
      readNumberEnv(env, "ANOMALY_MIN_HISTORY_POINTS", DEFAULT_ANOMALY_CONFIG.minHistoryPoints, 2, 120)
    ),
    minPositiveBaselineDays: Math.trunc(
      readNumberEnv(
        env,
        "ANOMALY_MIN_POSITIVE_BASELINE_DAYS",
        DEFAULT_ANOMALY_CONFIG.minPositiveBaselineDays,
        1,
        120
      )
    ),
    sigmaThreshold,
    criticalSigma,
    minObserved: {
      cost: readNumberEnv(env, "ANOMALY_MIN_COST_USD", DEFAULT_ANOMALY_CONFIG.minObserved.cost, 0, 1_000_000),
      requests: readNumberEnv(env, "ANOMALY_MIN_REQUESTS", DEFAULT_ANOMALY_CONFIG.minObserved.requests, 0, 1_000_000_000),
    },
    minRelativeJump: readNumberEnv(env, "ANOMALY_MIN_RELATIVE_JUMP", DEFAULT_ANOMALY_CONFIG.minRelativeJump, 0, 100),
    direction,
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Robust scale estimate for the baseline, with graceful fallbacks. */
function robustScale(baseline: readonly number[], center: number): { spread: number; method: AnomalyMethod } {
  const absDevs = baseline.map((v) => Math.abs(v - center));
  const mad = median(absDevs);
  if (mad > 0) return { spread: SCALE_MAD_TO_SIGMA * mad, method: "mad" };
  // MAD collapsed (>= half the window identical). Fall back to a scaled mean
  // absolute deviation so a mostly-flat-but-slightly-noisy series still has a
  // usable scale instead of an infinite z-score.
  const meanAbs = mean(absDevs);
  if (meanAbs > 0) return { spread: SCALE_MEANABS_TO_SIGMA * meanAbs, method: "mad-fallback-mean-abs" };
  // Perfectly flat baseline. No statistical scale exists; the relative-jump +
  // absolute-floor guards decide instead.
  return { spread: 0, method: "flat-baseline-relative" };
}

/** Baseline days with economically material spend (same floor as minObserved). */
export function countPositiveBaselineDays(
  baseline: readonly number[],
  metric: AnomalyMetric,
  config: AnomalyConfig
): number {
  const floor = config.minObserved[metric];
  let count = 0;
  for (const value of baseline) {
    if (value >= floor) count += 1;
  }
  return count;
}

/**
 * Core detector. `baseline` is the trailing series EXCLUDING `observed`, in
 * chronological order. Returns a structured anomaly, or null when nothing
 * trips (short history, below floor, within band, wrong direction, ...).
 *
 * Pure and deterministic — no clock or randomness.
 */
export function detectAnomaly(
  observed: number,
  baseline: readonly number[],
  metric: AnomalyMetric,
  config: AnomalyConfig,
  day = ""
): AnomalyResult | null {
  if (!Number.isFinite(observed)) return null;
  if (baseline.length < config.minHistoryPoints) return null;
  if (observed < config.minObserved[metric]) return null;

  const positiveBaselineDays = countPositiveBaselineDays(baseline, metric, config);
  if (positiveBaselineDays < config.minPositiveBaselineDays) return null;

  const center = median(baseline);
  const deviation = observed - center;

  if (config.direction === "up" && deviation <= 0) return null;

  // Relative-jump guard: bias hard toward real spikes over statistically-large
  // but economically-trivial wiggles on a near-flat baseline. When the center
  // is ~0 any material observed value (already past the absolute floor) is a
  // jump, so the guard only bites once there is a meaningful center.
  if (center > 0 && Math.abs(deviation) < center * config.minRelativeJump) return null;

  const { spread, method } = robustScale(baseline, center);

  let sigmas: number;
  if (spread > 0) {
    sigmas = deviation / spread;
    if (Math.abs(sigmas) < config.sigmaThreshold) return null;
  } else {
    // Flat baseline: we only reach here having already cleared the absolute
    // floor and (center>0) relative-jump guard, so this is a genuine jump off a
    // dead-flat line. Report an infinite modified-z for transparency.
    sigmas = deviation > 0 ? Infinity : -Infinity;
  }

  const severity: AnomalySeverity =
    Math.abs(sigmas) >= config.criticalSigma ? "critical" : "warning";
  const halfBand = spread * config.sigmaThreshold;

  return {
    metric,
    day,
    observed,
    baselineCenter: center,
    baselineSpread: spread,
    expectedLow: Math.max(0, center - halfBand),
    expectedHigh: center + halfBand,
    sigmas,
    severity,
    method,
    windowSize: baseline.length,
  };
}

/**
 * Detect an anomaly on the most recent point of a daily series. The last point
 * is treated as the observed value; the preceding `config.windowDays` points
 * form the baseline. Returns null when the series is too short or nothing trips.
 */
export function detectSeriesAnomaly(
  series: readonly SpendPoint[],
  metric: AnomalyMetric,
  config: AnomalyConfig
): AnomalyResult | null {
  if (series.length < 2) return null;
  const observed = series[series.length - 1];
  const baseline = series
    .slice(Math.max(0, series.length - 1 - config.windowDays), series.length - 1)
    .map((point) => point.value);
  return detectAnomaly(observed.value, baseline, metric, config, observed.day);
}

interface CumulativePoint {
  day: string;
  cumulative: number;
}

/**
 * Convert a per-day CUMULATIVE (month-to-date) series into per-day INCREMENTAL
 * spend, resetting the running baseline at each UTC month boundary (provider
 * month-to-date totals reset every billing month) and clamping negative deltas
 * (mid-month corrections) to zero so a correction never manufactures a spike.
 */
export function dailyIncrementsFromCumulative(points: readonly CumulativePoint[]): SpendPoint[] {
  const sorted = [...points].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const out: SpendPoint[] = [];
  let prev: CumulativePoint | null = null;
  for (const point of sorted) {
    const month = point.day.slice(0, 7);
    const sameMonth = prev != null && prev.day.slice(0, 7) === month;
    let value: number;
    if (!sameMonth) {
      // First day we have this month: the cumulative IS the month-to-date spend.
      value = Math.max(0, point.cumulative);
    } else {
      value = Math.max(0, point.cumulative - (prev as CumulativePoint).cumulative);
    }
    out.push({ day: point.day, value });
    prev = point;
  }
  return out;
}

function formatObserved(metric: AnomalyMetric, value: number): string {
  if (metric === "cost") {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
  }
  return `${new Intl.NumberFormat("en-US").format(Math.round(value))} requests`;
}

/** Human-readable one-line summary for an alert message. */
export function describeAnomaly(result: AnomalyResult): string {
  const label = result.metric === "cost" ? "Spend spike" : "Request spike";
  const observed = formatObserved(result.metric, result.observed);
  const expected = formatObserved(result.metric, result.expectedHigh);
  const baseline = formatObserved(result.metric, result.baselineCenter);
  const sigmaText = Number.isFinite(result.sigmas)
    ? `${result.sigmas.toFixed(1)}σ`
    : "flat baseline";
  return (
    `${label}: ${observed} on ${result.day} vs expected ≤ ${expected} ` +
    `(baseline ${baseline}, ${result.windowSize}-day window, ${sigmaText}).`
  );
}
