import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Network is stubbed at the adapter boundary (`fetchJson`) so no probe test
 * ever opens a socket.  Sentry is stubbed one level higher because its probe
 * deliberately reuses `sentry-health` rather than re-implementing that fetch;
 * `isSentryHealthConfigured` stays real (the factories spread the original
 * module) so the unconfigured assertions exercise the actual env check.
 */
vi.mock("@/lib/adapters/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/adapters/helpers")>();
  return { ...actual, fetchJson: vi.fn() };
});

vi.mock("@/lib/sentry-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sentry-health")>();
  return { ...actual, fetchSentryHealth: vi.fn() };
});

import { fetchJson } from "@/lib/adapters/helpers";
import { OBSERVABILITY_PROBES } from "@/lib/platform-status/probes/observability";
import type { PlatformProbe } from "@/lib/platform-status/types";
import {
  fetchSentryHealth,
  type SentryHealthSummary,
  type SentryProjectHealth,
} from "@/lib/sentry-health";

const fetchJsonMock = vi.mocked(fetchJson);
const fetchSentryHealthMock = vi.mocked(fetchSentryHealth);

function probeFor(id: string): PlatformProbe {
  const probe = OBSERVABILITY_PROBES.find((candidate) => candidate.id === id);
  if (!probe) throw new Error(`missing probe: ${id}`);
  return probe;
}

/** Same shape the real `fetchJson` resolves with. */
function jsonResponse(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    data,
    headers: new Headers({ "content-type": "application/json" }),
  };
}

function requestHeaders(index = 0): Record<string, string> {
  return (fetchJsonMock.mock.calls[index]?.[1]?.headers ?? {}) as Record<string, string>;
}

/**
 * Serve one response per request, in order.  A request past the end throws, so
 * a probe that paginates without a working stop condition fails loudly instead
 * of quietly re-reading the last page forever.
 */
function servePages(...responses: ReturnType<typeof jsonResponse>[]) {
  let call = 0;
  fetchJsonMock.mockImplementation(async () => {
    const response = responses[call];
    call += 1;
    if (!response) throw new Error(`unexpected page request #${call}`);
    return response;
  });
}

/** Form-encoded body of the nth request, for asserting pagination offsets. */
function requestBody(index: number): URLSearchParams {
  return new URLSearchParams(String(fetchJsonMock.mock.calls[index]?.[1]?.body ?? ""));
}

function sentryProject(
  overrides: Partial<SentryProjectHealth> & Pick<SentryProjectHealth, "projectSlug" | "displayName">
): SentryProjectHealth {
  return {
    unresolvedCount: 0,
    hasMore: false,
    issuesUrl: "https://sentry.io/organizations/simple-with-us/issues/",
    ...overrides,
  };
}

function sentrySummary(projects: SentryProjectHealth[]): SentryHealthSummary {
  return {
    configured: true,
    org: "simple-with-us",
    projects,
    fetchedAt: "2026-08-11T12:00:00.000Z",
  };
}

