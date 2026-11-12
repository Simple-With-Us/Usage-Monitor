import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANOMALY_CONFIG,
  type AnomalyConfig,
  dailyIncrementsFromCumulative,
  describeAnomaly,
  countPositiveBaselineDays,
  detectAnomaly,
  detectSeriesAnomaly,
  median,
  resolveAnomalyConfig,
} from "../anomaly-detection";

const CONFIG: AnomalyConfig = DEFAULT_ANOMALY_CONFIG;

// A calm baseline: ~10/day with small noise, MAD > 0.
const CALM = [10, 11, 9, 10, 12, 8, 10, 11, 9, 10];

describe("detectAnomaly", () => {
  it("catches a clear upward spike", () => {
    const result = detectAnomaly(100, CALM, "cost", CONFIG, "2026-07-19");
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("critical");
    expect(result!.observed).toBe(100);
    expect(result!.baselineCenter).toBe(10);
    expect(result!.expectedHigh).toBeLessThan(100);
    expect(result!.day).toBe("2026-07-19");
    expect(result!.method).toBe("mad");
  });

  it("does NOT flag normal variation within the band", () => {
    // 13 vs a ~10 baseline: elevated but well inside normal noise.
    expect(detectAnomaly(13, CALM, "cost", CONFIG)).toBeNull();
  });

  it("does not fire on short history (no false alarm on 2 points)", () => {
    // A huge observed value, but only 2 baseline points < minHistoryPoints (7).
    expect(detectAnomaly(10_000, [1, 2], "cost", CONFIG)).toBeNull();
  });

  it("stays quiet on a perfectly flat baseline for a trivial jump", () => {
    const flat = [10, 10, 10, 10, 10, 10, 10, 10];
    // +0.4 off a dead-flat $10 line: statistically infinite z, but economically
    // trivial — the relative-jump guard suppresses it.
    expect(detectAnomaly(10.4, flat, "cost", CONFIG)).toBeNull();
  });

  it("fires on a flat baseline once the jump is material (zero-variance handling)", () => {
    const flat = [10, 10, 10, 10, 10, 10, 10, 10];
    const result = detectAnomaly(50, flat, "cost", CONFIG, "2026-07-19");
    expect(result).not.toBeNull();
    expect(result!.method).toBe("flat-baseline-relative");
    expect(result!.sigmas).toBe(Infinity);
    expect(result!.severity).toBe("critical");
    expect(result!.baselineSpread).toBe(0);
  });

  it("respects the absolute floor (sub-floor observed never alarms)", () => {
    const flatZero = [0, 0, 0, 0, 0, 0, 0, 0];
    // 0.5 < ANOMALY_MIN_COST_USD default of 1 → suppressed despite a $0 baseline.
    expect(detectAnomaly(0.5, flatZero, "cost", CONFIG)).toBeNull();
  });

  it("does not CRITICAL-page on first-seen traffic off a zero baseline (B2 integration)", () => {
    const coldZero = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    // Legitimate multipart backup / inventory day-one spend — no positive history.
    expect(detectAnomaly(85, coldZero, "cost", CONFIG, "2026-10-04")).toBeNull();
    expect(countPositiveBaselineDays(coldZero, "cost", CONFIG)).toBe(0);
  });

  it("waits for minPositiveBaselineDays before alerting off a near-zero baseline", () => {
    const ramping = [0, 0, 0, 0, 0, 1.5, 1.5, 0, 0, 0, 0, 0, 0, 0];
    expect(countPositiveBaselineDays(ramping, "cost", CONFIG)).toBe(2);
    expect(detectAnomaly(120, ramping, "cost", CONFIG)).toBeNull();
    const warmed = [1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 0, 0, 0, 0, 0, 0, 0];
    expect(countPositiveBaselineDays(warmed, "cost", CONFIG)).toBe(7);
    expect(detectAnomaly(120, warmed, "cost", CONFIG)).not.toBeNull();
  });

  it("only flags upward spikes by default (a drop is not a budget risk)", () => {
    expect(detectAnomaly(2, CALM, "cost", CONFIG)).toBeNull();
  });

  it("uses the request floor for the requests metric", () => {
    const calmRequests = [1000, 1100, 900, 1000, 1200, 800, 1000, 1100, 900];
    // 50 requests is below the 100-request floor.
    expect(detectAnomaly(50, calmRequests, "requests", CONFIG)).toBeNull();
    // A genuine request spike fires.
    const spike = detectAnomaly(9000, calmRequests, "requests", CONFIG);
    expect(spike).not.toBeNull();
    expect(spike!.metric).toBe("requests");
  });

  it("is robust: one prior spike in the window does not mask a new spike (MAD vs stdev)", () => {
    // Nine calm points plus ONE prior spike of 300.
    const baseline = [9, 10, 11, 10, 9, 11, 10, 9, 11, 300];
    const observed = 80;

    // A naive mean+stdev z-score is blinded by the prior spike inflating stdev.
    const mean = baseline.reduce((s, v) => s + v, 0) / baseline.length;
    const stdev = Math.sqrt(
      baseline.reduce((s, v) => s + (v - mean) ** 2, 0) / baseline.length
    );
    const naiveZ = (observed - mean) / stdev;
    expect(naiveZ).toBeLessThan(CONFIG.sigmaThreshold); // naive detector would MISS it

    // The robust MAD detector still catches the new spike.
    const result = detectAnomaly(observed, baseline, "cost", CONFIG);
    expect(result).not.toBeNull();
    expect(result!.method).toBe("mad");
    expect(Math.abs(result!.sigmas)).toBeGreaterThan(CONFIG.sigmaThreshold);
  });

  it("returns null when disabled config would still be evaluated purely (enabled flag is a wiring gate, not a detector gate)", () => {
    // The pure detector does not consult `enabled`; it is the loader/wiring that
    // gates. Given valid inputs it still detects. This documents that contract.
    const result = detectAnomaly(100, CALM, "cost", { ...CONFIG, enabled: false });
    expect(result).not.toBeNull();
  });
});

