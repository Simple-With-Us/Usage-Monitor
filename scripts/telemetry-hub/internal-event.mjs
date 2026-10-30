// The hub's own event form, plus the OTLP -> internal normalization.
//
// Every producer signal becomes ONE internal event.  The internal form is
// what the journal stores, what the UM sender turns into a turn and a ledger
// row, and what the Sentry sender scrubs into a span or a log record.
//
// The content fields (`promptText`, `responseText`) live here and ONLY here.
// They are the reason the journal is a local, user-only file: the journal is
// the audit trail and it holds the prompt and the response.
//
// Fields beyond the documented internal form:
//
//   kind     "span" for a turn, "log" for a log record.  It routes the event
//            to Sentry's /v1/traces or /v1/logs without duplicating it.
//   provider The ledger provider name for the v2 usage event.  It is NOT a
//            Sentry attribute; it never leaves for Sentry.
//   attrs    The ALLOWLISTED attributes the producer sent, as a flat map.
//            They are extracted at the edge so that a Sentry payload can be
//            rebuilt faithfully from the journal alone.

import { createHash } from "node:crypto";

import { SENTRY_ATTRIBUTE_ALLOWLIST } from "./allowlist.mjs";

const ALLOWLIST_SET = new Set(SENTRY_ATTRIBUTE_ALLOWLIST);

/** The internal event fields, for documentation and for the journal writer. */
export const INTERNAL_EVENT_FIELDS = Object.freeze([
  "eventId",
  "ts",
  "platform",
  "vendor",
  "model",
  "operation",
  "tokens",
  "costUsd",
  "durationMs",
  "ttftMs",
  "toolNames",
  "toolStatus",
  "status",
  "errorType",
  "context",
  "project",
  "sessionId",
  "promptText",
  "responseText",
  "kind",
  "provider",
  "attrs",
]);

/** A logger that drops everything.  Used as the default in every module. */
export const NULL_LOGGER = Object.freeze({
  info() {},
  warn() {},
  error() {},
});

/**
 * A console logger that prints ONLY safe fields.
 *
 * S5: the hub never logs a producer value.  Counts, keys, ids and lengths
 * are fine; a prompt, a response, a token or a secret is not.  The logger
 * cannot be trusted to be called correctly, so it drops any value that is
 * not an explicitly allowed type and truncates strings.
 */
