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
// known not to contain arbitrary payloads. In particular, user.email, prompt
// fragments, and future exporter attributes are excluded. All attributes
// still participate in the one-way series/idempotency hashes, which
// preserves counter correctness without retaining sensitive values.
//
// session.id is an exception, added 2026-09-24 for the Sentry agent-telemetry
// plan's "cost per board item" view (GET /api/cost-by-session): THE BOARD
// records a Claude Code session id on a finding, and this app sums cost
// across those ids by matching this metadata key. It is an opaque per-process
// UUID Claude Code mints for itself, not PII, and carries no prompt/response
// content -- unlike user.email (still excluded), it is safe and useful to
// retain. See src/lib/cost-by-session.ts.
const METADATA_ALLOWLIST = new Set([
  "service.name",
  "service.version",
  "deployment.environment",
  "project",
  "project.name",
  // Claude Code repository identity (OTEL_METRICS_INCLUDE_REPOSITORY=1, v2.1.269+),
  // derived from the origin remote.  Public repo coordinates only: credentials,
  // query strings and fragments are stripped by Claude Code.  UM-1599.
  "vcs.repository.name",
  "vcs.repository.url.full",
  "vcs.owner.name",
  "vcs.provider.name",
  "session.id",
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
  // Generic gen_ai mapper (gen-ai-mapper.ts): OTel gen_ai semconv + relay
  // resource attrs. Same rule as above — attribution dimensions only, never
  // prompt/response/tool-argument content (those ride AgentTurn, not events).
  "agent.platform",
  "agent.launcher",
  "agent.launcher.session",
  "seat",
  "lane",
  "repo",
  "gen_ai.system",
  "gen_ai.agent.name",
  "gen_ai.request.model",
  "gen_ai.token.type",
  "gen_ai.operation.name",
  "gen_ai.conversation.id",
  "gen_ai.tool.name",
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
