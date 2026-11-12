import { beforeEach, describe, expect, it } from "vitest";
import {
  acquireInternalUsageWriteAdmission,
  getIngestAdmissionMetrics,
  isOtlpMetricsIngestEnabled,
  resetIngestAdmissionMetricsForTests,
  tryAcquireIngestAdmission,
  withInternalUsageWriteAdmission,
} from "../ingest-admission";

describe("ingest admission", () => {
  beforeEach(() => {
    resetIngestAdmissionMetricsForTests();
  });

  it("records http admit/reject metrics (C8)", () => {
    const release = tryAcquireIngestAdmission();
    expect(release).not.toBeNull();
    expect(tryAcquireIngestAdmission()).toBeNull();
    release?.();
    const m = getIngestAdmissionMetrics();
    expect(m.httpAdmits).toBe(1);
    expect(m.httpRejects).toBe(1);
    expect(m.held).toBe(false);
  });

  it("keeps OTLP metrics enabled unless explicitly disabled (false/0/off/no)", () => {
    expect(isOtlpMetricsIngestEnabled(undefined)).toBe(true);
    expect(isOtlpMetricsIngestEnabled("")).toBe(true);
    expect(isOtlpMetricsIngestEnabled("true")).toBe(true);
    expect(isOtlpMetricsIngestEnabled("  FaLsE  ")).toBe(false);
    expect(isOtlpMetricsIngestEnabled("0")).toBe(false);
    expect(isOtlpMetricsIngestEnabled("off")).toBe(false);
    expect(isOtlpMetricsIngestEnabled("NO")).toBe(false);
  });

  it("keeps OTLP system.* metrics disabled unless explicitly enabled (Wave G / E9)", async () => {
    const { isOtlpSystemMetricsIngestEnabled } = await import("../ingest-admission");
    expect(isOtlpSystemMetricsIngestEnabled(undefined)).toBe(false);
    expect(isOtlpSystemMetricsIngestEnabled("")).toBe(false);
    expect(isOtlpSystemMetricsIngestEnabled("false")).toBe(false);
    expect(isOtlpSystemMetricsIngestEnabled("true")).toBe(true);
    expect(isOtlpSystemMetricsIngestEnabled("1")).toBe(true);
    expect(isOtlpSystemMetricsIngestEnabled("on")).toBe(true);
  });

  it("admits one writer and rejects overlap until it releases", () => {
    const releaseFirst = tryAcquireIngestAdmission();
    expect(releaseFirst).not.toBeNull();
    expect(tryAcquireIngestAdmission()).toBeNull();

    releaseFirst?.();
    const releaseSecond = tryAcquireIngestAdmission();
    expect(releaseSecond).not.toBeNull();
    releaseSecond?.();
  });

  it("makes release idempotent without releasing a later owner", () => {
    const releaseFirst = tryAcquireIngestAdmission();
    expect(releaseFirst).not.toBeNull();
    releaseFirst?.();

    const releaseSecond = tryAcquireIngestAdmission();
    expect(releaseSecond).not.toBeNull();
    releaseFirst?.();
    expect(tryAcquireIngestAdmission()).toBeNull();
    releaseSecond?.();
  });

  it("hands queued internal writers off FIFO before admitting new HTTP work", async () => {
    const releaseExternal = tryAcquireIngestAdmission();
    expect(releaseExternal).not.toBeNull();

    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const first = acquireInternalUsageWriteAdmission().then((release) => {
      order.push("first");
      releaseFirst = release;
    });
    const second = acquireInternalUsageWriteAdmission().then((release) => {
      order.push("second");
      releaseSecond = release;
    });

    expect(tryAcquireIngestAdmission()).toBeNull();
    releaseExternal?.();
    await first;
    expect(order).toEqual(["first"]);
    expect(tryAcquireIngestAdmission()).toBeNull();

    releaseFirst?.();
    await second;
    expect(order).toEqual(["first", "second"]);
    expect(tryAcquireIngestAdmission()).toBeNull();

    releaseSecond?.();
    const releaseAfterQueue = tryAcquireIngestAdmission();
    expect(releaseAfterQueue).not.toBeNull();
    releaseAfterQueue?.();
  });

  it("releases internal admission when queued work throws", async () => {
    await expect(
      withInternalUsageWriteAdmission(async () => {
        throw new Error("write failed");
      })
    ).rejects.toThrow("write failed");

    const release = tryAcquireIngestAdmission();
    expect(release).not.toBeNull();
    release?.();
  });

  it("reuses an inherited internal lease instead of deadlocking nested writes", async () => {
    const order: string[] = [];

    await withInternalUsageWriteAdmission(async () => {
      order.push("outer-start");
      await withInternalUsageWriteAdmission(async () => {
        order.push("nested");
      });
      expect(tryAcquireIngestAdmission()).toBeNull();
      order.push("outer-end");
    });

    expect(order).toEqual(["outer-start", "nested", "outer-end"]);
    const release = tryAcquireIngestAdmission();
    expect(release).not.toBeNull();
    release?.();
  });
});
