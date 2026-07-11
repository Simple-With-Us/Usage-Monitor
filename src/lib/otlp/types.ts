// Minimal OTLP (OpenTelemetry Protocol) type definitions for the subset of
// the metrics data model this app needs to read. These mirror the JSON
// projection of the official protobuf schema published at
// https://github.com/open-telemetry/opentelemetry-proto (proto3 JSON mapping:
// int64 fields serialize as JSON strings, oneof `value` fields become
// `asDouble` / `asInt` / etc, enums serialize as either their name or their
// numeric value). We intentionally model only the fields Claude Code's
// exporter actually emits (Sum-typed metrics with attributes) rather than
// the full spec (Gauge, Histogram, ExponentialHistogram, Summary), since
// unrecognized metric shapes are handled by the "unknown metric" tolerance
// path in claude-code-mapper.ts, not by exhaustively typing every OTLP metric
// kind.

export interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: OtlpKeyValue[] };
  bytesValue?: string;
}

export interface OtlpKeyValue {
  key: string;
  value?: OtlpAnyValue;
}

export interface OtlpNumberDataPoint {
  attributes?: OtlpKeyValue[];
  startTimeUnixNano?: string | number;
  timeUnixNano?: string | number;
  asDouble?: number;
  asInt?: string | number;
}

export interface OtlpSum {
  dataPoints?: OtlpNumberDataPoint[];
  // Protobuf decoding yields the numeric enum; canonical OTLP JSON may use
  // either the enum name or number.
  aggregationTemporality?: number | string;
  isMonotonic?: boolean;
}

export interface OtlpGauge {
  dataPoints?: OtlpNumberDataPoint[];
}

export interface OtlpMetric {
  name: string;
  description?: string;
  unit?: string;
  sum?: OtlpSum;
  gauge?: OtlpGauge;
  // histogram / exponentialHistogram / summary deliberately omitted — Claude
  // Code only emits Sum (counters) today. If present, these fall through to
  // the "unknown shape" tolerance path (no dataPoints extracted, so the
  // metric is counted+logged-once and skipped, never a 500).
}

export interface OtlpScopeMetrics {
  scope?: { name?: string; version?: string };
  metrics?: OtlpMetric[];
}

export interface OtlpResourceMetrics {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeMetrics?: OtlpScopeMetrics[];
}

export interface OtlpExportMetricsServiceRequest {
  resourceMetrics?: OtlpResourceMetrics[];
}

// --- Logs (accept-and-drop / minimal-store stub; see logs route) ---------

export interface OtlpLogRecord {
  timeUnixNano?: string | number;
  observedTimeUnixNano?: string | number;
  severityNumber?: number;
  severityText?: string;
  body?: OtlpAnyValue;
  attributes?: OtlpKeyValue[];
}

export interface OtlpScopeLogs {
  scope?: { name?: string; version?: string };
  logRecords?: OtlpLogRecord[];
}

export interface OtlpResourceLogs {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeLogs?: OtlpScopeLogs[];
}

export interface OtlpExportLogsServiceRequest {
  resourceLogs?: OtlpResourceLogs[];
}

/** Flattened attribute map: key -> plain JS scalar (or undefined if unsupported type). */
export type FlatAttributes = Record<string, string | number | boolean | undefined>;

export function anyValueToScalar(value: OtlpAnyValue | undefined): string | number | boolean | undefined {
  if (!value) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.intValue !== undefined) {
    return typeof value.intValue === "string" ? Number(value.intValue) : value.intValue;
  }
  // arrayValue / kvlistValue / bytesValue: not used by any Claude Code
  // attribute today; returning undefined is safe (attribute is just dropped).
  return undefined;
}

export function flattenAttributes(attributes: OtlpKeyValue[] | undefined): FlatAttributes {
  const flat: FlatAttributes = {};
  for (const kv of attributes ?? []) {
    if (!kv.key) continue;
    flat[kv.key] = anyValueToScalar(kv.value);
  }
  return flat;
}

/** OTLP timestamps are fixed64 nanoseconds since epoch, serialized as decimal strings in JSON. */
export function nanosToDate(value: string | number | undefined): Date | undefined {
  if (value == null) return undefined;
  const nanos = typeof value === "string" ? BigInt(value) : BigInt(Math.round(value));
  if (nanos <= BigInt(0)) return undefined;
  const millis = Number(nanos / BigInt(1_000_000));
  if (!Number.isFinite(millis) || millis <= 0) return undefined;
  return new Date(millis);
}

/** Reads a Sum or Gauge data point's numeric value regardless of which oneof field was set. */
export function dataPointValue(point: OtlpNumberDataPoint): number | undefined {
  if (point.asDouble !== undefined) return point.asDouble;
  if (point.asInt !== undefined) {
    return typeof point.asInt === "string" ? Number(point.asInt) : point.asInt;
  }
  return undefined;
}
