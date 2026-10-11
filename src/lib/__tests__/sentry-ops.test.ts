import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_ADMIN_POLL_INTERVAL_MS } from "@/lib/cursor-admin-poller";
import { POLL_INTERVAL_MS } from "@/lib/usage-recorder";
import {
  SENTRY_CRON_CHECKIN_MARGIN,
  SENTRY_CRON_INTERVAL_MINUTES,
  SENTRY_CRON_MAX_RUNTIME,
  SENTRY_CRON_MONITOR_SLUG,
  SENTRY_CURSOR_ADMIN_CRON_CHECKIN_MARGIN,
  SENTRY_CURSOR_ADMIN_CRON_INTERVAL_MINUTES,
  SENTRY_CURSOR_ADMIN_CRON_MAX_RUNTIME,
  SENTRY_CURSOR_ADMIN_CRON_SLUG,
  sentryCronMonitorConfig,
  sentryCursorAdminCronMonitorConfig,
} from "@/lib/sentry-ops";

describe("sentry cron monitor config", () => {
  it("matches the in-process 15-minute scheduler cadence", () => {
    expect(SENTRY_CRON_MONITOR_SLUG).toBe("usage-monitor-scheduler");
    expect(SENTRY_CRON_INTERVAL_MINUTES).toBe(15);
    expect(POLL_INTERVAL_MS).toBe(SENTRY_CRON_INTERVAL_MINUTES * 60 * 1000);
    const config = sentryCronMonitorConfig();
    expect(config.schedule).toEqual({
      type: "interval",
      value: 15,
      unit: "minute",
    });
    expect(config.checkinMargin).toBe(SENTRY_CRON_CHECKIN_MARGIN);
    expect(config.maxRuntime).toBe(SENTRY_CRON_MAX_RUNTIME);
    expect(config.timezone).toBe("UTC");
  });

  it("does not advertise a 1-minute schedule that would miss healthy ticks", () => {
    expect(sentryCronMonitorConfig().schedule.value).not.toBe(1);
  });

  it("matches the hourly Cursor admin poller", () => {
    expect(SENTRY_CURSOR_ADMIN_CRON_SLUG).toBe("usage-monitor-cursor-admin");
    expect(SENTRY_CURSOR_ADMIN_CRON_INTERVAL_MINUTES).toBe(60);
    expect(CURSOR_ADMIN_POLL_INTERVAL_MS).toBe(
      SENTRY_CURSOR_ADMIN_CRON_INTERVAL_MINUTES * 60 * 1000
    );
    const config = sentryCursorAdminCronMonitorConfig();
    expect(config.schedule).toEqual({
      type: "interval",
      value: 60,
      unit: "minute",
    });
    expect(config.checkinMargin).toBe(SENTRY_CURSOR_ADMIN_CRON_CHECKIN_MARGIN);
    expect(config.maxRuntime).toBe(SENTRY_CURSOR_ADMIN_CRON_MAX_RUNTIME);
    expect(config.timezone).toBe("UTC");
  });
});

describe("sparse Sentry ops no-op without a client", () => {
  it("swallows SDK load failures", async () => {
    vi.resetModules();
    vi.doMock("@sentry/nextjs", () => {
      throw new Error("sdk missing");
    });
    const {
      recordSentryCronHeartbeat,
      logSchedulerOutcome,
      logSchedulerDegraded,
      logIngestFailed,
      recordSchedulerDuration,
      recordIngestAdmissionRejected,
      recordIngestEventsRejected,
      recordRollupCompleted,
    } = await import("@/lib/sentry-ops");
    await expect(recordSentryCronHeartbeat("ok")).resolves.toBeUndefined();
    await expect(logSchedulerOutcome("ok")).resolves.toBeUndefined();
    await expect(logSchedulerDegraded({ failures: 1 })).resolves.toBeUndefined();
    await expect(logIngestFailed({ reason: "test" })).resolves.toBeUndefined();
    await expect(recordSchedulerDuration(123)).resolves.toBeUndefined();
    await expect(recordIngestAdmissionRejected({ route: "ingest/usage" })).resolves.toBeUndefined();
    await expect(recordIngestEventsRejected(2, { route: "ingest/usage" })).resolves.toBeUndefined();
    await expect(recordRollupCompleted({ rollupsTouched: 1 })).resolves.toBeUndefined();
    vi.doUnmock("@sentry/nextjs");
    vi.resetModules();
  });
});

