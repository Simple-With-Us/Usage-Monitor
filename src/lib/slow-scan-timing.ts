/** UM-1633: threshold-gated timing logs for slow per-tick MTD / budget computes. */
export const SLOW_SCAN_TIMING_LOG_THRESHOLD_MS = 1_000;

export type SlowScanTimingPayload = Record<string, number>;

export function logSlowScanTimingIfNeeded(
  label: string,
  startedAt: number,
  extra?: SlowScanTimingPayload
): void {
  const durationMs = Math.round(performance.now() - startedAt);
  if (durationMs < SLOW_SCAN_TIMING_LOG_THRESHOLD_MS) {
    return;
  }
  const payload: SlowScanTimingPayload = { durationMs, ...extra };
  console.info(label, JSON.stringify(payload));
}

export async function withSlowScanTiming<T>(
  label: string,
  run: () => Promise<T>,
  buildExtra?: (result: T) => SlowScanTimingPayload
): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await run();
    logSlowScanTimingIfNeeded(label, startedAt, buildExtra?.(result));
    return result;
  } catch (error) {
    logSlowScanTimingIfNeeded(label, startedAt);
    throw error;
  }
}
