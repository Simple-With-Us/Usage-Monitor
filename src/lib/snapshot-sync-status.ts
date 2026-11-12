import type {
  AdapterError,
  AdapterErrorCode,
  CostCoverageCaveat,
} from "@/lib/adapters/helpers";

const USAGE_MONITOR_SNAPSHOT_META_KEY = "__apiUsageMonitor";

export interface SnapshotPartialFailure {
  code: AdapterErrorCode;
  status: number | null;
  retryable: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function withSnapshotSyncFailure(
  rawData: unknown,
  postPersistError: AdapterError | undefined
): unknown {
  const adapterRawData = asRecord(rawData);
  const sanitizedAdapterRawData = adapterRawData
    ? Object.fromEntries(
        Object.entries(adapterRawData).filter(
          ([key]) => key !== USAGE_MONITOR_SNAPSHOT_META_KEY
        )
      )
    : null;
  if (!postPersistError) {
    return sanitizedAdapterRawData ?? rawData;
  }

  return {
    ...(sanitizedAdapterRawData ??
      (rawData == null ? {} : { adapterRawData: rawData })),
    [USAGE_MONITOR_SNAPSHOT_META_KEY]: {
      version: 1,
      partialFailure: {
        code: postPersistError.code,
        status: postPersistError.status,
        retryable: postPersistError.retryable,
      },
    },
  };
}

export function snapshotPartialFailure(
  rawData: unknown
): SnapshotPartialFailure | null {
  const metadata = asRecord(
    asRecord(rawData)?.[USAGE_MONITOR_SNAPSHOT_META_KEY]
  );
  const failure = asRecord(metadata?.partialFailure);
  if (
    metadata?.version !== 1 ||
    typeof failure?.code !== "string" ||
    !(failure.status === null || Number.isSafeInteger(failure.status)) ||
    typeof failure.retryable !== "boolean"
  ) {
    return null;
  }

  return {
    code: failure.code as AdapterErrorCode,
    status: failure.status as number | null,
    retryable: failure.retryable,
  };
}

export function isRetryablePartialSnapshot(rawData: unknown): boolean {
  return snapshotPartialFailure(rawData)?.retryable === true;
}

/**
 * Persists an adapter-set CostCoverageCaveat (see adapters/helpers.ts)
 * inside rawData's existing app-metadata bag - additive, no new DB column.
 * No-op when the adapter didn't set one. Apply this after
 * withSnapshotSyncFailure so both metadata kinds land in the same
 * __apiUsageMonitor object instead of one clobbering the other.
 */
export function withCostCoverageCaveat(
  rawData: unknown,
  costCoverageCaveat: CostCoverageCaveat | null | undefined
): unknown {
  if (!costCoverageCaveat) return rawData;
  const record =
    asRecord(rawData) ?? (rawData == null ? {} : { adapterRawData: rawData });
  const existingMeta = asRecord(record[USAGE_MONITOR_SNAPSHOT_META_KEY]);

  return {
    ...record,
    [USAGE_MONITOR_SNAPSHOT_META_KEY]: {
      version: 1,
      ...existingMeta,
      costCoverageCaveat: {
        code: costCoverageCaveat.code,
        message: costCoverageCaveat.message,
      },
    },
  };
}

export function snapshotCostCoverageCaveat(
  rawData: unknown
): CostCoverageCaveat | null {
  const metadata = asRecord(
    asRecord(rawData)?.[USAGE_MONITOR_SNAPSHOT_META_KEY]
  );
  const caveat = asRecord(metadata?.costCoverageCaveat);
  if (
    metadata?.version !== 1 ||
    typeof caveat?.code !== "string" ||
    typeof caveat.message !== "string"
  ) {
    return null;
  }

  return {
    code: caveat.code,
    message: caveat.message,
  };
}
