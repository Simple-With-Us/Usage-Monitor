import crypto from "crypto";
import {
  flattenAttributes,
  type FlatAttributes,
  type OtlpNumberDataPoint,
} from "./types";

export type OtlpAggregationTemporality =
  | "delta"
  | "cumulative"
  | "unspecified"
  | "gauge";

export interface OtlpPointDescriptor {
  metricName: string;
  temporality: OtlpAggregationTemporality;
  isMonotonic: boolean;
  seriesKey: string;
  rawValue: number;
  startTimeUnixNano?: string;
  timeUnixNano: string;
}

// Persist only dimensions that are useful for attribution/debugging and are
// known not to contain arbitrary payloads. In particular, user.email,
// session.id, prompt fragments, and future exporter attributes are excluded.
// All attributes still participate in the one-way series/idempotency hashes,
// which preserves counter correctness without retaining sensitive values.
const METADATA_ALLOWLIST = new Set([
  "service.name",
  "service.version",
  "deployment.environment",
  "project",
  "project.name",
  "host.name",
  "model",
  "type",
  "start_type",
  "state",
  "direction",
  "device",
  "mountpoint",
  "network.interface.name",
  "tool_name",
  "decision",
  "source",
]);

export function cleanOtlpMetadata(
  resourceAttrs: FlatAttributes,
  pointAttrs: FlatAttributes,
  extra: FlatAttributes = {}
): Record<string, string | number | boolean> {
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of [
    ...Object.entries(resourceAttrs),
    ...Object.entries(pointAttrs),
  ]) {
    if (!METADATA_ALLOWLIST.has(key) || value === undefined) continue;
    clean[key] = value;
  }
  // Mapper-generated fields are a closed set at the call site, not producer
  // supplied, so they can be retained without widening the external allowlist.
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

function sortedEntries(record: FlatAttributes) {
  return Object.keys(record)
    .sort()
    .map((key) => [key, record[key]] as const);
}

function canonicalNano(value: string | number | undefined, fallbackMs: number): string {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return String(BigInt(Math.max(0, Math.trunc(fallbackMs))) * BigInt(1_000_000));
}

export function normalizeTemporality(
  value: number | string | undefined,
  isGauge = false
): OtlpAggregationTemporality {
  if (isGauge) return "gauge";
  if (value === 1 || value === "AGGREGATION_TEMPORALITY_DELTA" || value === "DELTA") {
    return "delta";
  }
  if (
    value === 2 ||
    value === "AGGREGATION_TEMPORALITY_CUMULATIVE" ||
    value === "CUMULATIVE"
  ) {
    return "cumulative";
  }
  return "unspecified";
}

export function describeOtlpPoint(input: {
  metricName: string;
  resourceAttrs: FlatAttributes;
  point: OtlpNumberDataPoint;
  value: number;
  temporality: OtlpAggregationTemporality;
  isMonotonic?: boolean;
  occurredAt: Date;
}): OtlpPointDescriptor {
  const pointAttrs = flattenAttributes(input.point.attributes);
  // OTLP point attributes override same-named resource attributes. Hash the
  // merged set so the historical repair script can reconstruct the series
  // identity from the metadata shape written by the previous receiver.
  const seriesBasis = {
    metric: input.metricName,
    attributes: sortedEntries({ ...input.resourceAttrs, ...pointAttrs }),
  };
  return {
    metricName: input.metricName,
    temporality: input.temporality,
    isMonotonic: input.isMonotonic !== false,
    seriesKey: crypto
      .createHash("sha256")
      .update(JSON.stringify(seriesBasis))
      .digest("hex"),
    rawValue: input.value,
    startTimeUnixNano:
      input.point.startTimeUnixNano == null
        ? undefined
        : canonicalNano(input.point.startTimeUnixNano, input.occurredAt.getTime()),
    timeUnixNano: canonicalNano(input.point.timeUnixNano, input.occurredAt.getTime()),
  };
}
