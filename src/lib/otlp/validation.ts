import type {
  OtlpAnyValue,
  OtlpExportMetricsServiceRequest,
  OtlpKeyValue,
  OtlpNumberDataPoint,
  OtlpResourceMetrics,
} from "./types";
import { dataPointValue } from "./types";
import { readBoundedRequestBody } from "@/lib/bounded-request-body";

export const MAX_OTLP_BODY_BYTES = 1_048_576;
const MAX_RESOURCE_METRICS = 64;
const MAX_SCOPE_METRICS = 256;
const MAX_METRICS = 1_000;
const MAX_DATA_POINTS = 10_000;
const MAX_ATTRIBUTES_PER_SET = 64;
const MAX_ATTRIBUTE_KEY_LENGTH = 128;
const MAX_ATTRIBUTE_STRING_LENGTH = 1_024;
const MAX_METRIC_NAME_LENGTH = 256;

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function validateAnyValue(value: OtlpAnyValue | undefined, path: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an OTLP AnyValue object`);
  }
  if (
    value.stringValue !== undefined &&
    (typeof value.stringValue !== "string" || value.stringValue.length > MAX_ATTRIBUTE_STRING_LENGTH)
  ) {
    throw new Error(`${path}.stringValue is too long or invalid`);
  }
  if (value.boolValue !== undefined && typeof value.boolValue !== "boolean") {
    throw new Error(`${path}.boolValue must be boolean`);
  }
  for (const [key, numeric] of [
    ["doubleValue", value.doubleValue],
    ["intValue", value.intValue],
  ] as const) {
    if (numeric === undefined) continue;
    const parsed = typeof numeric === "string" ? Number(numeric) : numeric;
    if (!Number.isFinite(parsed)) throw new Error(`${path}.${key} must be finite`);
  }
  // Nested arrays/maps and bytes are not consumed by this receiver. Rejecting
  // them avoids retaining or recursively traversing unbounded producer data.
  if (value.arrayValue || value.kvlistValue || value.bytesValue !== undefined) {
    throw new Error(`${path} contains an unsupported nested or bytes value`);
  }
}

function validateAttributes(value: unknown, path: string): void {
  if (value === undefined) return;
  const attributes = requireArray(value, path) as OtlpKeyValue[];
  if (attributes.length > MAX_ATTRIBUTES_PER_SET) {
    throw new Error(`${path} must contain ${MAX_ATTRIBUTES_PER_SET} or fewer attributes`);
  }
  for (let index = 0; index < attributes.length; index += 1) {
    const attribute = attributes[index];
    if (!attribute || typeof attribute !== "object" || Array.isArray(attribute)) {
      throw new Error(`${path}[${index}] must be an object`);
    }
    if (
      typeof attribute.key !== "string" ||
      attribute.key.length === 0 ||
      attribute.key.length > MAX_ATTRIBUTE_KEY_LENGTH
    ) {
      throw new Error(`${path}[${index}].key is invalid`);
    }
    validateAnyValue(attribute.value, `${path}[${index}].value`);
  }
}

function validateNano(value: unknown, path: string): void {
  if (value === undefined) return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${path} must be a safe integer`);
    return;
  }
  if (typeof value !== "string" || !/^\d{1,30}$/.test(value)) {
    throw new Error(`${path} must be a nanosecond integer string`);
  }
}

function validatePoint(point: OtlpNumberDataPoint, path: string): void {
  if (!point || typeof point !== "object" || Array.isArray(point)) {
    throw new Error(`${path} must be an object`);
  }
  validateAttributes(point.attributes, `${path}.attributes`);
  validateNano(point.startTimeUnixNano, `${path}.startTimeUnixNano`);
  validateNano(point.timeUnixNano, `${path}.timeUnixNano`);
  if (
    point.timeUnixNano === undefined ||
    BigInt(point.timeUnixNano) <= BigInt(0)
  ) {
    throw new Error(`${path}.timeUnixNano must be a positive nanosecond timestamp`);
  }
  if (point.asDouble !== undefined && !Number.isFinite(point.asDouble)) {
    throw new Error(`${path}.asDouble must be finite`);
  }
  if (point.asInt !== undefined) {
    const parsed = typeof point.asInt === "string" ? Number(point.asInt) : point.asInt;
    if (!Number.isSafeInteger(parsed)) throw new Error(`${path}.asInt must be a safe integer`);
  }
}

