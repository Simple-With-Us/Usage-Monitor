export const EXTERNAL_BILLING_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

export function isExternalBillingStale(
  record: { syncedAt: string },
  staleAfterMs = EXTERNAL_BILLING_STALE_AFTER_MS,
  now = Date.now()
): boolean {
  const syncedAt = Date.parse(record.syncedAt);
  const threshold = Number.isFinite(staleAfterMs) && staleAfterMs > 0
    ? staleAfterMs
    : EXTERNAL_BILLING_STALE_AFTER_MS;
  return !Number.isFinite(syncedAt) || now - syncedAt > threshold;
}
