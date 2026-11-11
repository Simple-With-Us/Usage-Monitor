import crypto from "crypto";
import {
  anyValueToScalar,
  nanosToDate,
  type FlatAttributes,
  type OtlpAnyValue,
  type OtlpExportLogsServiceRequest,
  type OtlpKeyValue,
  type OtlpLogRecord,
} from "./types";

// ---------------------------------------------------------------------------
// Per-request AI telemetry mapping (UM-1590) -> AiRequest
// ---------------------------------------------------------------------------
// Sources (attribute names verified 2026-10-17):
//
// Claude Code, https://code.claude.com/docs/en/monitoring-usage
//   log event `claude_code.api_request` (attribute event.name = "api_request"):
//     model, cost_usd, cost_usd_micros, duration_ms, input_tokens (excludes
//     cache), output_tokens, cache_read_tokens, cache_creation_tokens (5m + 1h
//     together), request_id, client_request_id, speed, query_source, effort,
//     plus session.id, prompt.id, event.sequence, event.timestamp,
//     workspace.host_paths and any OTEL_RESOURCE_ATTRIBUTES keys.
//   trace span `claude_code.llm_request` (CLAUDE_CODE_ENHANCED_TELEMETRY_BETA):
//     the same token/model/request_id attributes plus ttft_ms, success,
//     status_code, error, gen_ai.request.model, gen_ai.response.id.
//
// Codex, openai/codex codex-rs/otel/src/events/session_telemetry.rs:
//   `codex.api_request` / `codex.websocket_request`: duration_ms (time to
//     response headers), http.response.status_code, error.message, attempt.
//     No token counts.
//   `codex.sse_event` with event.kind = "response.completed": input_token_count
//     (includes cached), output_token_count (includes reasoning),
//     cached_token_count, cache_write_token_count, reasoning_token_count,
//     ttft_ms.  No duration.
//   Every event carries event.timestamp, conversation.id, auth_mode, model.
//   The persistence layer stitches an api_request and its later completion
//   into one row (see src/lib/ai-requests.ts).
//
// Attribution (verified 2026-10-17 by capturing real exports with a local OTLP
// receiver, claude 2.x and codex-cli 0.163.0):
//   - Seat and project ride on OTEL_RESOURCE_ATTRIBUTES (`seat=...,project=...`),
//     which both harnesses copy into the OTLP resource.  Codex builds its
//     resource with the SDK's env detector, so the env var is honoured; there
//     is no equivalent key in ~/.codex/config.toml ([otel] only configures
//     exporters, environment and span_attributes for traces).  Codex events
//     carry no cwd or workspace attribute at all, so project cannot be derived
//     from them.
//   - Claude Code with OTEL_METRICS_INCLUDE_REPOSITORY=1 adds vcs.repository.name
//     (lowercased, from the origin remote) to metrics, events and spans.
//   - Codex rows with no seat resource attribute default to seat CODEX (the
//     platform default seat).  A `codex exec` launched by another seat is
//     attributed to CODEX unless that launcher exports OTEL_RESOURCE_ATTRIBUTES.
//
// Served vs requested model: neither harness exports a separate response-model
// attribute (Claude Code's llm_request span has gen_ai.request.model equal to
// `model` and only gen_ai.response.id; Codex events carry `model` and `slug`
// only).  Both are emitted after the response completed, so the reported model
// is the one that ran: servedModel falls back to it when no explicit
// gen_ai.response.model exists, and an explicit response model always wins.
// A Codex api_request/websocket_request is a pending row (no response yet), so
// it stores requestedModel only; the response.completed event fills servedModel.
//
// Never read: prompt, body, tool_input, response.model_output, user.email.
// Only the scalar attributes named here are retained.
// ---------------------------------------------------------------------------

export type AiRequestKind = "complete" | "codex-api" | "codex-completion";
/** `ingest`: a usage telemetry v2 event that carried the shared `ai` block (UM-1592). */
export type AiRequestSource = "logs" | "traces" | "ingest";

export interface AiRequestInput {
  dedupeKey: string;
  kind: AiRequestKind;
  source: AiRequestSource;
  harness: string;
  seat?: string;
  project?: string;
  billingMode?: string;
  sessionId?: string;
  requestedModel?: string;
  servedModel?: string;
  durationMs?: number;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  costSource?: string;
  speed?: string;
  effort?: string;
  querySource?: string;
  statusCode?: number;
  error?: string;
  occurredAt: Date;
}

export interface MapAiRequestsResult {
  requests: AiRequestInput[];
  /** Log records seen that are not per-request events (kept accept-and-drop). */
  ignored: number;
}

