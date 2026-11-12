import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SLOW_SCAN_TIMING_LOG_THRESHOLD_MS,
  logSlowScanTimingIfNeeded,
  withSlowScanTiming,
} from "../slow-scan-timing";

describe("slow-scan timing diagnostic", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs nothing when duration is below the shared threshold", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(SLOW_SCAN_TIMING_LOG_THRESHOLD_MS - 1);

    logSlowScanTimingIfNeeded("[test-scan]", 0, { rawGroups: 3 });

    expect(info).not.toHaveBeenCalled();
    clock.mockRestore();
  });

  it("keeps measured durationMs when extra supplies a colliding durationMs", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const measuredMs = SLOW_SCAN_TIMING_LOG_THRESHOLD_MS + 500;
    const clock = vi.spyOn(performance, "now").mockReturnValue(measuredMs);

    logSlowScanTimingIfNeeded("[external-events-mtd-scan]", 0, {
      durationMs: 42,
      rawGroups: 1,
    });

    expect(info).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(info.mock.calls[0][1]));
    expect(payload.durationMs).toBe(measuredMs);
    expect(payload.rawGroups).toBe(1);
    clock.mockRestore();
  });

  it("emits one bounded log at or above the threshold with allowed numeric fields only", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const clock = vi.spyOn(performance, "now").mockReturnValue(
      SLOW_SCAN_TIMING_LOG_THRESHOLD_MS + 250
    );

    logSlowScanTimingIfNeeded("[external-events-mtd-scan]", 0, {
      rawGroups: 2,
      rollupRows: 1,
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toBe("[external-events-mtd-scan]");
    const payload = JSON.parse(String(info.mock.calls[0][1]));
    expect(payload).toEqual({
      durationMs: SLOW_SCAN_TIMING_LOG_THRESHOLD_MS + 250,
      rawGroups: 2,
      rollupRows: 1,
    });
    expect(Object.keys(payload).sort()).toEqual(
      ["durationMs", "rawGroups", "rollupRows"].sort()
    );
    clock.mockRestore();
  });

  it("withSlowScanTiming returns the same value and stays silent when fast", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(100);

    const value = await withSlowScanTiming("[project-budget-scan]", async () => ({
      projects: [{ id: "p1" }],
    }));

    expect(value).toEqual({ projects: [{ id: "p1" }] });
    expect(info).not.toHaveBeenCalled();
    clock.mockRestore();
  });

  it("withSlowScanTiming logs duration-only on slow success without extra builder", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(2_000);

    await withSlowScanTiming("[provider-budget-scan]", async () => "ok");

    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(info.mock.calls[0][1]))).toEqual({ durationMs: 2_000 });
    clock.mockRestore();
  });

  it("withSlowScanTiming propagates errors unchanged and still logs slow failures", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1_500);
    const boom = new Error("mtd scan failed");

    await expect(
      withSlowScanTiming("[project-budget-scan]", async () => {
        throw boom;
      })
    ).rejects.toBe(boom);

    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(info.mock.calls[0][1]))).toEqual({ durationMs: 1_500 });
    clock.mockRestore();
  });
});
