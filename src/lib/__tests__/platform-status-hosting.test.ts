import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/adapters/helpers", () => ({
  fetchJson: vi.fn(),
}));

import { fetchJson } from "@/lib/adapters/helpers";
import { HOSTING_PROBES } from "@/lib/platform-status/probes/hosting";
import type { PlatformProbe } from "@/lib/platform-status/types";

const fetchJsonMock = vi.mocked(fetchJson);

/** Every env var any hosting probe reads.  Cleared before each test. */
const HOSTING_ENV = [
  "HCLOUD_TOKEN",
  "HETZNER_API_TOKEN",
  "HETZNER_API_KEY",
  "HETZNER_SERVER_ID",
  "COOLIFY_SERVER_STATS",
  "COOLIFY_API_TOKEN",
  "COOLIFY_HOST",
  "RENDER_API_KEY",
  "RENDER_API_TOKEN",
  "VERCEL_API_TOKEN",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "NETLIFY_API_TOKEN",
  "FLY_API_TOKEN",
  "FLY_ORG_SLUG",
  "RAILWAY_API_TOKEN",
  "DIGITALOCEAN_API_TOKEN",
];

function probeById(id: string): PlatformProbe {
  const probe = HOSTING_PROBES.find((candidate) => candidate.id === id);
  if (!probe) throw new Error(`no hosting probe with id ${id}`);
  return probe;
}

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    data,
    headers: new Headers(),
  };
}

function metricValue(
  metrics: Array<{ label: string; value: string }>,
  label: string
): string | undefined {
  return metrics.find((entry) => entry.label === label)?.value;
}

/** The fleet writes two spaces between sentences in every human-read string. */
function assertSentenceGaps(headline: string | null): void {
  expect(headline).not.toBeNull();
  // A period followed by a single space then a capital letter is the failure mode.
  expect(headline!).not.toMatch(/\. [A-Z]/);
}

