import { describe, expect, it } from "vitest";
import { sentryBeforeSend, sentryBeforeSendTransaction, sentryBeforeSendLog, sentryBeforeSendMetric, sentryBeforeSendSpan } from "../sentry-scrubber";

describe("class/stack and explicit operational telemetry", () => {
  it("drops caller extra, unrecognized root fields and private contexts", () => {
    const result = sentryBeforeSend({ type: undefined, extra: { credentials: "denied", prompt: "denied", benignValue: "also private" },
      contexts: { custom: { environment: "denied" }, runtime: { name: "node", version: "24.0", privateContent: "denied" } },
      unrecognized: "denied", user: { email: "denied@example.test" },
    } as never, {});
    expect(result?.extra).toBeUndefined(); expect(result?.user).toBeUndefined();
    expect(result?.contexts).toEqual({ runtime: { name: "node", version: "24.0" } });
    expect(JSON.stringify(result)).not.toContain("denied");
  });
  it("preserves exception class and locations, never message/locals/source content", () => {
    const result = sentryBeforeSend({ type: undefined, exception: { values: [{ type: "TypeError", value: "denied prompt postgres://demo:denied@db/test", stacktrace: { frames: [{ filename: "app.js", lineno: 42, colno: 7, function: "loadQuota", vars: { customer: "denied" }, context_line: "denied", pre_context: ["denied"], post_context: ["denied"] }] } }] } }, {});
    expect(result?.exception?.values?.[0]?.type).toBe("TypeError");
    expect(result?.exception?.values?.[0]?.value).toBe("[REDACTED]");
    expect(result?.exception?.values?.[0]?.stacktrace?.frames?.[0]).toEqual({ filename: "app.js", lineno: 42, colno: 7, function: "[REDACTED]" });
    expect(JSON.stringify(result)).not.toContain("denied");
  });
  it("retains only safe operational bag values", () => {
    const result = sentryBeforeSend({ type: undefined, tags: { region: "us-east-1", outcome: "ok", customer_name: "denied", reason: "denied free form" }, breadcrumbs: [{ message: "denied user content", data: { route: "ingest/usage", total: 3, email_address: "denied@example.test", prompt: "denied" } }] }, {});
    expect(result?.tags).toEqual({ region: "us-east-1", outcome: "ok", reason: "[REDACTED]" });
    expect(result?.breadcrumbs?.[0]).toEqual({ message: "[REDACTED]", data: { route: "ingest/usage", total: 3 } });
  });
  it("removes request path/query contents, headers, cookies and bodies", () => {
    const result = sentryBeforeSend({ type: undefined, request: { url: "https://demo:denied@example.test/private/denied?token=denied", query_string: "denied=denied", headers: { authorization: "denied" }, cookies: { session: "denied" }, data: "denied" } }, {});
    expect(result?.request).toEqual({ url: "[REDACTED]", query_string: "[REDACTED]" });
  });
  it("preserves only SDK-owned sampling metadata and safely handles internal cycles", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const result = sentryBeforeSend({ type: undefined, sdkProcessingMetadata: { dynamicSamplingContext: { public_key: "public", trace_id: "trace", transaction: "denied" }, capturedSpanScope: cycle, capturedSpanIsolationScope: cycle, requestSession: { status: "ok" }, privatePayload: "denied" } } as never, {});
    expect(result?.sdkProcessingMetadata?.dynamicSamplingContext).toEqual({ public_key: "public", trace_id: "trace", transaction: "[REDACTED]" });
    expect(result?.sdkProcessingMetadata?.capturedSpanScope).toBe("[SDK_INTERNAL]");
    expect(result?.sdkProcessingMetadata?.requestSession).toEqual({ status: "ok" });
    expect(JSON.stringify(result)).not.toContain("denied");
  });
  it("applies the same boundary to transactions", () => {
    const result = sentryBeforeSendTransaction({ type: "transaction", transaction: "denied user path", extra: { environment: "denied" }, tags: { outcome: "ok" } } as never, {});
    expect(result?.transaction).toBe("[REDACTED]"); expect(result?.extra).toBeUndefined();
  });
  it("preserves curated health log labels and metric names", () => {
    expect(sentryBeforeSendLog({ level: "warn", message: "ingest.failed", attributes: { route: "ingest/usage", reason: "TypeError", credentials: "denied" } } as never)).toEqual({ level: "warn", message: "ingest.failed", attributes: { route: "ingest/usage", reason: "TypeError" } });
    expect(sentryBeforeSendMetric({ name: "scheduler.tick", type: "counter", value: 1, attributes: { outcome: "ok", total: 4, prompt: "denied" } } as never)).toEqual({ name: "scheduler.tick", type: "counter", value: 1, attributes: { outcome: "ok", total: 4 } });
  });
  it("does not forward an arbitrary message or metric name", () => {
    expect(sentryBeforeSendLog({ level: "error", message: "denied user prompt" } as never)?.message).toBe("[REDACTED]");
    expect(sentryBeforeSendMetric({ name: "denied-user-content", type: "counter", value: 1 } as never)).toBeNull();
  });
  it("masks credential patterns in retained stack locations", () => {
    const result = sentryBeforeSend({ type: undefined, exception: { values: [{ type: "TypeError", value: "denied body", stacktrace: { frames: [{ filename: "https://demo:denied-userinfo@example.test/app.js?api_key=denied-query", function: "load password: denied-inline" }] } }] } }, {});
    expect(JSON.stringify(result)).not.toContain("denied");
    expect(result?.exception?.values?.[0]?.type).toBe("TypeError");
  });
  it("fails closed on unreadable permitted fields", () => {
    const malformed = { type: undefined, get exception(): never { throw Error("denied"); } };
    expect(sentryBeforeSend(malformed, {})).toBeNull();
    expect(sentryBeforeSendTransaction(malformed as never, {})).toBeNull();
  });
  it("projects nested containers and rejects malformed protocol shapes", () => {
    const result = sentryBeforeSend({ exception: { description: "denied", values: [] }, transaction_info: { source: "route", details: "denied" }, measurements: { arbitrary: { value: "denied" }, lcp: { value: 12, unit: "millisecond", extra: "denied" } } } as never, {});
    expect(JSON.stringify(result)).not.toContain("denied");
    expect(result?.measurements).toEqual({ lcp: { value: 12, unit: "millisecond" } });
    for (const field of ["release", "environment", "dist", "platform", "event_id"]) expect(sentryBeforeSend({ [field]: { note: "denied" } } as never, {})).toBeNull();
    expect(sentryBeforeSend({ spans: ["denied"] } as never, {})).toBeNull();
    expect(sentryBeforeSend({ exception: { values: "denied" } } as never, {})).toBeNull();
    for (const invalid of [{ links: { note: "denied" } }, { name: { note: "denied" } }, { status: { note: "denied" } }]) {
      const span = sentryBeforeSendSpan({ trace_id: "a".repeat(32), span_id: "b".repeat(16), name: "safe", start_timestamp: 1, status: "ok", is_segment: false, attributes: {}, ...invalid } as never);
      expect(span.name).toBe("[REDACTED]"); expect(span.links).toBeUndefined();
    }
  });

  it("bounds classes and locations without allowing free-text filename or symbol bypass", () => {
    const result = sentryBeforeSend({ exception: { values: [{ type: "denied-private-name", value: "denied", stacktrace: { frames: [{ filename: "/home/denied/private.js", function: "denied", module: "denied", lineno: 5 }, { filename: "/_next/static/chunks/abcdef123456.js", lineno: 9 }] } }] } } as never, {});
    expect(JSON.stringify(result)).not.toContain("denied");
    expect(result?.exception?.values?.[0]?.type).toBe("Error");
    expect(result?.exception?.values?.[0]?.stacktrace?.frames?.[1]?.filename).toBe("/_next/static/chunks/abcdef123456.js");
  });

});
