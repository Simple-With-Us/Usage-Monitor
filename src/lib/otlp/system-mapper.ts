import crypto from "crypto";
import {
  dataPointValue,
  flattenAttributes,
  nanosToDate,
  type OtlpExportMetricsServiceRequest,
  type OtlpNumberDataPoint,
} from "./types";
import type { MappedUsageEvent, UnknownMetricSummary, MapMetricsResult } from "./claude-code-mapper";
import {
  cleanOtlpMetadata,
  describeOtlpPoint,
  normalizeTemporality,
  type OtlpAggregationTemporality,
} from "./mapping-utils";

const KNOWN_METRICS = new Set([
  "system.cpu.utilization",
  "system.memory.usage",
  "system.disk.io",
  "system.network.io",
  "system.filesystem.usage",
]);

export const SOURCE_APP = "system-metrics";
export const PROVIDER = "hetzner"; // By default, we'll map system metrics to hetzner
export const SERVICE = "system";

function sortedEntries(
  record: Record<string, string | number | boolean | undefined>
): [string, string | number | boolean | undefined][] {
  return Object.keys(record)
    .sort()
    .map((key) => [key, record[key]] as [string, string | number | boolean | undefined]);
}

function deriveIdempotencyKey(
  metricName: string,
  resourceAttrs: Record<string, string | number | boolean | undefined>,
  point: OtlpNumberDataPoint,
  value: number
): string {
  const pointAttrs = flattenAttributes(point.attributes);
  const basis = {
    metric: metricName,
    resource: sortedEntries(resourceAttrs),
    point: sortedEntries(pointAttrs),
    start: String(point.startTimeUnixNano ?? ""),
    end: String(point.timeUnixNano ?? ""),
    value,
  };
  return crypto.createHash("sha256").update(JSON.stringify(basis)).digest("hex");
}

function asString(value: string | number | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function mapDataPoint(
  metricName: string,
  unit: string | undefined,
  resourceAttrs: Record<string, string | number | boolean | undefined>,
  point: OtlpNumberDataPoint,
  temporality: OtlpAggregationTemporality = "unspecified",
  isMonotonic = true
): MappedUsageEvent | undefined {
  const value = dataPointValue(point);
  if (value == null || !Number.isFinite(value)) return undefined;

  const pointAttrs = flattenAttributes(point.attributes);
  const occurredAt = nanosToDate(point.timeUnixNano) ?? nanosToDate(point.startTimeUnixNano) ?? new Date();
  const environment = asString(resourceAttrs["deployment.environment"]) ?? asString(pointAttrs["deployment.environment"]);
  
  // Try to use host.name as the keyRef (identifies which server this came from)
  const hostname = asString(resourceAttrs["host.name"]) ?? "unknown-host";

  const base = {
    sourceApp: SOURCE_APP,
    provider: PROVIDER,
    service: SERVICE,
    environment,
    billingMode: "actual" as const,
    occurredAt,
    otlp: describeOtlpPoint({
      metricName,
      resourceAttrs,
      point,
      value,
      temporality,
      isMonotonic,
      occurredAt,
    }),
  };

  switch (metricName) {
    case "system.cpu.utilization": {
      const state = asString(pointAttrs.state) ?? "unknown";
      return {
        ...base,
        metricType: "health",
        quantity: value,
        keyRef: hostname,
        label: `cpu:${state}`,
        metadata: cleanOtlpMetadata(resourceAttrs, pointAttrs, { state }),
        idempotencyKey: deriveIdempotencyKey(metricName, resourceAttrs, point, value),
      };
    }
    case "system.memory.usage": {
      const state = asString(pointAttrs.state) ?? "unknown";
      return {
        ...base,
        metricType: "health",
        quantity: value,
        unit: "byte",
        keyRef: hostname,
        label: `memory:${state}`,
        metadata: cleanOtlpMetadata(resourceAttrs, pointAttrs, { state }),
        idempotencyKey: deriveIdempotencyKey(metricName, resourceAttrs, point, value),
      };
    }
    case "system.disk.io": {
      const direction = asString(pointAttrs.direction) ?? "unknown";
      return {
        ...base,
        metricType: "health",
        quantity: value,
        unit: "byte",
        keyRef: hostname,
        label: `disk_io:${direction}`,
        metadata: cleanOtlpMetadata(resourceAttrs, pointAttrs, { direction }),
        idempotencyKey: deriveIdempotencyKey(metricName, resourceAttrs, point, value),
      };
    }
    case "system.network.io": {
      const direction = asString(pointAttrs.direction) ?? "unknown";
      return {
        ...base,
        metricType: "health",
        quantity: value,
        unit: "byte",
        keyRef: hostname,
        label: `network_io:${direction}`,
        metadata: cleanOtlpMetadata(resourceAttrs, pointAttrs, { direction }),
        idempotencyKey: deriveIdempotencyKey(metricName, resourceAttrs, point, value),
      };
    }
    case "system.filesystem.usage": {
      const state = asString(pointAttrs.state) ?? "unknown";
      return {
        ...base,
        metricType: "health",
        quantity: value,
        unit: "byte",
        keyRef: hostname,
        label: `filesystem:${state}`,
        metadata: cleanOtlpMetadata(resourceAttrs, pointAttrs, { state }),
        idempotencyKey: deriveIdempotencyKey(metricName, resourceAttrs, point, value),
      };
    }
    default:
      return undefined;
  }
}

export function mapSystemMetrics(request: OtlpExportMetricsServiceRequest): MapMetricsResult {
  const events: MappedUsageEvent[] = [];
  const unknownCounts = new Map<string, number>();

  for (const resourceMetrics of request.resourceMetrics ?? []) {
    const resourceAttrs = flattenAttributes(resourceMetrics.resource?.attributes);
    for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
      for (const metric of scopeMetrics.metrics ?? []) {
        const isGauge = !metric.sum && !!metric.gauge;
        const dataPoints = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
        if (!KNOWN_METRICS.has(metric.name)) {
          unknownCounts.set(metric.name, (unknownCounts.get(metric.name) ?? 0) + dataPoints.length);
          continue;
        }
        for (const point of dataPoints) {
          const mapped = mapDataPoint(
            metric.name,
            metric.unit,
            resourceAttrs,
            point,
            normalizeTemporality(metric.sum?.aggregationTemporality, isGauge),
            metric.sum?.isMonotonic
          );
          if (mapped) events.push(mapped);
        }
      }
    }
  }

  const unknownMetrics: UnknownMetricSummary[] = Array.from(unknownCounts.entries()).map(
    ([name, dataPointCount]) => ({ name, dataPointCount })
  );

  return { events, unknownMetrics };
}
