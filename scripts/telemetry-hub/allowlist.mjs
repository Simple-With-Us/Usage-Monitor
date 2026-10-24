// Sentry allowlist and scrubbers for the telemetry hub.
//
// Two destinations read the same journal and apply two different content
// policies.  Usage Monitor (UM) receives every turn: the prompt, the
// response, the tool arguments and the tool results.  Sentry receives
// counts, durations, the model, the tool names and a status, and nothing
// else.
//
// The scrubber in this file is the only control that matters.  Sentry's own
// default scrubbing does not protect `gen_ai.input.messages`,
// `gen_ai.output.messages`, `gen_ai.tool.call.arguments` or
// `gen_ai.tool.call.result`, and plain OTLP bypasses the SDK PII flags
// entirely.  This org's own settings have `dataScrubber: false`.  So the hub
// scrubs on the Mac, before the packet leaves.
//
// The invariants this module enforces:
//   S1  A producer free-text field never reaches the scrubbed output.  The
//       content fields are stripped BEFORE the scrubber runs, and the
//       scrubber drops them too, so there are two independent barriers.
//   S2  Drop by default.  An attribute survives only if its key is on the
//       allowlist.  A dropped value is dropped WHOLE, never redacted.
//   S3  A dropped value leaves no trace anywhere in the output.
//   S4  The scrubber never throws.  Malformed input yields an empty or
//       minimal result.
//   S5  Nothing here logs a value.  Counts, keys and lengths only.
//   S6  A log body is REBUILT from allowlisted fields.  The producer's raw
//       log body is never forwarded.
//   S7  A span's `events` and `links` arrays are dropped, because Sentry
//       drops them server-side anyway and they can carry content.
//   S8  A scope is PROJECTED, never forwarded as it arrived.  Its attributes
//       go through the allowlist like every other attribute list.
//
// This module has no imports on purpose: it is the security-critical core
// and it must stay independently testable.

/**
 * The complete set of attribute keys that may leave the Mac for Sentry.
 *
 * There is NO prompt, NO tool argument, NO tool result, NO file path, NO
 * project name, NO user identifier, NO session id, NO conversation id and NO
 * raw error text in this list.  Adding a key is a policy change and needs a
 * deliberate edit here, not a config toggle.
 */
export const SENTRY_ATTRIBUTE_ALLOWLIST = Object.freeze([
  "gen_ai.system",
  "gen_ai.operation.name",
  "gen_ai.request.model",
  "gen_ai.response.model",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.cache_read_input_tokens",
  "gen_ai.usage.cache_creation_input_tokens",
  "gen_ai.usage.reasoning_tokens",
  "gen_ai.tool.name",
  "gen_ai.tool.type",
  "gen_ai.tool.status",
  "duration_ms",
  "ttft_ms",
  "error.type",
  "http.response.status_code",
  "context.tokens",
  "context.limit",
  "context.utilization_pct",
  "service.name",
  "service.version",
]);

const ALLOWLIST_SET = new Set(SENTRY_ATTRIBUTE_ALLOWLIST);
const SENTRY_STRING_NUMERIC_ATTRIBUTES = new Set([
  "ttft_ms",
  "context.tokens",
  "context.limit",
  "context.utilization_pct",
]);

/**
 * Producer free-text fields.  These are CONTENT: they belong to the UM path
 * only and must never reach the Sentry path in any form.
 */
export const PRODUCER_CONTENT_FIELDS = Object.freeze(["promptText", "responseText"]);

/** Upper bound for one allowlisted string value.  A bound, not a redaction. */
export const MAX_ALLOWED_VALUE_CHARS = 1024;

/** Upper bound for a rebuilt log body. */
export const MAX_REBUILT_BODY_CHARS = 2048;