export function createLogger(sink = console) {
  const write = (level, message, fields) => {
    const line = { level, message };
    if (fields && typeof fields === "object" && !Array.isArray(fields)) {
      for (const [key, value] of Object.entries(fields)) {
        if (typeof value === "number" && Number.isFinite(value)) line[key] = value;
        else if (typeof value === "boolean") line[key] = value;
        else if (typeof value === "string") line[key] = value.length > 120 ? `${value.slice(0, 120)}` : value;
        else if (Array.isArray(value)) line[key] = value.filter((item) => typeof item === "string").slice(0, 32);
      }
    }
    const method = level === "error" ? sink.error : level === "warn" ? sink.warn : sink.info;
    if (typeof method === "function") method.call(sink, JSON.stringify(line));
  };
  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readString(value, max = 4000) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function readNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

function readInt(value) {
  const parsed = readNumber(value);
  if (parsed === undefined) return undefined;
  const truncated = Math.trunc(parsed);
  return truncated >= 0 ? truncated : undefined;
}

/**
 * Flatten an OTLP attribute list into a plain map of scalars.
 *
 * Nested arrays, kvlists and bytes are ignored: they are the shapes a
 * producer uses to smuggle content past a naive reader, and the Sentry
 * attribute support for them is partial anyway.
 */
export function flattenOtlpAttributes(attributes) {
  const out = {};
  if (!Array.isArray(attributes)) return out;
  for (const entry of attributes) {
    if (!isPlainObject(entry)) continue;
    const key = entry.key;
    if (typeof key !== "string" || !key) continue;
    const value = entry.value;
    if (!isPlainObject(value)) continue;
    if (typeof value.stringValue === "string") {
      out[key] = value.stringValue;
    } else if (typeof value.boolValue === "boolean") {
      out[key] = value.boolValue;
    } else if (typeof value.doubleValue === "number" && Number.isFinite(value.doubleValue)) {
      out[key] = value.doubleValue;
    } else if (value.intValue !== undefined && value.intValue !== null) {
      const parsed = typeof value.intValue === "string" ? Number(value.intValue) : value.intValue;
      if (typeof parsed === "number" && Number.isFinite(parsed)) out[key] = Math.trunc(parsed);
    }
  }
  return out;
}

/**
 * Keep only the allowlisted attributes of a flat map.
 *
 * The receiver applies the allowlist at the edge, so the journal never
 * carries a prompt or a tool argument in its `attrs` map.  The prompt and
 * the response are lifted out on purpose into the content fields, which the
 * Sentry path strips.
 */
export function allowlistedAttributes(flat) {
  const out = {};
  if (!isPlainObject(flat)) return out;
  for (const [key, value] of Object.entries(flat)) {
    if (!ALLOWLIST_SET.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

/** SHA-256 hex of a stable string.  The internal event identity. */
export function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * A stable JSON serialization: object keys are sorted, so the same logical
 * value always produces the same text whatever key order the producer used.
 */
function stableStringify(value) {
  if (value === undefined) return "u";
  if (value === null) return "n";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  return JSON.stringify(String(value));
}

/**
 * A one-way digest of an arbitrary JSON value.
 *
 * Only the digest is ever kept.  The value itself is neither stored nor
 * sent, so a digest can tell two records apart without carrying their
 * content.  This is the same idea the monitor's own idempotency keys use.
 */
export function stableDigest(value) {
  return sha256Hex(stableStringify(value));
}

function normalizePlatform(raw) {
  const value = readString(raw, 64);
  if (!value) return "unknown-agent";
  return value.toLowerCase().replace(/[\s_]+/g, "-");
}

function splitList(raw) {
  if (Array.isArray(raw)) {
    return raw
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 50);
  }
  if (typeof raw !== "string") return [];
  return raw
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 50);
}

function spanDurationMs(span) {
  const start = readNumber(span.startTimeUnixNano);
  const end = readNumber(span.endTimeUnixNano);
  if (start === undefined || end === undefined || end < start) return undefined;
  const ms = Math.round((end - start) / 1_000_000);
  return ms >= 0 && ms <= 86_400_000 ? ms : undefined;
}

function nanosToIso(value) {
  const nanos = readNumber(value);
  if (nanos === undefined || nanos <= 0) return undefined;
  const date = new Date(Math.round(nanos / 1_000_000));
  const time = date.getTime();
  if (!Number.isFinite(time)) return undefined;
  return date.toISOString();
}

/**
 * The deterministic identity of an internal event.
 *
 * It is derived from the SOURCE, never from the arrival time, so a producer
 * that retries the same span produces the same eventId.  That matters twice:
 * the journal can hold the same signal twice without creating two ledger
 * rows, and the Sentry path can dedupe a resend.
 */
export function computeEventId(kind, sourceParts) {
  return sha256Hex([kind, ...sourceParts.map((part) => String(part ?? ""))].join("\u0000"));
}

/**
 * Normalize one OTLP span into an internal event.
 *
 * The prompt and the response come from `gen_ai.input.messages` and
 * `gen_ai.output.messages`.  They are CONTENT and they are the reason the
 * UM path receives everything.
 */
export function normalizeSpan(span, resourceAttributes = {}) {
  if (!isPlainObject(span)) return null;
  const flat = { ...resourceAttributes, ...flattenOtlpAttributes(span.attributes) };

  const platform = normalizePlatform(
    flat["agent.platform"] ?? flat["gen_ai.system"] ?? flat["gen_ai.agent.name"],
  );
  const model = readString(flat["gen_ai.request.model"] ?? flat["model"], 160);
  //  The operation comes from the ALLOWLISTED `gen_ai.operation.name`
  //  attribute and from nothing else.  A raw span name is producer free
  //  text: it can carry the prompt, so it never becomes the operation and
  //  never reaches the Sentry path.
  const operation = readString(flat["gen_ai.operation.name"], 120) ?? "chat";
  const statusCode = isPlainObject(span.status) ? span.status.code : undefined;
  const statusText = isPlainObject(span.status) ? span.status.message : undefined;
  const isError =
    statusCode === 2 ||
    (typeof statusCode === "string" && statusCode.toLowerCase() === "error") ||
    typeof flat["error.type"] === "string" ||
    typeof flat["error"] === "string";

  const hasNativeIdentity =
    typeof span.traceId === "string" && span.traceId.length > 0 &&
    typeof span.spanId === "string" && span.spanId.length > 0;
  if (!hasNativeIdentity) return null;
  const eventId = computeEventId("span", [span.traceId, span.spanId, span.startTimeUnixNano ?? "", platform]);

  const tokens = {
    input: readInt(flat["gen_ai.usage.input_tokens"]),
    output: readInt(flat["gen_ai.usage.output_tokens"]),
    cacheRead: readInt(flat["gen_ai.usage.cache_read_input_tokens"] ?? flat["gen_ai.usage.cache_read_tokens"]),
    cacheCreation: readInt(
      flat["gen_ai.usage.cache_creation_input_tokens"] ?? flat["gen_ai.usage.cache_creation_tokens"],
    ),
    reasoning: readInt(flat["gen_ai.usage.reasoning_tokens"]),
  };

  const context = {
    tokens: readInt(flat["context.tokens"]),
    limit: readInt(flat["context.limit"]),
    utilizationPct: readNumber(flat["context.utilization_pct"]),
  };

  const toolNames = splitList(
    flat["gen_ai.tool.name"] ?? flat["gen_ai.tool.names"] ?? flat["tool.name"] ?? flat["tool.names"],
  );

  const event = {
    eventId,
    ts: nanosToIso(span.endTimeUnixNano) ?? nanosToIso(span.startTimeUnixNano) ?? new Date().toISOString(),
    platform,
    vendor: readString(flat["gen_ai.system"], 80),
    model,
    operation,
    tokens,
    costUsd: readNumber(flat["gen_ai.usage.cost"] ?? flat["cost_usd"] ?? flat["costUsd"]),
    durationMs: readInt(flat["duration_ms"] ?? flat["durationMs"]) ?? spanDurationMs(span),
    ttftMs: readInt(flat["ttft_ms"] ?? flat["ttftMs"]),
    toolNames,
    toolStatus: readString(flat["gen_ai.tool.status"] ?? flat["tool.status"], 32),
    status: isError ? "error" : "ok",
    errorType: readString(flat["error.type"] ?? flat["exception.type"], 120),
    context,
    project: readString(flat["project.name"] ?? flat["project"] ?? flat["repo"], 120),
    sessionId: readString(flat["session.id"] ?? flat["gen_ai.conversation.id"], 200),
    // CONTENT.  UM only.  The Sentry path strips these before scrubbing.
    promptText: readString(flat["gen_ai.input.messages"] ?? flat["prompt"]),
    responseText: readString(flat["gen_ai.output.messages"] ?? flat["response"]),
    kind: "span",
    provider: readString(flat["gen_ai.provider.name"] ?? flat["provider"], 120),
    attrs: allowlistedAttributes(flat),
  };
  if (!event.errorType && isError && typeof statusText === "string" && statusText.trim()) {
    // The raw status message is free text and is NOT captured.  Only the
    // error TYPE travels, so the journal stays a structured record.
    event.errorType = "error";
  }
  return event;
}

/**
 * Normalize one OTLP log record into an internal event.
 *
 * A log record has no prompt and no response, but its BODY is free text and
 * is never captured.  The event therefore carries counts and names only,
 * and its `attrs` map is the allowlisted attribute set.
 */
export function normalizeLogRecord(record, resourceAttributes = {}) {
  if (!isPlainObject(record)) return null;
  const flat = { ...resourceAttributes, ...flattenOtlpAttributes(record.attributes) };
  const platform = normalizePlatform(
    flat["agent.platform"] ?? flat["gen_ai.system"] ?? flat["gen_ai.agent.name"],
  );
  const severity = readInt(record.severityNumber);
  const isError = severity !== undefined && severity >= 17;
  //  A log record has no id of its own, so the identity is built from the
  //  record itself.  The timestamp alone is not enough: two records of the
  //  same nanosecond on the same span would collide, and the second one
  //  would be dropped as already sent.  The body and the attributes enter
  //  the identity as ONE-WAY DIGESTS, never as values, so the content is
  //  neither kept nor sent.  A retry of the same record produces the same
  //  digests and therefore the same identity.
  const eventId = computeEventId("log", [
    record.timeUnixNano ?? "",
    record.observedTimeUnixNano ?? "",
    platform,
    record.spanId ?? "",
    record.traceId ?? "",
    severity ?? "",
    typeof record.severityText === "string" ? record.severityText : "",
    stableDigest(record.body ?? null),
    stableDigest(record.attributes ?? []),
  ]);
  return {
    eventId,
    ts: nanosToIso(record.timeUnixNano) ?? nanosToIso(record.observedTimeUnixNano) ?? new Date().toISOString(),
    platform,
    vendor: readString(flat["gen_ai.system"], 80),
    model: readString(flat["gen_ai.request.model"] ?? flat["model"], 160),
    operation: readString(flat["gen_ai.operation.name"], 120) ?? "log",
    tokens: {
      input: readInt(flat["gen_ai.usage.input_tokens"]),
      output: readInt(flat["gen_ai.usage.output_tokens"]),
      cacheRead: readInt(flat["gen_ai.usage.cache_read_input_tokens"]),
      cacheCreation: readInt(flat["gen_ai.usage.cache_creation_input_tokens"]),
      reasoning: readInt(flat["gen_ai.usage.reasoning_tokens"]),
    },
    costUsd: readNumber(flat["gen_ai.usage.cost"] ?? flat["cost_usd"]),
    durationMs: readInt(flat["duration_ms"]),
    ttftMs: readInt(flat["ttft_ms"]),
    toolNames: splitList(flat["gen_ai.tool.name"] ?? flat["gen_ai.tool.names"]),
    toolStatus: readString(flat["gen_ai.tool.status"], 32),
    status: isError ? "error" : "ok",
    errorType: readString(flat["error.type"], 120),
    context: {
      tokens: readInt(flat["context.tokens"]),
      limit: readInt(flat["context.limit"]),
      utilizationPct: readNumber(flat["context.utilization_pct"]),
    },
    project: readString(flat["project.name"] ?? flat["project"], 120),
    sessionId: readString(flat["session.id"] ?? flat["gen_ai.conversation.id"], 200),
    // A log body is free text and is deliberately NOT captured.
    promptText: undefined,
    responseText: undefined,
    kind: "log",
    provider: readString(flat["gen_ai.provider.name"] ?? flat["provider"], 120),
    attrs: allowlistedAttributes(flat),
  };
}

/**
 * Normalize a whole `{ resourceSpans: [...] }` payload.
 *
 * Resource attributes are merged into every span, so a producer that sets
 * `service.name` once at the resource level is not repeated per span.
 */
export function normalizeOtlpTraces(payload) {
  const events = [];
  let ignored = 0;
  const resourceSpans = isPlainObject(payload) ? payload.resourceSpans : undefined;
  if (!Array.isArray(resourceSpans)) return { events, ignored };
  for (const resource of resourceSpans) {
    if (!isPlainObject(resource)) {
      ignored += 1;
      continue;
    }
    const resourceAttributes = flattenOtlpAttributes(
      isPlainObject(resource.resource) ? resource.resource.attributes : undefined,
    );
    const scopeSpans = Array.isArray(resource.scopeSpans) ? resource.scopeSpans : [];
    for (const scope of scopeSpans) {
      if (!isPlainObject(scope)) {
        ignored += 1;
        continue;
      }
      const spans = Array.isArray(scope.spans) ? scope.spans : [];
      for (const span of spans) {
        const event = normalizeSpan(span, resourceAttributes);
        if (event) events.push(event);
        else ignored += 1;
      }
    }
  }
  return { events, ignored };
}

/** Normalize a whole `{ resourceLogs: [...] }` payload. */
export function normalizeOtlpLogs(payload) {
  const events = [];
  let ignored = 0;
  const resourceLogs = isPlainObject(payload) ? payload.resourceLogs : undefined;
  if (!Array.isArray(resourceLogs)) return { events, ignored };
  for (const resource of resourceLogs) {
    if (!isPlainObject(resource)) {
      ignored += 1;
      continue;
    }
    const resourceAttributes = flattenOtlpAttributes(
      isPlainObject(resource.resource) ? resource.resource.attributes : undefined,
    );
    const scopeLogs = Array.isArray(resource.scopeLogs) ? resource.scopeLogs : [];
    for (const scope of scopeLogs) {
      if (!isPlainObject(scope)) {
        ignored += 1;
        continue;
      }
      const records = Array.isArray(scope.logRecords) ? scope.logRecords : [];
      for (const record of records) {
        const event = normalizeLogRecord(record, resourceAttributes);
        if (event) events.push(event);
        else ignored += 1;
      }
    }
  }
  return { events, ignored };
}
