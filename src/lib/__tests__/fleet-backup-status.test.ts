import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchFleetBackupStatus,
  resetFleetBackupStatusCacheForTests,
} from "../fleet-backup-status";

describe("fetchFleetBackupStatus", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetFleetBackupStatusCacheForTests();
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
    resetFleetBackupStatusCacheForTests();
  });

  it("returns unconfigured B2 rows when monitor credentials are missing", async () => {
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY_ID", "");
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY", "");
    vi.stubEnv("B2_MONITOR_KEY_ID", "");
    vi.stubEnv("B2_MONITOR_APPLICATION_KEY", "");
    vi.stubEnv("FLEET_ST_HEALTH_URL", "");

    const payload = await fetchFleetBackupStatus();
    expect(payload.configured).toBe(false);
    // A genuinely unconfigured key is still reported as such (and fails the
    // check) — only a deliberately skipped check is exempt.
    expect(payload.offline).toBeFalsy();
    expect(payload.warnings.join(" ")).toContain(
      "credentials are not configured"
    );
    expect(payload.ok).toBe(false);
    expect(payload.apps).toHaveLength(3);
    expect(payload.apps.map((a) => a.id)).toEqual([
      "usage-monitor",
      "socratic-trade",
      "congress-trade",
    ]);
    const um = payload.apps.find((a) => a.id === "usage-monitor");
    expect(um?.self).toBe(true);
    expect(um?.locations.some((l) => l.id === "local")).toBe(true);
    expect(um?.locations.some((l) => l.id === "r2-historic")).toBe(true);
    expect(
      payload.apps
        .find((a) => a.id === "socratic-trade")
        ?.locations.find((l) => l.id === "b2-full-dump")?.reason
    ).toBe("b2_unconfigured");
  });

  it("inventories B2 prefixes and peer litestream age when credentials work", async () => {
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY_ID", "keyid");
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY", "secret");
    vi.stubEnv(
      "FLEET_ST_HEALTH_URL",
      "https://example.test/st/api/health"
    );
    vi.stubEnv(
      "FLEET_CT_HEALTH_URL",
      "https://example.test/ct/api/health"
    );

    const now = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return new Response(
            JSON.stringify({
              accountId: "acct",
              apiUrl: "https://api003.backblazeb2.com",
              authorizationToken: "tok",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("b2_list_buckets")) {
          return new Response(
            JSON.stringify({
              buckets: [
                {
                  bucketId: "b-um",
                  bucketName: "jays-usage-monitor-eu",
                },
                {
                  bucketId: "b-st",
                  bucketName: "jays-socratic-trade-eu",
                },
                {
                  bucketId: "b-ct",
                  bucketName: "jays-congress-trade-eu",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("b2_list_file_names")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            bucketId?: string;
            prefix?: string;
          };
          const files =
            body.prefix === "hetzner/"
              ? [
                  {
                    action: "upload",
                    contentLength: 1_000_000,
                    uploadTimestamp: now - 2 * 3600 * 1000,
                    fileName: `${body.prefix}dump.db`,
                  },
                ]
              : body.prefix?.includes("trading-live") ||
                  body.prefix?.includes("api-usage-monitor") ||
                  body.prefix?.includes("congress-trade")
                ? [
                    {
                      action: "upload",
                      contentLength: 500,
                      uploadTimestamp: now - 60_000,
                      fileName: `${body.prefix}ltx`,
                    },
                  ]
                : [];
          return new Response(JSON.stringify({ files, nextFileName: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("example.test/st/api/health")) {
          return new Response(
            JSON.stringify({
              ok: true,
              checks: {
                storage: {
                  litestreamAgeSeconds: 42,
                  litestreamStatus: "replicating",
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("example.test/ct/api/health")) {
          return new Response(
            JSON.stringify({
              ok: true,
              checks: {
                storage: {
                  litestreamAgeSeconds: 30,
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response("not found", { status: 404 });
      })
    );

    const payload = await fetchFleetBackupStatus();
    expect(payload.configured).toBe(true);

    const st = payload.apps.find((a) => a.id === "socratic-trade");
    expect(st).toBeTruthy();
    const stDump = st!.locations.find((l) => l.id === "b2-full-dump");
    expect(stDump?.present).toBe(true);
    expect(stDump?.ok).toBe(true);
    const stPeer = st!.locations.find((l) => l.id === "peer-litestream");
    expect(stPeer?.latestAgeSeconds).toBe(42);
    expect(stPeer?.ok).toBe(true);
    const stLtx = st!.locations.find((l) => l.id === "b2-litestream");
    expect(stLtx?.present).toBe(true);
    expect(stLtx?.ok).toBe(true);
    // Pre-ship peers: missing r2Weekly stays null and does not degrade the app.
    const stR2 = st!.locations.find((l) => l.id === "r2-historic");
    expect(stR2?.ok).toBeNull();
    expect(stR2?.present).toBe(false);
    expect(stR2?.reason).toBe("peer_r2_weekly_missing");
    expect(st?.ok).toBe(true);

    const ct = payload.apps.find((a) => a.id === "congress-trade");
    const ctLtx = ct!.locations.find((l) => l.id === "b2-litestream");
    expect(ctLtx?.present).toBe(true);
    expect(ctLtx?.ok).toBe(true);
    const ctDump = ct!.locations.find((l) => l.id === "b2-full-dump");
    expect(ctDump?.present).toBe(true);
    const ctR2 = ct!.locations.find((l) => l.id === "r2-historic");
    expect(ctR2?.ok).toBeNull();
    expect(ctR2?.reason).toBe("peer_r2_weekly_missing");
    expect(ct?.ok).toBe(true);
  });

  it("surfaces peer R2 Weekly Archive when checks.storage.r2Weekly is present", async () => {
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY_ID", "keyid");
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY", "secret");
    vi.stubEnv(
      "FLEET_ST_HEALTH_URL",
      "https://example.test/st/api/health"
    );
    vi.stubEnv(
      "FLEET_CT_HEALTH_URL",
      "https://example.test/ct/api/health"
    );

    const now = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return new Response(
            JSON.stringify({
              accountId: "acct",
              apiUrl: "https://api003.backblazeb2.com",
              authorizationToken: "tok",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("b2_list_buckets")) {
          return new Response(
            JSON.stringify({
              buckets: [
                {
                  bucketId: "b-um",
                  bucketName: "jays-usage-monitor-eu",
                },
                {
                  bucketId: "b-st",
                  bucketName: "jays-socratic-trade-eu",
                },
                {
                  bucketId: "b-ct",
                  bucketName: "jays-congress-trade-eu",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("b2_list_file_names")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            prefix?: string;
          };
          const files =
            body.prefix === "hetzner/"
              ? [
                  {
                    action: "upload",
                    contentLength: 1_000_000,
                    uploadTimestamp: now - 2 * 3600 * 1000,
                    fileName: `${body.prefix}dump.db`,
                  },
                ]
              : body.prefix?.includes("api-usage-monitor") ||
                  body.prefix?.includes("congress-trade")
                ? [
                    {
                      action: "upload",
                      contentLength: 500,
                      uploadTimestamp: now - 60_000,
                      fileName: `${body.prefix}ltx`,
                    },
                  ]
                : [];
          return new Response(JSON.stringify({ files, nextFileName: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("example.test/st/api/health")) {
          return new Response(
            JSON.stringify({
              ok: true,
              checks: {
                storage: {
                  litestreamAgeSeconds: 12,
                  r2Weekly: {
                    ok: true,
                    ageSeconds: 86_400,
                    key: "weekly/prod-2026-08-10.db.gz",
                    reason: null,
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("example.test/ct/api/health")) {
          return new Response(
            JSON.stringify({
              ok: true,
              checks: {
                storage: {
                  litestreamAgeSeconds: 20,
                  r2Weekly: {
                    ok: true,
                    ageSeconds: 50_000,
                    key: "weekly/ct-2026-08-11.db.gz",
                    reason: null,
                  },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response("not found", { status: 404 });
      })
    );

    const payload = await fetchFleetBackupStatus();
    const st = payload.apps.find((a) => a.id === "socratic-trade");
    const stR2 = st!.locations.find((l) => l.id === "r2-historic");
    expect(stR2).toMatchObject({
      id: "r2-historic",
      label: "R2 Weekly Archive",
      ok: true,
      present: true,
      latestAgeSeconds: 86_400,
      bytes: null,
      fileCount: null,
      reason: null,
    });
    expect(st?.ok).toBe(true);

    const ct = payload.apps.find((a) => a.id === "congress-trade");
    const ctR2 = ct!.locations.find((l) => l.id === "r2-historic");
    expect(ctR2?.ok).toBe(true);
    expect(ctR2?.present).toBe(true);
    expect(ctR2?.latestAgeSeconds).toBe(50_000);
    expect(ctR2?.label).toBe("R2 Weekly Archive");
    expect(ct?.ok).toBe(true);
  });

  it("keeps peer apps ok when r2Weekly is missing and other off-site rows are fine", async () => {
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY_ID", "keyid");
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY", "secret");
    vi.stubEnv(
      "FLEET_ST_HEALTH_URL",
      "https://example.test/st/api/health"
    );
    vi.stubEnv(
      "FLEET_CT_HEALTH_URL",
      "https://example.test/ct/api/health"
    );

    const now = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return new Response(
            JSON.stringify({
              accountId: "acct",
              apiUrl: "https://api003.backblazeb2.com",
              authorizationToken: "tok",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("b2_list_buckets")) {
          return new Response(
            JSON.stringify({
              buckets: [
                { bucketId: "b-um", bucketName: "jays-usage-monitor-eu" },
                { bucketId: "b-st", bucketName: "jays-socratic-trade-eu" },
                { bucketId: "b-ct", bucketName: "jays-congress-trade-eu" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("b2_list_file_names")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            prefix?: string;
          };
          const files =
            body.prefix === "hetzner/" ||
            body.prefix?.includes("congress-trade") ||
            body.prefix?.includes("api-usage-monitor")
              ? [
                  {
                    action: "upload",
                    contentLength: 100,
                    uploadTimestamp: now - 120_000,
                    fileName: `${body.prefix ?? ""}obj`,
                  },
                ]
              : [];
          return new Response(JSON.stringify({ files, nextFileName: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/api/health")) {
          return new Response(
            JSON.stringify({
              ok: true,
              checks: { storage: { litestreamAgeSeconds: 5 } },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response("not found", { status: 404 });
      })
    );

    const payload = await fetchFleetBackupStatus();
    for (const id of ["socratic-trade", "congress-trade"] as const) {
      const app = payload.apps.find((a) => a.id === id);
      const r2 = app!.locations.find((l) => l.id === "r2-historic");
      expect(r2?.ok).toBeNull();
      expect(r2?.present).toBe(false);
      expect(r2?.reason).toBe("peer_r2_weekly_missing");
      expect(app?.ok).toBe(true);
    }
  });

  it("uses the continuous tier age when the peer omits top-level litestreamAgeSeconds", async () => {
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY_ID", "");
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY", "");
    vi.stubEnv("FLEET_ST_HEALTH_URL", "https://example.test/st/api/health");
    vi.stubEnv("FLEET_CT_HEALTH_URL", "");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("example.test/st/api/health")) {
          return new Response(
            JSON.stringify({
              ok: true,
              checks: {
                storage: {
                  litestreamAgeSeconds: null,
                  litestreamLastSyncAt: null,
                  litestreamTiers: [
                    {
                      tier: "0",
                      label: "Continuous Sync",
                      ageSeconds: 3,
                      degraded: false,
                    },
                  ],
                  r2Weekly: { ok: true, ageSeconds: 1800, reason: null },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        throw new Error(`unexpected fetch ${String(input)}`);
      })
    );

    const payload = await fetchFleetBackupStatus();
    const st = payload.apps.find((a) => a.id === "socratic-trade");
    const live = st!.locations.find((l) => l.id === "peer-litestream");
    expect(live?.present).toBe(true);
    expect(live?.ok).toBe(true);
    expect(live?.latestAgeSeconds).toBe(3);
    expect(live?.reason).toBeNull();
  });

  it("marks Live Litestream failed when a peer compaction tier is wedged", async () => {
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY_ID", "");
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY", "");
    vi.stubEnv("FLEET_ST_HEALTH_URL", "https://example.test/st/api/health");
    vi.stubEnv("FLEET_CT_HEALTH_URL", "");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("example.test/st/api/health")) {
          return new Response(
            JSON.stringify({
              ok: true,
              checks: {
                storageDegraded: true,
                storage: {
                  litestreamAgeSeconds: null,
                  litestreamTiersDegraded: true,
                  litestreamTiers: [
                    {
                      tier: "0",
                      label: "Continuous Sync",
                      ageSeconds: 0,
                      degraded: false,
                    },
                    {
                      tier: "2",
                      label: "Deep Compaction",
                      state: "empty",
                      degraded: true,
                      reason: "backlog-past-threshold",
                    },
                  ],
                  r2Weekly: { ok: true, ageSeconds: 1800, reason: null },
                },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        throw new Error(`unexpected fetch ${String(input)}`);
      })
    );

    const payload = await fetchFleetBackupStatus();
    const st = payload.apps.find((a) => a.id === "socratic-trade");
    const live = st!.locations.find((l) => l.id === "peer-litestream");
    expect(live?.present).toBe(true);
    expect(live?.ok).toBe(true);
    expect(live?.latestAgeSeconds).toBe(0);
    expect(live?.reason).toBe("peer_litestream_tiers_degraded");
    const weekly = st!.locations.find((l) => l.id === "r2-historic");
    expect(weekly?.ok).toBe(true);
  });

  it("keeps ST B2 Litestream visible when peer health returns 503", async () => {
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY_ID", "keyid");
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY", "secret");
    vi.stubEnv("FLEET_ST_HEALTH_URL", "https://example.test/st/api/health");
    vi.stubEnv("FLEET_CT_HEALTH_URL", "");

    const now = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return new Response(
            JSON.stringify({
              accountId: "acct",
              apiUrl: "https://api003.backblazeb2.com",
              authorizationToken: "tok",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("b2_list_buckets")) {
          return new Response(
            JSON.stringify({
              buckets: [
                { bucketId: "b-um", bucketName: "jays-usage-monitor-eu" },
                { bucketId: "b-st", bucketName: "jays-socratic-trade-eu" },
                { bucketId: "b-ct", bucketName: "jays-congress-trade-eu" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("b2_list_file_names")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { prefix?: string };
          const files =
            body.prefix === "hetzner/" || body.prefix?.includes("trading-live")
              ? [
                  {
                    action: "upload",
                    contentLength: 500,
                    uploadTimestamp: now - 60_000,
                    fileName: `${body.prefix}ltx`,
                  },
                ]
              : [];
          return new Response(JSON.stringify({ files, nextFileName: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("example.test/st/api/health")) {
          return new Response("unavailable", { status: 503 });
        }
        return new Response("not found", { status: 404 });
      })
    );

    const payload = await fetchFleetBackupStatus();
    const st = payload.apps.find((a) => a.id === "socratic-trade");
    const live = st!.locations.find((l) => l.id === "peer-litestream");
    expect(live?.ok).toBeNull();
    expect(live?.reason).toBe("peer_health_http_503");
    const ltx = st!.locations.find((l) => l.id === "b2-litestream");
    expect(ltx?.present).toBe(true);
    expect(ltx?.ok).toBe(true);
    expect(st?.ok).toBe(true);
  });

  it("skips every egress and reports the peer as unknown (not missing) when offline", async () => {
    vi.stubEnv("OPERATIONS_HEALTH_OFFLINE", "true");
    vi.stubEnv("E2E_TEST_PASSWORD", "visual-test-password");
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY_ID", "keyid");
    vi.stubEnv("BACKBLAZE_APPLICATION_KEY", "secret");
    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = await fetchFleetBackupStatus();
    expect(fetchMock).not.toHaveBeenCalled();
    // The check was skipped on purpose, so it must not claim the Backblaze
    // key is missing.
    expect(payload.offline).toBe(true);
    expect(payload.configured).toBe(false);
    expect(payload.warnings.join(" ")).toContain("offline mode");
    expect(payload.warnings.join(" ")).not.toContain("credentials are not configured");
    // A skipped check is not a passed check either: the verdict stays
    // fail-closed and `offline` explains why, so no consumer reads an
    // unobserved fleet as healthy. This also keeps the assertion independent
    // of ambient env (LITESTREAM_REQUIRED and friends cannot flip it).
    expect(payload.ok).toBe(false);
    const st = payload.apps.find((a) => a.id === "socratic-trade");
    const live = st?.locations.find((l) => l.id === "peer-litestream");
    expect(live?.ok).toBeNull();
    // Unknown state must not read as "replica present" or "replica missing".
    expect(live?.present).toBe(false);
    expect(live?.unknown).toBe(true);
    expect(live?.reason).toBe("peer_health_offline");
    // An unobserved peer must not flip the app to a failed backup.
    expect(st?.ok).toBe(true);
  });
});
