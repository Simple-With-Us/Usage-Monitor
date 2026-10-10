// Deliberate malformed-input fixtures and partial SDK mocks cross typed boundaries
// via as never; real SDK transport tests separately validate supported wire shapes.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { NodeClient, defaultStackParser } from "@sentry/node";
import { BrowserClient, defaultStackParser as browserStackParser, init as initBrowser, startSpan, getCurrentScope, setUser, logger, metrics } from "@sentry/browser";
import { forEachEnvelopeItem, type Envelope } from "@sentry/core";
import { middleware } from "@/middleware";
import { sentryConnectSrcOrigins } from "../sentry-options";
import { sentryPrivacyIntegration, sentryBeforeSendSpan, sentryBeforeSend, sentryBeforeSendTransaction, sentryBeforeSendLog, sentryBeforeSendMetric } from "../sentry-scrubber";
const DSN = "https://0123456789abcdef@o123.ingest.us.sentry.io/456";
afterEach(() => vi.unstubAllEnvs());
function transport(envelopes: Envelope[]) {
  return { send: async (envelope: Envelope) => { envelopes.push(envelope); return { statusCode: 200 }; }, flush: async () => true };
}
function expectTypedAttributes(envelopes: Envelope[]) {
  for (const envelope of envelopes) forEachEnvelopeItem(envelope, (item, type) => {
    if (!["log", "trace_metric", "span"].includes(type)) return;
    const payload = item[1] as { items: Array<{ attributes: Record<string, unknown> }> };
    for (const entry of payload.items) for (const attr of Object.values(entry.attributes)) {
      expect(attr).toEqual(expect.objectContaining({ type: expect.any(String), value: expect.anything() }));
    }
  });
}

describe("Sentry configured-origin CSP", () => {
  it("adds only its origin, without DSN key or project", () => {
    vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", DSN);
    expect(sentryConnectSrcOrigins()).toEqual(["https://o123.ingest.us.sentry.io"]);
    const csp = middleware(new NextRequest("https://example.test/login")).headers.get("Content-Security-Policy");
    if (!csp) throw new Error("Expected Content-Security-Policy header");
    expect(csp).toContain("connect-src 'self' https://o123.ingest.us.sentry.io");
    expect(csp).not.toContain("0123456789abcdef");
    expect(csp).not.toContain("/456");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });
  it.each(["", "not a dsn", DSN.replace("https:", "http:"), DSN.replace(".sentry.io", ".sentry.io.evil.test"), DSN.replace("o123.ingest.us.sentry.io", "evil.test"), DSN.replace("@", ":secret@"), DSN+"?token=x", DSN+"#fragment", DSN.replace("/456", ":444/456"), DSN.replace("/456", "/bad"), DSN+"; connect-src *"])("rejects %s", value => expect(sentryConnectSrcOrigins(value)).toEqual([]));
});