/** Codex's platform default seat, used when its OTLP resource names none. */
const CODEX_DEFAULT_SEAT = "CODEX";
const MAX_REQUESTS_PER_BATCH = 2_000;
const MAX_STRING = 200;
const ERROR_MAX = 500;

function str(value: unknown, max = MAX_STRING): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function int(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  const i = Math.round(n);
  return i >= 0 && i <= 2_147_483_647 ? i : undefined;
}

function num(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function hash(parts: unknown[]): string {
  return crypto
    .createHash("sha256")
    .update(parts.map((p) => (p == null ? "" : String(p))).join("\u0000"))
    .digest("hex")
    .slice(0, 40);
}

/** First string of an OTLP array attribute (workspace.host_paths is an array). */
function firstArrayString(value: OtlpAnyValue | undefined): string | undefined {
  if (!value) return undefined;
  if (typeof value.stringValue === "string") return value.stringValue;
  for (const item of value.arrayValue?.values ?? []) {
    if (typeof item.stringValue === "string" && item.stringValue.trim()) return item.stringValue;
  }
  return undefined;
}

function flatten(attributes: OtlpKeyValue[] | undefined, into: FlatAttributes, arrays: Record<string, string>) {
  for (const kv of attributes ?? []) {
    if (!kv?.key) continue;
    const scalar = anyValueToScalar(kv.value);
    if (scalar !== undefined) into[kv.key] = scalar;
    else if (kv.value?.arrayValue) {
      const first = firstArrayString(kv.value);
      if (first) arrays[kv.key] = first;
    }
  }
}

/**
 * Project from a workspace path: ~/apps/lanes/<Repo>/<lane> and ~/Code/<Repo>
 * give <Repo>; anything else gives the last path segment.  Only the derived
 * name is stored, never the path.
 */
export function projectFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split("/").filter(Boolean);
  const lanes = parts.indexOf("lanes");
  if (lanes >= 0 && parts[lanes + 1] && !parts[lanes + 1].startsWith("_")) return str(parts[lanes + 1]);
  const code = parts.indexOf("Code");
  if (code >= 0 && parts[code + 1]) return str(parts[code + 1]);
  return str(parts[parts.length - 1]);
}

/** subscription | payg | free, from an explicit attribute or Codex auth_mode. */
export function normalizeBillingMode(explicit: unknown, authMode?: unknown): string | undefined {
  const raw = str(explicit)?.toLowerCase().replace(/[\s_-]+/g, "");
  if (raw) {
    if (["subscription", "sub", "plan", "max", "pro"].includes(raw)) return "subscription";
    if (["payg", "api", "apikey", "paygo", "paid"].includes(raw)) return "payg";
    if (raw === "free") return "free";
  }
  const auth = str(authMode)?.toLowerCase().replace(/[\s_-]+/g, "");
  if (auth) {
    if (auth.includes("chatgpt")) return "subscription";
    if (auth.includes("apikey") || auth === "api") return "payg";
  }
  return undefined;
}

function seatOf(attrs: FlatAttributes): string | undefined {
  return str(attrs["seat"] ?? attrs["agent.seat"] ?? attrs["fleet.seat"], 40)?.toUpperCase();
}

function projectOf(attrs: FlatAttributes, arrays: Record<string, string>): string | undefined {
  return (
    str(attrs["project"]) ??
    str(attrs["project.name"]) ??
    // The workspace path keeps the repo's original casing; vcs.repository.name
    // (Claude Code lowercases it) is the fallback when no path is exported.
    projectFromPath(arrays["workspace.host_paths"] ?? str(attrs["workspace.host_paths"], 1000)) ??
    str(attrs["vcs.repository.name"])
  );
}

function billingOf(attrs: FlatAttributes): string | undefined {
  return normalizeBillingMode(attrs["billing.mode"] ?? attrs["billing_mode"], attrs["auth_mode"]);
}

