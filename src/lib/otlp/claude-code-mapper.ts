import crypto from "crypto";
import {
  dataPointValue,
  flattenAttributes,
  nanosToDate,
  type OtlpExportMetricsServiceRequest,
  type OtlpKeyValue,
  type OtlpNumberDataPoint,
} from "./types";
import {
  cleanOtlpMetadata,
  describeOtlpPoint,
  normalizeTemporality,
  type OtlpAggregationTemporality,
  type OtlpPointDescriptor,
} from "./mapping-utils";

// ---------------------------------------------------------------------------
// Claude Code -> ExternalUsageEvent metric mapping table
// ---------------------------------------------------------------------------
// Source: https://code.claude.com/docs/en/monitoring-usage ("OpenTelemetry
// Metrics and Logs Export"), current as of 2026-07-04. Claude Code's OTel
// meter name is `com.anthropic.claude_code`; every metric below is a Sum
// (monotonic counter). Attributes listed are the ones this mapper actually
// reads. Claude Code emits several more (session.id, user.email,
// organization.id, terminal.type, query_source, speed, effort, agent.name,
// skill.name, plugin.name, mcp_server.name, mcp_tool.name, ...). Those values
// participate in one-way series/idempotency hashes but are not persisted;
// metadata storage uses the explicit allowlist in mapping-utils.ts.
//
//   OTLP metric name                      | unit   | -> ExternalUsageEvent fields
//   ---------------------------------------+--------+---------------------------------
//   claude_code.token.usage                | tokens | metricType="usage", quantity=value,
//                                           |        | unit="token"; `type` attribute
//                                           |        | (input/output/cacheRead/cacheCreation)
//                                           |        | -> metadata.tokenType AND selects
//                                           |        | which of requests/credits-style
//                                           |        | sub-bucket via label suffix so the
//                                           |        | four token types don't collide on
//                                           |        | one idempotency key (see keyRef below)
//   claude_code.cost.usage                  | USD    | metricType="cost", costUsd=value
//   claude_code.session.count               | count  | metricType="usage", unit="request",
//                                           |        | requests=value (session starts)
//   claude_code.lines_of_code.count          | count  | metricType="usage", unit="row",
//                                           |        | quantity=value; `type` (added/removed)
//                                           |        | -> metadata.locType
//   claude_code.commit.count                | count  | metricType="usage", unit="job",
//                                           |        | quantity=value
//   claude_code.pull_request.count           | count  | metricType="usage", unit="job",
//                                           |        | quantity=value
//   claude_code.active_time.total            | s      | metricType="usage", unit="request"
//                                           |        | is a poor fit for seconds, so this
//                                           |        | is stored as quantity with unit
//                                           |        | left unset (no "second" unit in the
//                                           |        | ingest enum) — see UNIT below
//   claude_code.code_edit_tool.decision       | count  | metricType="usage", quantity=value;
//                                           |        | tool_name/decision/source -> metadata
//   (anything else, e.g. future metrics)     |  -     | accepted, counted, logged once,
//                                           |        | never mapped or 500'd — see
//                                           |        | mapUnknownMetric handling in route.
//
// provider/service dimension: every row is provider="anthropic",
// service="claude-code" (per the owner's goal split: usage metrics land here
// under the anthropic provider so existing budgets/alerts apply; Sentry
// keeps errors/health). sourceApp is always "claude-code" so these rows are
// distinguishable from any other Anthropic usage pushed via the generic
// POST /api/ingest/usage contract (e.g. a hand-rolled app-level Anthropic
// SDK cost push would use a different sourceApp).
// ---------------------------------------------------------------------------

const KNOWN_METRICS = new Set([
  "claude_code.token.usage",
  "claude_code.cost.usage",
  "claude_code.session.count",
  "claude_code.lines_of_code.count",
  "claude_code.commit.count",
  "claude_code.pull_request.count",
  "claude_code.active_time.total",
  "claude_code.code_edit_tool.decision",
]);

export const SOURCE_APP = "claude-code";
export const PROVIDER = "anthropic";
export const SERVICE = "claude-code";

export interface MappedUsageEvent {
  sourceApp: string;
  provider: string;
  service: string;
  environment?: string;
  // Producer-supplied project name from the `project` (or `project.name`)
  // OTLP resource attribute, set via OTEL_RESOURCE_ATTRIBUTES on the Claude
  // Code side (e.g. `OTEL_RESOURCE_ATTRIBUTES=project=socratic-trade`, ideally
  // per-repo via direnv). Resolved to a Project.id at the ingest route. Claude
  // Code emits one resource-attribute set per process, so this is constant for
  // a whole session — per-repo attribution comes from setting it per project
  // directory, not from Claude Code varying it mid-session.
  projectName?: string;
  keyRef?: string;
  label?: string;
  billingMode: "actual" | "estimated" | "manual";
  metricType: "usage" | "cost" | "quota" | "tier" | "health";
  quantity?: number;
  unit?: "request" | "call" | "token" | "credit" | "usd" | "page" | "job" | "document" | "row" | "byte";
  costUsd?: number;
  requests?: number;
  occurredAt: Date;
  metadata: Record<string, string | number | boolean>;
  idempotencyKey: string;
  otlp: OtlpPointDescriptor;
}

export interface UnknownMetricSummary {
  name: string;
  dataPointCount: number;
}

export interface MapMetricsResult {
  events: MappedUsageEvent[];
  unknownMetrics: UnknownMetricSummary[];
}

