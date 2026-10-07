/** Shared final redaction for browser, server and edge Sentry payloads.
 * Unreadable payloads fail closed rather than returning unsanitized input. */
import { sentryCronMonitorConfig, SENTRY_CRON_MONITOR_SLUG } from "./sentry-ops";
import { envelopeItemTypeToDataCategory } from "@sentry/core";
import type { ErrorEvent, EventHint, Log, Metric, TransactionEvent, StreamedSpanJSON, Integration } from "@sentry/core";

const SENSITIVE_KEY_SUBSTRINGS = ["token", "secret", "key", "password", "passwd", "auth", "credential", "prompt", "email", "customer", "database_url", "databaseurl"];
const SDK_INTERNAL_CYCLIC_PATHS = new Set([
  "sdkProcessingMetadata.capturedSpanScope",
  "sdkProcessingMetadata.capturedSpanIsolationScope",
  "sdkProcessingMetadata.capturedSpanScopeAsString",
]);

// Only code-owned operational labels survive uncontrolled message fields.
const OPERATIONAL_MESSAGES = new Set([
  "scheduler.disabled", "scheduler.tick_failed", "scheduler.provider_fetch_degraded",
  "ingest.failed", "scheduler.tick", "scheduler.duration_ms", "ingest.admission_rejected",
  "ingest.events_rejected", "rollup.completed",
  "node.runtime.cpu.system", "node.runtime.cpu.user", "node.runtime.cpu.utilization",
  "node.runtime.event_loop.delay.max", "node.runtime.event_loop.delay.mean", "node.runtime.event_loop.delay.min",
  "node.runtime.event_loop.delay.p50", "node.runtime.event_loop.delay.p90", "node.runtime.event_loop.delay.p99",
  "node.runtime.event_loop.utilization", "node.runtime.mem.array_buffers", "node.runtime.mem.external",
  "node.runtime.mem.heap_total", "node.runtime.mem.heap_used", "node.runtime.mem.rss", "node.runtime.process.uptime",
]);
const OPERATIONAL_FIELDS = new Set([
  "route", "outcome", "reason", "total", "successes", "failures", "skipped",
  "providerFetchDegraded", "tickBudgetExceeded", "rollupsTouched", "scanned", "pruned",
  "tombstonesWritten", "count", "durationMs", "status_code", "statusCode", "method",
  "url", "duration", "status", "code", "errno", "syscall", "region",
]);
const SDK_ATTRIBUTES = new Set([
  "sentry.environment", "sentry.release", "sentry.origin", "sentry.op", "sentry.sample_rate",
  "sentry.sample_rand", "sentry.sdk.name", "sentry.sdk.version", "sentry.sdk.integrations",
  "sentry.segment.id", "sentry.segment.name", "sentry.segment.name.source",
  "sentry.timestamp.sequence", "sentry.trace_lifecycle", "sentry.trace.parent_span_id",
  "sentry.profile_id", "sentry.profiler_id", "sentry.link.type", "http.request.method", "http.response.status_code",
  "http.response.body.size", "http.route", "url.full", "db.system", "db.operation.name",
]);
const EVENT_FIELDS = new Set([
  "event_id", "timestamp", "start_timestamp", "platform", "level", "logger", "transaction",
  "transaction_info", "environment", "release", "dist", "sdk", "sdkProcessingMetadata",
  "exception", "stacktrace", "contexts", "tags", "request", "breadcrumbs", "message",
  "type", "spans", "measurements",
]);
const CONTEXT_FIELDS: Record<string, readonly string[]> = {
  trace: ["type", "trace_id", "span_id", "parent_span_id", "op", "status", "origin"],
  runtime: ["type", "name", "version"], browser: ["type", "name", "version"],
  os: ["type", "name", "version", "build", "kernel_version"],
  device: ["type", "arch", "processor_count", "memory_size"],
  app: ["type", "app_identifier", "app_version", "app_build"],
};
const WIRE_FIELDS: Record<string, readonly string[]> = {
  span: ["trace_id", "parent_span_id", "span_id", "name", "start_timestamp", "end_timestamp", "status", "is_segment", "attributes", "links"],
  log: ["timestamp", "level", "message", "body", "trace_id", "span_id", "attributes", "severity_number", "severityNumber"],
  trace_metric: ["timestamp", "trace_id", "span_id", "name", "type", "unit", "value", "attributes"],
};
function projectFields<T>(input: T, fields: Iterable<string>): T {
  if (!input || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const key of fields) if (Object.hasOwn(input, key)) out[key] = (input as Record<string, unknown>)[key];
  return out as T;
}
function projectWireRow<T>(input: T, type: string): T {
  const result = projectFields(input, WIRE_FIELDS[type] ?? []) as Record<string, unknown>;
  if (result && typeof result === "object") {
    if (type === "log") for (const key of ["message", "body"]) {
      if (key in result && typeof result[key] !== "string") result[key] = "[REDACTED]";
    }
    for (const key of ["trace_id", "parent_span_id", "span_id", "name", "status", "level", "type", "unit"]) {
      if (result[key] !== undefined && typeof result[key] !== "string") throw new Error("Invalid telemetry scalar");
    }
    for (const key of ["timestamp", "start_timestamp", "end_timestamp", "severity_number", "severityNumber"]) {
      if (result[key] !== undefined && (typeof result[key] !== "number" || !Number.isFinite(result[key]))) throw new Error("Invalid telemetry timestamp");
    }
    if (result.is_segment !== undefined && typeof result.is_segment !== "boolean") throw new Error("Invalid telemetry segment flag");
    if (result.attributes !== undefined && (!result.attributes || typeof result.attributes !== "object" || Array.isArray(result.attributes))) throw new Error("Invalid telemetry attributes");
    if (result.links !== undefined && !Array.isArray(result.links)) throw new Error("Invalid telemetry links");
    if (type === "trace_metric" && (typeof result.name !== "string" || !OPERATIONAL_MESSAGES.has(result.name))) throw new Error("Unapproved metric name");
    if (type === "trace_metric" && "value" in result && (typeof result.value !== "number" || !Number.isFinite(result.value))) throw new Error("Invalid metric value");
  }
  return result as T;
}
function projectAuxiliary(input: unknown, type: string): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid operational payload");
  const row = input as Record<string, unknown>;
  if (type === "client_report") {
    if (!Array.isArray(row.discarded_events) || row.discarded_events.length > 1000) throw new Error("Invalid client report");
    const discarded_events = row.discarded_events.map(entry => {
      if (!entry || typeof entry !== "object") throw new Error("Invalid discard row");
      const { reason, category, quantity } = entry;
      if (!["before_send", "event_processor", "sample_rate", "network_error", "queue_overflow", "ratelimit_backoff", "internal_sdk_error", "send_error", "callback_error", "buffer_overflow", "ignored", "invalid", "no_parent_span"].includes(reason) ||
          !["error", "transaction", "span", "log_item", "log_byte", "metric", "monitor", "session", "attachment", "profile", "replay", "security", "internal", "feedback", "default", "unknown"].includes(category) ||
          typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 0) throw new Error("Invalid discard count");
      return { reason, category, quantity };
    });
    return { timestamp: typeof row.timestamp === "number" && Number.isFinite(row.timestamp) ? row.timestamp : 0, discarded_events };
  }
  if (type === "check_in") {
    if (row.monitor_slug !== SENTRY_CRON_MONITOR_SLUG || !["in_progress", "ok", "error"].includes(String(row.status)) || typeof row.check_in_id !== "string" || !/^[a-f0-9-]{32,36}$/i.test(row.check_in_id)) throw new Error("Invalid check-in");
    const { schedule, checkinMargin, maxRuntime, timezone } = sentryCronMonitorConfig();
    return { check_in_id: row.check_in_id, monitor_slug: row.monitor_slug, status: row.status,
      ...(typeof row.duration === "number" && Number.isFinite(row.duration) ? { duration: row.duration } : {}),
      ...(row.environment === "production" || row.environment === "development" ? { environment: row.environment } : {}),
      monitor_config: { schedule, checkin_margin: checkinMargin, max_runtime: maxRuntime, timezone } };
  }
  throw new Error("Unsupported telemetry envelope type");
}
function projectEvent<T>(event: T): T {
  const result = projectFields(event, EVENT_FIELDS) as Record<string, unknown>;
  if (!result || typeof result !== "object") return result as T;
  if ("message" in result && typeof result.message !== "string") result.message = "[REDACTED]";
  for (const key of ["event_id", "platform", "level", "logger", "transaction", "environment", "release", "dist", "type"]) {
    if (result[key] !== undefined && typeof result[key] !== "string") throw new Error("Invalid diagnostic scalar");
  }
  for (const key of ["timestamp", "start_timestamp"]) {
    if (result[key] !== undefined && (typeof result[key] !== "number" || !Number.isFinite(result[key]))) throw new Error("Invalid diagnostic timestamp");
  }
  for (const key of ["exception", "stacktrace", "sdk", "sdkProcessingMetadata", "contexts", "tags", "request", "transaction_info", "measurements"]) {
    if (result[key] !== undefined && (!result[key] || typeof result[key] !== "object" || Array.isArray(result[key]))) throw new Error("Invalid diagnostic record");
  }
  for (const key of ["spans", "breadcrumbs"]) {
    if (result[key] !== undefined && !Array.isArray(result[key])) throw new Error("Invalid diagnostic list");
  }
  if (result.measurements) {
    const measurements: Record<string, { value: number; unit?: string }> = {};
    for (const key of ["lcp", "fcp", "fid", "fp", "ttfb", "cls", "inp", "frames_total", "frames_slow", "frames_frozen"]) {
      const entry = (result.measurements as Record<string, unknown>)[key];
      if (!entry || typeof entry !== "object" || !("value" in entry) || typeof entry.value !== "number" || !Number.isFinite(entry.value)) continue;
      const unit = "unit" in entry && typeof entry.unit === "string" && ["millisecond", "second", "none", "ratio", "percent", "byte"].includes(entry.unit) ? entry.unit : undefined;
      measurements[key] = { value: entry.value, ...(unit ? { unit } : {}) };
    }
    result.measurements = measurements;
  }
  return result as T;
}
function allowedChild(path: string, key: string): boolean {
  if (path === "envelope") return ["event_id", "sent_at", "sdk", "trace", "dsn"].includes(key);
  if (path === "envelope.sdk") return ["name", "version"].includes(key);
  if (path === "exception") return key === "values";
  if (path === "transaction_info") return key === "source";
  if (path === "measurements") return ["lcp", "fcp", "fid", "fp", "ttfb", "cls", "inp", "frames_total", "frames_slow", "frames_frozen"].includes(key);
  if (path.startsWith("measurements.")) return ["value", "unit"].includes(key);
  if (/^spans\[\d+\]$/.test(path)) return ["trace_id", "span_id", "parent_span_id", "op", "description", "start_timestamp", "timestamp", "status", "tags", "data", "origin", "links"].includes(key);
  if (/(?:^|\.)links\[\d+\]$/.test(path)) return ["trace_id", "span_id", "sampled", "attributes"].includes(key);
  if (/(?:^|\.)attributes\.[^\[\]]+$/.test(path)) return ["type", "value", "unit"].includes(key);
  if (/^discarded_events\[\d+\]$/.test(path)) return ["reason", "category", "quantity"].includes(key);
  if (path === "monitor_config") return ["schedule", "checkin_margin", "max_runtime", "timezone", "failure_issue_threshold", "recovery_threshold"].includes(key);
  if (path === "monitor_config.schedule") return ["type", "value", "unit"].includes(key);
  if (/^aggregates\[\d+\]$/.test(path)) return ["started", "exited", "errored", "abnormal", "crashed"].includes(key);
  if (["extra", "did", "ip_address", "user_agent"].includes(key) || ["vars", "pre_context", "post_context", "context_line"].includes(key)) return false;
  if (path === "sdkProcessingMetadata") return ["dynamicSamplingContext", "requestSession", "capturedSpanScope", "capturedSpanIsolationScope", "capturedSpanScopeAsString"].includes(key);
  if (path === "sdkProcessingMetadata.requestSession") return key === "status";
  if (path === "sdkProcessingMetadata.dynamicSamplingContext" || path === "envelope.trace") return ["trace_id", "public_key", "org_id", "environment", "release", "transaction", "sample_rate", "sampled", "sample_rand", "replay_id"].includes(key);
  if (path === "sdk") return ["name", "version", "integrations", "packages"].includes(key);
  if (/^sdk\.packages\[\d+\]$/.test(path)) return ["name", "version"].includes(key);
  if (path === "attrs") return ["release", "environment"].includes(key);
  if (path.endsWith("stacktrace") || path === "stacktrace") return key === "frames";
  if (/\.frames\[\d+\]$/.test(path)) return ["filename", "abs_path", "function", "module", "lineno", "colno", "in_app", "instruction_addr", "platform", "addr_mode", "function_id", "package", "symbol", "symbol_addr", "image_addr"].includes(key);
  if (/^exception\.values\[\d+\]\.mechanism$/.test(path)) return ["type", "handled", "synthetic", "exception_id", "parent_id", "source", "is_exception_group", "data", "meta"].includes(key);
  if (/^exception\.values\[\d+\]\.mechanism\.meta$/.test(path)) return ["errno", "signal", "mach_exception"].includes(key);
  if (path === "contexts") return Object.hasOwn(CONTEXT_FIELDS, key);
  if (path.startsWith("contexts.") && path.split(".").length === 2) return (CONTEXT_FIELDS[path.slice(9)] ?? []).includes(key);
  if (path === "tags" || /^spans\[\d+\]\.tags$/.test(path) || path === "attributes" || path.endsWith(".attributes") || path.endsWith(".data")) return OPERATIONAL_FIELDS.has(key) || ((path === "attributes" || path.endsWith(".attributes")) && SDK_ATTRIBUTES.has(key));
  if (/^breadcrumbs\[\d+\]$/.test(path)) return ["timestamp", "type", "category", "level", "message", "data"].includes(key);
  if (path === "request") return ["url", "method", "query_string"].includes(key);
  if (/^exception\.values\[\d+\]$/.test(path)) return ["type", "value", "module", "stacktrace", "mechanism", "thread_id"].includes(key);
  return path === "";
}
function isOperationalBag(path: string): boolean {
  return path === "tags" || /^spans\[\d+\]\.tags$/.test(path) || path === "attributes" || path.endsWith(".attributes") || path.endsWith(".data");
}
const SAFE_ROUTES = new Set(["ingest/usage", "otlp/v1/metrics", "/api/ingest/usage", "/api/otlp/v1/metrics", "/api/health", "/api/ready", "/login"]);
const SAFE_ERROR_CLASSES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError", "DOMException", "AbortError", "TimeoutError", "PrismaClientKnownRequestError", "PrismaClientUnknownRequestError", "PrismaClientInitializationError", "PrismaClientValidationError", "PrismaClientRustPanicError"]);
function safeBagValue(key: string, value: unknown): unknown {
  const typed = value && typeof value === "object" && "type" in value && "value" in value;
  const raw = typed ? (value as { value: unknown }).value : value;
  let clean: unknown = "[REDACTED]";
  if (typeof raw === "number" && Number.isFinite(raw) || typeof raw === "boolean") clean = raw;
  else if (typeof raw === "string" && raw.length <= 200) {
    if (key === "reason" && (SAFE_ERROR_CLASSES.has(raw) || ["unknown", "USAGE_SCHEDULER_ENABLED=false"].includes(raw))) clean = raw;
    else if ((key === "route" || key === "http.route") && SAFE_ROUTES.has(raw)) clean = raw;
    else if ((key === "outcome" || key === "status") && ["ok", "error", "disabled", "all_rejected", "partial", "success", "failure"].includes(raw)) clean = raw;
    else if ((key === "method" || key === "http.request.method") && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(raw)) clean = raw;
    else if ((key === "code" || key === "errno") && /^[A-Z][A-Z0-9_]{1,40}$/.test(raw)) clean = raw;
    else if (key === "region" && /^(?:us|eu|ap|sa|ca|me|af)-(?:east|west|north|south|central|northeast|southeast)-?\d$/.test(raw)) clean = raw;
    else if (key === "url" || key === "url.full") {
      clean = "[REDACTED]"; // Hosts and paths can identify end-user resources too.
    } else if (SDK_ATTRIBUTES.has(key) && key !== "sentry.segment.name" && key !== "http.route" && /^[A-Za-z0-9_.@:/-]{1,160}$/.test(raw)) clean = scrubString(raw);
  } else if (key === "sentry.sdk.integrations" && Array.isArray(raw) && raw.length <= 200 && raw.every(v => typeof v === "string" && /^[A-Za-z0-9_]{1,80}$/.test(v))) clean = raw;
  return typed ? { type: typeof clean === "number" ? (Number.isInteger(clean) ? "integer" : "double") : typeof clean === "boolean" ? "boolean" : Array.isArray(clean) ? "array" : "string", value: clean } : clean;
}
function contextString(path: string, value: string): string | undefined {
  const match = /^contexts\.([^.]+)\.([^.]+)$/.exec(path);
  if (!match) return undefined;
  const [, context, key] = match;
  if (key === "type") return value === context ? value : "[REDACTED]";
  if (["trace_id", "span_id", "parent_span_id"].includes(key)) return new RegExp(`^[a-f0-9]{${key === "trace_id" ? 32 : 16}}$`, "i").test(value) ? value : "[REDACTED]";
  if (["version", "build", "kernel_version", "app_version", "app_build"].includes(key)) return /^v?\d[0-9A-Za-z._+-]{0,79}$/.test(value) ? value : "[REDACTED]";
  if (key === "name") return ["node", "Node.js", "JavaScript", "v8", "Chrome", "Chromium", "Firefox", "Safari", "Edge", "Chrome Mobile", "Mobile Safari", "Linux", "Windows", "macOS", "iOS", "Android"].includes(value) ? value : "[REDACTED]";
  if (key === "arch") return ["arm64", "arm", "x64", "x86", "ia32", "amd64"].includes(value) ? value : "[REDACTED]";
  if (key === "app_identifier") return ["usage-monitor", "api-usage-monitor", "com.simplewithus.usage"].includes(value) ? value : "[REDACTED]";
  if (key === "status") return ["ok", "error", "unknown", "unknown_error", "invalid_argument", "not_found", "permission_denied", "unauthenticated", "cancelled", "deadline_exceeded", "resource_exhausted", "failed_precondition", "aborted", "out_of_range", "unimplemented", "internal_error", "unavailable", "data_loss", "already_exists"].includes(value) ? value : "[REDACTED]";
  if (key === "op" || key === "origin") return ["http.server", "http.client", "db", "db.query", "db.sql.query", "pageload", "navigation", "ui.action", "ui.action.click", "resource.script", "resource.css", "function", "manual", "auto.http.browser", "auto.http.otel.http", "auto.db.otel.sqlite"].includes(value) ? value : "[REDACTED]";
  return "[REDACTED]";
}
function stackLocation(path: string, value: string): string | undefined {
  if (!/\.frames\[\d+\]\.[^.]+$/.test(path)) return undefined;
  const key = path.slice(path.lastIndexOf(".") + 1);
  if (["filename", "abs_path"].includes(key)) {
    // Only content-free generated locations. Never forward hostnames, home
    // directories, request paths, source text, or arbitrary caller filenames.
    if (["app.js", "index.js"].includes(value)) return value;
    if (value.length <= 160 && /^(?:\/_next\/static\/chunks\/|\.next\/server\/chunks\/)?[a-f0-9]{8,64}(?:-[a-f0-9]{8,64})?\.js$/.test(value)) return value;
    return "[REDACTED]";
  }
  if (["instruction_addr", "symbol_addr", "image_addr"].includes(key)) return /^0x[a-f0-9]{1,16}$/i.test(value) ? value : "[REDACTED]";
  return "[REDACTED]";
}
function privateTextPath(path: string): boolean {
  return path === "message" || path === "logger" || path === "body" || path.startsWith("body.") || path.startsWith("body[") || /(?:^|\.)message(?:\.|$)/.test(path) ||
    /^exception\.values\[\d+\]\.value$/.test(path) ||
    (path === "transaction" || path.endsWith(".transaction")) ||
    path === "name" || path.endsWith(".description") || /^attributes\.sentry\.segment\.name(?:\.value)?$/.test(path);
}
function safeLabel(value: string): string {
  if (OPERATIONAL_MESSAGES.has(value)) return value;
  return "[REDACTED]";
}