/** Upper bound for the tool-name list folded into one `gen_ai.tool.name`. */
const MAX_TOOL_NAME_CHARS = 256;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read a scalar out of an OTLP AnyValue.  Nested arrays, kvlists and bytes
 * are refused outright: they are the shapes a producer uses to smuggle
 * content, and Sentry only supports array attributes partially anyway.
 */
export function scalarFromAnyValue(value) {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.boolValue === "boolean") return value.boolValue;
  if (typeof value.doubleValue === "number") {
    return Number.isFinite(value.doubleValue) ? value.doubleValue : undefined;
  }
  if (value.intValue !== undefined && value.intValue !== null) {
    const parsed = typeof value.intValue === "string" ? Number(value.intValue) : value.intValue;
    if (typeof parsed === "number" && Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return undefined;
}

function boundString(value) {
  if (typeof value !== "string") return undefined;
  return value.length > MAX_ALLOWED_VALUE_CHARS ? value.slice(0, MAX_ALLOWED_VALUE_CHARS) : value;
}

function dropKeySet(options) {
  const raw = options?.dropAttributeKeys;
  if (!raw) return null;
  if (raw instanceof Set) return raw;
  if (Array.isArray(raw)) return new Set(raw);
  return null;
}

function keyIsAllowed(key, dropKeys) {
  if (typeof key !== "string" || !key) return false;
  if (!ALLOWLIST_SET.has(key)) return false;
  if (dropKeys && dropKeys.has(key)) return false;
  return true;
}

/**
 * Build one OTLP attribute entry from a plain scalar.
 *
 * Integers are emitted as `intValue` (a string, per the OTLP JSON mapping of
 * int64) and non-integers as `doubleValue`.
 */
export function otlpAttribute(key, value) {
  if (typeof value === "string") return { key, value: { stringValue: boundString(value) } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) return { key, value: { intValue: String(value) } };
    return { key, value: { doubleValue: value } };
  }
  return undefined;
}

/**
 * Sentry drops these custom attributes when OTLP sends numeric AnyValues (UM-1614, observed 2026-10-21).  Keep
 * their values queryable as strings on the Sentry path while leaving the journal and UM's typed event numeric.
 */
function sentryAttribute(key, value) {
  if (SENTRY_STRING_NUMERIC_ATTRIBUTES.has(key) && typeof value === "number" && Number.isFinite(value)) {
    return { key, value: { stringValue: String(value) } };
  }
  return otlpAttribute(key, value);
}

/**
 * The core policy gate: an attribute survives only if its key is on the
 * allowlist.  A key that is not allowed is dropped WHOLE, together with its
 * value, so there is nothing left to redact (S2, S3).
 *
 * Accepts the OTLP `[{ key, value }]` array shape.  Never throws (S4).
 */
export function scrubOtlpAttributes(attributes, options) {
  if (!Array.isArray(attributes)) return [];
  const dropKeys = dropKeySet(options);
  const out = [];
  for (const entry of attributes) {
    if (!isPlainObject(entry)) continue;
    const key = entry.key;
    if (!keyIsAllowed(key, dropKeys)) continue;
    const scalar = scalarFromAnyValue(entry.value);
    if (scalar === undefined) continue;
    const attribute = sentryAttribute(key, scalar);
    if (attribute) out.push(attribute);
  }
  return out;
}

/**
 * The same policy gate for a flat `{ key: scalar }` map, used for the
 * allowlisted attributes carried on an internal event.  Never throws (S4).
 */
export function scrubAttributeMap(map, options) {
  if (!isPlainObject(map)) return [];
  const dropKeys = dropKeySet(options);
  const out = [];
  for (const [key, value] of Object.entries(map)) {
    if (!keyIsAllowed(key, dropKeys)) continue;
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "boolean") {
      const attribute = sentryAttribute(key, value);
      if (attribute) out.push(attribute);
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const attribute = sentryAttribute(key, value);
      if (attribute) out.push(attribute);
    }
  }
  return out;
}

