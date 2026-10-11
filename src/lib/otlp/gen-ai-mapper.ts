import crypto from "crypto";
import {
  dataPointValue,
  flattenAttributes,
  nanosToDate,
  type OtlpExportMetricsServiceRequest,
  type OtlpNumberDataPoint,
} from "./types";
import {
  cleanOtlpMetadata,
  describeOtlpPoint,
  normalizeTemporality,
  type OtlpAggregationTemporality,
  type OtlpPointDescriptor,
} from "./mapping-utils";
import type {
  MappedUsageEvent,
  MapMetricsResult,
  UnknownMetricSummary,
} from "./claude-code-mapper";

// ---------------------------------------------------------------------------
// Generic OTel gen_ai -> ExternalUsageEvent metric mapping table
// ---------------------------------------------------------------------------
// Consumed by the fleet-telemetry-relay (see the telemetry audit §B.4): the
// relay normalizes every vendor's native OTel (Claude Code, Codex, Grok CLI,
// Cursor/agy/Copilot hook shim, BotFleet/Clutch) onto OTel gen_ai semconv
// and forwards token/cost/duration as OTLP metrics here. Supported names:
//
//   gen_ai.client.token.usage       | tokens | metricType="usage", unit="token",
//                                          | quantity=value; token-type attr
//                                          | (input/output, several key
//                                          | spellings) -> label
//                                          | "token:<type>" + metadata.tokenType
//   gen_ai.client.operation.duration | ms   | metricType="usage", quantity=value
//                                          | (unit unset: no ms unit in the
//                                          | ingest enum — same call as
//                                          | claude active_time); durationMs
//                                          | echoed in metadata
//   gen_ai.usage.cost                | USD    | metricType="cost",
//                                          | costUsd=value,
//                                          | billingMode="estimated"
//
// (anything else)                          |  -     | accepted, counted, logged
//                                          | once, never mapped or 500'd.
//
// Platform/provider/model come from attributes, never the metric name:
//   platform: `agent.platform` > `gen_ai.system`-derived > `gen_ai.agent.name`
//   provider: `gen_ai.system` mapped below, else the platform default
//   model:    `gen_ai.request.model`
// Every mapped row keeps sourceApp=<platform> so these rows stay
// distinguishable from the claude_code.* mapper (sourceApp="claude-code")
// and from v2 ingest producers. Unknown platforms are accepted under their
// normalized name rather than rejected.
//
// Double-counting guard (lives in the ROUTE, not here — this function is
// pure): platforms with an exact local JSONL collector (codex, grok,
// copilot, deepseek, antigravity) are skipped by default; see
// OVERLAP_SOURCE_APPS + shouldMapGenAiPlatform in this module and the
// OTLP_GEN_AI_* env knobs in .env.example.
// ---------------------------------------------------------------------------

export const GEN_AI_TOKEN_USAGE_METRIC = "gen_ai.client.token.usage";
export const GEN_AI_OPERATION_DURATION_METRIC = "gen_ai.client.operation.duration";
export const GEN_AI_COST_METRIC = "gen_ai.usage.cost";

const KNOWN_GEN_AI_METRICS = new Set([
  GEN_AI_TOKEN_USAGE_METRIC,
  GEN_AI_OPERATION_DURATION_METRIC,
  GEN_AI_COST_METRIC,
]);

/** Platforms whose tokens already arrive via an exact local JSONL collector.
 * OTLP gen_ai rows for these are skipped unless explicitly allowlisted, so
 * running both the collector and the relay cannot double count one turn. */
export const OVERLAP_SOURCE_APPS = new Set([
  "openai-codex",
  "codex-cli",
  "grok-build",
  "copilot-cli",
  "github-copilot",
  "deepseek-dsh",
  "deepseek-harness",
  "antigravity-cli",
  "antigravity-statusline",
]);

function readEnvList(name: string): string[] | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

/** Default-on master switch for the generic gen_ai mapper. */
export function isGenAiMetricsEnabled(): boolean {
  const raw = process.env.OTLP_GEN_AI_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  return !["false", "0", "off", "no"].includes(raw);
}

/** When true, overlap platforms are mapped too (operator accepts both feeds). */
export function isGenAiOverlapAllowed(): boolean {
  const raw = process.env.OTLP_GEN_AI_ALLOW_OVERLAP?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "on" || raw === "yes";
}

/**
 * Pure per-platform gate. Returns false when this platform's points must be
 * skipped (counted as ignoredOverlap by the route, never persisted).
 * Precedence: master switch off -> allowlist (when set) -> overlap block.
 */