export function validateMetricsRequest(request: OtlpExportMetricsServiceRequest): void {
  const resourceMetrics = requireArray(request.resourceMetrics ?? [], "resourceMetrics");
  if (resourceMetrics.length > MAX_RESOURCE_METRICS) {
    throw new Error(`resourceMetrics must contain ${MAX_RESOURCE_METRICS} or fewer items`);
  }
  let scopeCount = 0;
  let metricCount = 0;
  let pointCount = 0;

  resourceMetrics.forEach((resourceMetric, resourceIndex) => {
    if (!resourceMetric || typeof resourceMetric !== "object" || Array.isArray(resourceMetric)) {
      throw new Error(`resourceMetrics[${resourceIndex}] must be an object`);
    }
    const resource = resourceMetric as OtlpResourceMetrics;
    validateAttributes(resource.resource?.attributes, `resourceMetrics[${resourceIndex}].resource.attributes`);
    const scopes = requireArray(
      resource.scopeMetrics ?? [],
      `resourceMetrics[${resourceIndex}].scopeMetrics`
    );
    scopeCount += scopes.length;
    if (scopeCount > MAX_SCOPE_METRICS) throw new Error("OTLP payload contains too many scopes");

    scopes.forEach((scope, scopeIndex) => {
      if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
        throw new Error(`scopeMetrics[${scopeIndex}] must be an object`);
      }
      const metrics = requireArray(
        (scope as { metrics?: unknown }).metrics ?? [],
        `resourceMetrics[${resourceIndex}].scopeMetrics[${scopeIndex}].metrics`
      );
      metricCount += metrics.length;
      if (metricCount > MAX_METRICS) throw new Error("OTLP payload contains too many metrics");

      metrics.forEach((metric, metricIndex) => {
        if (!metric || typeof metric !== "object" || Array.isArray(metric)) {
          throw new Error(`metrics[${metricIndex}] must be an object`);
        }
        const typedMetric = metric as {
          name?: unknown;
          sum?: { dataPoints?: unknown; aggregationTemporality?: unknown; isMonotonic?: unknown };
          gauge?: { dataPoints?: unknown };
        };
        if (
          typeof typedMetric.name !== "string" ||
          typedMetric.name.length === 0 ||
          typedMetric.name.length > MAX_METRIC_NAME_LENGTH
        ) {
          throw new Error(`metrics[${metricIndex}].name is invalid`);
        }
        if (typedMetric.sum?.isMonotonic !== undefined && typeof typedMetric.sum.isMonotonic !== "boolean") {
          throw new Error(`metrics[${metricIndex}].sum.isMonotonic must be boolean`);
        }
        const temporality = typedMetric.sum?.aggregationTemporality;
        const isKnownClaudeMetric = [
          "claude_code.token.usage",
          "claude_code.cost.usage",
          "claude_code.session.count",
          "claude_code.lines_of_code.count",
          "claude_code.commit.count",
          "claude_code.pull_request.count",
          "claude_code.active_time.total",
          "claude_code.code_edit_tool.decision",
        ].includes(typedMetric.name);
        if (isKnownClaudeMetric && !typedMetric.sum) {
          throw new Error(`metrics[${metricIndex}] must encode known Claude counters as Sum`);
        }
        if (isKnownClaudeMetric && typedMetric.sum?.isMonotonic === false) {
          throw new Error(`metrics[${metricIndex}].sum.isMonotonic must be true for known Claude counters`);
        }
        if (
          typedMetric.sum &&
          ![
            1,
            2,
            "AGGREGATION_TEMPORALITY_DELTA",
            "AGGREGATION_TEMPORALITY_CUMULATIVE",
            "DELTA",
            "CUMULATIVE",
          ].includes(temporality as never)
        ) {
          throw new Error(
            `metrics[${metricIndex}].sum.aggregationTemporality must be DELTA or CUMULATIVE`
          );
        }
        const rawPoints = typedMetric.sum?.dataPoints ?? typedMetric.gauge?.dataPoints ?? [];
        const points = requireArray(rawPoints, `metrics[${metricIndex}].dataPoints`);
        pointCount += points.length;
        if (pointCount > MAX_DATA_POINTS) throw new Error("OTLP payload contains too many data points");
        points.forEach((point, pointIndex) => {
          const typedPoint = point as OtlpNumberDataPoint;
          validatePoint(
            typedPoint,
            `metrics[${metricIndex}].dataPoints[${pointIndex}]`
          );
          const value = dataPointValue(typedPoint);
          if (
            typedMetric.sum &&
            (isKnownClaudeMetric || typedMetric.sum.isMonotonic !== false) &&
            value != null &&
            value < 0
          ) {
            throw new Error(
              `metrics[${metricIndex}].dataPoints[${pointIndex}] is negative for a monotonic sum`
            );
          }
        });
      });
    });
  });
}

export async function readBoundedBody(request: Request): Promise<Uint8Array> {
  // Delegates to the same streaming bounded reader used by
  // /api/ingest/usage, keeping one canonical implementation across ingest
  // routes. RequestBodyTooLargeError's message ("<label> exceeds <n>
  // bytes") preserves the "exceeds" substring both OTLP route handlers key
  // their 413 response off of, so callers are unaffected by this change.
  return readBoundedRequestBody(request, {
    maxBytes: MAX_OTLP_BODY_BYTES,
    label: "OTLP payload",
  });
}
