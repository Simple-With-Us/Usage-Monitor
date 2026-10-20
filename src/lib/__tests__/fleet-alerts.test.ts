import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getFleetAlerts,
  parseFleetAlertsPayload,
  worstFiringSeverity,
  resetFleetAlertsCacheForTests,
  FLEET_ALERTS_FAILURE_RETRY_MS,
} from "../fleet-alerts";

afterEach(() => {
  resetFleetAlertsCacheForTests();
  vi.unstubAllGlobals();
  delete process.env.FLEET_ALERTS_URL;
});

const sample = {
  generatedAt: "2026-10-18T22:40:00.000Z",
  channel: "alerts",
  summary: { topics: 2, alerts: 3, firing: 2 },
  topics: {
    "Mac.Jays.Services": {
      firing: 1,
      total: 2,
      alerts: [
        {
          key: "datadog:22024797",
          service: "Mac.Jays.Services",
          phase: "alerting",
          severity: "MODERATE",
          text: "System load is high",
          link: "https://us5.datadoghq.com/monitors/22024797",
          since: 1792358697000,
          updated: 1792360437000,
          prodDown: false,
        },
        {
          key: "datadog:22024800",
          service: "Mac.Jays.Services",
          phase: "ok",
          severity: "INFO",
          text: "CPU usage normal",
          link: "",
          since: 1,
          updated: 2,
          prodDown: false,
        },
      ],
    },
    "Congress.Trade": {
      firing: 1,
      total: 1,
      alerts: [
        {
          key: "bt:1",
          service: "Congress.Trade",
          phase: "alerting",
          severity: "SEVERE",
          text: "Endpoint latency 4.2s",
          link: "https://betterstack.com/x",
          since: 1,
          updated: 2,
          prodDown: true,
        },
      ],
    },
  },
};