describe("HOSTING_PROBES", () => {
  beforeEach(() => {
    fetchJsonMock.mockReset();
    for (const name of HOSTING_ENV) vi.stubEnv(name, "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fetchJsonMock.mockReset();
  });

  it("exposes the expected platforms in order, all in the hosting category", () => {
    expect(HOSTING_PROBES.map((probe) => probe.id)).toEqual([
      "hetzner",
      "coolify",
      "render",
      "vercel",
      "netlify",
      "fly-io",
      "railway",
      "digitalocean",
    ]);
    for (const probe of HOSTING_PROBES) {
      expect(probe.category).toBe("hosting");
      expect(probe.requiredEnv.length).toBeGreaterThan(0);
    }
  });

  it("reports every platform unconfigured when no env is set, without any network call", () => {
    for (const probe of HOSTING_PROBES) {
      expect(probe.isConfigured()).toBe(false);
    }
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });

  it("names the exact env var to set on the platforms with no integration yet", () => {
    expect(probeById("netlify").requiredEnv).toContain("NETLIFY_API_TOKEN");
    expect(probeById("fly-io").requiredEnv).toContain("FLY_API_TOKEN");
    expect(probeById("railway").requiredEnv).toContain("RAILWAY_API_TOKEN");
    expect(probeById("digitalocean").requiredEnv).toContain("DIGITALOCEAN_API_TOKEN");
  });

  // -------------------------------------------------------------------------
  // Hetzner
  // -------------------------------------------------------------------------

  describe("hetzner", () => {
    beforeEach(() => {
      vi.stubEnv("HETZNER_SERVER_ID", "12345678");
    });

    const server = {
      server: {
        id: 12345678,
        name: "fleet-hetzner-nbg1",
        status: "running",
        backup_window: "14-18",
        server_type: { name: "cx43", cores: 8, memory: 16 },
        location: { name: "nbg1" },
        public_net: { ipv4: { ip: "203.0.113.10" } },
      },
    };

    it("is configured by either Hetzner token name", () => {
      expect(probeById("hetzner").isConfigured()).toBe(false);
      vi.stubEnv("HETZNER_API_TOKEN", "hetzner-token");
      expect(probeById("hetzner").isConfigured()).toBe(true);
    });

    it("renders a healthy card from a running server with backups enabled", async () => {
      vi.stubEnv("HCLOUD_TOKEN", "hcloud-token");
      fetchJsonMock.mockResolvedValue(jsonResponse(server));

      const result = await probeById("hetzner").probe();

      expect(result.state).toBe("healthy");
      expect(result.headline).toBe("Hetzner server fleet-hetzner-nbg1 is running.");
      expect(metricValue(result.metrics, "Status")).toBe("Running");
      expect(metricValue(result.metrics, "Server Type")).toBe("cx43 · 8 vCPU · 16 GB");
      expect(metricValue(result.metrics, "Location")).toBe("nbg1");
      expect(metricValue(result.metrics, "Automatic Backups")).toBe("Enabled");
      expect(result.metrics.length).toBeLessThanOrEqual(6);

      const [url, init] = fetchJsonMock.mock.calls[0];
      expect(url).toBe("https://api.hetzner.cloud/v1/servers/12345678");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer hcloud-token"
      );
      // Nothing rendered may carry the token.
      expect(JSON.stringify(result)).not.toContain("hcloud-token");
    });

    it("calls out disabled automatic backups in a second sentence", async () => {
      vi.stubEnv("HCLOUD_TOKEN", "hcloud-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse({ server: { ...server.server, backup_window: null } })
      );

      const result = await probeById("hetzner").probe();

      expect(result.state).toBe("healthy");
      expect(result.headline).toBe(
        "Hetzner server fleet-hetzner-nbg1 is running.  Automatic backups are off."
      );
      assertSentenceGaps(result.headline);
      expect(metricValue(result.metrics, "Automatic Backups")).toBe("Disabled");
    });

    it("degrades when the server is not running", async () => {
      vi.stubEnv("HCLOUD_TOKEN", "hcloud-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse({ server: { ...server.server, status: "off" } })
      );

      const result = await probeById("hetzner").probe();

      expect(result.state).toBe("degraded");
      expect(result.headline).toContain("reports status off");
    });

    it("maps a rejected token to unavailable / unauthorized", async () => {
      vi.stubEnv("HCLOUD_TOKEN", "hcloud-token");
      fetchJsonMock.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));

      const result = await probeById("hetzner").probe();

      expect(result.state).toBe("unavailable");
      expect(result.error).toBe("unauthorized");
      expect(result.headline).toBe("Hetzner Cloud rejected the configured credentials.");
      expect(result.metrics).toEqual([]);
    });

    it("maps a transport failure to unreachable without throwing", async () => {
      vi.stubEnv("HCLOUD_TOKEN", "hcloud-token");
      fetchJsonMock.mockRejectedValue(new Error("socket hang up"));

      const result = await probeById("hetzner").probe();

      expect(result.state).toBe("unreachable");
      expect(result.error).toBe("unreachable");
    });

    it("maps a timeout to the timeout error code", async () => {
      vi.stubEnv("HCLOUD_TOKEN", "hcloud-token");
      fetchJsonMock.mockRejectedValue(
        new Error("Request to https://api.hetzner.cloud timed out after 8000ms")
      );

      const result = await probeById("hetzner").probe();

      expect(result.state).toBe("unreachable");
      expect(result.error).toBe("timeout");
    });
  });

  // -------------------------------------------------------------------------
  // Coolify
  // -------------------------------------------------------------------------

  describe("coolify", () => {
    it("renders a healthy card when every application is running and healthy", async () => {
      vi.stubEnv("COOLIFY_SERVER_STATS", "stats-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse([
          { uuid: "a", name: "usage-monitor", status: "running:healthy" },
          { uuid: "b", name: "socratic-trade", status: "running:healthy" },
        ])
      );

      const result = await probeById("coolify").probe();

      expect(result.state).toBe("healthy");
      expect(result.headline).toBe("All 2 Coolify applications are running and healthy.");
      expect(metricValue(result.metrics, "Applications")).toBe("2");
      expect(metricValue(result.metrics, "Running")).toBe("2");
      expect(metricValue(result.metrics, "Unknown Health")).toBe("0");
      expect(result.metrics.length).toBeLessThanOrEqual(6);
    });

    it("treats an application reporting running:unknown as unknown and degrades, naming it", async () => {
      vi.stubEnv("COOLIFY_SERVER_STATS", "stats-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse([
          { uuid: "a", name: "usage-monitor", status: "running:healthy" },
          { uuid: "b", name: "congress-trade", status: "running:unknown" },
          { uuid: "c", name: "socratic-trade", status: "running:healthy" },
        ])
      );

      const result = await probeById("coolify").probe();

      expect(result.state).toBe("degraded");
      expect(metricValue(result.metrics, "Unknown Health")).toBe("1");
      expect(metricValue(result.metrics, "Running")).toBe("2");
      expect(result.headline).toBe(
        "2 of 3 Coolify applications are healthy.  congress-trade reports unknown health."
      );
      assertSentenceGaps(result.headline);
    });

    it("prefers the stopped application in the headline when several things are wrong", async () => {
      vi.stubEnv("COOLIFY_SERVER_STATS", "stats-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse([
          { uuid: "a", name: "worker", status: "exited:unhealthy" },
          { uuid: "b", name: "api", status: "running:unhealthy" },
          { uuid: "c", name: "web", status: "running:unknown" },
        ])
      );

      const result = await probeById("coolify").probe();

      expect(result.state).toBe("degraded");
      expect(metricValue(result.metrics, "Stopped")).toBe("1");
      expect(metricValue(result.metrics, "Unhealthy")).toBe("1");
      expect(result.headline).toContain("worker is not running.");
    });

    it("uses the untrusted security mode for the operator-configured host", async () => {
      vi.stubEnv("COOLIFY_SERVER_STATS", "stats-token");
      vi.stubEnv("COOLIFY_HOST", "https://coolify.example.com/");
      fetchJsonMock.mockResolvedValue(jsonResponse([]));

      await probeById("coolify").probe();

      const [url, , options] = fetchJsonMock.mock.calls[0];
      expect(url).toBe("https://coolify.example.com/api/v1/applications");
      expect(options?.security).toBe("untrusted");
    });

    it("maps a rejected token to unavailable / unauthorized", async () => {
      vi.stubEnv("COOLIFY_SERVER_STATS", "stats-token");
      fetchJsonMock.mockResolvedValue(jsonResponse({ message: "forbidden" }, 403));

      const result = await probeById("coolify").probe();

      expect(result.state).toBe("unavailable");
      expect(result.error).toBe("unauthorized");
      expect(result.headline).toBe("Coolify rejected the configured credentials.");
    });
  });

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  describe("render", () => {
    it("counts services and names suspended ones", async () => {
      vi.stubEnv("RENDER_API_KEY", "rnd_key");
      fetchJsonMock.mockResolvedValue(
        jsonResponse([
          {
            cursor: "c1",
            service: { id: "srv-1", name: "api", type: "web_service", suspended: "not_suspended" },
          },
          {
            cursor: "c2",
            service: { id: "srv-2", name: "docs", type: "static_site", suspended: "suspended" },
          },
        ])
      );

      const result = await probeById("render").probe();

      expect(result.state).toBe("degraded");
      expect(metricValue(result.metrics, "Services")).toBe("2");
      expect(metricValue(result.metrics, "Live")).toBe("1");
      expect(metricValue(result.metrics, "Suspended")).toBe("1");
      expect(result.headline).toBe(
        "1 of 2 Render services are live.  docs is suspended."
      );
      assertSentenceGaps(result.headline);
    });

    it("is healthy when nothing is suspended", async () => {
      vi.stubEnv("RENDER_API_TOKEN", "rnd_key");
      fetchJsonMock.mockResolvedValue(
        jsonResponse([
          { cursor: "c1", service: { id: "srv-1", name: "api", suspended: "not_suspended" } },
        ])
      );

      const result = await probeById("render").probe();

      expect(result.state).toBe("healthy");
      expect(result.headline).toBe("All 1 Render services are live.");
    });

    it("maps a server error to degraded / upstream_error", async () => {
      vi.stubEnv("RENDER_API_KEY", "rnd_key");
      fetchJsonMock.mockResolvedValue(jsonResponse(null, 503));

      const result = await probeById("render").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("upstream_error");
      expect(result.headline).toBe("Render returned a server error.");
    });
  });

  // -------------------------------------------------------------------------
  // Vercel
  // -------------------------------------------------------------------------

  describe("vercel", () => {
    it("summarizes production deployment health", async () => {
      vi.stubEnv("VERCEL_API_TOKEN", "vercel-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse({
          projects: [
            { id: "p1", name: "marketing", targets: { production: { readyState: "READY" } } },
            { id: "p2", name: "dashboard", targets: { production: { readyState: "ERROR" } } },
            { id: "p3", name: "docs", latestDeployments: [{ readyState: "BUILDING" }] },
          ],
          pagination: { count: 3 },
        })
      );

      const result = await probeById("vercel").probe();

      expect(result.state).toBe("degraded");
      expect(metricValue(result.metrics, "Projects")).toBe("3");
      expect(metricValue(result.metrics, "Production Ready")).toBe("1");
      expect(metricValue(result.metrics, "Failed")).toBe("1");
      expect(metricValue(result.metrics, "Building")).toBe("1");
      expect(result.headline).toContain("dashboard failed to deploy.");
      assertSentenceGaps(result.headline);
    });

    it("does not report healthy when a project has no ready production deployment", async () => {
      // Regression: this returned `healthy` while its own headline read
      // "0 of 1 ... have a ready production deployment".  Nothing failed
      // outright, but nothing was confirmed live either.
      vi.stubEnv("VERCEL_API_TOKEN", "vercel-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse({
          projects: [{ id: "p1", name: "marketing", latestDeployments: [{ readyState: "BUILDING" }] }],
          pagination: { count: 1 },
        })
      );

      const result = await probeById("vercel").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("deploy_in_progress");
      expect(metricValue(result.metrics, "Production Ready")).toBe("0");
      expect(result.headline).not.toContain("All ");
      assertSentenceGaps(result.headline);
    });

    it("does not report healthy when a production state cannot be classified", async () => {
      vi.stubEnv("VERCEL_API_TOKEN", "vercel-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse({
          projects: [{ id: "p1", name: "marketing", targets: { production: { readyState: "WAT" } } }],
          pagination: { count: 1 },
        })
      );

      const result = await probeById("vercel").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("not_ready");
    });

    it("is healthy when every production deployment is ready", async () => {
      vi.stubEnv("VERCEL_API_TOKEN", "vercel-token");
      vi.stubEnv("VERCEL_TEAM_ID", "team_abc");
      fetchJsonMock.mockResolvedValue(
        jsonResponse({
          projects: [{ id: "p1", name: "marketing", targets: { production: { readyState: "READY" } } }],
        })
      );

      const result = await probeById("vercel").probe();

      expect(result.state).toBe("healthy");
      expect(result.headline).toBe(
        "All 1 Vercel projects have a ready production deployment."
      );
      expect(String(fetchJsonMock.mock.calls[0][0])).toContain("teamId=team_abc");
    });

    it("maps a rejected token to unavailable / unauthorized", async () => {
      vi.stubEnv("VERCEL_API_TOKEN", "vercel-token");
      fetchJsonMock.mockResolvedValue(jsonResponse({ error: { code: "forbidden" } }, 403));

      const result = await probeById("vercel").probe();

      expect(result.state).toBe("unavailable");
      expect(result.error).toBe("unauthorized");
    });
  });

  // -------------------------------------------------------------------------
  // Netlify
  // -------------------------------------------------------------------------

  describe("netlify", () => {
    /** Published + Failed Builds + Not Published must always equal Sites. */
    function assertNetlifyBucketsTotal(metrics: Array<{ label: string; value: string }>): void {
      const read = (label: string) => Number(metricValue(metrics, label));
      expect(read("Published") + read("Failed Builds") + read("Not Published")).toBe(
        read("Sites")
      );
    }

    it("counts published sites and names failed builds", async () => {
      vi.stubEnv("NETLIFY_API_TOKEN", "netlify-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse([
          { id: "s1", name: "brochure", published_deploy: { state: "ready" } },
          { id: "s2", name: "blog", published_deploy: { state: "error" } },
        ])
      );

      const result = await probeById("netlify").probe();

      expect(result.state).toBe("degraded");
      expect(metricValue(result.metrics, "Sites")).toBe("2");
      expect(metricValue(result.metrics, "Published")).toBe("1");
      expect(metricValue(result.metrics, "Failed Builds")).toBe("1");
      expect(metricValue(result.metrics, "Not Published")).toBe("0");
      assertNetlifyBucketsTotal(result.metrics);
      expect(result.headline).toContain("blog failed to build.");
      assertSentenceGaps(result.headline);
    });

    it("never calls a site with no published deploy healthy", async () => {
      vi.stubEnv("NETLIFY_API_TOKEN", "netlify-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse([
          { id: "s1", name: "brochure", published_deploy: { state: "ready" } },
          { id: "s2", name: "blog", published_deploy: null },
        ])
      );

      const result = await probeById("netlify").probe();

      expect(result.state).toBe("degraded");
      expect(metricValue(result.metrics, "Published")).toBe("1");
      expect(metricValue(result.metrics, "Not Published")).toBe("1");
      assertNetlifyBucketsTotal(result.metrics);
      expect(result.headline).toBe(
        "1 of 2 Netlify sites have a published deploy.  blog has no published deploy."
      );
      assertSentenceGaps(result.headline);
    });

    it("counts an in-flight or cancelled deploy state as not published", async () => {
      vi.stubEnv("NETLIFY_API_TOKEN", "netlify-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse([
          { id: "s1", name: "brochure", published_deploy: { state: "building" } },
          { id: "s2", name: "blog", published_deploy: { state: "canceled" } },
          { id: "s3", name: "docs" },
        ])
      );

      const result = await probeById("netlify").probe();

      expect(result.state).toBe("degraded");
      expect(metricValue(result.metrics, "Sites")).toBe("3");
      expect(metricValue(result.metrics, "Published")).toBe("0");
      expect(metricValue(result.metrics, "Failed Builds")).toBe("0");
      expect(metricValue(result.metrics, "Not Published")).toBe("3");
      assertNetlifyBucketsTotal(result.metrics);
      // The old bug: "Published: 0" beside a headline claiming every site published.
      expect(result.headline).toBe(
        "0 of 3 Netlify sites have a published deploy.  brochure and 2 more have no published deploy."
      );
      assertSentenceGaps(result.headline);
    });

    it("still leads with the failed build when sites are also unpublished", async () => {
      vi.stubEnv("NETLIFY_API_TOKEN", "netlify-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse([
          { id: "s1", name: "brochure", published_deploy: { state: "ready" } },
          { id: "s2", name: "blog", published_deploy: { state: "failed" } },
          { id: "s3", name: "docs", published_deploy: { state: "enqueued" } },
        ])
      );

      const result = await probeById("netlify").probe();

      expect(result.state).toBe("degraded");
      expect(metricValue(result.metrics, "Failed Builds")).toBe("1");
      expect(metricValue(result.metrics, "Not Published")).toBe("1");
      assertNetlifyBucketsTotal(result.metrics);
      expect(result.headline).toBe(
        "1 of 3 Netlify sites have a published deploy.  blog failed to build."
      );
    });

    it("is healthy only when every site has a ready published deploy", async () => {
      vi.stubEnv("NETLIFY_API_TOKEN", "netlify-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse([
          { id: "s1", name: "brochure", published_deploy: { state: "ready" } },
          { id: "s2", name: "blog", published_deploy: { state: "ready" } },
        ])
      );

      const result = await probeById("netlify").probe();

      expect(result.state).toBe("healthy");
      expect(metricValue(result.metrics, "Published")).toBe("2");
      expect(metricValue(result.metrics, "Not Published")).toBe("0");
      assertNetlifyBucketsTotal(result.metrics);
      expect(result.headline).toBe("All 2 Netlify sites have a published deploy.");
    });

    it("maps a missing resource to degraded / not_found", async () => {
      vi.stubEnv("NETLIFY_API_TOKEN", "netlify-token");
      fetchJsonMock.mockResolvedValue(jsonResponse({ message: "Not Found" }, 404));

      const result = await probeById("netlify").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("not_found");
    });
  });

  // -------------------------------------------------------------------------
  // Fly.io
  // -------------------------------------------------------------------------

  describe("fly-io", () => {
    it("counts apps and machines for the configured organization", async () => {
      vi.stubEnv("FLY_API_TOKEN", "fly-token");
      vi.stubEnv("FLY_ORG_SLUG", "jays-services");
      fetchJsonMock.mockResolvedValue(
        jsonResponse({
          total_apps: 2,
          apps: [
            { id: "a1", name: "edge-api", machine_count: 3, network: "default" },
            { id: "a2", name: "cron", machine_count: 1, network: "default" },
          ],
        })
      );

      const result = await probeById("fly-io").probe();

      expect(result.state).toBe("healthy");
      expect(metricValue(result.metrics, "Apps")).toBe("2");
      expect(metricValue(result.metrics, "Machines")).toBe("4");
      expect(metricValue(result.metrics, "Organization")).toBe("jays-services");
      expect(result.headline).toBe("Fly.io reports 2 apps on 4 machines.");
      expect(String(fetchJsonMock.mock.calls[0][0])).toBe(
        "https://api.machines.dev/v1/apps?org_slug=jays-services"
      );
    });

    it("degrades when an app has no machines", async () => {
      vi.stubEnv("FLY_API_TOKEN", "fly-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse({ total_apps: 1, apps: [{ id: "a1", name: "edge-api", machine_count: 0 }] })
      );

      const result = await probeById("fly-io").probe();

      expect(result.state).toBe("degraded");
      expect(result.headline).toContain("edge-api has no machines.");
      assertSentenceGaps(result.headline);
    });

    it("maps rate limiting to degraded / rate_limited", async () => {
      vi.stubEnv("FLY_API_TOKEN", "fly-token");
      fetchJsonMock.mockResolvedValue(jsonResponse(null, 429));

      const result = await probeById("fly-io").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("rate_limited");
      expect(result.headline).toBe("Fly.io is rate limiting status checks.");
    });
  });

  // -------------------------------------------------------------------------
  // Railway
  // -------------------------------------------------------------------------

  describe("railway", () => {
    it("counts projects and services from the GraphQL response", async () => {
      vi.stubEnv("RAILWAY_API_TOKEN", "railway-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse({
          data: {
            me: {
              projects: {
                edges: [
                  {
                    node: {
                      id: "p1",
                      name: "fleet",
                      services: { edges: [{ node: { id: "s1" } }, { node: { id: "s2" } }] },
                    },
                  },
                  { node: { id: "p2", name: "scratch", services: { edges: [] } } },
                ],
              },
            },
          },
        })
      );

      const result = await probeById("railway").probe();

      expect(result.state).toBe("healthy");
      expect(metricValue(result.metrics, "Projects")).toBe("2");
      expect(metricValue(result.metrics, "Services")).toBe("2");
      expect(result.headline).toBe(
        "Railway lists 2 projects with 2 services.  Deployment status is not checked."
      );
      assertSentenceGaps(result.headline);
      expect(fetchJsonMock.mock.calls[0][1]?.method).toBe("POST");
    });

    it("says plainly that deployment status is not part of the inventory", async () => {
      vi.stubEnv("RAILWAY_API_TOKEN", "railway-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse({
          data: {
            me: {
              projects: {
                edges: [
                  {
                    node: { id: "p1", name: "fleet", services: { edges: [{ node: { id: "s1" } }] } },
                  },
                ],
              },
            },
          },
        })
      );

      const result = await probeById("railway").probe();

      // The query cannot see a stopped, crashed or failed deployment, so the
      // card must not imply the discovered services are running.
      expect(result.headline).not.toMatch(/running|live|up\b/i);
      expect(metricValue(result.metrics, "Deployment Status")).toBe("Not checked");
      // Singular copy, because "1 projects" is not something a human writes.
      expect(result.headline).toBe(
        "Railway lists 1 project with 1 service.  Deployment status is not checked."
      );
    });

    it("degrades on a GraphQL error returned with HTTP 200", async () => {
      vi.stubEnv("RAILWAY_API_TOKEN", "railway-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse({ data: null, errors: [{ message: "Not Authorized" }] })
      );

      const result = await probeById("railway").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("graphql_error");
      // The upstream message is never echoed back to the card.
      expect(JSON.stringify(result)).not.toContain("Not Authorized");
    });

    it("maps a server error to degraded / upstream_error", async () => {
      vi.stubEnv("RAILWAY_API_TOKEN", "railway-token");
      fetchJsonMock.mockResolvedValue(jsonResponse(null, 500));

      const result = await probeById("railway").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("upstream_error");
    });
  });

  // -------------------------------------------------------------------------
  // DigitalOcean
  // -------------------------------------------------------------------------

  describe("digitalocean", () => {
    it("counts droplets and names the ones that are not active", async () => {
      vi.stubEnv("DIGITALOCEAN_API_TOKEN", "do-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse({
          droplets: [
            { id: 1, name: "web-1", status: "active", region: { slug: "nyc3" } },
            { id: 2, name: "batch-1", status: "off", region: { slug: "nyc3" } },
          ],
          meta: { total: 2 },
        })
      );

      const result = await probeById("digitalocean").probe();

      expect(result.state).toBe("degraded");
      expect(metricValue(result.metrics, "Droplets")).toBe("2");
      expect(metricValue(result.metrics, "Active")).toBe("1");
      expect(metricValue(result.metrics, "Not Active")).toBe("1");
      expect(result.headline).toBe(
        "1 of 2 DigitalOcean droplets are active.  batch-1 is not active."
      );
      assertSentenceGaps(result.headline);
    });

    it("is healthy when every droplet is active", async () => {
      vi.stubEnv("DIGITALOCEAN_API_TOKEN", "do-token");
      fetchJsonMock.mockResolvedValue(
        jsonResponse({ droplets: [{ id: 1, name: "web-1", status: "active" }] })
      );

      const result = await probeById("digitalocean").probe();

      expect(result.state).toBe("healthy");
      expect(result.headline).toBe("All 1 DigitalOcean droplets are active.");
    });

    it("maps a rejected token to unavailable / unauthorized", async () => {
      vi.stubEnv("DIGITALOCEAN_API_TOKEN", "do-token");
      fetchJsonMock.mockResolvedValue(jsonResponse({ id: "unauthorized" }, 401));

      const result = await probeById("digitalocean").probe();

      expect(result.state).toBe("unavailable");
      expect(result.error).toBe("unauthorized");
    });
  });
});
