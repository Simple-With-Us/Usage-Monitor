import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDatabaseFileBaseline,
  markSchedulerStarted,
  markSchedulerTickCompleted,
  resetRuntimeHealthForTests,
} from "@/lib/runtime-health";

const mocks = vi.hoisted(() => ({
  queryRawUnsafe: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRawUnsafe: mocks.queryRawUnsafe },
}));

import { GET } from "../route";

const READY_REQUEST = new Request("https://usage.jays.services/api/ready");
const resetReadinessStateForTests = (globalThis as any).resetReadinessStateForTests;

describe("GET /api/ready", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeHealthForTests();
    resetReadinessStateForTests();
    mocks.queryRawUnsafe.mockReset();
    mocks.queryRawUnsafe.mockResolvedValue([{ "1": 1 }]);
    markSchedulerStarted(new Date("2026-07-11T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns ready only after the scheduler starts and SQLite responds", async () => {
    const response = await GET(READY_REQUEST);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-readiness-status")).toBe("ready");
    expect(body).toMatchObject({
      ok: true,
      status: "ready",
      checks: {
        database: { ok: true },
        // Additive: no SQLite file identity was ever captured in this mocked
        // environment, so the new check makes no claim and never gates ok.
        databaseFile: { ok: true, checked: false, reason: null },
        scheduler: { ok: true },
        backup: { ok: true, required: false, active: false },
        startup: { ok: true, required: false, active: false },
      },
    });
  });

  describe("database file identity", () => {
    let fixtureDir: string | null = null;

    const stubDatabaseFile = () => {
      fixtureDir = mkdtempSync(join(tmpdir(), "usage-monitor-ready-dbfile-"));
      const dbPath = join(fixtureDir, "prod.db");
      writeFileSync(dbPath, "not-actually-sqlite\n");
      vi.stubEnv("DATABASE_URL", `file:${dbPath}`);
      return dbPath;
    };

    afterEach(() => {
      if (fixtureDir) {
        rmSync(fixtureDir, { recursive: true, force: true });
        fixtureDir = null;
      }
    });

    it("fails strict readiness when the database file is deleted under a live SELECT 1", async () => {
      vi.spyOn(process, "uptime").mockReturnValue(301);
      const dbPath = stubDatabaseFile();
      captureDatabaseFileBaseline();
      rmSync(dbPath);

      // The mocked prisma keeps answering SELECT 1 — exactly the incident
      // shape: only file identity can see the deletion.
      const strictResponse = await GET(
        new Request("https://usage.jays.services/api/ready?strict=1")
      );
      const strictBody = await strictResponse.json();

      expect(strictResponse.status).toBe(503);
      expect(strictResponse.headers.get("x-readiness-status")).toBe(
        "not_ready"
      );
      expect(strictBody).toMatchObject({
        ok: false,
        status: "not_ready",
        checks: {
          database: { ok: true },
          databaseFile: {
            ok: false,
            checked: true,
            reason: "database_file_unlinked",
            linkCount: 0,
            pathPresent: false,
          },
        },
      });
      // The absolute database path must never leak — /api/ready is public.
      expect(JSON.stringify(strictBody)).not.toContain(dbPath);

      // Default transport stays liveness-safe HTTP 200 with the same verdict.
      const plainResponse = await GET(READY_REQUEST);
      expect(plainResponse.status).toBe(200);
      await expect(plainResponse.json()).resolves.toMatchObject({
        ok: false,
        status: "not_ready",
      });
    });

    it("never grants cold-start grace to a database-file failure", async () => {
      // Well inside the 5-minute cold-start window.
      vi.spyOn(process, "uptime").mockReturnValue(30);
      const dbPath = stubDatabaseFile();
      captureDatabaseFileBaseline();
      rmSync(dbPath);
      mocks.queryRawUnsafe.mockRejectedValue(new Error("database still opening"));

      const response = await GET(READY_REQUEST);
      const body = await response.json();

      // A database-only failure would report "starting" here (see the bounded
      // cold-start test above); a missing/replaced file must not.
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        ok: false,
        status: "not_ready",
        checks: {
          database: { ok: false, coldStartGraceActive: false },
          databaseFile: { ok: false, reason: "database_file_unlinked" },
        },
      });
    });
  });

  it("reports required env-only backup as unhealthy without failing overall ready", async () => {
    vi.stubEnv("LITESTREAM_REQUIRED", "true");
    vi.stubEnv("LITESTREAM_ACTIVE", "true");
    // LITESTREAM_REQUIRED also mandates the verified startup wrapper; satisfy
    // it so this test isolates backup observability (no longer an ok-gate).
    vi.stubEnv("APP_STARTUP_WRAPPER", "start-with-litestream-v2");

    // No replica side-channel: backup check is red, but overall ready stays green.
    const unverifiedResponse = await GET(
      new Request("https://usage.jays.services/api/ready?strict=1")
    );
    expect(unverifiedResponse.status).toBe(200);
    await expect(unverifiedResponse.json()).resolves.toMatchObject({
      ok: true,
      status: "ready",
      checks: {
        backup: {
          ok: false,
          gatesOverallOk: false,
          required: true,
          active: true,
          envOnly: true,
          verificationRequired: true,
          reason: "env_active_unverified",
        },
      },
    });

    // Explicit verification opt-out still flips checks.backup.ok to true.
    // Layer AND stays false here because this fixture has no local snapshots
    // and no weekly R2 archive — gatesOverallOk is no longer hard-coded.
    vi.stubEnv("LITESTREAM_REPLICA_VERIFICATION_REQUIRED", "false");
    const optedOutResponse = await GET(
      new Request("https://usage.jays.services/api/ready?strict=1")
    );
    expect(optedOutResponse.status).toBe(200);
    const optedOutBody = await optedOutResponse.json();
    expect(optedOutBody).toMatchObject({
      ok: true,
      status: "ready",
      checks: {
        backup: { ok: true, envOnly: true, verificationRequired: false },
      },
    });
    expect(optedOutBody.checks.backup.gatesOverallOk).toBe(
      Boolean(
        optedOutBody.checks.backupLayers?.local?.ok &&
          optedOutBody.checks.backupLayers?.primary?.ok &&
          optedOutBody.checks.backupLayers?.r2Historic?.ok
      )
    );
    expect(optedOutBody.ok).toBe(true);
  });

  it("reports gatesOverallOk true when every backup layer is healthy, without flipping ready ok", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-monitor-ready-layers-"));
    try {
      const dbPath = join(dir, "prod.db");
      writeFileSync(dbPath, "sqlite-placeholder\n");
      const backupDir = join(dir, ".pre-migration-backups");
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(join(backupDir, "prod.backup.db"), "backup-bytes\n");
      const archivePath = join(dir, "archive.json");
      writeFileSync(
        archivePath,
        JSON.stringify({
          ok: true,
          key: "weekly/prod-2026-08-14T00-00-00Z.db.gz",
          completedAt: new Date().toISOString(),
          prunedCount: 0,
        })
      );
      vi.stubEnv("DATABASE_URL", `file:${dbPath}`);
      vi.stubEnv("APP_STARTUP_WRAPPER", "start-with-litestream-v2");
      vi.stubEnv("LITESTREAM_REQUIRED", "true");
      vi.stubEnv("LITESTREAM_ACTIVE", "true");
      vi.stubEnv("LITESTREAM_REPLICA_VERIFICATION_REQUIRED", "false");
      vi.stubEnv(
        "LITESTREAM_S3_ENDPOINT",
        "https://s3.eu-central-003.backblazeb2.com"
      );
      vi.stubEnv("R2_USAGE_ACCOUNT_ID", "acct");
      vi.stubEnv("R2_USAGE_API_TOKEN", "tok");
      vi.stubEnv("R2_ARCHIVE_STATUS_PATH", archivePath);

      const response = await GET(READY_REQUEST);
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.status).toBe("ready");
      expect(body.checks.backupLayers.local.ok).toBe(true);
      expect(body.checks.backupLayers.primary.ok).toBe(true);
      expect(body.checks.backupLayers.r2Historic.ok).toBe(true);
      expect(body.checks.backup.gatesOverallOk).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes secret-free usage-read-token observability, never gating ok", async () => {
    vi.stubEnv("USAGE_READ_TOKEN", "read-secret");

    const response = await GET(READY_REQUEST);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.usageReadToken).toEqual({
      required: false, // NODE_ENV is "test" under vitest
      dedicated: true,
      breakGlassFallback: false,
      readsAuthorized: true,
    });
    expect(JSON.stringify(body.checks.usageReadToken)).not.toContain(
      "read-secret"
    );
  });

  it("exposes secret-free Datadog observability, never gating ok", async () => {
    vi.stubEnv("DD_API_KEY", "dd-secret-must-not-leak");
    vi.stubEnv("DD_AGENT_HOST", "127.0.0.1");

    const response = await GET(READY_REQUEST);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.datadog).toEqual({
      required: false,
      apmConfigured: false,
      rumConfigured: false,
      service: null,
      env: null,
      site: null,
      missing: ["DD_SERVICE"],
    });
    expect(JSON.stringify(body.checks.datadog)).not.toContain(
      "dd-secret-must-not-leak"
    );
  });

  it("keeps HTTP liveness-safe while reporting SQLite unavailable", async () => {
    vi.spyOn(process, "uptime").mockReturnValue(301);
    mocks.queryRawUnsafe.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(READY_REQUEST);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-readiness-status")).toBe("not_ready");
    expect(body).toMatchObject({
      ok: false,
      status: "not_ready",
      checks: {
        database: {
          ok: false,
          cached: false,
          probeInFlight: false,
        },
      },
    });
  });

  it("returns transport failure for an independent strict readiness monitor", async () => {
    vi.spyOn(process, "uptime").mockReturnValue(301);
    mocks.queryRawUnsafe.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(
      new Request("https://usage.jays.services/api/ready?strict=1")
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("x-readiness-status")).toBe("not_ready");
    expect(body).toMatchObject({ ok: false, status: "not_ready" });
  });

  it("keeps strict readiness green when every dependency is ready", async () => {
    const response = await GET(
      new Request("https://usage.jays.services/api/ready?strict=1")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-readiness-status")).toBe("ready");
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: "ready" });
  });

  it("treats an intentionally disabled standby scheduler as not required", async () => {
    vi.stubEnv("USAGE_SCHEDULER_ENABLED", "false");
    resetRuntimeHealthForTests();

    const response = await GET(
      new Request("https://usage-oracle.example/api/ready?strict=1")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      checks: {
        scheduler: {
          ok: true,
          required: false,
          readinessReason: "disabled",
        },
      },
    });
  });

  it("backs off failed SQLite probes and retries after the failure window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T09:00:00.000Z"));
    vi.spyOn(process, "uptime").mockReturnValue(301);
    mocks.queryRawUnsafe.mockRejectedValue(new Error("database unavailable"));

    const firstResponse = await GET(READY_REQUEST);
    const firstBody = await firstResponse.json();
    expect(firstResponse.status).toBe(200);
    expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(firstBody.checks.database).toMatchObject({
      ok: false,
      cached: false,
      checkedAt: "2026-07-14T09:00:00.000Z",
      retryAfter: "2026-07-14T09:01:00.000Z",
      probeInFlight: false,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const cachedResponse = await GET(READY_REQUEST);
    const cachedBody = await cachedResponse.json();
    expect(cachedResponse.status).toBe(200);
    expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(cachedBody.checks.database).toMatchObject({
      ok: false,
      cached: true,
      checkedAt: "2026-07-14T09:00:00.000Z",
      retryAfter: "2026-07-14T09:01:00.000Z",
      probeInFlight: false,
    });

    mocks.queryRawUnsafe.mockResolvedValue([{ "1": 1 }]);
    await vi.advanceTimersByTimeAsync(55_000);
    const retriedResponse = await GET(READY_REQUEST);
    const retriedBody = await retriedResponse.json();
    expect(retriedResponse.status).toBe(200);
    expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(retriedBody.checks.database).toMatchObject({
      ok: true,
      cached: false,
      checkedAt: "2026-07-14T09:01:00.000Z",
      retryAfter: null,
      probeInFlight: false,
    });
  });

  it("reports starting over HTTP 200 during a bounded database-only cold start", async () => {
    vi.spyOn(process, "uptime").mockReturnValue(30);
    mocks.queryRawUnsafe.mockRejectedValue(new Error("database still opening"));

    const response = await GET(READY_REQUEST);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      status: "starting",
      checks: {
        database: { ok: false, coldStartGraceActive: true },
      },
    });
  });

  it("never re-enters cold-start grace after the first successful database probe", async () => {
    vi.spyOn(process, "uptime").mockReturnValue(30);
    expect((await GET(READY_REQUEST)).status).toBe(200);

    mocks.queryRawUnsafe.mockRejectedValue(new Error("database became unavailable"));
    const response = await GET(READY_REQUEST);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      status: "not_ready",
      checks: {
        database: { ok: false, coldStartGraceActive: false },
      },
    });
  });

  it("reports not-ready after cold-start grace without failing HTTP liveness", async () => {
    vi.spyOn(process, "uptime").mockReturnValue(301);
    mocks.queryRawUnsafe.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(READY_REQUEST);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      status: "not_ready",
      checks: {
        database: { ok: false, coldStartGraceActive: false },
      },
    });
  });

  it("reuses a timed-out SQLite probe instead of queueing more uncancelled queries", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "uptime").mockReturnValue(301);
    let finishProbe: ((value: Array<Record<string, number>>) => void) | undefined;
    mocks.queryRawUnsafe.mockReturnValue(
      new Promise<Array<Record<string, number>>>((resolve) => {
        finishProbe = resolve;
      })
    );

    try {
      const firstRequest = GET(READY_REQUEST);
      await vi.advanceTimersByTimeAsync(2_000);
      const firstResponse = await firstRequest;
      expect(firstResponse.status).toBe(200);
      expect(await firstResponse.json()).toMatchObject({
        status: "not_ready",
        checks: {
          database: {
            ok: false,
            cached: false,
            probeInFlight: true,
          },
        },
      });
      expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1);

      const secondRequest = GET(READY_REQUEST);
      expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1);

      finishProbe?.([{ "1": 1 }]);
      expect((await secondRequest).status).toBe(200);
      expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays ready after one transient scheduler failure", async () => {
    markSchedulerTickCompleted(false, null);

    const response = await GET(READY_REQUEST);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.checks.scheduler).toMatchObject({
      ok: true,
      readinessReason: null,
      consecutiveFailures: 1,
    });
  });

  it("reports scheduler not-ready without failing HTTP liveness", async () => {
    markSchedulerTickCompleted(false, null);
    markSchedulerTickCompleted(false, null);
    markSchedulerTickCompleted(false, null);

    const response = await GET(READY_REQUEST);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: false, status: "not_ready" });
    expect(body.checks.scheduler).toMatchObject({
      ok: false,
      readinessReason: "repeated_tick_failures",
      consecutiveFailures: 3,
    });
  });

  it("exposes only the bounded handoff reason and maintenance health in the scheduler summary", async () => {
    const unsafeSummary = {
      total: 2,
      successes: 2,
      failures: 0,
      skipped: 0,
      maintenanceHealthy: false,
      providerFetchDegraded: false,
      cloudflareLegacyHandoff: "charge_proof_missing" as const,
      targetId: "must-not-leak-target-id",
      rawEnv: "must-not-leak-env-value",
      billingPayload: "must-not-leak-billing-payload",
      providerError: "must-not-leak-provider-error",
    };
    markSchedulerTickCompleted(false, unsafeSummary);

    const response = await GET(READY_REQUEST);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.checks.scheduler).toMatchObject({
      ok: true,
      readinessReason: null,
      lastTickSucceeded: false,
      consecutiveFailures: 1,
      lastRun: {
        total: 2,
        successes: 2,
        failures: 0,
        skipped: 0,
        maintenanceHealthy: false,
        providerFetchDegraded: false,
        cloudflareLegacyHandoff: "charge_proof_missing",
      },
    });
    expect(Object.keys(body.checks.scheduler.lastRun).sort()).toEqual(
      [
        "cloudflareLegacyHandoff",
        "failures",
        "maintenanceHealthy",
        "providerFetchDegraded",
        "skipped",
        "successes",
        "total",
      ].sort()
    );
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
  });

  it("stays ready after a single provider-fetch-degraded tick", async () => {
    const degradedRun = {
      total: 6,
      successes: 1,
      failures: 5,
      skipped: 0,
      maintenanceHealthy: true,
      providerFetchDegraded: true,
      cloudflareLegacyHandoff: "disabled" as const,
    };
    markSchedulerTickCompleted(true, degradedRun);

    const response = await GET(READY_REQUEST);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: "ready" });
    expect(body.checks.scheduler).toMatchObject({
      ok: true,
      readinessReason: null,
      providerFetchDegraded: false,
      consecutiveProviderFetchDegradedTicks: 1,
      lastTickSucceeded: true,
      lastTickProviderPollHealthy: false,
    });
  });

  it("surfaces a zero-success provider-fetch outage on the first tick (UM-1373)", async () => {
    const degradedRun = {
      total: 27,
      successes: 0,
      failures: 2,
      skipped: 25,
      maintenanceHealthy: true,
      providerFetchDegraded: true,
      cloudflareLegacyHandoff: "disabled" as const,
    };
    markSchedulerTickCompleted(true, degradedRun);

    const response = await GET(READY_REQUEST);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: "ready" });
    expect(body.checks.scheduler).toMatchObject({
      ok: true,
      readinessReason: "provider_fetch_degraded",
      providerFetchDegraded: true,
      consecutiveProviderFetchDegradedTicks: 1,
      lastTickSucceeded: true,
      lastTickProviderPollHealthy: false,
      lastRun: {
        successes: 0,
        failures: 2,
        providerFetchDegraded: true,
      },
    });
  });

  it("surfaces sustained provider-fetch degradation without failing readiness or HTTP liveness", async () => {
    const degradedRun = {
      total: 6,
      successes: 0,
      failures: 6,
      skipped: 0,
      maintenanceHealthy: true,
      providerFetchDegraded: true,
      cloudflareLegacyHandoff: "disabled" as const,
    };
    markSchedulerTickCompleted(true, degradedRun);
    markSchedulerTickCompleted(true, degradedRun);
    markSchedulerTickCompleted(true, degradedRun);

    const response = await GET(READY_REQUEST);
    const body = await response.json();

    // The service itself is still serving correctly - a provider-fetch
    // outage is upstream, so overall readiness (`ok`/`status`) and the
    // scheduler's own `ok` must both stay true even though the outage is
    // now visible via readinessReason/providerFetchDegraded.
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: "ready" });
    expect(body.checks.scheduler).toMatchObject({
      ok: true,
      readinessReason: "provider_fetch_degraded",
      providerFetchDegraded: true,
      providerFetchDegradedTickThreshold: 3,
      consecutiveProviderFetchDegradedTicks: 3,
      lastTickSucceeded: true,
      lastTickProviderPollHealthy: false,
      consecutiveFailures: 0,
    });
  });

  it("reports backup unhealthy without failing overall ready or liveness", async () => {
    vi.stubEnv("LITESTREAM_REQUIRED", "true");
    vi.stubEnv("LITESTREAM_ACTIVE", "false");
    vi.stubEnv("APP_STARTUP_WRAPPER", "start-with-litestream-v2");

    const response = await GET(READY_REQUEST);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: "ready" });
    expect(body.checks.backup).toMatchObject({
      ok: false,
      gatesOverallOk: false,
      required: true,
      active: false,
    });
  });

  it("reports startup not-ready without failing HTTP liveness", async () => {
    // A production-mode process booted without the verified startup wrapper
    // (bare `npm start`) must fail strict readiness even over HTTP 200.
    vi.stubEnv("NODE_ENV", "production");

    const response = await GET(READY_REQUEST);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: false, status: "not_ready" });
    expect(body.checks.startup).toMatchObject({
      ok: false,
      required: true,
      active: false,
    });
  });

  it("fails strict readiness for a production process missing the startup wrapper", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const response = await GET(
      new Request("https://usage.jays.services/api/ready?strict=1")
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      status: "not_ready",
      checks: {
        startup: { ok: false, required: true, active: false },
      },
    });
  });

  it("exposes disk free-space observability without gating readiness", async () => {
    const response = await GET(READY_REQUEST);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.disk).toMatchObject({
      ok: true,
      thresholdBytes: 5 * 1024 * 1024 * 1024,
      reason: null,
    });
    expect(typeof body.checks.disk.freeBytes).toBe("number");
    expect(body.checks.disk.freeBytes).toBeGreaterThan(0);
    expect(typeof body.checks.disk.totalBytes).toBe("number");
    // The absolute filesystem path is deliberately not disclosed publicly.
    expect(JSON.stringify(body.checks.disk)).not.toContain(process.cwd());
  });

  it("reports low disk headroom as observability only, never flipping ok", async () => {
    vi.stubEnv("READY_DISK_WARN_FREE_BYTES", "1000000000000000000");

    const response = await GET(READY_REQUEST);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: "ready" });
    expect(body.checks.disk).toMatchObject({
      ok: false,
      thresholdBytes: 1e18,
      reason: "free_bytes_below_warn_threshold",
    });
  });
});
