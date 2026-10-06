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
    const csp = middleware(new NextRequest("https://example.test/login")).headers.get("Content-Security-Policy")!;
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
      captureContext: { extra: { password: "denied-password", list: ["?token=denied-array"], safe: "synthetic" } },
    });
    expect(await client.flush(2000)).toBe(true);
    const events: unknown[] = [];
    for (const envelope of envelopes) forEachEnvelopeItem(envelope, (item, type) => { if (type === "event") events.push(item); });
    expect(events).toHaveLength(1);
    expect(url).toContain("https://o123.ingest.us.sentry.io/api/456/envelope/");
    const serialized = JSON.stringify(envelopes);
    expect(serialized).toContain("synthetic delivery"); expect(serialized).toContain("[REDACTED]"); expect(serialized).not.toContain("denied");
    await client.close();
  });
  it("redacts streamed spans and envelope trace headers", async () => {
    const envelopes: Envelope[] = [];
    const client = initBrowser({ dsn: DSN, defaultIntegrations: [], integrations: [sentryPrivacyIntegration()], tracesSampleRate: 1,
      beforeSendSpan: sentryBeforeSendSpan, transport: () => transport(envelopes) });
    startSpan({ name: "synthetic ?%74oken=denied-span", attributes: { "url.full": "https://example.test/?x-amz-signature=denied-signature", "user.email": "denied@example.test", "http.request.body": "denied-body" } }, () => {});
    expect(await client!.flush(2000)).toBe(true);
    expect(JSON.stringify(envelopes)).toContain("synthetic");
    expect(JSON.stringify(envelopes)).not.toContain("denied");
    expectTypedAttributes(envelopes);
    await client!.close();
  });
  it("redacts scope attributes added after log and metric hooks", async () => {
    const envelopes: Envelope[] = [];
    const client = initBrowser({ dsn: DSN, defaultIntegrations: [], integrations: [sentryPrivacyIntegration()], dataCollection: { userInfo: false },
      beforeSendLog: sentryBeforeSendLog, beforeSendMetric: sentryBeforeSendMetric, transport: () => transport(envelopes) });
    getCurrentScope().setAttributes({ apiToken: "denied-scope-token" }); setUser({ email: "denied@example.test" });
    logger.info("synthetic delivery log"); metrics.count("synthetic.delivery", 1);
    expect(await client!.flush(2000)).toBe(true);
    const serialized = JSON.stringify(envelopes);
    expect(serialized).toContain("synthetic delivery log"); expect(serialized).toContain("synthetic.delivery"); expect(serialized).not.toContain("denied");
    expectTypedAttributes(envelopes);
    getCurrentScope().setAttributes({ apiToken: undefined }); setUser(null); await client!.close();
  });
});