/**
 * S1, barrier one: remove the producer free-text fields from an event.
 *
 * The returned object is a copy, so the caller's event is not mutated.  The
 * field names are dropped, not blanked, so a `promptText: ""` never exists
 * in the object at all.
 */
export function stripProducerContent(event) {
  if (!isPlainObject(event)) return {};
  const copy = { ...event };
  for (const field of PRODUCER_CONTENT_FIELDS) {
    delete copy[field];
  }
  return copy;
}

/**
 * S6: rebuild a log body from allowlisted fields only.
 *
 * The producer's own body is never read.  The rebuilt body carries keys and
 * values that already passed the allowlist, so it can only contain the same
 * non-content data the attribute list carries.
 */
export function rebuildLogBody(attributes) {
  if (!Array.isArray(attributes) || attributes.length === 0) return "";
  const parts = [];
  for (const attribute of attributes) {
    if (!isPlainObject(attribute)) continue;
    const key = attribute.key;
    if (typeof key !== "string" || !key) continue;
    const scalar = scalarFromAnyValue(attribute.value);
    if (scalar === undefined) continue;
    parts.push(`${key}=${typeof scalar === "string" ? scalar : String(scalar)}`);
  }
  const body = parts.join(" ");
  return body.length > MAX_REBUILT_BODY_CHARS ? body.slice(0, MAX_REBUILT_BODY_CHARS) : body;
}

function boundedName(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_ALLOWED_VALUE_CHARS ? trimmed.slice(0, MAX_ALLOWED_VALUE_CHARS) : trimmed;
}

function boundedNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Project one OTLP scope object.
 *
 * The scope is producer controlled, so it is never forwarded as it arrived.
 * The name and the version are bounded strings, the attributes go through
 * the same allowlist as every other attribute list, and everything else is
 * dropped.  A scope with no valid field becomes an empty object.
 */
export function projectScope(scope, options) {
  if (!isPlainObject(scope)) return {};
  const out = {};
  const name = boundedName(scope.name);
  if (name) out.name = name;
  const version = boundedName(scope.version);
  if (version) out.version = version;
  const attributes = scrubOtlpAttributes(scope.attributes, options);
  out.attributes = attributes;
  if (Number.isInteger(scope.droppedAttributesCount) && scope.droppedAttributesCount >= 0) {
    out.droppedAttributesCount = scope.droppedAttributesCount;
  }
  return out;
}

/**
 * Scrub ONE OTLP span.
 *
 * Keeps the identity and timing fields, filters the attributes through the
 * allowlist, keeps only the numeric status code (a status MESSAGE is free
 * text and is dropped), and drops the `events` and `links` arrays (S7).
 *
 * Never throws (S4).
 */
export function scrubSpan(span, options) {
  if (!isPlainObject(span)) return null;
  const attributes = scrubOtlpAttributes(span.attributes, options);
  const status = isPlainObject(span.status) ? span.status : undefined;
  const code = status && status.code !== undefined ? status.code : undefined;
  const out = {
    name: boundedName(span.name) ?? "telemetry.hub",
    attributes,
  };
  if (typeof span.traceId === "string") out.traceId = span.traceId;
  if (typeof span.spanId === "string") out.spanId = span.spanId;
  if (span.startTimeUnixNano !== undefined) out.startTimeUnixNano = String(span.startTimeUnixNano);
  if (span.endTimeUnixNano !== undefined) out.endTimeUnixNano = String(span.endTimeUnixNano);
  if (code !== undefined) {
    out.status = { code: typeof code === "number" ? code : 2 };
  }
  return out;
}

/**
 * Scrub ONE OTLP log record.
 *
 * The body is rebuilt from the allowlisted attributes (S6); the producer's
 * raw body is never forwarded.  `severityText` is kept only when it looks
 * like a short level name.
 */
