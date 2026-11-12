import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUsage, resolveBandwidthWindow } from "../render";

type ResourceKey = "service" | "postgres" | "keyValue";

function renderPage(
  key: ResourceKey,
  resources: Array<Record<string, unknown>>
): Response {
  return new Response(
    JSON.stringify(
      resources.map((resource) => ({
        [key]: resource,
        cursor: `${key}-${String(resource.id)}`,
      }))
    ),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function mockRenderLists(
  pages: Record<string, Record<string, unknown>[]>
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const cursor = url.searchParams.get("cursor") ?? "first";
    const key = `${url.pathname}:${cursor}`;
    const resourceKey: ResourceKey = url.pathname.endsWith("/services")
      ? "service"
      : url.pathname.endsWith("/postgres")
        ? "postgres"
        : "keyValue";
    return renderPage(resourceKey, pages[key] ?? []);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function bandwidthResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bandwidthSeries(
  entries: Array<{ resource: string; bytes: number[]; unit?: string }>
): Response {
  return bandwidthResponse(
    entries.map(({ resource, bytes, unit }) => ({
      labels: [{ field: "resource", value: resource }],
      values: bytes.map((value, index) => ({
        timestamp: `2026-07-${String(10 + index).padStart(2, "0")}T00:00:00Z`,
        value,
      })),
      unit: unit ?? "bytes",
    }))
  );
}

// Combines the account-inventory mock (services/postgres/key-value) with a
// bandwidth-metrics mock. Requests to unset apiKeys are simulated by
// returning 401 whenever the Authorization header carries an empty token,
// mirroring how Render itself rejects an unset/blank credential.
function mockRenderAccount(
  pages: Record<string, Record<string, unknown>[]>,
  bandwidthHandler?: (url: URL) => Response
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    if (headers?.Authorization === "Bearer ") {
      return bandwidthResponse({ id: "unauthorized", message: "invalid api key" }, 401);
    }
    const url = new URL(String(input));
    if (url.pathname === "/v1/metrics/bandwidth") {
      return bandwidthHandler ? bandwidthHandler(url) : bandwidthSeries([]);
    }
    const cursor = url.searchParams.get("cursor") ?? "first";
    const key = `${url.pathname}:${cursor}`;
    const resourceKey: ResourceKey = url.pathname.endsWith("/services")
      ? "service"
      : url.pathname.endsWith("/postgres")
        ? "postgres"
        : "keyValue";
    return renderPage(resourceKey, pages[key] ?? []);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("render adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("discovers and paginates paid services, Postgres, and Key Value without a serviceId", async () => {
    const fetchMock = mockRenderLists({
      "/v1/services:first": [
        {
          id: "srv_paid",
          name: "api",
          type: "web_service",
          suspended: "not_suspended",
          repo: "private/repo",
          serviceDetails: {
            plan: "starter",
            runtime: "node",
            region: "oregon",
            numInstances: 2,
            disk: { id: "dsk_1", name: "data", sizeGB: 20, mountPath: "/data" },
          },
        },
      ],
      "/v1/services:service-srv_paid": [
        {
          id: "srv_free",
          name: "landing",
          type: "static_site",
          suspended: "not_suspended",
          serviceDetails: { plan: "free", buildPlan: "starter" },
        },
      ],
      "/v1/postgres:first": [
        {
          id: "dpg_primary",
          name: "usage-db",
          plan: "basic_1gb",
          status: "available",
          suspended: "not_suspended",
          role: "primary",
          diskSizeGB: 25,
          highAvailabilityEnabled: true,
          readReplicas: [{ id: "dpg_replica", name: "usage-db-replica" }],
        },
      ],
      "/v1/key-value:first": [
        { id: "red_free", name: "cache-free", plan: "free", status: "available" },
        { id: "red_paid", name: "cache", plan: "starter", status: "available" },
      ],
    });

    const result = await fetchUsage("token");

    expect(result.totalCost).toBeNull();
    expect(result.externalBilling).toMatchObject({
      source: "render-service-plans",
      authoritative: true,
    });
    expect(result.externalBilling?.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: "srv_paid",
          planName: "starter",
          usageQuantity: 2,
          usageUnit: "instances",
          rollupRole: "canonical",
        }),
        expect.objectContaining({
          externalId: "srv_paid:disk:dsk_1",
          planName: "20 GB persistent disk",
          rollupRole: "component",
        }),
        expect.objectContaining({ externalId: "dpg_primary", planName: "basic_1gb" }),
        expect.objectContaining({ externalId: "red_paid", planName: "starter" }),
      ])
    );
    expect(result.externalBilling?.records.map((record) => record.externalId)).not.toContain(
      "srv_free"
    );
    expect(result.externalBilling?.records.map((record) => record.externalId)).not.toContain(
      "red_free"
    );
    expect(result.externalBilling?.records.every((record) => record.amountUsd == null)).toBe(true);
    expect(result.rawData).toEqual(
      expect.objectContaining({
        services: expect.arrayContaining([
          expect.objectContaining({ id: "srv_paid", runtime: "node", paidPlan: true }),
          expect.objectContaining({ id: "srv_free", paidPlan: false }),
        ]),
        postgres: [
          expect.objectContaining({
            id: "dpg_primary",
            readReplicas: [{ id: "dpg_replica", name: "usage-db-replica" }],
          }),
        ],
      })
    );
    expect(JSON.stringify(result.rawData)).not.toContain("private/repo");

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).toContain(
      "https://api.render.com/v1/services?limit=100&cursor=service-srv_paid"
    );
    expect(urls).toContain(
      "https://api.render.com/v1/services?limit=100&cursor=service-srv_free"
    );
    expect(urls).toContain(
      "https://api.render.com/v1/postgres?limit=100&cursor=postgres-dpg_primary"
    );
    expect(urls).toContain(
      "https://api.render.com/v1/key-value?limit=100&cursor=keyValue-red_paid"
    );
  });

  it("keeps accepting legacy serviceId config while using account-wide discovery", async () => {
    mockRenderLists({
      "/v1/services:first": [
        {
          id: "srv_current",
          name: "api-usage-monitor",
          type: "web_service",
          suspended: "not_suspended",
          plan: "legacy-fallback",
          serviceDetails: { plan: "starter", runtime: "node" },
        },
      ],
    });

    const result = await fetchUsage("token", { serviceId: "srv_current" });

    expect(result.externalBilling?.records[0]?.planName).toBe("starter");
    expect(result.rawData).toEqual(
      expect.objectContaining({
        services: [expect.objectContaining({ plan: "starter", runtime: "node" })],
      })
    );
  });

  it("rejects a malformed resource class instead of reconciling a partial inventory", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/postgres")) {
        return new Response(JSON.stringify({ postgres: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return renderPage(url.pathname.endsWith("/services") ? "service" : "keyValue", []);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchUsage("token")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it.each([
    [
      "non-static service plan",
      {
        "/v1/services:first": [
          { id: "srv_bad", type: "web_service", serviceDetails: { runtime: "node" } },
        ],
      },
    ],
    [
      "service details object",
      {
        "/v1/services:first": [
          { id: "srv_bad", type: "web_service", plan: "starter", serviceDetails: [] },
        ],
      },
    ],
    [
      "Postgres plan",
      { "/v1/postgres:first": [{ id: "dpg_bad", status: "available" }] },
    ],
    [
      "Key Value plan",
      { "/v1/key-value:first": [{ id: "red_bad", status: "available" }] },
    ],
    [
      "persistent disk identity",
      {
        "/v1/services:first": [
          {
            id: "srv_bad_disk",
            type: "web_service",
            serviceDetails: { plan: "starter", disk: { sizeGB: 10 } },
          },
        ],
      },
    ],
    [
      "persistent disk size",
      {
        "/v1/services:first": [
          {
            id: "srv_bad_disk",
            type: "web_service",
            serviceDetails: { plan: "starter", disk: { id: "dsk_bad" } },
          },
        ],
      },
    ],
  ])("rejects a resource missing its required %s", async (_field, pages) => {
    mockRenderLists(pages);

    await expect(fetchUsage("token")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("allows the documented plan-less static-site shape", async () => {
    mockRenderLists({
      "/v1/services:first": [
        { id: "srv_static", name: "landing", type: "static_site" },
      ],
    });

    const result = await fetchUsage("token");

    expect(result.externalBilling).toMatchObject({
      authoritative: true,
      records: [],
    });
    expect(result.rawData).toMatchObject({
      services: [{ id: "srv_static", type: "static_site", plan: null }],
    });
  });

  describe("bandwidth usage", () => {
    it("reports account-wide bandwidth as integer megabytes via totalRequests (happy path)", async () => {
      // Pin a mid-month instant so the calendar-month window unambiguously
      // reaches the 1st (coversCalendarMonthStart === true).
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
      const fetchMock = mockRenderAccount(
        {
          "/v1/services:first": [
            { id: "srv_a", name: "api", type: "web_service", serviceDetails: { plan: "starter" } },
            { id: "srv_b", name: "worker", type: "background_worker", serviceDetails: { plan: "starter" } },
          ],
        },
        (url) => {
          expect(url.searchParams.getAll("resource")).toEqual(["srv_a", "srv_b"]);
          expect(url.searchParams.get("resolutionSeconds")).toBe("3600");
          const start = url.searchParams.get("startTime")!;
          const end = url.searchParams.get("endTime")!;
          // Window is the current UTC calendar month to date, aligning with the
          // monthly limit it feeds (not a rolling 29-day span).
          expect(start).toBe("2026-07-01T00:00:00Z");
          expect(end).toBe("2026-07-15T12:00:00Z");
          return bandwidthSeries([
            { resource: "srv_a", bytes: [1_000_000_000, 2_000_000_000] },
            { resource: "srv_b", bytes: [500_000_000] },
          ]);
        }
      );

      const result = await fetchUsage("token");

      // 3.5 GB -> 3500 MB. Integer (fits the Int totalRequests column without
      // truncation), and exact bytes/GB stay in rawData.
      expect(result.totalRequests).toBe(3500);
      expect(Number.isInteger(result.totalRequests)).toBe(true);
      expect(result.postPersistError).toBeUndefined();
      expect(result.rawData).toMatchObject({
        bandwidth: {
          status: "ready",
          coversCalendarMonthStart: true,
          totalBytes: 3_500_000_000,
          totalMegabytes: 3500,
          totalGigabytes: 3.5,
          discoveredServiceCount: 2,
          coveredServiceCount: 2,
          truncatedResourceCount: false,
          byService: [
            { serviceId: "srv_a", bytes: 3_000_000_000, gigabytes: 3 },
            { serviceId: "srv_b", bytes: 500_000_000, gigabytes: 0.5 },
          ],
        },
        capabilities: expect.objectContaining({ bandwidthUsage: true }),
      });
      const bandwidthCalls = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/v1/metrics/bandwidth")
      );
      expect(bandwidthCalls).toHaveLength(1);
    });

    it("skips the bandwidth call and reports zero when the account has no services", async () => {
      mockRenderAccount({});

      const result = await fetchUsage("token");

      expect(result.totalRequests).toBe(0);
      expect(result.rawData).toMatchObject({
        bandwidth: {
          status: "ready",
          totalBytes: 0,
          totalMegabytes: 0,
          totalGigabytes: 0,
          byService: [],
        },
      });
    });

    it("marks bandwidth partial and withholds the scalar total when the service list is truncated", async () => {
      // One service page over the 200-resource cap: the summed bandwidth is a
      // subset, not the account-wide total, so it must not be presented as a
      // complete number that could drive a request-limit alert.
      const services = Array.from({ length: 205 }, (_, i) => ({
        id: `srv_${String(i).padStart(3, "0")}`,
        name: `svc-${i}`,
        type: "web_service",
        serviceDetails: { plan: "starter" },
      }));
      const bandwidthCalls: string[] = [];
      mockRenderAccount(
        { "/v1/services:first": services },
        (url) => {
          const ids = url.searchParams.getAll("resource");
          bandwidthCalls.push(...ids);
          return bandwidthSeries(ids.map((id) => ({ resource: id, bytes: [1_000_000] })));
        }
      );

      const result = await fetchUsage("token");

      // Never present a capped subset as the complete account-wide total.
      expect(result.totalRequests).toBeNull();
      expect(result.rawData).toMatchObject({
        bandwidth: {
          status: "partial",
          discoveredServiceCount: 205,
          coveredServiceCount: 200,
          truncatedResourceCount: true,
        },
        capabilities: expect.objectContaining({ bandwidthUsage: false }),
      });
      // Coverage is genuinely capped at the bound, not silently unbounded.
      expect(new Set(bandwidthCalls).size).toBe(200);
      // A truncation is a permanent shape, not a transient fetch failure, so it
      // does not mark the snapshot as a retryable partial-failure.
      expect(result.postPersistError).toBeUndefined();
    });

    it("keeps the account inventory when the bandwidth endpoint returns 401", async () => {
      mockRenderAccount(
        {
          "/v1/services:first": [
            {
              id: "srv_paid",
              name: "api",
              type: "web_service",
              suspended: "not_suspended",
              serviceDetails: { plan: "starter" },
            },
          ],
        },
        () => bandwidthResponse({ id: "unauthorized", message: "missing metrics scope" }, 401)
      );

      const result = await fetchUsage("token");

      // The inventory reconciliation must survive a bandwidth-only failure.
      expect(result.externalBilling?.records).toEqual(
        expect.arrayContaining([expect.objectContaining({ externalId: "srv_paid" })])
      );
      expect(result.totalRequests).toBeNull();
      expect(result.rawData).toMatchObject({
        bandwidth: { status: "error", errorCode: "HTTP_ERROR", httpStatus: 401 },
      });
      expect(result.postPersistError).toMatchObject({ code: "HTTP_ERROR", status: 401 });
    });

    it("fails cleanly (not hanging or crashing) when the API key is empty - the unset-token blind state", async () => {
      mockRenderAccount({
        "/v1/services:first": [{ id: "srv_a", type: "static_site" }],
      });

      await expect(fetchUsage("")).rejects.toMatchObject({
        code: "HTTP_ERROR",
        status: 401,
      });
    });

    it.each([
      ["a non-array top-level response", () => bandwidthResponse({ not: "an array" })],
      [
        "a series missing labels",
        () => bandwidthResponse([{ values: [{ timestamp: "2026-07-10T00:00:00Z", value: 1 }], unit: "bytes" }]),
      ],
      [
        "an unsupported unit",
        () => bandwidthSeries([{ resource: "srv_a", bytes: [100], unit: "gigabits" }]),
      ],
      [
        "a series for an unrequested resource",
        () => bandwidthSeries([{ resource: "srv_unexpected", bytes: [100] }]),
      ],
      [
        "a negative data point",
        () => bandwidthSeries([{ resource: "srv_a", bytes: [-5] }]),
      ],
    ])("degrades gracefully (keeps inventory) on malformed bandwidth data: %s", async (_case, handler) => {
      mockRenderAccount(
        {
          "/v1/services:first": [
            { id: "srv_a", name: "api", type: "web_service", serviceDetails: { plan: "starter" } },
          ],
        },
        handler
      );

      const result = await fetchUsage("token");

      expect(result.rawData).toMatchObject({
        services: expect.arrayContaining([expect.objectContaining({ id: "srv_a" })]),
        bandwidth: { status: "error", errorCode: "INVALID_RESPONSE" },
      });
      expect(result.totalRequests).toBeNull();
      expect(result.postPersistError).toMatchObject({ code: "INVALID_RESPONSE" });
    });

    it("clamps the window and withholds the scalar on the late-month edge that can't reach the 1st", async () => {
      // Last day of a 31-day month: the 1st is > 29 days back, outside Render's
      // 30-day metrics floor, so the window can't be a true calendar-month
      // total. It must clamp and report "partial", not silently present a
      // rolling window as the month's usage.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-31T12:00:00Z"));
      let observedStart = "";
      mockRenderAccount(
        {
          "/v1/services:first": [
            { id: "srv_a", name: "api", type: "web_service", serviceDetails: { plan: "starter" } },
          ],
        },
        (url) => {
          observedStart = url.searchParams.get("startTime")!;
          return bandwidthSeries([{ resource: "srv_a", bytes: [5_000_000_000] }]);
        }
      );

      const result = await fetchUsage("token");

      // Clamped to now - 29 days (2026-07-02T12:00:00Z), never before the 1st.
      expect(observedStart).toBe("2026-07-02T12:00:00Z");
      expect(result.totalRequests).toBeNull();
      expect(result.rawData).toMatchObject({
        bandwidth: {
          status: "partial",
          coversCalendarMonthStart: false,
          truncatedResourceCount: false,
          totalGigabytes: 5,
        },
        capabilities: expect.objectContaining({ bandwidthUsage: false }),
      });
      // Not a fetch failure - the snapshot still persists cleanly.
      expect(result.postPersistError).toBeUndefined();
    });
  });

  describe("resolveBandwidthWindow", () => {
    it("uses the 1st of the current UTC month when it is within the 30-day floor", () => {
      const window = resolveBandwidthWindow(new Date("2026-07-15T09:30:00Z"));
      expect(window).toEqual({
        start: "2026-07-01T00:00:00Z",
        end: "2026-07-15T09:30:00Z",
        coversCalendarMonthStart: true,
      });
    });

    it("treats the exact 29-day boundary as still reaching the 1st", () => {
      // 2026-07-30T00:00:00Z minus 29 days is exactly 2026-07-01T00:00:00Z.
      const window = resolveBandwidthWindow(new Date("2026-07-30T00:00:00Z"));
      expect(window.start).toBe("2026-07-01T00:00:00Z");
      expect(window.coversCalendarMonthStart).toBe(true);
    });

    it("clamps to the reachable floor once the 1st slips past 29 days", () => {
      const window = resolveBandwidthWindow(new Date("2026-07-31T12:00:00Z"));
      expect(window).toEqual({
        start: "2026-07-02T12:00:00Z",
        end: "2026-07-31T12:00:00Z",
        coversCalendarMonthStart: false,
      });
    });

    it("never clamps in a short month (Feb), where the 1st is always reachable", () => {
      const window = resolveBandwidthWindow(new Date("2026-02-28T23:00:00Z"));
      expect(window.start).toBe("2026-02-01T00:00:00Z");
      expect(window.coversCalendarMonthStart).toBe(true);
    });
  });
});
