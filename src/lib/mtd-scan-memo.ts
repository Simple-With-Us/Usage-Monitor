/**
 * Wave H / E1 process-local MTD external-cost scan memo.
 * Lived outside budget-status / external-usage-events to avoid import cycles
 * when invalidating after ingest soft-stale or hard bust.
 *
 * E1 (2026-07-29 perf lane): a second slot memoizes the /api/usage-events
 * summary aggregation. Both slots are cleared by the same clearMtdScanMemo()
 * budget-status already calls after ingest soft-stale / hard bust, so the
 * summary memo inherits the existing post-write invalidation path for free.
 */
export const MTD_SCAN_MEMO_TTL_MS = 5_000;

export type MtdScanMemoEntry<TProvider, TAttr> = {
  key: string;
  byProvider: TProvider;
  attribution: TAttr;
  expiresAt: number;
};

export type UsageEventsSummaryMemoEntry<TSummary> = {
  key: string;
  value: TSummary;
  expiresAt: number;
};

let entry: MtdScanMemoEntry<unknown, unknown> | null = null;
let summaryEntry: UsageEventsSummaryMemoEntry<unknown> | null = null;

export function getMtdScanMemo<TProvider, TAttr>(): MtdScanMemoEntry<TProvider, TAttr> | null {
  return entry as MtdScanMemoEntry<TProvider, TAttr> | null;
}

export function setMtdScanMemo<TProvider, TAttr>(
  next: MtdScanMemoEntry<TProvider, TAttr>
): void {
  entry = next as MtdScanMemoEntry<unknown, unknown>;
}

export function getUsageEventsSummaryMemo<TSummary>(): UsageEventsSummaryMemoEntry<TSummary> | null {
  return summaryEntry as UsageEventsSummaryMemoEntry<TSummary> | null;
}

export function setUsageEventsSummaryMemo<TSummary>(
  next: UsageEventsSummaryMemoEntry<TSummary>
): void {
  summaryEntry = next as UsageEventsSummaryMemoEntry<unknown>;
}

export function clearMtdScanMemo(): void {
  entry = null;
  summaryEntry = null;
}
