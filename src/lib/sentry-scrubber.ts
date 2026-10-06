/** Shared final redaction for browser, server and edge Sentry payloads.
 * Unreadable payloads fail closed rather than returning unsanitized input. */
import type { ErrorEvent, EventHint, Log, Metric, TransactionEvent, StreamedSpanJSON, Integration } from "@sentry/core";

const SENSITIVE_KEY_SUBSTRINGS = ["token", "secret", "key", "password", "passwd", "auth"];
const SDK_INTERNAL_CYCLIC_PATHS = new Set([
  "sdkProcessingMetadata.capturedSpanScope",
  "sdkProcessingMetadata.capturedSpanIsolationScope",
  "sdkProcessingMetadata.capturedSpanScopeAsString",
]);

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
  return value.replace(/([?&]|^)([^?&=\s"']+)=([^&\s"']*)/g,
    (_match, prefix, name) => `${prefix}${name}=[REDACTED]`
  ).replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.~=-]+/gi, "$1 [REDACTED]");
}

interface ScrubState { ancestors: WeakSet<object>; remaining: number; characters: number }
function scrubObject<T>(input: T, path = "", state: ScrubState = { ancestors: new WeakSet(), remaining: 2000, characters: 100_000 }, depth = 0): T {
  if (--state.remaining < 0) throw new Error("Sentry redaction budget exceeded");
  const { ancestors } = state;
  if (typeof input === "string") {
    state.characters -= input.length;
    if (state.characters < 0) throw new Error("Sentry redaction character budget exceeded");
    return scrubString(input) as T;
  }
  if (typeof input === "function" || typeof input === "symbol") return "[REDACTED]" as T;
  if (input === null || typeof input !== "object") return input;
  if (ancestors.has(input)) return "[CIRCULAR]" as T;
  // Total work/output is bounded, including duplicate subtrees.  Memoized
  // aliases alone would still expand exponentially during JSON serialization.
  if (depth > 40) return "[REDACTED]" as T;
  ancestors.add(input);
  if (Array.isArray(input)) {
    if (input.length > state.remaining) throw new Error("Sentry redaction budget exceeded");
    const out: unknown[] = [];
    for (let i = 0; i < input.length; i++) out.push(scrubObject(input[i], `${path}[${i}]`, state, depth + 1));
    ancestors.delete(input);
    return out as T;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(input)) {
    if (--state.remaining < 0) throw new Error("Sentry redaction budget exceeded");
    state.characters -= key.length;
    if (state.characters < 0) throw new Error("Sentry redaction character budget exceeded");
    const value = (input as Record<string, unknown>)[key];
    const childPath = path ? `${path}.${key}` : key;
    if (SDK_INTERNAL_CYCLIC_PATHS.has(childPath)) { out[key] = "[SDK_INTERNAL]"; continue; }
    if (["user", "request.data", "request.cookies", "request.headers"].includes(childPath)) continue;
    if (isSensitiveKey(key, childPath)) {
      // Preserve serialized v11 attribute type/value wire structure.
      out[key] = value && typeof value === "object" && "type" in value && "value" in value
        ? { type: "string", value: "[REDACTED]" } : "[REDACTED]";
    } else out[key] = scrubObject(value, childPath, state, depth + 1);
  }
  ancestors.delete(input);
  return out as T;
}

export function sentryBeforeSend(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  try { return scrubObject(event); } catch { return null; }
}
export function sentryBeforeSendTransaction(event: TransactionEvent, _hint: EventHint): TransactionEvent | null {
  try { return scrubObject(event); } catch { return null; }
}
export function sentryBeforeSendLog(log: Log): Log | null {
  try { return scrubObject(log); } catch { return null; }
}
export function sentryBeforeSendMetric(metric: Metric): Metric | null {
  try { return scrubObject(metric); } catch { return null; }
}

/** v11 ignores beforeSendTransaction for streamed spans.  Returning null or
 * throwing here sends the original span, so return a content-free fallback. */
export function sentryBeforeSendSpan(span: StreamedSpanJSON): StreamedSpanJSON {
  try { return scrubObject(span); } catch {
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
        try {
          envelope[0] = scrubObject(envelope[0], "envelope");
          for (let i = envelope[1].length - 1; i >= 0; i--) {
            const item = envelope[1][i]!;
            if (["attachment", "replay_event", "replay_recording"].includes(item[0].type) ||
                !item[1] || typeof item[1] !== "object" || item[1] instanceof Uint8Array) {
              envelope[1].splice(i, 1); continue;
            }
            // v11 batches independent telemetry rows.  Bound each row rather
            // than dropping a normal batch merely because its total is large.
            if (["span", "log", "trace_metric"].includes(item[0].type)) {
              const payload = item[1] as { items?: unknown[]; [key: string]: unknown };
              if (!Array.isArray(payload.items) || payload.items.length > 1000) throw new Error("Invalid telemetry batch");
              const { items, ...metadata } = payload;
              const sanitized: unknown[] = [];
              for (const row of items) {
                if (!row || typeof row !== "object" || Array.isArray(row)) continue;
                try { sanitized.push(scrubObject(row)); } catch { /* Drop only the unsafe row. */ }
              }
              if (sanitized.length === 0) { envelope[1].splice(i, 1); continue; }
              item[1] = { ...scrubObject(metadata), items: sanitized } as typeof item[1];
              if ("item_count" in item[0]) item[0].item_count = sanitized.length;
            } else item[1] = scrubObject(item[1]);
            delete item[0].length;
          }
        } catch {
          envelope[0] = {};
          envelope[1].splice(0);
        }
      });
    },
  };
}