function stubFetch(body: unknown, ok = true, status = 200) {
  const fn = vi.fn(async (_url: string) => ({
    ok,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("parseFleetAlertsPayload", () => {
  it("reads the ingress contract", () => {
    const p = parseFleetAlertsPayload(sample);
    expect(p.ok).toBe(true);
    expect(p.summary).toEqual({ topics: 2, alerts: 3, firing: 2 });
    expect(Object.keys(p.topics)).toEqual(["Congress.Trade", "Mac.Jays.Services"]);
    expect(p.topics["Congress.Trade"].alerts[0].prodDown).toBe(true);
  });

  it("counts firing itself rather than trusting the summary block", () => {
    const p = parseFleetAlertsPayload({
      ...sample,
      summary: { topics: 0, alerts: 0, firing: 99 },
    });
    expect(p.summary.firing).toBe(2);
    expect(p.summary.alerts).toBe(3);
  });

  it("sorts firing before ok", () => {
    const p = parseFleetAlertsPayload(sample);
    const phases = p.topics["Mac.Jays.Services"].alerts.map((a) => a.phase);
    expect(phases).toEqual(["alerting", "ok"]);
  });

  it("never lets a non-alerting phase carry an alarming severity", () => {
    const p = parseFleetAlertsPayload({
      topics: {
        svc: {
          alerts: [
            { key: "k", service: "svc", phase: "pending", severity: "SEVERE", text: "t" },
          ],
        },
      },
    });
    expect(p.topics.svc.alerts[0].severity).toBe("INFO");
  });

  it("drops a topic whose alerts are all unusable", () => {
    const p = parseFleetAlertsPayload({
      topics: {
        good: { alerts: [{ key: "k", service: "svc", phase: "ok", severity: "INFO", text: "t" }] },
        empty: { alerts: [] },
        junk: { alerts: [{ nope: true }, null, 42] },
      },
    });
    expect(Object.keys(p.topics)).toEqual(["good"]);
  });

  it("degrades instead of throwing on malformed input", () => {
    for (const bad of [null, undefined, 42, "nope", [], { topics: "no" }]) {
      expect(() => parseFleetAlertsPayload(bad)).not.toThrow();
    }
    expect(parseFleetAlertsPayload(null).ok).toBe(false);
  });

  it("tolerates an entirely empty ingress", () => {
    const p = parseFleetAlertsPayload({ topics: {} });
    expect(p.ok).toBe(true);
    expect(p.summary).toEqual({ topics: 0, alerts: 0, firing: 0 });
  });
});

describe("worstFiringSeverity", () => {
  it("reports the worst currently firing severity", () => {
    expect(worstFiringSeverity(parseFleetAlertsPayload(sample))).toBe("SEVERE");
  });

  it("is INFO when nothing is firing", () => {
    const p = parseFleetAlertsPayload({
      topics: { svc: { alerts: [{ key: "k", service: "svc", phase: "ok", severity: "INFO", text: "t" }] } },
    });
    expect(worstFiringSeverity(p)).toBe("INFO");
  });
});

describe("getFleetAlerts", () => {
  it("reports Not Configured when no URL is set", async () => {
    const p = await getFleetAlerts();
    expect(p.configured).toBe(false);
    expect(p.ok).toBe(false);
  });

  it("fetches /status and parses it", async () => {
    process.env.FLEET_ALERTS_URL = "https://alert-ingress.example.workers.dev/";
    const fn = stubFetch(sample);
    const p = await getFleetAlerts();
    expect(p.ok).toBe(true);
    expect(p.summary.firing).toBe(2);
    // Trailing slash must not produce a double slash.
    expect(fn.mock.calls[0][0]).toBe("https://alert-ingress.example.workers.dev/status");
  });

  it("caches within the TTL rather than refetching per render", async () => {
    process.env.FLEET_ALERTS_URL = "https://alert-ingress.example.workers.dev";
    const fn = stubFetch(sample);
    await getFleetAlerts();
    await getFleetAlerts();
    await getFleetAlerts();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("degrades on a non-2xx without throwing", async () => {
    process.env.FLEET_ALERTS_URL = "https://alert-ingress.example.workers.dev";
    stubFetch({}, false, 503);
    const p = await getFleetAlerts();
    expect(p.configured).toBe(true);
    expect(p.ok).toBe(false);
    expect(p.reason).toContain("503");
  });

  it("degrades when the ingress is unreachable", async () => {
    process.env.FLEET_ALERTS_URL = "https://alert-ingress.example.workers.dev";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    const p = await getFleetAlerts();
    expect(p.configured).toBe(true);
    expect(p.ok).toBe(false);
    expect(p.reason).toContain("network down");
  });

  it("backs off faster after a failure than after a success", () => {
    // The constant is the contract the cache uses; a failure must retry sooner
    // than the normal TTL so a blip does not leave /ops stale for a minute.
    expect(FLEET_ALERTS_FAILURE_RETRY_MS).toBeLessThan(30_000);
  });
});
describe("topic ordering", () => {
  it("puts the topic with more firing first, regardless of payload key order", () => {
    const p = parseFleetAlertsPayload({
      topics: {
        AllClear: {
          alerts: [{ key: "a", service: "AllClear", phase: "ok", severity: "INFO", text: "fine" }],
        },
        Broken: {
          alerts: [
            { key: "b", service: "Broken", phase: "alerting", severity: "SEVERE", text: "down" },
            { key: "c", service: "Broken", phase: "alerting", severity: "MODERATE", text: "slow" },
          ],
        },
      },
    });
    expect(Object.keys(p.topics)).toEqual(["Broken", "AllClear"]);
  });

  it("is stable when firing counts tie", () => {
    const p = parseFleetAlertsPayload({
      topics: {
        Zulu: { alerts: [{ key: "z", service: "Zulu", phase: "alerting", severity: "SEVERE", text: "x" }] },
        Alpha: { alerts: [{ key: "a", service: "Alpha", phase: "alerting", severity: "SEVERE", text: "y" }] },
      },
    });
    expect(Object.keys(p.topics)).toEqual(["Alpha", "Zulu"]);
  });
});

describe("review regressions", () => {
  it("fails closed when a 2xx payload is missing its topics block", () => {
    // A missing/non-record topics must not render as a false "All Clear".
    expect(parseFleetAlertsPayload({ generatedAt: "2026-10-20T00:00:00Z" }).ok).toBe(false);
    expect(parseFleetAlertsPayload({ topics: null }).ok).toBe(false);
  });

  it("rejects a 2xx with a malformed envelope at the fetch boundary", async () => {
    process.env.FLEET_ALERTS_URL = "https://alert-ingress.example.workers.dev";
    stubFetch({ generatedAt: "2026-10-20T00:00:00Z" });
    const p = await getFleetAlerts();
    expect(p.ok).toBe(false);
    expect(p.reason).toContain("malformed");
  });

  it("tolerates additive top-level fields from the ingress", async () => {
    // The ingress contract lives in AI-Fleet-Coordinator, so a routine field
    // addition there must not blank the whole card to "malformed".
    process.env.FLEET_ALERTS_URL = "https://alert-ingress.example.workers.dev";
    stubFetch({ ...sample, statusPageUrl: "https://status.example" });
    const p = await getFleetAlerts();
    expect(p.ok).toBe(true);
    expect(p.summary.alerts).toBeGreaterThan(0);
  });

  it("caches each payload under its own ttl, not the previous payload's", async () => {
    vi.useFakeTimers();
    try {
      process.env.FLEET_ALERTS_URL = "https://alert-ingress.example.workers.dev";
      const fn = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
        .mockResolvedValue({ ok: true, status: 200, json: async () => sample });
      vi.stubGlobal("fetch", fn);

      await getFleetAlerts(); // failure cached under the 15s retry TTL
      vi.setSystemTime(Date.now() + 16_000);
      await getFleetAlerts(); // past 15s: refetches, success now cached 30s
      expect(fn).toHaveBeenCalledTimes(2);

      vi.setSystemTime(Date.now() + 16_000);
      await getFleetAlerts(); // still inside the success TTL: no refetch
      expect(fn).toHaveBeenCalledTimes(2);

      vi.setSystemTime(Date.now() + 15_001);
      await getFleetAlerts(); // past 30s: refetch
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