function clearObservabilityEnv() {
  vi.stubEnv("SENTRY_READ_TOKEN", "");
  vi.stubEnv("SENTRY_ORG", "");
  vi.stubEnv("UPTIMEROBOT_API_KEY", "");
  vi.stubEnv("PAGERDUTY_API_KEY", "");
  vi.stubEnv("DD_API_KEY", "");
  vi.stubEnv("DD_APP_KEY", "");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  fetchJsonMock.mockReset();
  fetchSentryHealthMock.mockReset();
  fetchJsonMock.mockImplementation(async () => {
    throw new Error("unexpected fetchJson call");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("OBSERVABILITY_PROBES registry shape", () => {
  it("exposes exactly the four observability platforms", () => {
    expect(OBSERVABILITY_PROBES.map((probe) => probe.id)).toEqual([
      "sentry",
      "uptimerobot",
      "pagerduty",
      "datadog",
    ]);
    for (const probe of OBSERVABILITY_PROBES) {
      expect(probe.category).toBe("observability");
      expect(probe.requiredEnv.length).toBeGreaterThan(0);
      expect(probe.consoleUrl).toMatch(/^https:\/\//);
    }
  });

  it("reports every platform unconfigured when no env is set", () => {
    clearObservabilityEnv();
    for (const probe of OBSERVABILITY_PROBES) {
      expect(probe.isConfigured()).toBe(false);
    }
    expect(fetchJsonMock).not.toHaveBeenCalled();
    expect(fetchSentryHealthMock).not.toHaveBeenCalled();
  });
});

describe("sentry probe", () => {
  it("is configured once the read token is present", () => {
    clearObservabilityEnv();
    expect(probeFor("sentry").isConfigured()).toBe(false);
    vi.stubEnv("SENTRY_READ_TOKEN", "sntrys_test-token");
    expect(probeFor("sentry").isConfigured()).toBe(true);
  });

  it("reports healthy when every tracked project has zero unresolved issues", async () => {
    vi.stubEnv("SENTRY_READ_TOKEN", "sntrys_test-token");
    vi.stubEnv("SENTRY_ORG", "simple-with-us");
    fetchSentryHealthMock.mockResolvedValue(
      sentrySummary([
        sentryProject({
          projectSlug: "usage-monitor",
          displayName: "Usage Monitor (this app)",
        }),
        sentryProject({ projectSlug: "socratic-trade", displayName: "Socratic Trade" }),
      ])
    );

    const result = await probeFor("sentry").probe();
    expect(result.state).toBe("healthy");
    expect(result.headline).toBe("No unresolved issues across 2 tracked projects.");
    expect(result.error).toBeUndefined();

    const byLabel = new Map(result.metrics.map((entry) => [entry.label, entry]));
    expect(byLabel.get("Unresolved Issues")?.value).toBe("0 issues");
    expect(byLabel.get("Socratic Trade")?.value).toBe("0 issues");
  });

  it("degrades when any project has unresolved issues and names the failed reads", async () => {
    vi.stubEnv("SENTRY_READ_TOKEN", "sntrys_test-token");
    fetchSentryHealthMock.mockResolvedValue(
      sentrySummary([
        sentryProject({
          projectSlug: "usage-monitor",
          displayName: "Usage Monitor (this app)",
          unresolvedCount: 3,
        }),
        sentryProject({ projectSlug: "congress-trade", displayName: "Congress Trade" }),
        sentryProject({
          projectSlug: "fleet-infra",
          displayName: "Fleet Infra",
          error: "HTTP 500",
        }),
      ])
    );

    const result = await probeFor("sentry").probe();
    expect(result.state).toBe("degraded");
    expect(result.headline).toBe(
      "3 unresolved issues across 1 of 2 projects.  1 project read failed."
    );
    expect(result.error).toBe("partial_read");

    const byLabel = new Map(result.metrics.map((entry) => [entry.label, entry]));
    expect(byLabel.get("Unresolved Issues")?.value).toBe("3 issues");
    expect(byLabel.get("Fleet Infra")?.value).toBe("Unavailable");
    // Upstream error text is never rendered onto the card.
    expect(JSON.stringify(result)).not.toContain("HTTP 500");
  });

  it("reports unavailable when no project could be read", async () => {
    vi.stubEnv("SENTRY_READ_TOKEN", "sntrys_test-token");
    fetchSentryHealthMock.mockResolvedValue(
      sentrySummary([
        sentryProject({
          projectSlug: "usage-monitor",
          displayName: "Usage Monitor (this app)",
          error: "HTTP 403",
        }),
      ])
    );

    const result = await probeFor("sentry").probe();
    expect(result.state).toBe("unavailable");
    expect(result.error).toBe("read_failed");
    expect(result.metrics).toEqual([]);
  });

  it("returns unreachable rather than throwing when the health read explodes", async () => {
    vi.stubEnv("SENTRY_READ_TOKEN", "sntrys_test-token");
    fetchSentryHealthMock.mockRejectedValue(new Error("socket hang up"));

    const result = await probeFor("sentry").probe();
    expect(result.state).toBe("unreachable");
    expect(result.error).toBe("unreachable");
    expect(result.headline).toBe("Sentry could not be reached.");
  });
});

describe("uptimerobot probe", () => {
  const healthyPayload = {
    stat: "ok",
    pagination: { offset: 0, limit: 50, total: 3 },
    monitors: [
      {
        id: 800_100_001,
        friendly_name: "Usage Monitor health",
        status: 2,
        custom_uptime_ratio: "100.000",
      },
      {
        id: 800_100_002,
        friendly_name: "OpenRouter credits probe",
        status: 2,
        custom_uptime_ratio: "99.980",
      },
      {
        id: 800_100_003,
        friendly_name: "Legacy staging",
        status: 0,
        custom_uptime_ratio: "0.000",
      },
    ],
  };

  it("is unconfigured without UPTIMEROBOT_API_KEY", () => {
    clearObservabilityEnv();
    expect(probeFor("uptimerobot").isConfigured()).toBe(false);
    vi.stubEnv("UPTIMEROBOT_API_KEY", "u800100-testkey");
    expect(probeFor("uptimerobot").isConfigured()).toBe(true);
  });

  it("holds a pending monitor indeterminate instead of claiming it is up", async () => {
    // Regression: with one pending monitor and zero up, the card returned
    // `healthy` and said "All 1 monitors are up".  UptimeRobot status 0 is
    // "paused", 1 is "not checked yet" — a monitor that has never reported
    // is not evidence of health.
    vi.stubEnv("UPTIMEROBOT_API_KEY", "u800100-testkey");
    fetchJsonMock.mockResolvedValue(
      jsonResponse(200, {
        stat: "ok",
        pagination: { offset: 0, limit: 50, total: 1 },
        monitors: [{ id: 1, friendly_name: "brand new", status: 1, custom_uptime_ratio: "0" }],
      })
    );

    const result = await probeFor("uptimerobot").probe();

    expect(result.state).toBe("stale");
    expect(result.error).toBe("pending_monitors");
    expect(result.headline).not.toContain("All ");
    expect(result.headline).toContain("not reported yet");
  });

  it("parses a healthy monitor list and never echoes the API key", async () => {
    vi.stubEnv("UPTIMEROBOT_API_KEY", "u800100-testkey");
    fetchJsonMock.mockResolvedValue(jsonResponse(200, healthyPayload));

    const result = await probeFor("uptimerobot").probe();
    expect(result.state).toBe("healthy");
    expect(result.headline).toBe("2 of 3 monitors are up.  1 paused.");
    expect(result.error).toBeUndefined();

    const byLabel = new Map(result.metrics.map((entry) => [entry.label, entry]));
    expect(byLabel.get("Monitors")?.value).toBe("3 monitors");
    expect(byLabel.get("Up")?.value).toBe("2");
    expect(byLabel.get("Down")?.value).toBe("0");
    expect(byLabel.get("Paused")?.value).toBe("1");
    // Paused monitors are excluded from the ratio average: (100 + 99.98) / 2.
    expect(byLabel.get("Uptime")?.value).toBe("99.99%");
    expect(byLabel.get("Uptime")?.hint).toBe("30-day average");
    expect(JSON.stringify(result)).not.toContain("u800100-testkey");

    expect(fetchJsonMock.mock.calls[0][0]).toBe("https://api.uptimerobot.com/v2/getMonitors");
    expect(fetchJsonMock.mock.calls[0][1]?.method).toBe("POST");
    expect(String(fetchJsonMock.mock.calls[0][1]?.body)).toContain("format=json");
  });

  it("degrades and names the down count when a monitor is down", async () => {
    vi.stubEnv("UPTIMEROBOT_API_KEY", "u800100-testkey");
    fetchJsonMock.mockResolvedValue(
      jsonResponse(200, {
        stat: "ok",
        pagination: { offset: 0, limit: 50, total: 2 },
        monitors: [
          {
            id: 800_100_001,
            friendly_name: "Usage Monitor health",
            status: 2,
            custom_uptime_ratio: "99.900",
          },
          {
            id: 800_100_002,
            friendly_name: "OpenRouter credits probe",
            status: 9,
            custom_uptime_ratio: "97.500",
          },
        ],
      })
    );

    const result = await probeFor("uptimerobot").probe();
    expect(result.state).toBe("degraded");
    expect(result.headline).toBe("1 of 2 monitors is down.");

    const down = result.metrics.find((entry) => entry.label === "Down");
    expect(down?.value).toBe("1");
    expect(down?.hint).toBe("OpenRouter credits probe");
  });

  it("maps a rejected API key reported inside a 200 body to unavailable", async () => {
    vi.stubEnv("UPTIMEROBOT_API_KEY", "u800100-badkey");
    fetchJsonMock.mockResolvedValue(
      jsonResponse(200, {
        stat: "fail",
        error: {
          type: "invalid_parameter",
          parameter_name: "api_key",
          passed_value: "u800100-badkey",
          message: "api_key is not valid",
        },
      })
    );

    const result = await probeFor("uptimerobot").probe();
    expect(result.state).toBe("unavailable");
    expect(result.error).toBe("unauthorized");
    expect(result.headline).toBe("UptimeRobot rejected the API key.");
    expect(result.metrics).toEqual([]);
    // UptimeRobot echoes the submitted key back in `passed_value`.
    expect(JSON.stringify(result)).not.toContain("u800100-badkey");
  });

  it("maps a non-ok HTTP response to a rate-limited degraded card", async () => {
    vi.stubEnv("UPTIMEROBOT_API_KEY", "u800100-testkey");
    fetchJsonMock.mockResolvedValue(jsonResponse(429, { stat: "fail" }));

    const result = await probeFor("uptimerobot").probe();
    expect(result.state).toBe("degraded");
    expect(result.error).toBe("rate_limited");
    expect(result.metrics).toEqual([]);
  });

  it("returns unreachable rather than throwing on a transport failure", async () => {
    vi.stubEnv("UPTIMEROBOT_API_KEY", "u800100-testkey");
    fetchJsonMock.mockRejectedValue(new Error("Request to https://api.uptimerobot.com timed out"));

    const result = await probeFor("uptimerobot").probe();
    expect(result.state).toBe("unreachable");
    expect(result.error).toBe("timeout");
  });

  /**
   * Regression: only the first page of 50 monitors used to be inspected, so a
   * monitor down on page two was invisible and the card claimed "healthy".
   */
  describe("pagination", () => {
    /** `count` monitors, all up, numbered from `start`. */
    function upMonitors(start: number, count: number) {
      return Array.from({ length: count }, (_, index) => ({
        id: 800_100_000 + start + index,
        friendly_name: `Monitor ${start + index}`,
        status: 2,
        custom_uptime_ratio: "100.000",
      }));
    }

    function page(offset: number, total: number, monitors: unknown[]) {
      return jsonResponse(200, {
        stat: "ok",
        pagination: { offset, limit: 50, total },
        monitors,
      });
    }

    const downMonitor = {
      id: 800_100_999,
      friendly_name: "OpenRouter credits probe",
      status: 9,
      custom_uptime_ratio: "97.500",
    };

    it("walks every page and reports the whole account once coverage is complete", async () => {
      vi.stubEnv("UPTIMEROBOT_API_KEY", "u800100-testkey");
      servePages(page(0, 60, upMonitors(0, 50)), page(50, 60, upMonitors(50, 10)));

      const result = await probeFor("uptimerobot").probe();
      expect(result.state).toBe("healthy");
      expect(result.headline).toBe("All 60 monitors are up.");
      expect(result.error).toBeUndefined();

      const byLabel = new Map(result.metrics.map((entry) => [entry.label, entry]));
      expect(byLabel.get("Monitors")?.value).toBe("60 monitors");
      // Coverage is complete, so nothing is hedged with a "+".
      expect(byLabel.get("Up")?.value).toBe("60");

      expect(fetchJsonMock).toHaveBeenCalledTimes(2);
      expect(requestBody(0).get("offset")).toBe("0");
      expect(requestBody(1).get("offset")).toBe("50");
      expect(requestBody(1).get("limit")).toBe("50");
    });

    it("finds a monitor that is down on a later page instead of reporting healthy", async () => {
      vi.stubEnv("UPTIMEROBOT_API_KEY", "u800100-testkey");
      servePages(
        page(0, 60, upMonitors(0, 50)),
        page(50, 60, [...upMonitors(50, 9), downMonitor])
      );

      const result = await probeFor("uptimerobot").probe();
      expect(result.state).toBe("degraded");
      expect(result.state).not.toBe("healthy");
      expect(result.headline).toBe("1 of 60 monitors is down.");

      const down = result.metrics.find((entry) => entry.label === "Down");
      expect(down?.value).toBe("1");
      expect(down?.hint).toBe("OpenRouter credits probe");
    });

    it("reports stale rather than healthy when the page cap leaves monitors unchecked", async () => {
      vi.stubEnv("UPTIMEROBOT_API_KEY", "u800100-testkey");
      // Six full pages of up monitors against an account claiming 1000.
      servePages(
        ...Array.from({ length: 6 }, (_, index) =>
          page(index * 50, 1000, upMonitors(index * 50, 50))
        )
      );

      const result = await probeFor("uptimerobot").probe();
      // A zero down count drawn from 300 of 1000 monitors is not evidence
      // that nothing is down.
      expect(result.state).toBe("stale");
      expect(result.state).not.toBe("healthy");
      expect(result.error).toBe("partial_read");
      expect(result.headline).toBe(
        "300 of 300 checked monitors are up.  700 more were not checked."
      );

      const byLabel = new Map(result.metrics.map((entry) => [entry.label, entry]));
      expect(byLabel.get("Monitors")?.value).toBe("1,000 monitors");
      expect(byLabel.get("Monitors")?.hint).toBe("300 of 1,000 checked");
      // Every tally is a floor while coverage is partial.
      expect(byLabel.get("Up")?.value).toBe("300+");

      // The cap is what stopped the sweep, not the mock running out of pages.
      expect(fetchJsonMock).toHaveBeenCalledTimes(6);
    });

    it("keeps the monitors it did read when a later page fails, and admits the gap", async () => {
      vi.stubEnv("UPTIMEROBOT_API_KEY", "u800100-testkey");
      servePages(page(0, 60, upMonitors(0, 50)), jsonResponse(500, null));

      const result = await probeFor("uptimerobot").probe();
      expect(result.state).toBe("stale");
      expect(result.error).toBe("partial_read");
      expect(result.headline).toBe(
        "50 of 50 checked monitors are up.  10 more were not checked."
      );
      expect(result.metrics.find((entry) => entry.label === "Up")?.value).toBe("50+");
      expect(fetchJsonMock).toHaveBeenCalledTimes(2);
    });

    it("stops paginating when the time budget is spent and does not claim healthy", async () => {
      // Frozen clock, advanced explicitly by the mock, so the budget is
      // exercised deterministically rather than against wall-clock timing.
      vi.useFakeTimers();
      const start = new Date("2026-08-11T12:00:00.000Z");
      vi.setSystemTime(start);
      vi.stubEnv("UPTIMEROBOT_API_KEY", "u800100-testkey");

      const slowFirstPage = page(0, 1000, upMonitors(0, 50));
      fetchJsonMock.mockImplementation(async () => {
        // Burn nearly the whole 12s budget on page one.
        vi.setSystemTime(new Date(start.getTime() + 11_500));
        return slowFirstPage;
      });

      const result = await probeFor("uptimerobot").probe();
      expect(result.state).toBe("stale");
      expect(result.error).toBe("partial_read");
      // One page only: too little budget remained to be worth another request.
      expect(fetchJsonMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("pagerduty probe", () => {
  it("is unconfigured without PAGERDUTY_API_KEY", () => {
    clearObservabilityEnv();
    expect(probeFor("pagerduty").isConfigured()).toBe(false);
    vi.stubEnv("PAGERDUTY_API_KEY", "pagerduty-fixture-token");
    expect(probeFor("pagerduty").isConfigured()).toBe(true);
  });

  it("reports healthy with no open incidents and sends v2 auth headers", async () => {
    vi.stubEnv("PAGERDUTY_API_KEY", "pagerduty-fixture-token");
    fetchJsonMock.mockResolvedValue(
      jsonResponse(200, { incidents: [], limit: 100, offset: 0, more: false, total: 0 })
    );

    const result = await probeFor("pagerduty").probe();
    expect(result.state).toBe("healthy");
    expect(result.headline).toBe("No open incidents.");
    expect(result.metrics.find((entry) => entry.label === "Triggered")?.value).toBe("0 incidents");
    expect(JSON.stringify(result)).not.toContain("pagerduty-fixture-token");

    expect(String(fetchJsonMock.mock.calls[0][0])).toContain("https://api.pagerduty.com/incidents");
    expect(requestHeaders().accept).toBe("application/vnd.pagerduty+json;version=2");
    expect(requestHeaders().authorization).toBe("Token token=pagerduty-fixture-token");
  });

  it("degrades on a triggered incident and ages it against a frozen clock", async () => {
    // The clock is frozen because "Oldest Triggered" renders a relative age.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
    vi.stubEnv("PAGERDUTY_API_KEY", "pagerduty-fixture-token");
    fetchJsonMock.mockResolvedValue(
      jsonResponse(200, {
        incidents: [
          {
            id: "PT4KHLK",
            status: "triggered",
            urgency: "high",
            created_at: "2026-08-11T09:30:00Z",
            title: "Usage Monitor 5xx spike",
          },
          {
            id: "PT4KHLM",
            status: "triggered",
            urgency: "low",
            created_at: "2026-08-11T11:45:00Z",
            title: "Backup lag",
          },
          {
            id: "PT4KHLN",
            status: "acknowledged",
            urgency: "high",
            created_at: "2026-08-11T08:00:00Z",
            title: "Coolify restart loop",
          },
        ],
        limit: 100,
        offset: 0,
        more: false,
        total: 3,
      })
    );

    const result = await probeFor("pagerduty").probe();
    expect(result.state).toBe("degraded");
    expect(result.headline).toBe("2 incidents are triggered.  1 more is acknowledged.");

    const byLabel = new Map(result.metrics.map((entry) => [entry.label, entry]));
    expect(byLabel.get("Triggered")?.value).toBe("2 incidents");
    expect(byLabel.get("Acknowledged")?.value).toBe("1 incident");
    expect(byLabel.get("High Urgency")?.value).toBe("2");
    expect(byLabel.get("Oldest Triggered")?.value).toBe("2h ago");
    // Incident titles are upstream text and never reach the card.
    expect(JSON.stringify(result)).not.toContain("5xx spike");
  });

  it("maps a rejected key to unavailable/unauthorized", async () => {
    vi.stubEnv("PAGERDUTY_API_KEY", "y_badkey");
    fetchJsonMock.mockResolvedValue(jsonResponse(401, { error: { code: 2006 } }));

    const result = await probeFor("pagerduty").probe();
    expect(result.state).toBe("unavailable");
    expect(result.error).toBe("unauthorized");
    expect(result.headline).toBe("PagerDuty rejected the API key.");
    expect(result.metrics).toEqual([]);
  });

  it("maps a 500 to a degraded upstream error", async () => {
    vi.stubEnv("PAGERDUTY_API_KEY", "pagerduty-fixture-token");
    fetchJsonMock.mockResolvedValue(jsonResponse(500, null));

    const result = await probeFor("pagerduty").probe();
    expect(result.state).toBe("degraded");
    expect(result.error).toBe("upstream_error");
  });

  it("returns unreachable rather than throwing on a transport failure", async () => {
    vi.stubEnv("PAGERDUTY_API_KEY", "pagerduty-fixture-token");
    fetchJsonMock.mockRejectedValue(new Error("network error"));

    const result = await probeFor("pagerduty").probe();
    expect(result.state).toBe("unreachable");
    expect(result.error).toBe("unreachable");
  });

  /**
   * Regression: with `more: true`, a first page of purely acknowledged
   * incidents used to render "healthy, zero triggered" even though a triggered
   * incident could be sitting on the very next page.
   */
  describe("pagination", () => {
    /** `count` acknowledged incidents, numbered from `start`. */
    function acknowledgedIncidents(start: number, count: number) {
      return Array.from({ length: count }, (_, index) => ({
        id: `PACK${start + index}`,
        status: "acknowledged",
        urgency: "low",
        created_at: "2026-08-11T08:00:00Z",
        title: "Being worked",
      }));
    }

    function page(offset: number, incidents: unknown[], more: boolean, total: number) {
      return jsonResponse(200, { incidents, limit: 100, offset, more, total });
    }

    const triggeredIncident = {
      id: "PT4KHLK",
      status: "triggered",
      urgency: "high",
      created_at: "2026-08-11T09:30:00Z",
      title: "Usage Monitor 5xx spike",
    };

    it("finds a triggered incident on a later page instead of reporting healthy", async () => {
      // "Oldest Triggered" renders a relative age, so the clock is frozen.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
      vi.stubEnv("PAGERDUTY_API_KEY", "pagerduty-fixture-token");
      servePages(
        page(0, acknowledgedIncidents(0, 100), true, 150),
        page(100, [...acknowledgedIncidents(100, 49), triggeredIncident], false, 150)
      );

      const result = await probeFor("pagerduty").probe();
      expect(result.state).toBe("degraded");
      expect(result.state).not.toBe("healthy");
      expect(result.headline).toBe("1 incident is triggered.  149 more are acknowledged.");
      // Coverage completed, so the counts are exact and carry no "+".
      expect(result.error).toBeUndefined();

      const byLabel = new Map(result.metrics.map((entry) => [entry.label, entry]));
      expect(byLabel.get("Triggered")?.value).toBe("1 incident");
      expect(byLabel.get("Acknowledged")?.value).toBe("149 incidents");
      expect(byLabel.get("Oldest Triggered")?.value).toBe("2h ago");
      expect(JSON.stringify(result)).not.toContain("5xx spike");

      expect(fetchJsonMock).toHaveBeenCalledTimes(2);
      expect(String(fetchJsonMock.mock.calls[0][0])).toContain("offset=0");
      expect(String(fetchJsonMock.mock.calls[1][0])).toContain("offset=100");
      expect(String(fetchJsonMock.mock.calls[1][0])).toContain("limit=100");
    });

    it("reports exact counts once every page has been read", async () => {
      vi.stubEnv("PAGERDUTY_API_KEY", "pagerduty-fixture-token");
      servePages(
        page(0, acknowledgedIncidents(0, 100), true, 120),
        page(100, acknowledgedIncidents(100, 20), false, 120)
      );

      const result = await probeFor("pagerduty").probe();
      expect(result.state).toBe("healthy");
      expect(result.headline).toBe("No triggered incidents.  120 acknowledged and being worked.");
      expect(result.error).toBeUndefined();
      expect(result.metrics.find((entry) => entry.label === "Acknowledged")?.value).toBe(
        "120 incidents"
      );
      // Nothing is hedged, and no coverage row is added, once coverage is whole.
      expect(result.metrics.some((entry) => entry.label === "Coverage")).toBe(false);
    });

    it("reports stale rather than healthy when the page cap leaves incidents unread", async () => {
      vi.stubEnv("PAGERDUTY_API_KEY", "pagerduty-fixture-token");
      servePages(
        ...Array.from({ length: 5 }, (_, index) =>
          page(index * 100, acknowledgedIncidents(index * 100, 100), true, 5000)
        )
      );

      const result = await probeFor("pagerduty").probe();
      // Zero triggered across 500 of 5000 open incidents proves nothing.
      expect(result.state).toBe("stale");
      expect(result.state).not.toBe("healthy");
      expect(result.error).toBe("partial_read");
      expect(result.headline).toBe(
        "No triggered incidents among the 500 checked.  4,500 more were not checked."
      );

      const byLabel = new Map(result.metrics.map((entry) => [entry.label, entry]));
      expect(byLabel.get("Triggered")?.value).toBe("0 incidents");
      expect(byLabel.get("Acknowledged")?.value).toBe("500 incidents+");
      expect(byLabel.get("Coverage")?.value).toBe("500 read");
      expect(byLabel.get("Coverage")?.hint).toBe("of 5,000 open");

      // The cap stopped the sweep, not the mock running out of pages.
      expect(fetchJsonMock).toHaveBeenCalledTimes(5);
    });

    it("keeps the incidents it did read when a later page fails, and admits the gap", async () => {
      vi.stubEnv("PAGERDUTY_API_KEY", "pagerduty-fixture-token");
      servePages(
        page(0, acknowledgedIncidents(0, 100), true, 150),
        jsonResponse(500, null)
      );

      const result = await probeFor("pagerduty").probe();
      expect(result.state).toBe("stale");
      expect(result.error).toBe("partial_read");
      expect(result.headline).toBe(
        "No triggered incidents among the 100 checked.  50 more were not checked."
      );
      expect(fetchJsonMock).toHaveBeenCalledTimes(2);
    });

    it("surfaces a first-page rejection rather than an empty partial card", async () => {
      vi.stubEnv("PAGERDUTY_API_KEY", "y_badkey");
      servePages(jsonResponse(403, { error: { code: 2006 } }));

      const result = await probeFor("pagerduty").probe();
      expect(result.state).toBe("unavailable");
      expect(result.error).toBe("unauthorized");
      expect(result.metrics).toEqual([]);
      // No point paginating past a rejected key.
      expect(fetchJsonMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("datadog probe", () => {
    function series(value: number) {
      return jsonResponse(200, { status: "ok", series: [{ pointlist: [[1, value]] }] });
    }

    it("is configured only when both API and app keys are present", () => {
      clearObservabilityEnv();
      expect(probeFor("datadog").isConfigured()).toBe(false);
      vi.stubEnv("DD_API_KEY", "dd-api");
      expect(probeFor("datadog").isConfigured()).toBe(false);
      vi.stubEnv("DD_APP_KEY", "dd-app");
      expect(probeFor("datadog").isConfigured()).toBe(true);
    });

    it("reports healthy inside the 5-host Free cap", async () => {
      vi.stubEnv("DD_API_KEY", "dd-api");
      vi.stubEnv("DD_APP_KEY", "dd-app");
      vi.stubEnv("DD_SITE", "us5.datadoghq.com");
      servePages(series(2), series(8), series(12), series(40));
      const result = await probeFor("datadog").probe();
      expect(result.state).toBe("healthy");
      expect(result.headline).toContain("5-host Free cap");
      expect(result.metrics[0]?.value).toBe("2 hosts");
    });

    it("degrades when estimated hosts exceed the Free cap", async () => {
      vi.stubEnv("DD_API_KEY", "dd-api");
      vi.stubEnv("DD_APP_KEY", "dd-app");
      servePages(series(6), series(20), series(1), series(1));
      const result = await probeFor("datadog").probe();
      expect(result.state).toBe("degraded");
      expect(result.error).toBe("host_cap");
      expect(result.headline).toContain("6 hosts");
    });
  });
});
