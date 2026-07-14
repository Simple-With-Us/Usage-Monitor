import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

import { GET, resetReadinessStateForTests } from "../route";

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
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      ok: true,
      status: "ready",
      checks: {
        database: { ok: true },
        scheduler: { ok: true },
        backup: { ok: true, required: false, active: false },
        startup: { ok: true, required: false, active: false },
      },
    });
  });

  it("returns 503 when SQLite is unavailable", async () => {
    vi.spyOn(process, "uptime").mockReturnValue(301);
    mocks.queryRawUnsafe.mockRejectedValue(new Error("database unavailable"));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.database.ok).toBe(false);
  });

  it("reports starting over HTTP 200 during a bounded database-only cold start", async () => {
    vi.spyOn(process, "uptime").mockReturnValue(30);
    mocks.queryRawUnsafe.mockRejectedValue(new Error("database still opening"));

    const response = await GET();
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
    expect((await GET()).status).toBe(200);

    mocks.queryRawUnsafe.mockRejectedValue(new Error("database became unavailable"));
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      status: "not_ready",
      checks: {
        database: { ok: false, coldStartGraceActive: false },
      },
    });
  });

  it("fails strictly when the cold-start grace expires without a successful probe", async () => {
    vi.spyOn(process, "uptime").mockReturnValue(301);
    mocks.queryRawUnsafe.mockRejectedValue(new Error("database unavailable"));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      status: "not_ready",
      checks: {
        database: { ok: false, coldStartGraceActive: false },
      },
    });
  });

  it("can soften only the HTTP status for a database-only Render compatibility window", async () => {
    vi.stubEnv("RENDER_READINESS_HTTP_COMPATIBILITY", "true");
    vi.spyOn(process, "uptime").mockReturnValue(301);

    const response = await GET();
    const body = await response.json();

    expect(mocks.queryRawUnsafe).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      status: "not_ready",
      checks: {
        database: {
          ok: false,
          latencyMs: 0,
          probeSkipped: true,
          coldStartGraceActive: false,
          healthCheckCompatibilityActive: true,
        },
      },
    });
  });

  it("does not let Render compatibility mask a non-database readiness failure", async () => {
    vi.stubEnv("RENDER_READINESS_HTTP_COMPATIBILITY", "true");
    vi.stubEnv("LITESTREAM_REQUIRED", "true");
    vi.stubEnv("LITESTREAM_ACTIVE", "false");
    vi.spyOn(process, "uptime").mockReturnValue(301);

    const response = await GET();
    const body = await response.json();

    expect(mocks.queryRawUnsafe).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      checks: {
        database: { healthCheckCompatibilityActive: false },
        backup: { ok: false },
      },
    });
  });

  it("keeps compatibility explicitly not-ready during the normal cold-start window", async () => {
    vi.stubEnv("RENDER_READINESS_HTTP_COMPATIBILITY", "true");
    vi.spyOn(process, "uptime").mockReturnValue(30);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: false,
      status: "not_ready",
      checks: {
        database: {
          probeSkipped: true,
          coldStartGraceActive: false,
          healthCheckCompatibilityActive: true,
        },
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
      const firstRequest = GET();
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await firstRequest).status).toBe(503);
      expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1);

      const secondRequest = GET();
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

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.checks.scheduler).toMatchObject({
      ok: true,
      readinessReason: null,
      consecutiveFailures: 1,
    });
  });

  it("returns 503 after repeated top-level scheduler tick failures", async () => {
    markSchedulerTickCompleted(false, null);
    markSchedulerTickCompleted(false, null);
    markSchedulerTickCompleted(false, null);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.scheduler).toMatchObject({
      ok: false,
      readinessReason: "repeated_tick_failures",
      consecutiveFailures: 3,
    });
  });

  it("returns 503 when backup is required but not active", async () => {
    vi.stubEnv("LITESTREAM_REQUIRED", "true");
    vi.stubEnv("LITESTREAM_ACTIVE", "false");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.backup).toMatchObject({
      ok: false,
      required: true,
      active: false,
    });
  });

  it("returns 503 on Render when the configured startup wrapper was bypassed", async () => {
    vi.stubEnv("RENDER", "true");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.checks.startup).toMatchObject({
      ok: false,
      required: true,
      active: false,
    });
  });
});