describe("detectSeriesAnomaly", () => {
  it("treats the last point as observed and preceding points as baseline", () => {
    const series = [...CALM, 100].map((value, i) => ({ day: `2026-07-${String(i + 1).padStart(2, "0")}`, value }));
    const result = detectSeriesAnomaly(series, "cost", CONFIG);
    expect(result).not.toBeNull();
    expect(result!.observed).toBe(100);
  });

  it("returns null for a series that is too short", () => {
    expect(detectSeriesAnomaly([{ day: "2026-07-01", value: 100 }], "cost", CONFIG)).toBeNull();
  });
});

describe("dailyIncrementsFromCumulative", () => {
  it("differences within a month and resets at the month boundary", () => {
    const increments = dailyIncrementsFromCumulative([
      { day: "2026-06-29", cumulative: 100 },
      { day: "2026-06-30", cumulative: 130 },
      { day: "2026-07-01", cumulative: 5 },
      { day: "2026-07-02", cumulative: 20 },
    ]);
    expect(increments.map((p) => p.value)).toEqual([100, 30, 5, 15]);
  });

  it("clamps mid-month corrections (a cumulative decrease) to zero", () => {
    const increments = dailyIncrementsFromCumulative([
      { day: "2026-07-01", cumulative: 50 },
      { day: "2026-07-02", cumulative: 40 }, // provider corrected downward
      { day: "2026-07-03", cumulative: 60 },
    ]);
    expect(increments.map((p) => p.value)).toEqual([50, 0, 20]);
  });

  it("sorts unordered input before differencing", () => {
    const increments = dailyIncrementsFromCumulative([
      { day: "2026-07-03", cumulative: 60 },
      { day: "2026-07-01", cumulative: 10 },
      { day: "2026-07-02", cumulative: 30 },
    ]);
    expect(increments.map((p) => p.day)).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
    expect(increments.map((p) => p.value)).toEqual([10, 20, 30]);
  });
});

describe("resolveAnomalyConfig", () => {
  it("uses conservative defaults with an empty env", () => {
    const config = resolveAnomalyConfig({});
    expect(config).toEqual(DEFAULT_ANOMALY_CONFIG);
  });

  it("reads and clamps env overrides", () => {
    const config = resolveAnomalyConfig({
      ANOMALY_ALERTS_ENABLED: "false",
      ANOMALY_WINDOW_DAYS: "30",
      ANOMALY_SIGMA_THRESHOLD: "4",
      ANOMALY_CRITICAL_SIGMA: "2", // below threshold → clamped up to threshold
      ANOMALY_MIN_COST_USD: "5",
      ANOMALY_MIN_POSITIVE_BASELINE_DAYS: "5",
      ANOMALY_DIRECTION: "both",
    });
    expect(config.enabled).toBe(false);
    expect(config.windowDays).toBe(30);
    expect(config.sigmaThreshold).toBe(4);
    expect(config.criticalSigma).toBe(4); // clamped to be >= threshold
    expect(config.minObserved.cost).toBe(5);
    expect(config.minPositiveBaselineDays).toBe(5);
    expect(config.direction).toBe("both");
  });
});

describe("median + describeAnomaly", () => {
  it("computes the median for even and odd length series", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("renders a readable cost anomaly summary", () => {
    const result = detectAnomaly(100, CALM, "cost", CONFIG, "2026-07-19")!;
    const text = describeAnomaly(result);
    expect(text).toContain("Spend spike");
    expect(text).toContain("$100.00");
    expect(text).toContain("2026-07-19");
  });
});