// Idempotency: hash the metric name + every attribute (resource + point,
// sorted by key so field order never matters) + the point's start/end time
// window + the numeric value. OTLP exporters (including Claude Code's SDK
// exporter) retry whole batches on transient network failure, so the same
// data point can arrive byte-identical more than once — the hash must
// collapse those retries to one row without depending on any exporter-side
// request id (OTLP has none at the HTTP-request level). Distinct data points
// (different attributes, different time window, or different value) always
// hash differently, so this never conflates two real observations.
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

function sortedEntries(
  record: Record<string, string | number | boolean | undefined>
): [string, string | number | boolean | undefined][] {
  return Object.keys(record)
    .sort()
    .map((key) => [key, record[key]] as [string, string | number | boolean | undefined]);
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
  const model = asString(pointAttrs.model);
  const environment = asString(resourceAttrs["deployment.environment"]) ?? asString(pointAttrs["deployment.environment"]);
  // `project` is the canonical key; accept `project.name` too since operators
  // may follow OTel's dotted-namespace convention. A point-level attribute
  // wins over the resource-level one if both are somehow present.
  const projectName =
    asString(pointAttrs.project) ??
    asString(pointAttrs["project.name"]) ??
    asString(resourceAttrs.project) ??
    asString(resourceAttrs["project.name"]);

  const base = {
    sourceApp: SOURCE_APP,
    provider: PROVIDER,
    service: SERVICE,
    environment,
    projectName,
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
    case "claude_code.token.usage": {
      const tokenType = asString(pointAttrs.type) ?? "unknown";
      return {
        ...base,
        metricType: "usage",
        quantity: value,
        unit: "token",
        keyRef: model,
        label: `token:${tokenType}`,
        metadata: cleanOtlpMetadata(resourceAttrs, pointAttrs, { tokenType }),
        idempotencyKey: deriveIdempotencyKey(metricName, resourceAttrs, point, value),
      };
    }
    case "claude_code.cost.usage": {
      return {
        ...base,
        metricType: "cost",
        costUsd: value,
        keyRef: model,
        label: "cost",
        metadata: cleanOtlpMetadata(resourceAttrs, pointAttrs),
        idempotencyKey: deriveIdempotencyKey(metricName, resourceAttrs, point, value),
      };
    }
    case "claude_code.session.count": {
      return {
        ...base,
        metricType: "usage",
        unit: "request",
        requests: value,
        label: "session",
        metadata: cleanOtlpMetadata(resourceAttrs, pointAttrs),
        idempotencyKey: deriveIdempotencyKey(metricName, resourceAttrs, point, value),
      };
    }
    case "claude_code.lines_of_code.count": {
      const locType = asString(pointAttrs.type) ?? "unknown";
      return {
        ...base,
        metricType: "usage",
        unit: "row",
        quantity: value,
        label: `lines_of_code:${locType}`,
        metadata: cleanOtlpMetadata(resourceAttrs, pointAttrs, { locType }),
        idempotencyKey: deriveIdempotencyKey(metricName, resourceAttrs, point, value),
      };
    }
    case "claude_code.commit.count": {
      return {
        ...base,
        metricType: "usage",
        unit: "job",
        quantity: value,
        label: "commit",
        metadata: cleanOtlpMetadata(resourceAttrs, pointAttrs),
        idempotencyKey: deriveIdempotencyKey(metricName, resourceAttrs, point, value),
      };
    }
    case "claude_code.pull_request.count": {
      return {
        ...base,
        metricType: "usage",
        unit: "job",
        quantity: value,
        label: "pull_request",
        metadata: cleanOtlpMetadata(resourceAttrs, pointAttrs),
        idempotencyKey: deriveIdempotencyKey(metricName, resourceAttrs, point, value),
      };
    }
    case "claude_code.active_time.total": {
      const activeType = asString(pointAttrs.type) ?? "unknown";
      return {
        ...base,
        metricType: "usage",
        // No "second" unit exists in the ingest enum (request/call/token/
        // credit/usd/page/job/document/row/byte) — leave unit unset rather
        // than mis-labeling seconds as one of those. Value is still stored
        // as quantity so it's not lost.
        quantity: value,
        label: `active_time:${activeType}`,
        metadata: cleanOtlpMetadata(resourceAttrs, pointAttrs, { activeType, unit: unit ?? "s" }),
        idempotencyKey: deriveIdempotencyKey(metricName, resourceAttrs, point, value),
      };
    }
    case "claude_code.code_edit_tool.decision": {
      const toolName = asString(pointAttrs.tool_name) ?? "unknown";
      const decision = asString(pointAttrs.decision) ?? "unknown";
      return {
        ...base,
        metricType: "usage",
        quantity: value,
        label: `code_edit_tool.decision:${toolName}:${decision}`,
        metadata: cleanOtlpMetadata(resourceAttrs, pointAttrs, { toolName, decision }),
        idempotencyKey: deriveIdempotencyKey(metricName, resourceAttrs, point, value),
      };
    }
    default:
      return undefined;
  }
}

/**
 * Maps a parsed OTLP ExportMetricsServiceRequest into ExternalUsageEvent-shaped
 * rows. Unknown metric names (anything not in KNOWN_METRICS) are tallied into
 * `unknownMetrics` and otherwise ignored — this function never throws on an
 * unrecognized metric so a Claude Code release that adds a new metric can
 * never turn into a 500 for the ingest route.
 */
export function mapClaudeCodeMetrics(request: OtlpExportMetricsServiceRequest): MapMetricsResult {
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

function pickKeyValue(attrs: OtlpKeyValue[] | undefined, key: string): string | undefined {
  return asString(flattenAttributes(attrs)[key]);
}

// Exported for tests that want to assert on raw attribute extraction without
// going through the full mapping pipeline.
export const _internal = { pickKeyValue, mapDataPoint, deriveIdempotencyKey };
