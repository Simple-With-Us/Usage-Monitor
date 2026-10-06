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
  return value.replace(/([?&]|^)([^?&=\s"']+)=([^&\s"']*)/g, (match, prefix, name) => {
    let decoded: string;
    try { decoded = decodeURIComponent(name.replace(/\+/g, " ")).toLowerCase(); }
    catch { return `${prefix}${name}=[REDACTED]`; }
    const sensitive = SENSITIVE_KEY_SUBSTRINGS.some(part => decoded.includes(part)) || /^(signature|sig|x-amz-|x-goog-)/.test(decoded);
    return sensitive ? `${prefix}${name}=[REDACTED]` : match;
  }).replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.~=-]+/gi, "$1 [REDACTED]");
}

function scrubObject<T>(input: T, path = "", ancestors = new WeakSet<object>(), depth = 0): T {
  if (typeof input === "string") return scrubString(input) as T;
  if (typeof input === "function" || typeof input === "symbol") return "[REDACTED]" as T;
  if (input === null || typeof input !== "object") return input;
  if (ancestors.has(input)) return "[CIRCULAR]" as T;
  if (depth > 40) return "[REDACTED]" as T;
  ancestors.add(input);
  if (Array.isArray(input)) {
    const out = input.map((entry, i) => scrubObject(entry, `${path}[${i}]`, ancestors, depth + 1));
    ancestors.delete(input);
    return out as T;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (SDK_INTERNAL_CYCLIC_PATHS.has(childPath)) { out[key] = "[SDK_INTERNAL]"; continue; }
    if (["user", "request.data", "request.cookies", "request.headers"].includes(childPath)) continue;
    if (isSensitiveKey(key, childPath)) {
      // Preserve serialized v11 attribute type/value wire structure.
      out[key] = value && typeof value === "object" && "type" in value && "value" in value
        ? { type: "string", value: "[REDACTED]" } : "[REDACTED]";
    } else out[key] = scrubObject(value, childPath, ancestors, depth + 1);
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
            item[1] = scrubObject(item[1]);
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
