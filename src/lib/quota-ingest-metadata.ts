import {
  normalizeQuotaWindowKey,
  rollupQuotaWindowKey,
} from "@/lib/quota-window-display";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function parseIso(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function resolveQuotaReportedAtIso(input: {
  metadata?: Record<string, unknown> | null;
  occurredAt: Date;
  ingestTime?: Date;
}): string {
  const meta = asRecord(input.metadata);
  const fromMeta = parseIso(asString(meta.reportedAt));
  if (fromMeta) return fromMeta;
  if (!Number.isNaN(input.occurredAt.getTime())) return input.occurredAt.toISOString();
  return (input.ingestTime ?? new Date()).toISOString();
}

export function resolveQuotaWindowKeyFromMetadata(
  metadata: Record<string, unknown>,
  label: string | null | undefined,
): string {
  const stamped = asString(metadata.windowKey);
  if (stamped) return rollupQuotaWindowKey(stamped);
  const { windowKey } = normalizeQuotaWindowKey({
    quotaWindow: asString(metadata.quotaWindow),
    bucketId: asString(metadata.bucketId),
    label,
    modelId: asString(metadata.modelId),
  });
  return rollupQuotaWindowKey(windowKey);
}

/**
 * Ensure quota ingest rows carry `reportedAt`, `windowKey`, and `machine` in
 * metadata so `/api/quota-windows` can judge freshness and merge by key.
 */
export function enrichQuotaIngestMetadata(
  event: {
    metricType: string;
    occurredAt: Date;
    metadata?: Record<string, string | number | boolean | null> | undefined;
    label?: string | null;
  },
  options: { producerInstanceId?: string | null; ingestTime?: Date } = {},
): Record<string, string | number | boolean | null> | undefined {
  if (event.metricType !== "quota") return event.metadata;

  const ingestTime = options.ingestTime ?? new Date();
  const base = asRecord(event.metadata);
  const reportedAt = resolveQuotaReportedAtIso({
    metadata: base,
    occurredAt: event.occurredAt,
    ingestTime,
  });
  const windowKey = resolveQuotaWindowKeyFromMetadata(base, event.label ?? null);
  const machine =
    asString(base.machine) ?? asString(options.producerInstanceId) ?? null;

  const enriched: Record<string, string | number | boolean | null> = {
    ...(event.metadata ?? {}),
    reportedAt,
    windowKey,
  };
  if (machine) enriched.machine = machine;
  return enriched;
}

/** Read path helper: freshness timestamp for a stored quota event. */
export function quotaEventReportedAtIso(
  occurredAt: Date | string,
  metadata: unknown,
): string {
  const meta = asRecord(metadata);
  const fromMeta = parseIso(asString(meta.reportedAt));
  if (fromMeta) return fromMeta;
  return toIso(occurredAt);
}