describe("Fail-closed redaction", () => {
  it("handles cycles and denies request content/PII", () => {
    const extra: Record<string, unknown> = { token: "denied-token", public_key_password: "denied-password", values: ["?signature=denied-signature"] }; extra.self = extra;
    const result = sentryBeforeSend({ type: undefined, exception: { values: [{ type: "Error", value: "synthetic" }] }, extra,
      user: { email: "denied@example.test" }, request: { data: "denied-body", cookies: { session: "denied-cookie" }, headers: { custom: "denied-header" } } }, {});
    expect(result).not.toBeNull(); expect(JSON.stringify(result)).toContain("[CIRCULAR]"); expect(JSON.stringify(result)).not.toContain("denied");
  });
  it("bounds shared-reference DAGs including serialized output", () => {
    let shared: Record<string, unknown> = { token: "denied-token" };
    for (let i = 0; i < 35; i++) shared = { x: shared, y: shared };
    const result = sentryBeforeSend({ type: undefined, message: "synthetic", extra: shared }, {});
    expect(result).toBeNull();
    expect(sentryBeforeSend({ type: undefined, extra: { sparse: new Array(10_000_000) } }, {})).toBeNull();
    expect(sentryBeforeSend({ type: undefined, extra: { repeatedText: Array(200).fill("x".repeat(1000)) } }, {})).toBeNull();
    expect(sentryBeforeSend({ type: undefined, extra: { sparse: Array.from({ length: 10 }, () => new Array(1000)) } }, {})).toBeNull();
    expect(sentryBeforeSend({ type: undefined, extra: Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [String(i), i])) }, {})).toBeNull();
  });
  it("keeps query names but removes all private query values", () => {
    const result = sentryBeforeSend({ type: undefined, request: { url: "https://example.test/?keyword=one&author=two&monkey=three&tokenizer=four&%74oken=denied-token&apiKey=denied-key&session_token=denied-session&secretKey=denied-secret-key&key=denied-bare-key&signature=denied-signature" } }, {});
    const encoded = JSON.stringify(result);
    expect(encoded).toContain("keyword=[REDACTED]&author=[REDACTED]&monkey=[REDACTED]&tokenizer=[REDACTED]");
    expect(encoded).not.toContain("denied");
  });
  it("drops unreadable events/logs/metrics and returns a content-free span fallback", () => {
    const bad = { type: undefined, get extra(): never { throw Error("unreadable"); }, token: "denied-token" };
    expect(sentryBeforeSend(bad, {})).toBeNull(); expect(sentryBeforeSendTransaction(bad as never, {})).toBeNull();
    expect(sentryBeforeSendLog(bad as never)).toBeNull(); expect(sentryBeforeSendMetric(bad as never)).toBeNull();
    const span = sentryBeforeSendSpan({ trace_id: "a".repeat(32), span_id: "b".repeat(16), name: "denied-name", get attributes(): never { throw Error("unreadable"); }, start_timestamp: 1, status: "ok", is_segment: true });
    expect(span.trace_id).toBe("a".repeat(32)); expect(span.attributes).toEqual({}); expect(JSON.stringify(span)).not.toContain("denied");
  });
  it("drops opaque payloads and unreadable envelopes at the final boundary", () => {
    let guard: (envelope: Envelope) => void = () => { throw Error("not installed"); };
    sentryPrivacyIntegration().setup!({ on: (_name: string, fn: typeof guard) => { guard = fn; } } as never);
    const envelope = [{ trace: { public_key: "public", transaction: "?%74oken=denied" } }, [[{ type: "event", length: 999 }, { type: undefined, message: "synthetic" }], [{ type: "attachment" }, new Uint8Array([1])], [{ type: "replay_recording" }, {}]]] as unknown as Envelope;
    guard(envelope); expect(envelope[1]).toHaveLength(1); expect(envelope[1][0][0].length).toBeUndefined(); expect(JSON.stringify(envelope)).not.toContain("denied");
    const bad = [{}, [[{ type: "event" }, { get extra(): never { throw Error("unreadable"); } }]]] as unknown as Envelope;
    guard(bad); expect(bad[1]).toEqual([]);
  });
  it("preserves shared typed attributes and isolates an oversized row in a normal batch", () => {
    let guard: (envelope: Envelope) => void = () => { throw Error("not installed"); };
    sentryPrivacyIntegration().setup!({ on: (_name: string, fn: typeof guard) => { guard = fn; } } as never);
    const shared = { type: "string", value: "synthetic" };
    const items = Array.from({ length: 100 }, () => ({ attributes: { one: shared, two: shared } }));
    const unsafe = { get attributes(): never { throw Error("unreadable"); } };
    const envelope = [{}, [[{ type: "log", item_count: 105, length: 123 }, { items: [...items, unsafe, null, undefined, [], "invalid"] }]]] as unknown as Envelope;
    guard(envelope);
    const payload = envelope[1][0][1] as { items: typeof items };
    expect(payload.items).toHaveLength(100);
    expect((envelope[1][0][0] as { item_count: number }).item_count).toBe(100);
    expect(payload.items[0].attributes.two).toEqual(shared);
    expectTypedAttributes([envelope]);
    expect(items[0].attributes.one).toBe(shared);
  });
  it("wires all runtimes and keeps Replay off", () => {
    for (const filename of ["src/instrumentation-client.ts", "src/sentry.server.config.ts", "src/sentry.edge.config.ts"]) {
      const source = readFileSync(filename, "utf8");
      for (const name of ["beforeSend", "beforeSendTransaction", "beforeSendLog", "beforeSendMetric", "beforeSendSpan"]) expect(source).toContain(`${name}:`);
      expect(source).toContain("sentryPrivacyIntegration()");
    }
    const source = readFileSync("src/instrumentation-client.ts", "utf8");
    expect(source).not.toContain("Sentry.replayIntegration("); expect(source).toContain("replaysSessionSampleRate: 0"); expect(source).toContain("replaysOnErrorSampleRate: 0");
  });
});