function isSensitiveKey(key: string, path: string): boolean {
  // Preserve only SDK-owned public identifiers, never similarly named app keys.
  if (path === "sdkProcessingMetadata.dynamicSamplingContext.public_key" || path === "envelope.trace.public_key") return false;
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_SUBSTRINGS.some(part => lower.includes(part)) ||
    /^(user[._]|(?:http[._])?(?:request|response)[._](?:body|headers|cookies)|file[._]contents?$|gen_ai[._](?:input|output|prompt|completion))/.test(lower) ||
    ["cookie", "cookies", "email", "filecontents", "filecontent"].includes(lower);
}

function scrubString(value: string): string {
  // Query values can contain search text or other private content even when
  // the parameter name looks benign.  Keep names for diagnostics, not values.
  return value
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+(?::[^\s/@]*)?@/gi, "[REDACTED_URL]@")
    .replace(/\b(?:sk-(?:ant-|proj-)?|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/(["']?(?:password|passwd|secret|token|api[_-]?key|credentials)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^,;&\s]+)/gi, "$1[REDACTED]")
    .replace(/([?&]|^)([^?&=\s"']+)=([^&\s"']*)/g,
    (_match, prefix, name) => `${prefix}${name}=[REDACTED]`
  ).replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.~=-]+/gi, "$1 [REDACTED]");
}

interface ScrubState { serialized?: boolean; ancestors: WeakSet<object>; budget: { remaining: number; characters: number } }
function scrubObject<T>(input: T, path = "", state: ScrubState = { ancestors: new WeakSet(), budget: { remaining: 50_000, characters: 1_000_000 } }, depth = 0): T {
  if (--state.budget.remaining < 0) throw new Error("Sentry redaction budget exceeded");
  const { ancestors } = state;
  if (/(?:exception\.values|frames|spans|links|breadcrumbs)\[\d+\]$/.test(path) && (!input || typeof input !== "object" || Array.isArray(input))) throw new Error("Invalid diagnostic record");
  if (typeof input === "string") {
    state.budget.characters -= input.length;
    if (state.budget.characters < 0) throw new Error("Sentry redaction character budget exceeded");
    const scrubbed = stackLocation(path, input) ?? contextString(path, input) ?? (path === "transaction_info.source" ? (["custom", "url", "route", "view", "component", "task"].includes(input) ? input : "[REDACTED]") : path === "request.method" ? (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(input) ? input : "[REDACTED]") : path === "request.query_string" ? "[REDACTED]" : path === "request.url" ? String(safeBagValue("url", input)) : /^exception\.values\[\d+\]\.type$/.test(path) ? (SAFE_ERROR_CLASSES.has(input) ? input : "Error") : privateTextPath(path) ? safeLabel(input) : scrubString(input));
    state.budget.characters -= Math.max(0, scrubbed.length - input.length);
    if (state.budget.characters < 0) throw new Error("Sentry redaction character budget exceeded");
    return scrubbed as T;
  }
  if (typeof input === "function" || typeof input === "symbol") return "[REDACTED]" as T;
  if (input === null || typeof input !== "object") return input;
  if (ancestors.has(input)) return "[CIRCULAR]" as T;
  // Total work/output is bounded, including duplicate subtrees.  Memoized
  // aliases alone would still expand exponentially during JSON serialization.
  if (depth > 40) return "[REDACTED]" as T;
  ancestors.add(input);
  if (Array.isArray(input)) {
    if (input.length > state.budget.remaining) throw new Error("Sentry redaction budget exceeded");
    const out: unknown[] = [];
    for (let i = 0; i < input.length; i++) out.push(scrubObject(input[i], `${path}[${i}]`, state, depth + 1));
    ancestors.delete(input);
    return out as T;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(input)) {
    if (--state.budget.remaining < 0) throw new Error("Sentry redaction budget exceeded");
    state.budget.characters -= key.length;
    if (state.budget.characters < 0) throw new Error("Sentry redaction character budget exceeded");
    if (!allowedChild(path, key)) continue;
    const value = (input as Record<string, unknown>)[key];
    const childPath = path ? `${path}.${key}` : key;
    if ((path === "exception" && key === "values" || path.endsWith("stacktrace") && key === "frames") && !Array.isArray(value)) throw new Error("Invalid diagnostic list");
    if (key === "links" && value !== undefined && !Array.isArray(value)) throw new Error("Invalid diagnostic links");
    if ((/^spans\[\d+\]$/.test(path) || /(?:^|\.)links\[\d+\]$/.test(path)) && !["tags", "data", "links", "attributes"].includes(key) && value !== null && typeof value === "object") throw new Error("Invalid span scalar");
    if (SDK_INTERNAL_CYCLIC_PATHS.has(childPath)) { out[key] = "[SDK_INTERNAL]"; continue; }
    if (["user", "request.data", "request.cookies", "request.headers"].includes(childPath)) continue;
    if ((/^contexts\.[^.]+$/.test(path) || path === "request" || /\.frames\[\d+\]$/.test(path) || path === "sdkProcessingMetadata.dynamicSamplingContext" || path === "envelope.trace") && value !== null && typeof value === "object") {
      out[key] = "[REDACTED]";
    } else if (/^exception\.values\[\d+\]\.value$/.test(childPath)) {
      out[key] = "[REDACTED]";
    } else if (isOperationalBag(path)) {
      let clean = safeBagValue(key, value);
      if (path !== "attributes" && !path.endsWith(".attributes") && clean && typeof clean === "object" && "value" in clean) clean = clean.value;
      if (state.serialized && (path === "attributes" || path.endsWith(".attributes")) && (!clean || typeof clean !== "object" || !("type" in clean && "value" in clean))) {
        clean = { type: typeof clean === "number" ? (Number.isInteger(clean) ? "integer" : "double") : typeof clean === "boolean" ? "boolean" : "string", value: clean };
      }
      out[key] = scrubObject(clean, childPath, state, depth + 1);
    } else if (isSensitiveKey(key, childPath)) {
      // Preserve serialized v11 attribute type/value wire structure.
      out[key] = value && typeof value === "object" && "type" in value && "value" in value
        ? { type: "string", value: "[REDACTED]" } : "[REDACTED]";
    } else out[key] = scrubObject(value, childPath, state, depth + 1);
  }
  ancestors.delete(input);
  return out as T;
}

export function sentryBeforeSend(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  try { return scrubObject(projectEvent(event)); } catch { return null; }
}
export function sentryBeforeSendTransaction(event: TransactionEvent, _hint: EventHint): TransactionEvent | null {
  try { return scrubObject(projectEvent(event)); } catch { return null; }
}
export function sentryBeforeSendLog(log: Log): Log | null {
  try { return scrubObject(projectWireRow(log, "log")); } catch { return null; }
}
export function sentryBeforeSendMetric(metric: Metric): Metric | null {
  try { return scrubObject(projectWireRow(metric, "trace_metric")); } catch { return null; }
}

/** v11 ignores beforeSendTransaction for streamed spans.  Returning null or
 * throwing here sends the original span, so return a content-free fallback. */
export function sentryBeforeSendSpan(span: StreamedSpanJSON): StreamedSpanJSON {
  try { return scrubObject(projectWireRow(span, "span")); } catch {
    const safeId = (key: "trace_id" | "span_id", length: number): string => {
      try {
        const value = Object.getOwnPropertyDescriptor(span, key)?.value;
        if (typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "i").test(value)) return value;
      } catch { /* No arbitrary getters in fallback. */ }
      return "0".repeat(length);
    };
    return { trace_id: safeId("trace_id", 32), span_id: safeId("span_id", 16),
      name: "[REDACTED]", start_timestamp: 0, end_timestamp: 0,
      status: "error", is_segment: false, attributes: {} };
  }
}

/** Final boundary for scope attributes and trace headers added after hooks.
 * Opaque attachments and recordings are outside the permitted telemetry. */
export function sentryPrivacyIntegration(): Integration {
  return {
    name: "UsageMonitorPrivacy",
    setup(client) {
      client.on("beforeEnvelope", envelope => {
        const reportDrop = (type: Parameters<typeof envelopeItemTypeToDataCategory>[0], count = 1) => {
          if (type === "client_report" || count <= 0) return;
          try { client.recordDroppedEvent("before_send", envelopeItemTypeToDataCategory(type), count); }
          catch { /* Observability must not break the privacy boundary. */ }
        };
        try {
          // SDK v11.3 buffers up to 100 logs or 1000 metrics/spans; its span
          // buffer flushes at an estimated 5 MB.  Allow normal full batches,
          // while keeping one finite aggregate budget across the envelope.
          const state: ScrubState = { ancestors: new WeakSet(), budget: { remaining: 250_000, characters: 6_000_000 } };
          if (envelope[1].length > 1000) throw new Error("Invalid envelope item count");
          envelope[0] = scrubObject(envelope[0], "envelope", state);
          // Process errors first within the shared finite envelope budget.
          envelope[1].sort((a, b) => Number(a[0].type === "event") - Number(b[0].type === "event"));
          for (let i = envelope[1].length - 1; i >= 0; i--) {
            const item = envelope[1][i]!;
            if (!["event", "transaction", "span", "log", "trace_metric", "check_in", "client_report"].includes(item[0].type) ||
                !item[1] || typeof item[1] !== "object" || item[1] instanceof Uint8Array) {
              reportDrop(item[0].type);
              envelope[1].splice(i, 1); continue;
            }
            try {
            // v11 batches independent telemetry rows.  Share one envelope-wide
            // work budget, but isolate unsafe rows and their ancestor sets.
            if (["span", "log", "trace_metric"].includes(item[0].type)) {
              const payload = item[1] as { items?: unknown[]; [key: string]: unknown };
              if (!Array.isArray(payload.items) || payload.items.length > 1000) { reportDrop(item[0].type, Array.isArray(payload.items) ? payload.items.length : 1); envelope[1].splice(i, 1); continue; }
              const items = payload.items;
              if (payload.version !== undefined && payload.version !== 2) { reportDrop(item[0].type, items.length); envelope[1].splice(i, 1); continue; }
              // Preserve protocol metadata and explicit no-inference controls;
              // unknown SDK/container metadata is not copied to the wire.
              const sanitizedMetadata = {
                ...(payload.version === 2 ? { version: 2 } : {}),
                ...(payload.ingest_settings !== undefined ? { ingest_settings: { infer_ip: "never", infer_user_agent: "never" } } : {}),
              };
              const sanitized: unknown[] = [];
              for (const row of items) {
                if (!row || typeof row !== "object" || Array.isArray(row)) { reportDrop(item[0].type); continue; }
                try { sanitized.push(scrubObject(projectWireRow(row, item[0].type), "", { serialized: true, ancestors: new WeakSet(), budget: state.budget })); } catch { reportDrop(item[0].type); }
              }
              if (sanitized.length === 0) { envelope[1].splice(i, 1); continue; }
              item[1] = { ...sanitizedMetadata, items: sanitized } as typeof item[1];
              if ("item_count" in item[0]) item[0].item_count = sanitized.length;
            } else item[1] = scrubObject(item[0].type === "event" || item[0].type === "transaction" ? projectEvent(item[1]) : projectAuxiliary(item[1], item[0].type), "", { ancestors: new WeakSet(), budget: state.budget }) as typeof item[1];
            delete item[0].length;
            } catch { reportDrop(item[0].type); envelope[1].splice(i, 1); }
          }
        } catch {
          for (const [header, payload] of envelope[1]) {
            let count = 1;
            try {
              if (["span", "log", "trace_metric"].includes(header.type) && payload && typeof payload === "object" && "items" in payload && Array.isArray(payload.items)) count = payload.items.length;
            } catch { /* Unreadable count: retain one bounded diagnostic. */ }
            reportDrop(header.type, count);
          }
          envelope[0] = {};
          envelope[1].splice(0);
        }
      });
    },
  };
}