function timestampOf(attrs: FlatAttributes, record: OtlpLogRecord): Date {
  const iso = str(attrs["event.timestamp"], 64);
  if (iso) {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  try {
    return nanosToDate(record.timeUnixNano) ?? nanosToDate(record.observedTimeUnixNano) ?? new Date();
  } catch {
    return new Date();
  }
}

function claudeDedupeKey(attrs: FlatAttributes, fallback: unknown[]): string {
  const requestId = str(attrs["request_id"], 120);
  if (requestId) return `claude-code|req|${requestId}`;
  const clientRequestId = str(attrs["client_request_id"], 120);
  if (clientRequestId) return `claude-code|creq|${clientRequestId}`;
  return `claude-code|h|${hash(fallback)}`;
}

/** Shared Claude Code mapping for the api_request log event and llm_request span. */
function claudeRequest(
  attrs: FlatAttributes,
  arrays: Record<string, string>,
  source: AiRequestSource,
  occurredAt: Date,
  fallbackKey: unknown[]
): AiRequestInput {
  const costUsd =
    num(attrs["cost_usd"]) ??
    (num(attrs["cost_usd_micros"]) != null ? num(attrs["cost_usd_micros"])! / 1_000_000 : undefined);
  const success = attrs["success"];
  const statusCode = int(attrs["status_code"] ?? attrs["http.response.status_code"]);
  const failed = success === false || success === "false" || (statusCode != null && statusCode >= 400);
  return {
    dedupeKey: claudeDedupeKey(attrs, fallbackKey),
    kind: "complete",
    source,
    harness: "claude-code",
    seat: seatOf(attrs),
    project: projectOf(attrs, arrays),
    billingMode: billingOf(attrs),
    sessionId: str(attrs["session.id"], 120),
    requestedModel: str(attrs["gen_ai.request.model"]) ?? str(attrs["model"]),
    servedModel: str(attrs["gen_ai.response.model"]) ?? str(attrs["gen_ai.request.model"]) ?? str(attrs["model"]),
    durationMs: int(attrs["duration_ms"]),
    ttftMs: int(attrs["ttft_ms"]),
    inputTokens: int(attrs["input_tokens"]),
    outputTokens: int(attrs["output_tokens"]),
    cacheReadTokens: int(attrs["cache_read_tokens"]),
    cacheWriteTokens: int(attrs["cache_creation_tokens"]),
    // Not emitted by Claude Code today (it reports 5m + 1h together); read
    // if a future version or a relay splits them.
    cacheWrite5mTokens: int(attrs["cache_creation_5m_tokens"] ?? attrs["cache_creation.ephemeral_5m_input_tokens"]),
    cacheWrite1hTokens: int(attrs["cache_creation_1h_tokens"] ?? attrs["cache_creation.ephemeral_1h_input_tokens"]),
    reasoningTokens: int(attrs["reasoning_tokens"]),
    costUsd,
    costSource: costUsd != null ? "estimated" : undefined,
    speed: str(attrs["speed"], 20),
    effort: str(attrs["effort"], 20),
    querySource: str(attrs["query_source"], 60),
    statusCode,
    error: failed ? str(attrs["error"], ERROR_MAX) ?? "request_failed" : undefined,
    occurredAt,
  };
}

function codexBase(attrs: FlatAttributes, arrays: Record<string, string>) {
  return {
    source: "logs" as const,
    harness: "codex",
    seat: seatOf(attrs) ?? CODEX_DEFAULT_SEAT,
    project: projectOf(attrs, arrays),
    billingMode: billingOf(attrs),
    sessionId: str(attrs["conversation.id"], 120),
    requestedModel: str(attrs["model"]),
  };
}

function codexApiRequest(
  attrs: FlatAttributes,
  arrays: Record<string, string>,
  occurredAt: Date
): AiRequestInput {
  const statusCode = int(attrs["http.response.status_code"]);
  const errorMessage = str(attrs["error.message"], ERROR_MAX);
  const failed =
    !!errorMessage ||
    (statusCode != null && (statusCode < 200 || statusCode > 299)) ||
    attrs["success"] === "false" ||
    attrs["success"] === false;
  return {
    ...codexBase(attrs, arrays),
    dedupeKey: `codex|api|${hash([
      attrs["conversation.id"],
      attrs["event.timestamp"],
      attrs["attempt"],
      attrs["duration_ms"],
      attrs["event.name"],
    ])}`,
    kind: "codex-api",
    durationMs: int(attrs["duration_ms"]),
    statusCode,
    error: failed ? errorMessage ?? `http_${statusCode ?? "error"}` : undefined,
    occurredAt,
  };
}

function codexCompletion(
  attrs: FlatAttributes,
  arrays: Record<string, string>,
  occurredAt: Date
): AiRequestInput {
  const input = int(attrs["input_token_count"]);
  const cacheRead = int(attrs["cached_token_count"]);
  const cacheWrite = int(attrs["cache_write_token_count"]);
  const uncached =
    input != null ? Math.max(0, input - (cacheRead ?? 0) - (cacheWrite ?? 0)) : undefined;
  return {
    ...codexBase(attrs, arrays),
    dedupeKey: `codex|done|${hash([attrs["conversation.id"], attrs["event.timestamp"], input, attrs["output_token_count"]])}`,
    kind: "codex-completion",
    servedModel: str(attrs["model"]),
    ttftMs: int(attrs["ttft_ms"]),
    inputTokens: uncached,
    outputTokens: int(attrs["output_token_count"]),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: int(attrs["reasoning_token_count"]),
    speed: str(attrs["service_tier"], 20),
    effort: str(attrs["model_reasoning_effort"], 20),
    occurredAt,
  };
}

function eventNameOf(attrs: FlatAttributes, record: OtlpLogRecord): string | undefined {
  return str(attrs["event.name"], 120) ?? (typeof record.body?.stringValue === "string" ? str(record.body.stringValue, 120) : undefined);
}

function isClaudeEvent(name: string, bodyName: string | undefined, scopeName: string | undefined, attrs: FlatAttributes) {
  if (name === "claude_code.api_request" || bodyName === "claude_code.api_request") return true;
  if (name !== "api_request") return false;
  const service = String(attrs["service.name"] ?? "").toLowerCase();
  return (scopeName ?? "").includes("claude_code") || service.includes("claude");
}

/**
 * Map an OTLP logs request to per-request rows.  Everything that is not a
 * per-request event (user_prompt, tool_result, api_error, ...) is counted in
 * `ignored` and dropped, as the logs route always did.
 */
export function mapOtlpLogsToAiRequests(request: OtlpExportLogsServiceRequest): MapAiRequestsResult {
  const requests: AiRequestInput[] = [];
  let ignored = 0;
  for (const resource of request.resourceLogs ?? []) {
    const resourceAttrs: FlatAttributes = {};
    const resourceArrays: Record<string, string> = {};
    flatten(resource.resource?.attributes, resourceAttrs, resourceArrays);
    for (const scope of resource.scopeLogs ?? []) {
      const scopeName = scope.scope?.name;
      for (const record of scope.logRecords ?? []) {
        const attrs: FlatAttributes = { ...resourceAttrs };
        const arrays: Record<string, string> = { ...resourceArrays };
        flatten(record.attributes, attrs, arrays);
        const name = eventNameOf(attrs, record) ?? "";
        const bodyName = typeof record.body?.stringValue === "string" ? record.body.stringValue.trim() : undefined;
        const occurredAt = timestampOf(attrs, record);
        let mapped: AiRequestInput | null = null;
        if (isClaudeEvent(name, bodyName, scopeName, attrs)) {
          mapped = claudeRequest(attrs, arrays, "logs", occurredAt, [
            attrs["session.id"],
            attrs["prompt.id"],
            attrs["event.sequence"],
            attrs["event.timestamp"] ?? String(record.timeUnixNano ?? ""),
          ]);
        } else if (name === "codex.api_request" || name === "codex.websocket_request") {
          // An api_request that names no model is not an inference call (Codex
          // also reports its own housekeeping HTTP calls through this event),
          // and no response.completed will ever arrive to complete it.  Storing
          // it left permanent zero-token rows grouped as model "unknown" (UM-1610).
          if (str(attrs["model"])) mapped = codexApiRequest(attrs, arrays, occurredAt);
        } else if (
          name === "codex.sse_event" &&
          attrs["event.kind"] === "response.completed" &&
          attrs["output_token_count"] !== undefined
        ) {
          mapped = codexCompletion(attrs, arrays, occurredAt);
        }
        if (mapped && requests.length < MAX_REQUESTS_PER_BATCH) requests.push(mapped);
        else ignored += 1;
      }
    }
  }
  return { requests, ignored };
}

/**
 * Map one OTLP span to a per-request row when it is a Claude Code
 * `claude_code.llm_request` span.  Returns null for every other span.
 */
export function aiRequestFromSpan(
  spanName: string | undefined,
  attrs: Record<string, string | number | boolean | undefined>,
  span: { startTimeUnixNano?: unknown; endTimeUnixNano?: unknown; spanId?: unknown; traceId?: unknown }
): AiRequestInput | null {
  if (spanName !== "claude_code.llm_request") return null;
  const flat: FlatAttributes = { ...attrs };
  let occurredAt = new Date();
  try {
    const end = span.endTimeUnixNano ?? span.startTimeUnixNano;
    if (typeof end === "string" || typeof end === "number") occurredAt = nanosToDate(end) ?? occurredAt;
  } catch {
    // keep now()
  }
  if (flat["duration_ms"] === undefined) {
    const start = Number(span.startTimeUnixNano);
    const end = Number(span.endTimeUnixNano);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      flat["duration_ms"] = Math.round((end - start) / 1_000_000);
    }
  }
  return claudeRequest(flat, {}, "traces", occurredAt, [
    "span",
    typeof span.traceId === "string" ? span.traceId : "",
    typeof span.spanId === "string" ? span.spanId : "",
    flat["session.id"],
    String(span.startTimeUnixNano ?? ""),
  ]);
}

export const _internal = { claudeDedupeKey, projectOf, MAX_REQUESTS_PER_BATCH };