describe("Real SDK sanitized envelopes", () => {
  it.each(["node", "browser"])("delivers %s errors with tracing off", async runtime => {
    const envelopes: Envelope[] = []; let url = "";
    const Client = runtime === "node" ? NodeClient : BrowserClient;
    const client = new Client({ dsn: DSN, integrations: [sentryPrivacyIntegration()], tracesSampleRate: 0,
      stackParser: runtime === "node" ? defaultStackParser : browserStackParser,
      beforeSend: sentryBeforeSend,
      transport: options => { url = options.url; return transport(envelopes); },
    });
    client.init();
    client.captureException(new Error("synthetic delivery ?%74oken=denied-token"), {
      captureContext: { extra: { password: "denied-password", list: ["?token=denied-array"], credentials: "denied-credentials", database_url: "postgres://demo:denied-password@db/test", prompt: "denied-prompt", environment: { OTHER: "denied-env" }, email_address: "denied@example.test", customer_name: "denied-customer" }, contexts: { privateContext: { content: "denied-context" } }, tags: { customer_name: "denied-customer", outcome: "denied-private-status" } },
    });
    expect(await client.flush(2000)).toBe(true);
    const events: unknown[] = [];
    for (const envelope of envelopes) forEachEnvelopeItem(envelope, (item, type) => { if (type === "event") events.push(item); });
    expect(events).toHaveLength(1);
    expect(url).toContain("https://o123.ingest.us.sentry.io/api/456/envelope/");
    const serialized = JSON.stringify(envelopes);
    expect(serialized).toContain('"type":"Error"'); expect(serialized).toContain("[REDACTED]"); expect(serialized).not.toContain("denied");
    await client.close();
  });
  it("delivers a normal breadcrumb-heavy error with sixty stack frames", async () => {
    const envelopes: Envelope[] = [];
    const client = new NodeClient({ dsn: DSN, integrations: [sentryPrivacyIntegration()], stackParser: defaultStackParser,
      beforeSend: sentryBeforeSend, transport: () => transport(envelopes) });
    client.init();
    client.captureEvent({ exception: { values: [{ type: "Error", value: "synthetic full error", stacktrace: { frames: Array.from({ length: 60 }, (_, i) => ({ filename: "synthetic.js", function: "synthetic", lineno: i + 1, colno: 1, in_app: true, module: "synthetic", abs_path: "/synthetic.js", context_line: "synthetic" })) } }] },
      breadcrumbs: Array.from({ length: 100 }, (_, i) => ({ timestamp: i, category: "console", level: "info" as const, type: "default", message: "synthetic breadcrumb", data: { operation: "synthetic", index: i, source: "synthetic" } })) });
    expect(await client.flush(2000)).toBe(true);
    expect(JSON.stringify(envelopes)).toContain('"lineno":60');
    expect(JSON.stringify(envelopes)).not.toContain("synthetic breadcrumb");
    await client.close();
  });
  it("delivers SDK-sized batches of 100 logs and 1000 metrics/spans", async () => {
    const envelopes: Envelope[] = [];
    const client = initBrowser({ dsn: DSN, defaultIntegrations: [], integrations: [sentryPrivacyIntegration()], tracesSampleRate: 1,
      beforeSendSpan: sentryBeforeSendSpan, beforeSendLog: sentryBeforeSendLog, beforeSendMetric: sentryBeforeSendMetric,
      transport: () => transport(envelopes) });
    for (let i = 0; i < 100; i++) logger.info("synthetic batch log", { route: "synthetic", outcome: "ok", index: i });
    for (let i = 0; i < 1000; i++) metrics.count("scheduler.tick", 1, { attributes: { route: "synthetic", outcome: "ok", index: i } });
    startSpan({ name: "synthetic batch root" }, () => {
      for (let i = 0; i < 1000; i++) startSpan({ name: "synthetic child", attributes: { "http.request.method": "GET", "http.response.status_code": 200, "url.full": "https://example.test/path?private=denied", "synthetic.index": i } }, () => {});
    });
    expect(await client!.flush(5000)).toBe(true);
    const counts: Record<string, number> = {};
    for (const envelope of envelopes) forEachEnvelopeItem(envelope, (item, type) => {
      if (["log", "trace_metric", "span"].includes(type)) counts[type] = (counts[type] ?? 0) + (item[1] as { items: unknown[] }).items.length;
    });
    expect(counts).toMatchObject({ log: 100, trace_metric: 1000, span: 1001 });
    expect(JSON.stringify(envelopes)).not.toContain("denied");
    expectTypedAttributes(envelopes);
    await client!.close();
  });
  it("keeps SDK client-report drop counts usable without payload contents", async () => {
    class ReportClient extends NodeClient { flushReports() { this._flushOutcomes(); } }
    const envelopes: Envelope[] = [];
    const client = new ReportClient({ dsn: DSN, integrations: [sentryPrivacyIntegration()], stackParser: defaultStackParser,
      sendClientReports: true, beforeSend: sentryBeforeSend, transport: () => transport(envelopes) });
    client.init();
    client.captureEvent({ message: "x".repeat(1_100_000) });
    await client.flush(2000);
    await client.sendEnvelope([{}, [[{ type: "log", item_count: 2 }, { items: [{ body: "synthetic safe row", attributes: {} }, { get body(): never { throw Error("denied-payload"); } }] }]]] as unknown as Envelope);
    client.recordDroppedEvent("ignored", "error", 1);
    client.flushReports();
    await client.flush(2000);
    const outcomes: unknown[] = [];
    for (const envelope of envelopes) forEachEnvelopeItem(envelope, (item, type) => {
      if (type === "client_report") outcomes.push(...(item[1] as { discarded_events: unknown[] }).discarded_events);
    });
    expect(outcomes).toEqual(expect.arrayContaining([
      { reason: "before_send", category: "error", quantity: 1 },
      { reason: "before_send", category: "log_item", quantity: 1 },
      { reason: "ignored", category: "error", quantity: 1 },
    ]));
    expect(JSON.stringify(envelopes)).not.toContain("denied-payload");
    expect(JSON.stringify(envelopes)).not.toContain("synthetic oversized diagnostic");
    await client.close();
  });
  it("redacts streamed spans and envelope trace headers", async () => {
    const envelopes: Envelope[] = [];
    const client = initBrowser({ dsn: DSN, defaultIntegrations: [], integrations: [sentryPrivacyIntegration()], tracesSampleRate: 1,
      beforeSendSpan: sentryBeforeSendSpan, transport: () => transport(envelopes) });
    startSpan({ name: "synthetic ?%74oken=denied-span", attributes: { "url.full": "https://example.test/?x-amz-signature=denied-signature", "user.email": "denied@example.test", "http.request.body": "denied-body" } }, () => {});
    expect(await client!.flush(2000)).toBe(true);
    expect(JSON.stringify(envelopes)).toContain('"type":"span"');
    expect(JSON.stringify(envelopes)).not.toContain("denied");
    expectTypedAttributes(envelopes);
    await client!.close();
  });
  it("never transports the SDK-serialized fallback marker and preserves safe siblings", async () => {
    const envelopes: Envelope[] = [];
    let rejectedId = "";
    const client = initBrowser({ dsn: DSN, defaultIntegrations: [], integrations: [sentryPrivacyIntegration()], tracesSampleRate: 1,
      beforeSend: sentryBeforeSend,
      beforeSendSpan: span => {
        if (span.name === "force-fallback") {
          rejectedId = span.span_id;
          return sentryBeforeSendSpan({ ...span, get attributes(): never { throw Error("denied"); } });
        }
        return sentryBeforeSendSpan(span);
      }, transport: () => transport(envelopes) });
    if (!client) throw Error("Expected browser client");
    const drops = vi.spyOn(client, "recordDroppedEvent");
    startSpan({ name: "force-fallback" }, () => {});
    startSpan({ name: "safe sibling" }, () => {});
    client.captureEvent({ exception: { values: [{ type: "TypeError", value: "denied" }] } });
    await client.flush(2000);
    const output = JSON.stringify(envelopes);
    expect(output).not.toContain(rejectedId);
    expect(output).not.toContain("usage_monitor.redaction_failed");
    expect(output).not.toContain("denied");
    expect(output).toContain('"type":"span"'); expect(output).toContain("TypeError");
    expect(drops.mock.calls.filter(call => call[0] === "before_send" && call[1] === "span")).toEqual([["before_send", "span", 1]]);
    await client.close();
  });
  it("redacts scope attributes added after log and metric hooks", async () => {
    const envelopes: Envelope[] = [];
    const client = initBrowser({ dsn: DSN, defaultIntegrations: [], integrations: [sentryPrivacyIntegration()], dataCollection: { userInfo: false },
      beforeSendLog: sentryBeforeSendLog, beforeSendMetric: sentryBeforeSendMetric, transport: () => transport(envelopes) });
    getCurrentScope().setAttributes({ apiToken: "denied-scope-token", credentials: "denied-credentials", database_url: "postgres://demo:denied-password@db/test", prompt: "denied-prompt", environment: { OTHER: "denied-env" }, email_address: "denied@example.test", customer_name: "denied-customer", outcome: "denied-private-status" }); setUser({ email: "denied@example.test" });
    logger.info("ingest.failed"); metrics.count("ingest.failed", 1);
    expect(await client!.flush(2000)).toBe(true);
    const serialized = JSON.stringify(envelopes);
    expect(serialized).toContain("ingest.failed"); expect(serialized).toContain("ingest.failed"); expect(serialized).not.toContain("denied");
    expectTypedAttributes(envelopes);
    getCurrentScope().setAttributes({ apiToken: undefined, credentials: undefined, database_url: undefined, prompt: undefined, environment: undefined, email_address: undefined, customer_name: undefined, outcome: undefined }); setUser(null); await client!.close();
  });
});

