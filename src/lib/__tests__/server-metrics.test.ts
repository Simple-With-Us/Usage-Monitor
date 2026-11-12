import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchServerMetrics,
  resetServerMetricsCacheForTests,
} from "../server-metrics";

describe("fetchServerMetrics", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetServerMetricsCacheForTests();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("unexpected fetch");
      })
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetServerMetricsCacheForTests();
  });

  it("reports missing configuration without throwing when providers are unset", async () => {
    vi.stubEnv("HCLOUD_TOKEN", "");
    vi.stubEnv("HETZNER_API_TOKEN", "");
    vi.stubEnv("COOLIFY_SERVER_STATS", "");
    vi.stubEnv("COOLIFY_API_TOKEN", "");

    const payload = await fetchServerMetrics();
    expect(payload.configuration.hetzner).toBe("missing");
    expect(payload.configuration.coolify).toBe("missing");
    expect(payload.resources).toEqual([]);
    expect(payload.selfResources).toEqual([]);
    expect(payload.degraded).toBe(true);
    expect(payload.warnings?.some((w) => /Hetzner is not configured/i.test(w))).toBe(
      true
    );
  });

  it("normalizes Coolify resources and marks the Usage Monitor app as self", async () => {
    vi.stubEnv("COOLIFY_SERVER_STATS", "stats-token-for-tests");
    vi.stubEnv("COOLIFY_APP_UUID", "um-self-uuid");
    vi.stubEnv("HCLOUD_TOKEN", "");
    vi.stubEnv("HETZNER_API_TOKEN", "");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/resources")) {
          return new Response(
            JSON.stringify([
              {
                uuid: "um-self-uuid",
                name: "usage-monitor",
                type: "application",
                status: "running:healthy",
              },
              {
                uuid: "st-uuid",
                name: "socratic-app",
                type: "application",
                status: "running:healthy",
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response("not found", { status: 404 });
      })
    );

    const payload = await fetchServerMetrics();
    expect(payload.configuration.coolify).toBe("configured");
    expect(payload.resources).toHaveLength(2);
    expect(payload.fleetBackups).not.toBeNull();
    expect(payload.fleetBackups?.apps.length).toBeGreaterThanOrEqual(1);
    expect(payload.prevention).not.toBeNull();
    expect(payload.prevention?.summary.appsTotal).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(payload.prevention?.history)).toBe(true);
    expect(payload.selfResources).toMatchObject([
      {
        uuid: "um-self-uuid",
        name: "usage-monitor",
        type: "application",
        status: "running:healthy",
        self: true,
        fleetAppId: "usage-monitor",
        fleetLabel: "Usage Monitor",
      },
    ]);
    const st = payload.resources.find((r) => r.name === "socratic-app");
    expect(st?.self).toBe(false);
    expect(st?.fleetAppId).toBe("socratic-trade");
  });

  it("parses Hetzner CPU into host-percent and latest hostUsage", async () => {
    vi.stubEnv("HCLOUD_TOKEN", "hetzner-token");
    vi.stubEnv("HETZNER_SERVER_ID", "123");
    vi.stubEnv("COOLIFY_SERVER_STATS", "");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/metrics")) {
          return new Response(
            JSON.stringify({
              metrics: {
                time_series: {
                  cpu: {
                    values: [
                      [1_700_000_000, "400"], // 400% aggregate on 8 cores → 50%
                      [1_700_000_060, "800"],
                    ],
                  },
                  "network.0.bandwidth.in": {
                    values: [[1_700_000_060, "1000"]],
                  },
                  "network.0.bandwidth.out": {
                    values: [[1_700_000_060, "2000"]],
                  },
                  "disk.0.bandwidth.read": {
                    values: [[1_700_000_060, "3000"]],
                  },
                  "disk.0.bandwidth.write": {
                    values: [[1_700_000_060, "4000"]],
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("/servers/123") && !url.includes("/metrics")) {
          return new Response(
            JSON.stringify({
              server: {
                name: "fleet-hetzner-nbg1",
                status: "running",
                backup_window: "14-18",
                server_type: { name: "cx43", cores: 8, memory: 16 },
                public_net: { ipv4: { ip: "192.0.2.1" } },
                datacenter: { location: { name: "nbg1" } },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response("not found", { status: 404 });
      })
    );

    const payload = await fetchServerMetrics();
    expect(payload.host.name).toBe("fleet-hetzner-nbg1");
    expect(payload.host.cpus).toBe(8);
    expect(payload.host.backupWindow).toBe("14-18");
    expect(payload.host.memoryTotalBytes).toBe(16 * 1024 * 1024 * 1024);
    expect(payload.metrics.cpu).toHaveLength(2);
    expect(payload.metrics.cpu[0]?.value).toBe(50);
    expect(payload.metrics.cpu[1]?.value).toBe(100);
    expect(payload.hostUsage.cpuPct).toBe(100);
    expect(payload.hostUsage.networkRxBytesPerSec).toBe(1000);
    expect(payload.hostUsage.networkTxBytesPerSec).toBe(2000);
  });
});
