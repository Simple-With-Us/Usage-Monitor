import { EventEmitter } from "node:events";
import https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../coolify";

// The self-hosted-host test below drives fetchJson's "untrusted"/pinned-DNS
// path (helpers.ts), which resolves the hostname via node:dns/promises
// `lookup` before ever touching https.request. dns/promises' named exports
// are non-configurable ESM bindings (vi.spyOn can't touch them), so the
// module itself has to be mocked to keep that resolution offline and
// deterministic instead of making a real DNS query.
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  };
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installCoolifyMock(options: {
  servers?: unknown[];
  applications?: unknown[];
  resourcesByServerUuid?: Record<string, unknown[] | number>;
  serversStatus?: number;
  applicationsStatus?: number;
}) {
  const fetchMock = vi.fn((input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v1/servers") {
      if (options.serversStatus) {
        return Promise.resolve(jsonResponse({ message: "error" }, options.serversStatus));
      }
      return Promise.resolve(jsonResponse(options.servers ?? []));
    }
    if (url.pathname === "/api/v1/applications") {
      if (options.applicationsStatus) {
        return Promise.resolve(jsonResponse({ message: "error" }, options.applicationsStatus));
      }
      return Promise.resolve(jsonResponse(options.applications ?? []));
    }
    const resourceMatch = url.pathname.match(/^\/api\/v1\/servers\/([^/]+)\/resources$/);
    if (resourceMatch) {
      const entry = options.resourcesByServerUuid?.[resourceMatch[1]];
      if (typeof entry === "number") {
        return Promise.resolve(jsonResponse({ message: "error" }, entry));
      }
      return Promise.resolve(jsonResponse(entry ?? []));
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Non-default (self-hosted) hosts go through fetchJson's "untrusted" /
// pinned-DNS path in helpers.ts, which calls node:dns/promises `lookup` and
// node:https `request` directly instead of the global `fetch` - so those two
// must be mocked here, or this test would make a real DNS lookup and a real
// HTTPS request to whatever host it's given.
function installUntrustedCoolifyMock(options: { servers?: unknown[]; applications?: unknown[] }) {
  const calls: Array<{ url: string; headers: Record<string, unknown> }> = [];
  vi.spyOn(https, "request").mockImplementation(((
    url: unknown,
    opts: Record<string, unknown>,
    callback: (res: EventEmitter & { statusCode: number; headers: Record<string, string>; resume: () => void }) => void
  ) => {
    const parsedUrl = url instanceof URL ? url : new URL(String(url));
    calls.push({ url: parsedUrl.toString(), headers: (opts?.headers as Record<string, unknown>) ?? {} });

    let body: unknown = [];
    if (parsedUrl.pathname === "/api/v1/servers") body = options.servers ?? [];
    else if (parsedUrl.pathname === "/api/v1/applications") body = options.applications ?? [];

    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      resume: () => {},
    });

    const request = Object.assign(new EventEmitter(), {
      write: () => {},
      destroy: () => {},
      end: () => {
        queueMicrotask(() => {
          callback(response);
          queueMicrotask(() => {
            response.emit("data", Buffer.from(JSON.stringify(body)));
            response.emit("end");
          });
        });
      },
    });

    return request;
  }) as unknown as typeof https.request);

  return { calls };
}

describe("coolify adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports server reachability and application deployment status against the default Coolify Cloud host", async () => {
    const fetchMock = installCoolifyMock({
      servers: [
        { uuid: "srv-1", name: "prod", ip: "1.2.3.4", is_reachable: true, is_usable: true },
        { uuid: "srv-2", name: "backup", ip: "5.6.7.8", is_reachable: false, is_usable: false },
      ],
      applications: [
        { uuid: "app-1", name: "web", fqdn: "https://web.example.com", status: "running:healthy" },
        { uuid: "app-2", name: "worker", fqdn: null, status: "exited" },
      ],
      resourcesByServerUuid: {
        "srv-1": [{ uuid: "app-1", name: "web", type: "application", status: "running:healthy" }],
        "srv-2": [],
      },
    });

    const result = await fetchUsage("coolify-token");

    expect(result.totalCost).toBeNull();
    expect(result.totalRequests).toBeNull();
    expect(result.balance).toBeNull();
    expect(result.externalBilling).toBeUndefined();
    expect(result.externalBillingSyncs).toBeUndefined();

    expect(result.rawData).toMatchObject({
      host: "https://app.coolify.io",
      resourceCounts: {
        servers: 2,
        serversUp: 1,
        serversDown: 1,
        applications: 2,
        applicationsDeployed: 2,
        applicationsUp: 1,
        applicationsDown: 1,
        applicationsDegraded: 0,
      },
      capabilities: {
        serverReachability: true,
        applicationHealth: true,
        resourceUsageMetrics: false,
        perServerResourceInventory: "ready",
        billing: false,
      },
    });

    const rawData = result.rawData as {
      servers: Array<Record<string, unknown>>;
      applications: Array<Record<string, unknown>>;
    };
    expect(rawData.servers).toEqual([
      expect.objectContaining({ uuid: "srv-1", up: true, reachable: true, usable: true, resourcesState: "ready" }),
      expect.objectContaining({ uuid: "srv-2", up: false, reachable: false, usable: false, resourcesState: "ready" }),
    ]);
    expect(rawData.applications).toEqual([
      expect.objectContaining({ uuid: "app-1", up: true, degraded: false, deployed: true, state: "running", health: "healthy" }),
      expect.objectContaining({ uuid: "app-2", up: false, deployed: true, state: "exited", health: null }),
    ]);

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).toContain("https://app.coolify.io/api/v1/servers");
    expect(urls).toContain("https://app.coolify.io/api/v1/applications");
    expect(urls).toContain("https://app.coolify.io/api/v1/servers/srv-1/resources");
    for (const call of fetchMock.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>) {
      expect(call[1]?.headers).toMatchObject({
        Authorization: "Bearer coolify-token",
      });
    }
  });

  it("treats a running:unhealthy application as up but degraded, and a null status as not-yet-deployed", async () => {
    installCoolifyMock({
      servers: [],
      applications: [
        { uuid: "app-1", name: "flaky", status: "running:unhealthy" },
        { uuid: "app-2", name: "never-deployed", status: null },
      ],
    });

    const result = await fetchUsage("token");

    const rawData = result.rawData as { applications: Array<Record<string, unknown>> };
    expect(rawData.applications).toEqual([
      expect.objectContaining({ uuid: "app-1", up: true, degraded: true, state: "running", health: "unhealthy" }),
      expect.objectContaining({ uuid: "app-2", up: null, degraded: false, deployed: false, state: null }),
    ]);
    expect((result.rawData as { resourceCounts: Record<string, number> }).resourceCounts).toMatchObject({
      applications: 2,
      applicationsDeployed: 1,
      applicationsUp: 1,
      applicationsDegraded: 1,
    });
  });

  it("uses a configured self-hosted host instead of the Coolify Cloud default", async () => {
    const { calls } = installUntrustedCoolifyMock({ servers: [], applications: [] });

    const result = await fetchUsage("token", { host: "https://host.jays.services/" });

    expect((result.rawData as { host: string }).host).toBe("https://host.jays.services");
    const urls = calls.map((call) => call.url);
    expect(urls).toContain("https://host.jays.services/api/v1/servers");
    expect(urls).toContain("https://host.jays.services/api/v1/applications");
    for (const call of calls) {
      expect(call.headers).toMatchObject({ Authorization: "Bearer token" });
    }
  });

  it("fails closed with a typed, gracefully-handled error instead of crashing when the token is rejected (401)", async () => {
    installCoolifyMock({ serversStatus: 401 });

    await expect(fetchUsage("bad-token")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 401,
      retryable: false,
    });
  });

  it("fails closed on a 401 from the applications endpoint too", async () => {
    installCoolifyMock({ servers: [], applicationsStatus: 401 });

    await expect(fetchUsage("bad-token")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 401,
    });
  });

  it("degrades per-server resource detail gracefully on failure without discarding the core health snapshot", async () => {
    installCoolifyMock({
      servers: [{ uuid: "srv-1", name: "prod", is_reachable: true, is_usable: true }],
      applications: [],
      resourcesByServerUuid: { "srv-1": 500 },
    });

    const result = await fetchUsage("token");

    const rawData = result.rawData as { servers: Array<Record<string, unknown>> };
    expect(rawData.servers).toEqual([
      expect.objectContaining({ uuid: "srv-1", up: true, resources: null, resourcesState: "unavailable" }),
    ]);
    expect((result.rawData as { capabilities: Record<string, unknown> }).capabilities).toMatchObject({
      perServerResourceInventory: "ready",
    });
  });

  it("rejects malformed (non-array) top-level responses instead of guessing", async () => {
    installCoolifyMock({});
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/v1/servers") {
          return Promise.resolve(jsonResponse({ not: "an array" }));
        }
        return Promise.resolve(jsonResponse([]));
      })
    );

    await expect(fetchUsage("token")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("requires a non-empty API token", async () => {
    await expect(fetchUsage("")).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
    await expect(fetchUsage("   ")).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
  });

  it("rejects a non-string host instead of silently ignoring it", async () => {
    await expect(
      fetchUsage("token", { host: 12345 as unknown as string })
    ).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
  });

  it("never reports a fabricated cost, balance, or billing record", async () => {
    installCoolifyMock({
      servers: [{ uuid: "srv-1", name: "prod", is_reachable: true, is_usable: true }],
      applications: [{ uuid: "app-1", name: "web", status: "running:healthy" }],
      resourcesByServerUuid: { "srv-1": [] },
    });

    const result = await fetchUsage("token");

    expect(result.totalCost).toBeNull();
    expect(result.balance).toBeNull();
    expect(result.credits).toBeNull();
    expect(result.externalBilling).toBeUndefined();
    expect(result.externalBillingSyncs).toBeUndefined();
    expect((result.rawData as { capabilities: Record<string, unknown> }).capabilities).toMatchObject({
      billing: false,
    });
  });
});
