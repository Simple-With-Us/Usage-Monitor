import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetSentryFleetDsnForTests,
  isFleetInfraFailureMetric,
  isSentryFleetConfigured,
  recordFleetInfraEvent,
  recordFleetInfraMetric,
} from "@/lib/sentry-fleet";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  __resetSentryFleetDsnForTests();
  delete process.env.SENTRY_FLEET_DSN;
  process.env.SENTRY_FLEET_DEBUG = "true";
  process.env.AGENT_TAG = "MM";
});

afterEach(() => {
  __resetSentryFleetDsnForTests();
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("sentry-fleet DSN configuration", () => {
  it("is unconfigured when SENTRY_FLEET_DSN is absent", () => {
    expect(isSentryFleetConfigured()).toBe(false);
  });

  it("parses the canonical Sentry DSN shape and is configured", () => {
    process.env.SENTRY_FLEET_DSN =
      "https://abcd1234567890abcd@o0.ingest.sentry.io/42";
    expect(isSentryFleetConfigured()).toBe(true);
  });

  it("strips the /serverdsn suffix Sentry sometimes appends", () => {
    process.env.SENTRY_FLEET_DSN =
      "https://abcd1234567890abcd@o0.ingest.sentry.io/42/serverdsn";
    expect(isSentryFleetConfigured()).toBe(true);
  });

  it("rejects a malformed DSN and disables emit", () => {
    process.env.SENTRY_FLEET_DSN = "not-a-dsn";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(isSentryFleetConfigured()).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("rejects a DSN with a non-hex public key", () => {
    process.env.SENTRY_FLEET_DSN =
      "https://not_hex_key@o0.ingest.sentry.io/42";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(isSentryFleetConfigured()).toBe(false);
  });
});

describe("recordFleetInfraEvent", () => {
  it("is a no-op when SENTRY_FLEET_DSN is absent", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await recordFleetInfraEvent("scheduler.tick", {
      app: "usage-monitor",
      agent: "MM",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs a Sentry envelope to the DSN-derived endpoint", async () => {
    process.env.SENTRY_FLEET_DSN =
      "https://abcd1234567890abcd@o0.ingest.sentry.io/42";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await recordFleetInfraEvent(
      "scheduler.tick",
      {
        app: "usage-monitor",
        agent: "MM",
        "metric.name": "scheduler.tick",
      },
      { level: "info", extra: { value: 1 } }
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [
      string,
      RequestInit | undefined,
    ];
    expect(url).toBe(
      "https://o0.ingest.sentry.io/api/42/envelope/?sentry_key=abcd1234567890abcd&sentry_version=7"
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/x-sentry-envelope",
    });
    const body = String(init?.body ?? "");
    // Envelope is newline-delimited: header, item-header, event, "".
    const lines = body.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const envelopeHeader = JSON.parse(lines[0]);
    expect(envelopeHeader.sent_at).toBeTruthy();
    expect(envelopeHeader.sdk).toMatchObject({ name: "sentry.jays.services.um-fleet" });
    const itemHeader = JSON.parse(lines[1]);
    expect(itemHeader).toMatchObject({
      type: "event",
      content_type: "application/json",
    });
    const event = JSON.parse(lines[2]);
    expect(event.tags).toMatchObject({
      app: "usage-monitor",
      agent: "MM",
    });
    expect(event.message).toBe("scheduler.tick");
    expect(event.level).toBe("info");
    // The envelope header carries the public key in trace.public_key (Sentry's
    // wire format for envelope routing — required, not a leak).  The URL
    // already pins the host and project id.  What we additionally verify:
    // the DSN string, the host, and the project id do not appear in the
    // request body beyond the trace envelope header.
    const bodyMinusHeader = lines.slice(2).join("\n");
    expect(bodyMinusHeader).not.toContain("ingest.sentry.io");
    expect(bodyMinusHeader).not.toContain('"42"');
  });

  it("swallows fetch failures and never throws", async () => {
    process.env.SENTRY_FLEET_DSN =
      "https://abcd1234567890abcd@o0.ingest.sentry.io/42";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    await expect(
      recordFleetInfraEvent("scheduler.tick", {
        app: "usage-monitor",
        agent: "MM",
      })
    ).resolves.toBeUndefined();
  });
});

const DSN = "https://abcd1234567890abcd@o0.ingest.sentry.io/42";

function postedLines(fetchSpy: { mock: { calls: unknown[][] } }, call = 0): string[] {
  const [, init] = fetchSpy.mock.calls[call] as [string, RequestInit | undefined];
  return String(init?.body ?? "").split("\n");
}

describe("recordFleetInfraMetric: failure-class metrics stay issue events", () => {
  it("stamps the app + agent + metric tags and a metric fingerprint", async () => {
    process.env.SENTRY_FLEET_DSN = DSN;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await recordFleetInfraMetric("ingest.failed", 1, {
      total: 10,
      reason: "TypeError",
    });
    const lines = postedLines(fetchSpy);
    expect(JSON.parse(lines[1]).type).toBe("event");
    const event = JSON.parse(lines[2]);
    expect(event.tags).toMatchObject({
      app: "usage-monitor",
      agent: "MM",
      "metric.name": "ingest.failed",
      "metric.kind": "counter",
      "metric.total": "10",
      "metric.reason": "TypeError",
    });
    expect(event.fingerprint).toEqual(["um-fleet", "metric", "ingest.failed"]);
    expect(event.extra).toMatchObject({ "metric.value": 1 });
  });

  it("marks warning level for metrics containing _rejected in any segment", async () => {
    process.env.SENTRY_FLEET_DSN = DSN;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await recordFleetInfraMetric("ingest.events_rejected", 1, { route: "ingest/usage" });
    expect(JSON.parse(postedLines(fetchSpy)[2]).level).toBe("warning");
  });

  it("records SQLite admission back-pressure as a metric, not an issue", async () => {
    process.env.SENTRY_FLEET_DSN = DSN;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    expect(isFleetInfraFailureMetric("ingest.admission_rejected")).toBe(false);
    expect(isFleetInfraFailureMetric("ingest.events_rejected")).toBe(true);
    await recordFleetInfraMetric("ingest.admission_rejected", 1, {
      route: "ingest/usage",
    });
    expect(JSON.parse(postedLines(fetchSpy)[1]).type).toBe("trace_metric");
    const payload = JSON.parse(postedLines(fetchSpy)[2]);
    expect(payload.items[0]).toMatchObject({
      name: "ingest.admission_rejected",
      type: "counter",
      value: 1,
    });
    expect(payload.items[0].attributes.route).toMatchObject({
      value: "ingest/usage",
      type: "string",
    });
  });

  it("marks warning level for .failed and .error metrics", async () => {
    process.env.SENTRY_FLEET_DSN = DSN;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await recordFleetInfraMetric("ingest.failed", 1, { reason: "TypeError" });
    await recordFleetInfraMetric("circuit_error", 1);
    expect(JSON.parse(postedLines(fetchSpy, 0)[2]).level).toBe("warning");
    expect(JSON.parse(postedLines(fetchSpy, 1)[2]).level).toBe("warning");
  });

  it("keeps the total poll outage page as an issue event", async () => {
    process.env.SENTRY_FLEET_DSN = DSN;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await recordFleetInfraMetric("scheduler.provider_fetch_zero_success", 1, {
      successes: 0,
      failures: 4,
    });
    const lines = postedLines(fetchSpy);
    expect(JSON.parse(lines[1]).type).toBe("event");
    expect(JSON.parse(lines[2]).level).toBe("warning");
  });

  it("writes the real byte length into the envelope item header", async () => {
    process.env.SENTRY_FLEET_DSN = DSN;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await recordFleetInfraMetric("ingest.failed", 1, { total: 10 });
    const lines = postedLines(fetchSpy);
    const itemHeader = JSON.parse(lines[1]);
    // Sentry envelope protocol: item `length` is the UTF-8 byte count of
    // the JSON body that follows.  A zero length on a non-empty payload
    // makes the receiver treat the item as truncated.
    expect(itemHeader.type).toBe("event");
    expect(itemHeader.length).toBe(Buffer.byteLength(lines[2], "utf8"));
    expect(itemHeader.length).toBeGreaterThan(0);
  });
});

describe("recordFleetInfraMetric: healthy metrics go out as Application Metrics", () => {
  it("never posts an event item for a healthy counter", async () => {
    process.env.SENTRY_FLEET_DSN = DSN;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    for (const name of [
      "usage.persisted",
      "usage.persisted_total",
      "ai.request",
      "ai.request_total",
      "poll.snapshot",
      "rollup.completed",
      "scheduler.tick",
    ]) {
      await recordFleetInfraMetric(name, 3, { route: "otlp/v1/metrics" });
    }
    expect(fetchSpy).toHaveBeenCalledTimes(7);
    for (let i = 0; i < 7; i++) {
      expect(JSON.parse(postedLines(fetchSpy, i)[1]).type).toBe("trace_metric");
    }
  });

  it("serializes a counter in the SDK trace_metric shape", async () => {
    process.env.SENTRY_FLEET_DSN = DSN;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await recordFleetInfraMetric("usage.persisted", 5, {
      provider: "anthropic",
      cost_usd: 0.0641,
      count: 2,
      sampled: true,
    });
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toContain("https://o0.ingest.sentry.io/api/42/envelope/");
    const lines = postedLines(fetchSpy);
    const itemHeader = JSON.parse(lines[1]);
    expect(itemHeader).toMatchObject({
      type: "trace_metric",
      item_count: 1,
      content_type: "application/vnd.sentry.items.trace-metric+json",
    });
    expect(itemHeader.length).toBe(Buffer.byteLength(lines[2], "utf8"));
    const payload = JSON.parse(lines[2]);
    expect(payload.version).toBe(2);
    expect(payload.items).toHaveLength(1);
    const item = payload.items[0];
    expect(item).toMatchObject({ name: "usage.persisted", type: "counter", value: 5 });
    expect(item.unit).toBeUndefined();
    expect(item.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof item.timestamp).toBe("number");
    expect(item.attributes).toMatchObject({
      app: { value: "usage-monitor", type: "string" },
      agent: { value: "MM", type: "string" },
      provider: { value: "anthropic", type: "string" },
      cost_usd: { value: 0.0641, type: "double" },
      count: { value: 2, type: "integer" },
      sampled: { value: true, type: "boolean" },
    });
  });

  it("classifies integer scheduler.duration_ms as a millisecond gauge by name, not value", async () => {
    process.env.SENTRY_FLEET_DSN = DSN;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    // Real production duration samples are integers (Date.now() delta).
    await recordFleetInfraMetric("scheduler.duration_ms", 1234, { outcome: "ok" });
    await recordFleetInfraMetric("ai.request.ttft_ms", 250.5);
    const first = JSON.parse(postedLines(fetchSpy, 0)[2]).items[0];
    expect(first).toMatchObject({ type: "gauge", unit: "millisecond", value: 1234 });
    const second = JSON.parse(postedLines(fetchSpy, 1)[2]).items[0];
    expect(second).toMatchObject({ type: "gauge", unit: "millisecond", value: 250.5 });
  });

  it("treats cost readings as gauges without a time unit", async () => {
    process.env.SENTRY_FLEET_DSN = DSN;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    await recordFleetInfraMetric("poll.snapshot.cost_usd", 0.107612, { provider: "openai" });
    const item = JSON.parse(postedLines(fetchSpy)[2]).items[0];
    expect(item.type).toBe("gauge");
    expect(item.unit).toBeUndefined();
  });

  it("is a no-op when SENTRY_FLEET_DSN is absent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await recordFleetInfraMetric("usage.persisted", 1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("drops non-finite values instead of posting them", async () => {
    process.env.SENTRY_FLEET_DSN = DSN;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await recordFleetInfraMetric("scheduler.duration_ms", Number.NaN);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("swallows fetch failures and never throws", async () => {
    process.env.SENTRY_FLEET_DSN = DSN;
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await expect(recordFleetInfraMetric("usage.persisted", 1)).resolves.toBeUndefined();
  });
});
