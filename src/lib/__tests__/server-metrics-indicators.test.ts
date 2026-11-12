import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildHostPreventionSnapshot,
  recordAndBuildPreventionPanel,
  resetHostMetricsHistoryForTests,
} from "../server-metrics-indicators";
import type { ServerMetricsPayload } from "../server-metrics";

function basePayload(
  overrides: Partial<ServerMetricsPayload> = {}
): ServerMetricsPayload {
  return {
    degraded: false,
    stale: false,
    cacheAgeSeconds: 0,
    configuration: { hetzner: "missing", coolify: "missing" },
    host: {
      name: "fleet-hetzner-nbg1",
      status: "running",
      serverType: "cx43",
      cpus: 8,
      memoryTotalBytes: 16 * 1024 ** 3,
      location: "nbg1",
      ip: null,
      backupWindow: "14-18",
    },
    hostUsage: {
      cpuPct: 20,
      networkRxBytesPerSec: 1000,
      networkTxBytesPerSec: 500,
      diskReadBytesPerSec: 0,
      diskWriteBytesPerSec: 0,
    },
    metrics: {
      cpu: [
        { timestamp: 1, value: 15 },
        { timestamp: 2, value: 25 },
      ],
      networkRx: [],
      networkTx: [],
      diskRead: [],
      diskWrite: [],
    },
    resources: [
      {
        uuid: "um",
        name: "usage-monitor",
        type: "application",
        status: "running:healthy",
        self: true,
        fleetAppId: "usage-monitor",
        fleetLabel: "Usage Monitor",
      },
    ],
    selfResources: [],
    appDisk: {
      freeBytes: 50 * 1024 ** 3,
      totalBytes: 150 * 1024 ** 3,
      usedPct: 33,
      ok: true,
    },
    fleetBackups: {
      configured: true,
      ok: true,
      asOf: "2026-08-11T00:00:00.000Z",
      cacheAgeSeconds: 0,
      apps: [
        {
          id: "usage-monitor",
          label: "Usage Monitor",
          self: true,
          ok: true,
          locations: [],
        },
      ],
      warnings: [],
    },
    prevention: null,
    asOf: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildHostPreventionSnapshot", () => {
  beforeEach(() => {
    resetHostMetricsHistoryForTests();
  });
  afterEach(() => {
    resetHostMetricsHistoryForTests();
  });

  it("is ok when CPU, disk, apps, and backups look healthy", () => {
    const snap = buildHostPreventionSnapshot(basePayload());
    expect(snap.overall).toBe("ok");
    expect(snap.summary.cpuPeakPct).toBe(25);
    expect(snap.summary.appsHealthy).toBe(1);
    expect(snap.indicators.filter((i) => i.severity !== "info")).toEqual([]);
  });

  it("flags high CPU as critical for OOM prevention", () => {
    const snap = buildHostPreventionSnapshot(
      basePayload({
        metrics: {
          cpu: [
            { timestamp: 1, value: 40 },
            { timestamp: 2, value: 92 },
          ],
          networkRx: [],
          networkTx: [],
          diskRead: [],
          diskWrite: [],
        },
      })
    );
    expect(snap.overall).toBe("critical");
    expect(snap.indicators.some((i) => i.id === "cpu_high")).toBe(true);
  });

  it("flags app down and backup lag", () => {
    const snap = buildHostPreventionSnapshot(
      basePayload({
        resources: [
          {
            uuid: "st",
            name: "socratic-app",
            type: "application",
            status: "exited",
            self: false,
            fleetAppId: "socratic-trade",
            fleetLabel: "Socratic.Trade",
          },
        ],
        fleetBackups: {
          configured: true,
          ok: false,
          asOf: "2026-08-11T00:00:00.000Z",
          cacheAgeSeconds: 0,
          apps: [
            {
              id: "socratic-trade",
              label: "Socratic.Trade",
              self: false,
              ok: false,
              locations: [
                {
                  id: "b2-full-dump",
                  label: "B2 Full Dump",
                  ok: false,
                  present: true,
                  latestAgeSeconds: 99_000,
                  bytes: 1,
                  fileCount: 1,
                  reason: "dump_stale",
                },
              ],
            },
          ],
          warnings: [],
        },
      })
    );
    expect(snap.indicators.some((i) => i.id.startsWith("app_down_"))).toBe(
      true
    );
    expect(snap.indicators.some((i) => i.id === "backup_lag_socratic-trade")).toBe(
      true
    );
    expect(snap.overall).toBe("critical");
  });

  it("records history samples without duplicating the same asOf", () => {
    const p = basePayload({ asOf: "2026-08-11T01:00:00.000Z" });
    const first = recordAndBuildPreventionPanel(p);
    const second = recordAndBuildPreventionPanel(p);
    expect(first.history).toHaveLength(1);
    expect(second.history).toHaveLength(1);
    const third = recordAndBuildPreventionPanel({
      ...p,
      asOf: "2026-08-11T01:02:00.000Z",
      hostUsage: { ...p.hostUsage, cpuPct: 88 },
      metrics: {
        ...p.metrics,
        cpu: [{ timestamp: 3, value: 88 }],
      },
    });
    expect(third.history).toHaveLength(2);
    expect(third.history[1]?.cpuPct).toBe(88);
  });
});