export function scrubLogRecord(record, options) {
  if (!isPlainObject(record)) return null;
  const attributes = scrubOtlpAttributes(record.attributes, options);
  const out = {
    attributes,
    body: { stringValue: rebuildLogBody(attributes) },
  };
  if (record.timeUnixNano !== undefined) out.timeUnixNano = String(record.timeUnixNano);
  if (record.observedTimeUnixNano !== undefined) {
    out.observedTimeUnixNano = String(record.observedTimeUnixNano);
  }
  if (record.severityNumber !== undefined) {
    const severity = Number(record.severityNumber);
    if (Number.isFinite(severity)) out.severityNumber = severity;
  }
  if (typeof record.severityText === "string" && /^[A-Za-z0-9_. -]{1,32}$/.test(record.severityText)) {
    out.severityText = record.severityText;
  }
  if (typeof record.traceId === "string") out.traceId = record.traceId;
  if (typeof record.spanId === "string") out.spanId = record.spanId;
  return out;
}

/**
 * Scrub a whole `{ resourceSpans: [...] }` payload.
 *
 * Resource attributes go through the same allowlist, so `service.name` and
 * `service.version` survive and everything else does not.
 */
export function scrubResourceSpans(payload, options) {
  const resourceSpans = isPlainObject(payload) ? payload.resourceSpans : undefined;
  if (!Array.isArray(resourceSpans)) return { resourceSpans: [] };
  const out = [];
  for (const resource of resourceSpans) {
    if (!isPlainObject(resource)) continue;
    const scopeSpans = Array.isArray(resource.scopeSpans) ? resource.scopeSpans : [];
    const outScopes = [];
    for (const scope of scopeSpans) {
      if (!isPlainObject(scope)) continue;
      const spans = Array.isArray(scope.spans) ? scope.spans : [];
      const outSpans = [];
      for (const span of spans) {
        const scrubbed = scrubSpan(span, options);
        if (scrubbed) outSpans.push(scrubbed);
      }
      if (outSpans.length > 0) outScopes.push({ scope: projectScope(scope.scope, options), spans: outSpans });
    }
    if (outScopes.length === 0) continue;
    out.push({
      resource: {
        attributes: scrubOtlpAttributes(
          isPlainObject(resource.resource) ? resource.resource.attributes : undefined,
          options,
        ),
      },
      scopeSpans: outScopes,
    });
  }
  return { resourceSpans: out };
}

/**
 * Scrub a whole `{ resourceLogs: [...] }` payload.  Bodies are rebuilt (S6).
 */
export function scrubResourceLogs(payload, options) {
  const resourceLogs = isPlainObject(payload) ? payload.resourceLogs : undefined;
  if (!Array.isArray(resourceLogs)) return { resourceLogs: [] };
  const out = [];
  for (const resource of resourceLogs) {
    if (!isPlainObject(resource)) continue;
    const scopeLogs = Array.isArray(resource.scopeLogs) ? resource.scopeLogs : [];
    const outScopes = [];
    for (const scope of scopeLogs) {
      if (!isPlainObject(scope)) continue;
      const records = Array.isArray(scope.logRecords) ? scope.logRecords : [];
      const outRecords = [];
      for (const record of records) {
        const scrubbed = scrubLogRecord(record, options);
        if (scrubbed) outRecords.push(scrubbed);
      }
      if (outRecords.length > 0) outScopes.push({ scope: projectScope(scope.scope, options), logRecords: outRecords });
    }
    if (outScopes.length === 0) continue;
    out.push({
      resource: {
        attributes: scrubOtlpAttributes(
          isPlainObject(resource.resource) ? resource.resource.attributes : undefined,
          options,
        ),
      },
      scopeLogs: outScopes,
    });
  }
  return { resourceLogs: out };
}

/**
 * Map one internal event onto the allowlisted attribute set.
 *
 * The typed fields of the internal form are the hub's normalized view; the
 * `attrs` map holds the allowlisted attributes the producer sent.  Both go
 * through the allowlist, and the typed fields win on a key collision.
 */
