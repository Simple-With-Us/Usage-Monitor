/**
 * Wave H / E1 process-local MTD external-cost scan memo.
 * Lived outside budget-status / external-usage-events to avoid import cycles
 * when invalidating after ingest soft-stale or hard bust.
 */
export const MTD_SCAN_MEMO_TTL_MS = 5_000;

export type MtdScanMemoEntry<TProvider, TAttr> = {
  key: string;
  byProvider: TProvider;
  attribution: TAttr;
  expiresAt: number;
};

let entry: MtdScanMemoEntry<unknown, unknown> | null = null;

export function getMtdScanMemo<TProvider, TAttr>(): MtdScanMemoEntry<TProvider, TAttr> | null {
  return entry as MtdScanMemoEntry<TProvider, TAttr> | null;
}

export function setMtdScanMemo<TProvider, TAttr>(
  next: MtdScanMemoEntry<TProvider, TAttr>
): void {
  entry = next as MtdScanMemoEntry<unknown, unknown>;
}

export function clearMtdScanMemo(): void {
  entry = null;
}