export function shouldMapGenAiPlatform(sourceApp: string): boolean {
  if (!isGenAiMetricsEnabled()) return false;
  const normalized = sourceApp.trim().toLowerCase();
  const allowlist = readEnvList("OTLP_GEN_AI_PLATFORM_ALLOWLIST");
  if (allowlist && !allowlist.includes(normalized)) return false;
  if (OVERLAP_SOURCE_APPS.has(normalized) && !isGenAiOverlapAllowed()) return false;
  return true;
}

const SYSTEM_TO_PROVIDER: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google-antigravity",
  xai: "xai",
  deepseek: "deepseek",
  mistral: "mistral",
  moonshot: "moonshot",
  minimax: "minimax",
  github: "github-copilot",
  cursor: "cursor",
  meta: "muse-code",
};

const PLATFORM_DEFAULT_PROVIDER: Record<string, string> = {
  "claude-code": "anthropic",
  codex: "openai",
  "openai-codex": "openai",
  "codex-cli": "openai",
  cursor: "cursor",
  "cursor-agent": "cursor",
  antigravity: "google-antigravity",
  "antigravity-cli": "google-antigravity",
  "antigravity-statusline": "google-antigravity",
  copilot: "github-copilot",
  "copilot-cli": "github-copilot",
  "github-copilot": "github-copilot",
  grok: "xai",
  "grok-build": "xai",
  deepseek: "deepseek",
  "deepseek-dsh": "deepseek",
  "deepseek-harness": "deepseek",
  minimax: "minimax",
  "minimax-code": "minimax",
  kimi: "moonshot",
  "kimi-code": "moonshot",
  moonshot: "moonshot",
  botfleet: "openai",
  clutch: "deepseek",
  muse: "muse",
  "muse-code": "muse-code",
};

function normalizePlatform(raw: string | undefined): string {
  const v = (raw ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  return v || "unknown-agent";
}

export interface GenAiIdentity {
  sourceApp: string;
  provider: string;
  service: string;
  model?: string;
}

/** Resolve (sourceApp, provider, service, model) from merged OTLP attributes. */
export function resolveGenAiIdentity(
  attrs: Record<string, string | number | boolean | undefined>
): GenAiIdentity {
  const asString = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const platformRaw =
    asString(attrs["agent.platform"]) ??
    asString(attrs["gen_ai.agent.name"]) ??
    asString(attrs["gen_ai.system"]) ??
    asString(attrs["service.name"]);
  const sourceApp = normalizePlatform(platformRaw);
  const system = asString(attrs["gen_ai.system"])?.toLowerCase();
  const provider =
    (system ? SYSTEM_TO_PROVIDER[system] : undefined) ??
    PLATFORM_DEFAULT_PROVIDER[sourceApp] ??
    system ??
    sourceApp;
  const model = asString(attrs["gen_ai.request.model"]) ?? asString(attrs["model"]);
  return { sourceApp, provider, service: sourceApp, model };
}

function tokenTypeOf(attrs: Record<string, string | number | boolean | undefined>): string {
  for (const key of [
    "gen_ai.token.type",
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "token.type",
    "type",
  ]) {
    const v = attrs[key];
    if (typeof v === "string" && v.trim()) {
      const t = v.trim().toLowerCase();
      if (t === "input" || t === "input_tokens" || t === "prompt") return "input";
      if (t === "output" || t === "output_tokens" || t === "completion") return "output";
      return t;
    }
  }
  // Some exporters encode the split as presence of input/output count attrs.
  if (attrs["gen_ai.usage.input_tokens"] !== undefined) return "input";
  if (attrs["gen_ai.usage.output_tokens"] !== undefined) return "output";
  return "unknown";
}

function asStringValue(value: string | number | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function deriveIdempotencyKey(
  metricName: string,
  resourceAttrs: Record<string, string | number | boolean | undefined>,
  point: OtlpNumberDataPoint,
  value: number
): string {
  const sorted = (r: Record<string, string | number | boolean | undefined>) =>
    Object.keys(r)
      .sort()
      .map((k) => [k, r[k]] as [string, string | number | boolean | undefined]);
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        metric: metricName,
        resource: sorted(resourceAttrs),
        point: sorted(flattenAttributes(point.attributes)),
        start: String(point.startTimeUnixNano ?? ""),
        end: String(point.timeUnixNano ?? ""),
        value,
      })
    )
    .digest("hex");
}

