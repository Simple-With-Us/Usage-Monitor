/**
 * A scheduler-wide poll outage, not one provider's own HTTP error.
 *
 * Skipped providers were not attempted. One failure beside a full skip set
 * (production: unusual-whales HTTP_ERROR, 27 skipped) is that provider.
 * Page on the first tick only when at least two attempts failed, or when
 * the whole poll set was attempted and every one failed.
 *
 * This module stays free of Node built-ins. sentry-ops is imported by the
 * edge and browser Sentry configs through sentry-scrubber, so it must not
 * reach runtime-health (node:fs) to answer this question.
 */
export function isBroadProviderFetchOutage(run: {
  successes: number;
  failures: number;
  skipped?: number;
}): boolean {
  if (run.successes !== 0 || run.failures <= 0) return false;
  if (run.failures >= 2) return true;
  return run.skipped === 0;
}