describe("Fail-closed redaction", () => {
  it("handles cycles and denies request content/PII", () => {
    const extra: Record<string, unknown> = { token: "denied-token", public_key_password: "denied-password", values: ["?signature=denied-signature"] }; extra.self = extra;
    const result = sentryBeforeSend({ type: undefined, exception: { values: [{ type: "Error", value: "synthetic" }] }, extra,
      user: { email: "denied@example.test" }, request: { data: "denied-body", cookies: { session: "denied-cookie" }, headers: { custom: "denied-header" } } }, {});
    expect(result).not.toBeNull(); expect(result?.extra).toBeUndefined(); expect(JSON.stringify(result)).not.toContain("denied");
  });
  it("rejects malformed DAG and sparse span containers before traversal", () => {
    let shared: Record<string, unknown> = { token: "denied-token" };
    for (let i = 0; i < 35; i++) shared = { x: shared, y: shared };
    const result = sentryBeforeSend({ type: undefined, message: "synthetic", spans: shared } as never, {});
    expect(result).toBeNull();
    expect(sentryBeforeSend({ type: undefined, spans: { sparse: new Array(10_000_000) } } as never, {})).toBeNull();
    expect(sentryBeforeSend({ type: undefined, spans: { repeatedText: Array(2000).fill("x".repeat(1000)) } } as never, {})).toBeNull();
    expect(sentryBeforeSend({ type: undefined, spans: { sparse: Array.from({ length: 100 }, () => new Array(1000)) } } as never, {})).toBeNull();
    expect(sentryBeforeSend({ type: undefined, spans: Object.fromEntries(Array.from({ length: 30_000 }, (_, i) => [String(i), i])) } as never, {})).toBeNull();
  });
  it("bounds traversal of valid-shaped oversized span arrays", () => {
    const span = { trace_id: "a".repeat(32), span_id: "b".repeat(16), start_timestamp: 1, timestamp: 2, status: "ok", op: "http.client" };
    expect(sentryBeforeSendTransaction({ type: "transaction", spans: Array(100).fill(span) }, {})).not.toBeNull();
    expect(sentryBeforeSendTransaction({ type: "transaction", spans: Array(30_000).fill(span) }, {})).toBeNull();
  });
  it("removes all user-controlled URL path and query contents", () => {
    const result = sentryBeforeSend({ type: undefined, request: { url: "https://example.test/?keyword=one&author=two&monkey=three&tokenizer=four&%74oken=denied-token&apiKey=denied-key&session_token=denied-session&secretKey=denied-secret-key&key=denied-bare-key&signature=denied-signature" } }, {});
    const encoded = JSON.stringify(result);
    expect(encoded).toContain("[REDACTED]");
    expect(encoded).not.toContain("denied");
  });
  it("drops unreadable events/logs/metrics and returns a content-free span fallback", () => {
    const bad = { type: undefined, get exception(): never { throw Error("unreadable"); }, get attributes(): never { throw Error("unreadable"); } };
    expect(sentryBeforeSend(bad, {})).toBeNull(); expect(sentryBeforeSendTransaction(bad as never, {})).toBeNull();
    expect(sentryBeforeSendLog(bad as never)).toBeNull(); expect(sentryBeforeSendMetric(bad as never)).toBeNull();
    const span = sentryBeforeSendSpan({ trace_id: "a".repeat(32), span_id: "b".repeat(16), name: "denied-name", get attributes(): never { throw Error("unreadable"); }, start_timestamp: 1, status: "ok", is_segment: true });
    expect(span.trace_id).toBe("a".repeat(32)); expect(span.attributes).toEqual({ "usage_monitor.redaction_failed": true }); expect(JSON.stringify(span)).not.toContain("denied");
  });
  it("drops marked fallback spans instead of inventing application errors", () => {
    const fallback = sentryBeforeSendSpan({ trace_id: "a".repeat(32), span_id: "b".repeat(16), name: "denied", start_timestamp: 1, status: "ok", is_segment: false, get attributes(): never { throw Error("denied"); } });
    expect(fallback.status).toBe("ok");
    let guard: (envelope: Envelope) => void = () => { throw Error("not installed"); };
    const drops: unknown[] = [];
    sentryPrivacyIntegration().setup!({ on: (_: string, fn: typeof guard) => { guard = fn; }, recordDroppedEvent: (...args: unknown[]) => drops.push(args) } as never);
    const e = [{}, [[{ type: "span" }, { items: [{ ...fallback, attributes: { "usage_monitor.redaction_failed": { type: "boolean", value: true } } }] }]]] as unknown as Envelope;
    guard(e); expect(e[1]).toEqual([]); expect(drops).toEqual([["before_send", "span", 1]]);
  });
  it("drops opaque payloads and unreadable envelopes at the final boundary", () => {
    let guard: (envelope: Envelope) => void = () => { throw Error("not installed"); };
    sentryPrivacyIntegration().setup!({ on: (_name: string, fn: typeof guard) => { guard = fn; } } as never);
    const envelope = [{ trace: { public_key: "public", transaction: "?%74oken=denied" } }, [[{ type: "event", length: 999 }, { type: undefined, message: "synthetic" }], [{ type: "attachment" }, new Uint8Array([1])], [{ type: "replay_recording" }, {}]]] as unknown as Envelope;
    guard(envelope); expect(envelope[1]).toHaveLength(1); expect(envelope[1][0][0].length).toBeUndefined(); expect(JSON.stringify(envelope)).not.toContain("denied");
    const bad = [{}, [[{ type: "event" }, { get exception(): never { throw Error("unreadable"); } }]]] as unknown as Envelope;
    guard(bad); expect(bad[1]).toEqual([]);
  });
  it("preserves shared typed attributes and isolates an oversized row in a normal batch", () => {
    let guard: (envelope: Envelope) => void = () => { throw Error("not installed"); };
    sentryPrivacyIntegration().setup!({ on: (_name: string, fn: typeof guard) => { guard = fn; } } as never);
    const shared = { type: "string", value: "ok" };
    const items = Array.from({ length: 100 }, () => ({ attributes: { outcome: shared, status: shared } }));
    const unsafe = { get attributes(): never { throw Error("unreadable"); } };
    const envelope = [{}, [[{ type: "log", item_count: 105, length: 123 }, { items: [...items, unsafe, null, undefined, [], "invalid"] }]]] as unknown as Envelope;
    guard(envelope);
    const payload = envelope[1][0][1] as { items: typeof items };
    expect(payload.items).toHaveLength(100);
    expect((envelope[1][0][0] as { item_count: number }).item_count).toBe(100);
    expect(payload.items[0].attributes.status).toEqual(shared);
    expectTypedAttributes([envelope]);
    expect(items[0].attributes.outcome).toBe(shared);
  });
  it("bounds aggregate string work across rows of one envelope", () => {
    let guard: (envelope: Envelope) => void = () => { throw Error("not installed"); };
    sentryPrivacyIntegration().setup!({ on: (_name: string, fn: typeof guard) => { guard = fn; } } as never);
    const row = { body: "x".repeat(100_000), attributes: {} };
    const envelope = [{}, [[{ type: "log", item_count: 1000 }, { items: Array(1000).fill(row) }]]] as unknown as Envelope;
    guard(envelope);
    // Keep only independently sanitized rows that fit the shared envelope
    // budget, even though every individual row fits its own limit.
    expect(JSON.stringify(envelope).length).toBeLessThan(6_100_000);
    const result = envelope[1][0][1] as { items: unknown[] };
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.length).toBeLessThan(60);
    expect((envelope[1][0][0] as { item_count: number }).item_count).toBe(result.items.length);
  });
  it("projects batch metadata without dropping version or privacy inference controls", () => {
    let guard: (envelope: Envelope) => void = () => { throw Error("not installed"); };
    sentryPrivacyIntegration().setup!({ on: (_name: string, fn: typeof guard) => { guard = fn; } } as never);
    const envelope = [{}, [[{ type: "log", item_count: 1 }, { version: 2, ingest_settings: { infer_ip: "auto", infer_user_agent: "auto" }, arbitrary_metadata: "denied", items: [{ timestamp: 1, level: "info", body: "denied free-form log", arbitrary_row_field: "denied", attributes: { outcome: { type: "string", value: "ok" } } }] }]]] as unknown as Envelope;
    guard(envelope);
    expect(envelope[1][0][1]).toEqual({ version: 2, ingest_settings: { infer_ip: "never", infer_user_agent: "never" }, items: [{ timestamp: 1, level: "info", body: "[REDACTED]", attributes: { outcome: { type: "string", value: "ok" } } }] });
    expect(JSON.stringify(envelope)).not.toContain("denied");
  });
  it("isolates invalid batch containers from valid sibling errors", () => {
    let guard: (envelope: Envelope) => void = () => { throw Error("not installed"); };
    const drops: unknown[] = [];
    sentryPrivacyIntegration().setup!({ on: (_name: string, fn: typeof guard) => { guard = fn; }, recordDroppedEvent: (...args: unknown[]) => drops.push(args) } as never);
    const envelope = [{}, [[{ type: "event" }, { exception: { values: [{ type: "TypeError", value: "denied" }] } }], [{ type: "log" }, { items: "invalid" }], [{ type: "span" }, { version: 99, items: [{}, {}] }], [{ type: "log" }, { items: Array(1001).fill({}) }]]] as unknown as Envelope;
    guard(envelope);
    expect(envelope[1]).toHaveLength(1); expect(envelope[1][0][0].type).toBe("event");
    expect(JSON.stringify(envelope)).toContain("TypeError"); expect(JSON.stringify(envelope)).not.toContain("denied");
    expect(drops).toEqual(expect.arrayContaining([["before_send", "span", 2], ["before_send", "log_item", 1], ["before_send", "log_item", 1001]]));
  });
  it("preserves only approved legacy nested span tags", () => {
    const result = sentryBeforeSendTransaction({ type: "transaction", spans: [{ tags: { outcome: "ok", region: "us-east-1", customer_name: "denied", reason: "denied free text" } }] } as never, {});
    expect((result?.spans?.[0] as unknown as { tags: unknown })?.tags).toEqual({ outcome: "ok", region: "us-east-1", reason: "[REDACTED]" });
  });
  it("drops feedback/unknown envelopes and permits only fixed operational check-ins", () => {
    let guard: (envelope: Envelope) => void = () => { throw Error("not installed"); };
    sentryPrivacyIntegration().setup!({ on: (_: string, fn: typeof guard) => { guard = fn; } } as never);
    const e = [{}, [[{ type: "user_report" }, { comments: "denied prose" }], [{ type: "future_custom" }, { payload: "denied" }], [{ type: "check_in" }, { check_in_id: "a".repeat(32), monitor_slug: "usage-monitor-scheduler", status: "ok", environment: "production", private: "denied" }]]] as unknown as Envelope;
    guard(e); expect(e[1]).toHaveLength(1); expect(e[1][0][0].type).toBe("check_in"); expect(JSON.stringify(e)).not.toContain("denied");
  });
  it("preserves error siblings when a telemetry batch exhausts the shared budget", () => {
    let guard: (envelope: Envelope) => void = () => { throw Error("not installed"); };
    sentryPrivacyIntegration().setup!({ on: (_: string, fn: typeof guard) => { guard = fn; } } as never);
    for (const reverse of [false, true]) {
      const items = [[{ type: "event" }, { exception: { values: [{ type: "TypeError", value: "denied" }] } }], [{ type: "log" }, { items: Array(1000).fill({ body: "x".repeat(100_000), attributes: {} }) }]];
      const e = [{}, reverse ? items.reverse() : items] as unknown as Envelope;
      guard(e); expect(e[1].some(i => i[0].type === "event")).toBe(true); expect(JSON.stringify(e)).toContain("TypeError"); expect(JSON.stringify(e).length).toBeLessThan(6_100_000);
    }
  });
  it("does not allow private http routes through SDK attribute fallback", () => {
    expect(sentryBeforeSendLog({ message: "ingest.failed", attributes: { "http.route": "/customers/denied", route: "/customers/denied" } } as never)?.attributes).toEqual({ "http.route": "[REDACTED]", route: "[REDACTED]" });
  });
  it("wires all runtimes and keeps Replay off", () => {
    expect(readFileSync("src/sentry.server.config.ts", "utf8")).toContain("profileSessionSampleRate: 0");
    for (const filename of ["src/instrumentation-client.ts", "src/sentry.server.config.ts", "src/sentry.edge.config.ts"]) {
      const source = readFileSync(filename, "utf8");
      for (const name of ["beforeSend", "beforeSendTransaction", "beforeSendLog", "beforeSendMetric", "beforeSendSpan"]) expect(source).toContain(`${name}:`);
      expect(source).toContain("sentryPrivacyIntegration()");
    }
    const source = readFileSync("src/instrumentation-client.ts", "utf8");
    expect(source).not.toContain("Sentry.replayIntegration("); expect(source).toContain("replaysSessionSampleRate: 0"); expect(source).toContain("replaysOnErrorSampleRate: 0");
  });
});