describe("Sentry Application Metrics emitted into the usage-monitor project", () => {
  it("emits scheduler.duration_ms as a gauge with the outcome tag", async () => {
    vi.resetModules();
    const gauge = vi.fn();
    vi.doMock("@sentry/nextjs", () => ({
      metrics: { gauge, count: vi.fn() },
      logger: { warn: vi.fn(), error: vi.fn() },
    }));
    const { recordSchedulerDuration } = await import("@/lib/sentry-ops");
    await recordSchedulerDuration(1234, { outcome: "ok", total: 10 });
    expect(gauge).toHaveBeenCalledWith(
      "scheduler.duration_ms",
      1234,
      expect.objectContaining({
        unit: "millisecond",
        attributes: expect.objectContaining({ outcome: "ok", total: 10 }),
      })
    );
    vi.doUnmock("@sentry/nextjs");
    vi.resetModules();
  });

  it("clips a negative duration to 0 instead of emitting garbage", async () => {
    vi.resetModules();
    const gauge = vi.fn();
    vi.doMock("@sentry/nextjs", () => ({
      metrics: { gauge, count: vi.fn() },
    }));
    const { recordSchedulerDuration } = await import("@/lib/sentry-ops");
    await recordSchedulerDuration(-1);
    expect(gauge).toHaveBeenCalledWith(
      "scheduler.duration_ms",
      0,
      expect.objectContaining({ unit: "millisecond" })
    );
    vi.doUnmock("@sentry/nextjs");
    vi.resetModules();
  });

  it("emits ingest.admission_rejected as a counter with the route tag", async () => {
    vi.resetModules();
    const count = vi.fn();
    vi.doMock("@sentry/nextjs", () => ({ metrics: { count } }));
    const { recordIngestAdmissionRejected } = await import("@/lib/sentry-ops");
    await recordIngestAdmissionRejected({ route: "otlp/v1/metrics" });
    expect(count).toHaveBeenCalledWith(
      "ingest.admission_rejected",
      1,
      expect.objectContaining({
        attributes: expect.objectContaining({ route: "otlp/v1/metrics" }),
      })
    );
    vi.doUnmock("@sentry/nextjs");
    vi.resetModules();
  });

  it("emits only a count and low-cardinality tags for rejected ingest events", async () => {
    vi.resetModules();
    const count = vi.fn();
    vi.doMock("@sentry/nextjs", () => ({ metrics: { count } }));
    const { recordIngestEventsRejected } = await import("@/lib/sentry-ops");
    await recordIngestEventsRejected(3, { route: "ingest/usage", outcome: "partial" });
    expect(count).toHaveBeenCalledWith(
      "ingest.events_rejected",
      3,
      expect.objectContaining({
        attributes: { route: "ingest/usage", outcome: "partial" },
      })
    );
    vi.doUnmock("@sentry/nextjs");
    vi.resetModules();
  });

  it("emits rollup.completed as a counter with the per-batch rollupsTouched tag", async () => {
    vi.resetModules();
    const count = vi.fn();
    vi.doMock("@sentry/nextjs", () => ({ metrics: { count } }));
    const { recordRollupCompleted } = await import("@/lib/sentry-ops");
    await recordRollupCompleted({ rollupsTouched: 7, pruned: 100 });
    expect(count).toHaveBeenCalledWith(
      "rollup.completed",
      1,
      expect.objectContaining({
        attributes: expect.objectContaining({ rollupsTouched: 7, pruned: 100 }),
      })
    );
    vi.doUnmock("@sentry/nextjs");
    vi.resetModules();
  });
});

describe("Sentry ops mirror to fleet-infra when SENTRY_FLEET_DSN is set", () => {
  beforeEach(() => {
    process.env.SENTRY_FLEET_DSN =
      "https://abcd1234567890abcd@o0.ingest.sentry.io/123456";
  });

  it("logIngestFailed mirrors to fleet-infra with the route tag", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const { logIngestFailed } = await import("@/lib/sentry-ops");
    await logIngestFailed({ route: "ingest/usage", reason: "TypeError" });
    expect(fetchSpy).toHaveBeenCalled();
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit | undefined];
    const lines = String(init?.body ?? "").split("\n");
    const event = JSON.parse(lines[2]);
    expect(event.tags).toMatchObject({
      app: "usage-monitor",
      agent: "MM",
      "metric.name": "ingest.failed",
      "metric.route": "ingest/usage",
    });
  });
});
