import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSchedulerBootDelayMs } from "@/lib/usage-recorder";

// startUsagePollingScheduler previously ran its first maintenance/provider-
// fetch tick synchronously at boot, racing the pre-migration backup and an
// optional concurrent Litestream replicate process for native memory on a
// 512MB container (see the comment above DEFAULT_SCHEDULER_BOOT_DELAY_MS in
// usage-recorder.ts). It now delays that first tick so the HTTP server can
// finish starting first, while recurring ticks keep the existing cadence.

const POLL_INTERVAL_MS = 15 * 60 * 1000;

describe("resolveSchedulerBootDelayMs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to 30 seconds", () => {
    expect(resolveSchedulerBootDelayMs()).toBe(30_000);
  });

  it("honors a valid env override", () => {
    vi.stubEnv("USAGE_SCHEDULER_BOOT_DELAY_MS", "5000");
    expect(resolveSchedulerBootDelayMs()).toBe(5000);
  });

  it("falls back to the default for invalid or negative overrides", () => {
    vi.stubEnv("USAGE_SCHEDULER_BOOT_DELAY_MS", "not-a-number");
    expect(resolveSchedulerBootDelayMs()).toBe(30_000);
    vi.stubEnv("USAGE_SCHEDULER_BOOT_DELAY_MS", "-1");
    expect(resolveSchedulerBootDelayMs()).toBe(30_000);
  });

  it("never exceeds the regular polling cadence", () => {
    vi.stubEnv("USAGE_SCHEDULER_BOOT_DELAY_MS", String(POLL_INTERVAL_MS * 10));
    expect(resolveSchedulerBootDelayMs()).toBe(POLL_INTERVAL_MS);
  });
});

describe("startUsagePollingScheduler timing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // schedulerStarted is a module-level guard against double-scheduling, so
    // each test needs its own fresh module instance rather than reusing the
    // one already started by a prior test in this file.
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("does not run the first tick synchronously, then runs it after the boot delay", async () => {
    vi.stubEnv("USAGE_SCHEDULER_BOOT_DELAY_MS", "20000");
    const { startUsagePollingScheduler } = await import("@/lib/usage-recorder");
    const tick = vi.fn().mockResolvedValue(undefined);

    startUsagePollingScheduler(tick);
    expect(tick).not.toHaveBeenCalled();

    vi.advanceTimersByTime(19_999);
    expect(tick).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledOnce();
  });

  it("keeps the regular interval cadence independent of the boot delay", async () => {
    vi.stubEnv("USAGE_SCHEDULER_BOOT_DELAY_MS", "20000");
    const { startUsagePollingScheduler } = await import("@/lib/usage-recorder");
    const tick = vi.fn().mockResolvedValue(undefined);

    startUsagePollingScheduler(tick);
    vi.advanceTimersByTime(20_000); // boot-delayed first tick fires
    expect(tick).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("ignores a second start call once already started", async () => {
    const { startUsagePollingScheduler } = await import("@/lib/usage-recorder");
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);

    startUsagePollingScheduler(first);
    startUsagePollingScheduler(second);
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 2);

    expect(second).not.toHaveBeenCalled();
    expect(first).toHaveBeenCalled();
  });

  it("starts when the Cursor poller is left off", async () => {
    vi.stubEnv("CURSOR_ADMIN_POLLER_ENABLED", "false");
    const { startUsagePollingScheduler } = await import("@/lib/usage-recorder");
    const tick = vi.fn().mockResolvedValue(undefined);

    expect(() => startUsagePollingScheduler(tick)).not.toThrow();
    vi.advanceTimersByTime(30_000);
    expect(tick).toHaveBeenCalledOnce();
  });

  it("fails registration when the Cursor poller is enabled without an API key", async () => {
    vi.stubEnv("CURSOR_ADMIN_POLLER_ENABLED", "true");
    vi.stubEnv("CURSOR_ADMIN_API_KEY", "   ");
    const { startUsagePollingScheduler } = await import("@/lib/usage-recorder");
    const tick = vi.fn().mockResolvedValue(undefined);

    expect(() => startUsagePollingScheduler(tick)).toThrow(/CURSOR_ADMIN_API_KEY is required/);
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 2);
    expect(tick).not.toHaveBeenCalled();
  });

  it("starts when the Cursor poller is enabled and the API key is present", async () => {
    vi.stubEnv("CURSOR_ADMIN_POLLER_ENABLED", "true");
    vi.stubEnv("CURSOR_ADMIN_API_KEY", "crsr_admin_test_key_do_not_log");
    const { startUsagePollingScheduler } = await import("@/lib/usage-recorder");
    const tick = vi.fn().mockResolvedValue(undefined);

    startUsagePollingScheduler(tick);
    vi.advanceTimersByTime(30_000);
    expect(tick).toHaveBeenCalledOnce();
  });
});