export function internalEventAttributes(event, options) {
  if (!isPlainObject(event)) return [];
  const merged = new Map();
  for (const attribute of scrubAttributeMap(event.attrs, options)) {
    merged.set(attribute.key, attribute);
  }
  const tokens = isPlainObject(event.tokens) ? event.tokens : {};
  const context = isPlainObject(event.context) ? event.context : {};
  const typed = [
    ["gen_ai.system", event.platform],
    ["gen_ai.operation.name", event.operation],
    ["gen_ai.request.model", event.model],
    ["gen_ai.response.model", event.model],
    ["gen_ai.usage.input_tokens", boundedNumber(tokens.input)],
    ["gen_ai.usage.output_tokens", boundedNumber(tokens.output)],
    ["gen_ai.usage.cache_read_input_tokens", boundedNumber(tokens.cacheRead)],
    ["gen_ai.usage.cache_creation_input_tokens", boundedNumber(tokens.cacheCreation)],
    ["gen_ai.usage.reasoning_tokens", boundedNumber(tokens.reasoning)],
    ["duration_ms", boundedNumber(event.durationMs)],
    ["ttft_ms", boundedNumber(event.ttftMs)],
    ["error.type", event.errorType],
    ["http.response.status_code", boundedNumber(event.httpStatus)],
    ["context.tokens", boundedNumber(context.tokens)],
    ["context.limit", boundedNumber(context.limit)],
    ["context.utilization_pct", boundedNumber(context.utilizationPct)],
    ["service.name", event.serviceName],
    ["service.version", event.serviceVersion],
  ];
  for (const [key, value] of typed) {
    if (value === undefined || value === null) continue;
    const attribute = sentryAttribute(key, value);
    if (attribute) merged.set(key, attribute);
  }
  if (Array.isArray(event.toolNames) && event.toolNames.length > 0) {
    const names = event.toolNames
      .filter((name) => typeof name === "string" && name.trim())
      .map((name) => name.trim())
      .join(",");
    if (names) {
      const attribute = otlpAttribute("gen_ai.tool.name", names.slice(0, MAX_TOOL_NAME_CHARS));
      if (attribute) merged.set("gen_ai.tool.name", attribute);
    }
  }
  if (typeof event.toolStatus === "string" && event.toolStatus.trim()) {
    const attribute = otlpAttribute("gen_ai.tool.status", event.toolStatus);
    if (attribute) merged.set("gen_ai.tool.status", attribute);
  }
  return [...merged.values()];
}

/**
 * Scrub one internal event into the shape the Sentry sender ships.
 *
 * S1 is enforced twice here: the content fields are stripped first, and the
 * attribute set is built only from allowlisted keys, so `promptText` and
 * `responseText` cannot appear under any circumstance.
 */
export function scrubInternalEvent(event, options) {
  if (!isPlainObject(event)) return null;
  const stripped = stripProducerContent(event);
  const attributes = internalEventAttributes(stripped, options);
  const out = {
    kind: stripped.kind === "log" ? "log" : "span",
    attributes,
  };
  if (typeof stripped.eventId === "string") out.eventId = stripped.eventId;
  if (typeof stripped.ts === "string") out.ts = stripped.ts;
  if (typeof stripped.durationMs === "number" && Number.isFinite(stripped.durationMs)) {
    out.durationMs = stripped.durationMs;
  }
  //  The span name is the operation, and the operation is an ALLOWLISTED
  //  value: it comes from the `gen_ai.operation.name` attribute and never
  //  from a raw span name.  It is bounded here as well, so a hand edited
  //  journal row cannot push an unbounded string into the envelope.
  const name = boundedName(stripped.operation);
  if (name) out.name = name;
  if (out.kind === "log") {
    out.body = { stringValue: rebuildLogBody(attributes) };
    out.severityNumber = stripped.status === "error" ? 17 : 9;
  } else {
    out.status = { code: stripped.status === "error" ? 2 : 1 };
  }
  return out;
}