function mapDataPoint(
  metricName: string,
  resourceAttrs: Record<string, string | number | boolean | undefined>,
  point: OtlpNumberDataPoint,
  temporality: OtlpAggregationTemporality = "unspecified",
  isMonotonic = true
): MappedUsageEvent | undefined {
  const value = dataPointValue(point);
  if (value == null || !Number.isFinite(value)) return undefined;

  const pointAttrs = flattenAttributes(point.attributes);
  const merged = { ...resourceAttrs, ...pointAttrs };
  const identity = resolveGenAiIdentity(merged);
  const occurredAt =
    nanosToDate(point.timeUnixNano) ?? nanosToDate(point.startTimeUnixNano) ?? new Date();
  const environment =
    asStringValue(resourceAttrs["deployment.environment"]) ??
    asStringValue(pointAttrs["deployment.environment"]);
  const projectName =
    asStringValue(pointAttrs.project) ??
    asStringValue(pointAttrs["project.name"]) ??
    asStringValue(resourceAttrs.project) ??
    asStringValue(resourceAttrs["project.name"]);

  const base = {
    sourceApp: identity.sourceApp,
    provider: identity.provider,
    service: identity.service,
    environment,
    projectName,
    billingMode: "estimated" as const,
    occurredAt,
    otlp: describeOtlpPoint({
      metricName,
      resourceAttrs,
      point,
      value,
      temporality,
      isMonotonic,
      occurredAt,
    }) as OtlpPointDescriptor,
  };

  switch (metricName) {
    case GEN_AI_TOKEN_USAGE_METRIC: {
      const tokenType = tokenTypeOf(merged);
      return {
        ...base,
        metricType: "usage",
        quantity: value,
        unit: "token",
        keyRef: identity.model,
        label: `token:${tokenType}`,
        metadata: cleanOtlpMetadata(resourceAttrs, pointAttrs, { tokenType }),
        idempotencyKey: deriveIdempotencyKey(metricName, resourceAttrs, point, value),
      };
    }
    case GEN_AI_COST_METRIC: {
      return {
        ...base,
        metricType: "cost",
        costUsd: value,
        keyRef: identity.model,
        label: "estimated_api_equivalent",
        metadata: cleanOtlpMetadata(resourceAttrs, pointAttrs, {
          costSemantics: "estimated_api_equivalent_not_authoritative",
        }),
        idempotencyKey: deriveIdempotencyKey(metricName, resourceAttrs, point, value),
      };
    }
    case GEN_AI_OPERATION_DURATION_METRIC: {
      return {
        ...base,
        metricType: "usage",
        quantity: value,
        keyRef: identity.model,
        label: "operation_duration_ms",
        metadata: cleanOtlpMetadata(resourceAttrs, pointAttrs, { durationMs: value }),
        idempotencyKey: deriveIdempotencyKey(metricName, resourceAttrs, point, value),
      };
    }
    default:
      return undefined;
  }
}

export interface MapGenAiMetricsResult extends MapMetricsResult {
  /** Points skipped by the per-platform dedup gate (overlap/allowlist). */
  ignoredOverlap: number;
}

/**
 * Maps a parsed OTLP ExportMetricsServiceRequest's gen_ai metrics into
 * ExternalUsageEvent-shaped rows. Unknown metric names are tallied (same
 * contract as the Claude mapper); overlap-gated platforms are counted in
 * `ignoredOverlap` and never mapped. Never throws on unrecognized input.
 */
export function mapGenAiMetrics(
  request: OtlpExportMetricsServiceRequest
): MapGenAiMetricsResult {
  const events: MappedUsageEvent[] = [];
  const unknownCounts = new Map<string, number>();
  let ignoredOverlap = 0;

  for (const resourceMetrics of request.resourceMetrics ?? []) {
    const resourceAttrs = flattenAttributes(resourceMetrics.resource?.attributes);
    for (const scopeMetrics of resourceMetrics.scopeMetrics ?? []) {
      for (const metric of scopeMetrics.metrics ?? []) {
        const isGauge = !metric.sum && !!metric.gauge;
        const dataPoints = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
        if (!KNOWN_GEN_AI_METRICS.has(metric.name)) {
          unknownCounts.set(metric.name, (unknownCounts.get(metric.name) ?? 0) + dataPoints.length);
          continue;
        }
        for (const point of dataPoints) {
          const mapped = mapDataPoint(
            metric.name,
            resourceAttrs,
            point,
            normalizeTemporality(metric.sum?.aggregationTemporality, isGauge),
            metric.sum?.isMonotonic
          );
          if (!mapped) continue;
          if (!shouldMapGenAiPlatform(mapped.sourceApp)) {
            ignoredOverlap += 1;
            continue;
          }
          events.push(mapped);
        }
      }
    }
  }

  const unknownMetrics: UnknownMetricSummary[] = Array.from(unknownCounts.entries()).map(
    ([name, dataPointCount]) => ({ name, dataPointCount })
  );
  return { events, unknownMetrics, ignoredOverlap };
}

export const _internal = { mapDataPoint, resolveGenAiIdentity, shouldMapGenAiPlatform };
