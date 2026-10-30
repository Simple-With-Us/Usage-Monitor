import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  calculatePaceProjection,
  assessR2Usage,
  isR2AutoDisabled,
  enforceR2AutoDisable,
  clearR2AutoDisable,
  hasR2AutoResumeMarker,
  R2_AUTO_RESUMED_FLAG_FILENAME,
  sendPushoverNotification,
  formatDailyPushoverMessage,
  runR2UsageCheck,
  parseR2GraphqlUsage,
  isR2ProductDisabledPayload,
  classifyR2Action,
  isLitestreamR2Endpoint,
  resolveR2UsageCredentials,
  loadR2FleetAccounts,
  fetchR2FleetSummary,
  fetchR2UsageMetrics,
  utcStorageLookbackIso,
  R2_STORAGE_GRAPHQL_BUCKET_LIMIT,
  R2_STORAGE_GRAPHQL_DAY_LIMIT,
  R2_STORAGE_GRAPHQL_GROUP_LIMIT,
  R2_STORAGE_GRAPHQL_LOOKBACK_MS,
  r2FreeTierFailClosedRequired,
  graphqlStorageSamplesAreFresh,
  mergeGraphqlStorageWithLiveOverlay,
  applyStorageOverlay,
  resolveBillingStorageBytes,
  summarizeR2DailyStorage,
  formatFleetR2DigestLines,
  parseR2BucketNames,
  planLtxTipPrune,
  DEFAULT_R2_FREE_TIER_LIMITS,
  R2_DISABLED_FLAG_FILENAME,
  R2_SOFT_PRUNE_STORAGE_PCT,
  R2_THRESHOLD_PCT,
  __getR2FlagFilePathForTests,
  __resetR2UsageStateForTests,
} from "../r2-usage";

describe("R2 usage monitoring & auto-disable", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete (globalThis as Record<string, unknown>)["__apiUsageMonitorSetWalAutocheckpoint"];
    delete process.env.LITESTREAM_R2_SUPERVISOR_ACTIVE;
    delete process.env.APP_STARTUP_WRAPPER;
    delete process.env.LITESTREAM_EMERGENCY_DISABLE;
    delete process.env.R2_WRITES_DISABLED;
    delete process.env.PUSHOVER_USER_KEY;
    delete process.env.PUSHOVER_API_TOKEN;
    delete process.env.PUSHOVER_USAGE_API_TOKEN;
    delete process.env.PUSHOVER_APP_TOKEN;
    delete process.env.R2_USAGE_ACCOUNT_ID;
    delete process.env.R2_USAGE_API_TOKEN;
    delete process.env.CLOUDFLARE_JAY_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_JAY_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_FLEET_API_TOKEN;
    delete process.env.CLOUDFLARE_OLD_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_OLD_API_TOKEN;
    delete process.env.LITESTREAM_S3_ENDPOINT;
    delete process.env.AWS_S3_ENDPOINT;
    __resetR2UsageStateForTests();
  });

  afterEach(() => {
    process.env = originalEnv;
    __resetR2UsageStateForTests();
  });

  it("prefers CLOUDFLARE_FLEET_API_TOKEN over legacy per-account tokens", () => {
    process.env.CLOUDFLARE_CT_ACCOUNT_ID = "acct-ct";
    process.env.CLOUDFLARE_CT_API_TOKEN = "legacy-ct";
    process.env.CLOUDFLARE_FLEET_API_TOKEN = "fleet-token";
    const accounts = loadR2FleetAccounts(process.env);
    const ct = accounts.find((a) => a.id === "ct");
    expect(ct?.apiToken).toBe("fleet-token");
  });

  it("uses the Usage.Jays.Services token before the fleet token", () => {
    process.env.R2_USAGE_ACCOUNT_ID = "acct-um";
    process.env.CLOUDFLARE_JAY_API_TOKEN = "ujs-own-token";
    process.env.CLOUDFLARE_FLEET_API_TOKEN = "fleet-token";
    const accounts = loadR2FleetAccounts(process.env);
    const um = accounts.find((a) => a.id === "um");
    expect(um?.apiToken).toBe("ujs-own-token");
  });

  it("calculates linear month pace projection accurately for ops (absolute_or_pace)", () => {
    const testDate = new Date("2026-07-15T12:00:00.000Z");
    const limit = 1_000_000;

    const statusLow = calculatePaceProjection(
      300_000,
      limit,
      testDate,
      R2_THRESHOLD_PCT,
      "absolute_or_pace"
    );
    expect(statusLow.onTrackToExceed).toBe(false);
    expect(statusLow.projectedPct).toBeLessThan(R2_THRESHOLD_PCT);

    const statusHigh = calculatePaceProjection(
      450_000,
      limit,
      testDate,
      R2_THRESHOLD_PCT,
      "absolute_or_pace"
    );
    expect(statusHigh.onTrackToExceed).toBe(true);
    expect(statusHigh.projectedPct).toBeGreaterThanOrEqual(R2_THRESHOLD_PCT);
  });

  it("storage absolute mode trips only on MTD ≥ 90%, not early-month pace alone", () => {
    const earlyMonth = new Date("2026-08-02T12:00:00.000Z");
    const threeGib = 3 * 1024 * 1024 * 1024;
    const absoluteOnly = calculatePaceProjection(
      threeGib,
      DEFAULT_R2_FREE_TIER_LIMITS.storageBytes,
      earlyMonth,
      R2_THRESHOLD_PCT,
      "absolute"
    );
    expect(absoluteOnly.mtdPct).toBeLessThan(R2_THRESHOLD_PCT);
    expect(absoluteOnly.projectedPct).toBeGreaterThan(R2_THRESHOLD_PCT);
    expect(absoluteOnly.onTrackToExceed).toBe(false);

    const withPace = calculatePaceProjection(
      threeGib,
      DEFAULT_R2_FREE_TIER_LIMITS.storageBytes,
      earlyMonth,
      R2_THRESHOLD_PCT,
      "absolute_or_pace"
    );
    expect(withPace.onTrackToExceed).toBe(true);

    const over = calculatePaceProjection(
      9.5 * 1024 * 1024 * 1024,
      DEFAULT_R2_FREE_TIER_LIMITS.storageBytes,
      earlyMonth,
      R2_THRESHOLD_PCT,
      "absolute"
    );
    expect(over.mtdPct).toBeGreaterThanOrEqual(R2_THRESHOLD_PCT);
    expect(over.onTrackToExceed).toBe(true);
  });

  it.each([
    [70, false],
    [85, false],
    [89.9, false],
    [90, true],
    [95, true],
  ])("applies the storage pause boundary at %s%%", (pct, shouldPause) => {
    expect(R2_THRESHOLD_PCT).toBe(90);
    const assessment = assessR2Usage(
      DEFAULT_R2_FREE_TIER_LIMITS.storageBytes * pct / 100,
      0,
      0,
      DEFAULT_R2_FREE_TIER_LIMITS,
      new Date("2026-08-02T12:00:00.000Z")
    );
    expect(assessment.storage.onTrackToExceed).toBe(shouldPause);
    expect(assessment.overallOnTrackToExceed70Pct).toBe(shouldPause);
  });

  it("planLtxTipPrune keeps highest max-txid tip per level", () => {
    expect(R2_SOFT_PRUNE_STORAGE_PCT).toBe(50);
    const plan = planLtxTipPrune([
      {
        key: "api-usage-monitor/prod.db/0001/0000000000000001-0000000000000010.ltx",
        size: 100,
      },
      {
        key: "api-usage-monitor/prod.db/0001/0000000000000011-0000000000000020.ltx",
        size: 200,
      },
      {
        key: "api-usage-monitor/prod.db/0002/0000000000000001-0000000000000015.ltx",
        size: 300,
      },
      { key: "api-usage-monitor/prod.db/meta.txt", size: 5 },
    ]);
    expect(plan.delete.map((o) => o.key)).toEqual([
      "api-usage-monitor/prod.db/0001/0000000000000001-0000000000000010.ltx",
    ]);
    expect(plan.keep.map((o) => o.key).sort()).toEqual(
      [
        "api-usage-monitor/prod.db/0001/0000000000000011-0000000000000020.ltx",
        "api-usage-monitor/prod.db/0002/0000000000000001-0000000000000015.ltx",
        "api-usage-monitor/prod.db/meta.txt",
      ].sort()
    );
    expect(plan.delete.reduce((s, o) => s + o.size, 0)).toBe(100);
  });

  it("assesses storage absolute + ops absolute/pace at 90%", () => {
    const testDate = new Date("2026-07-15T12:00:00.000Z");

    const lowAssessment = assessR2Usage(
      1 * 1024 * 1024 * 1024,
      100_000,
      500_000,
      DEFAULT_R2_FREE_TIER_LIMITS,
      testDate
    );
    expect(lowAssessment.overallOnTrackToExceed70Pct).toBe(false);
    expect(lowAssessment.exceededMetric).toBeUndefined();

    const highAssessment = assessR2Usage(
      1 * 1024 * 1024 * 1024,
      450_000,
      500_000,
      DEFAULT_R2_FREE_TIER_LIMITS,
      testDate
    );
    expect(highAssessment.overallOnTrackToExceed70Pct).toBe(true);
    expect(highAssessment.exceededMetric).toBe("classA");

    const storageBreach = assessR2Usage(
      9.5 * 1024 * 1024 * 1024,
      1_000,
      1_000,
      DEFAULT_R2_FREE_TIER_LIMITS,
      testDate
    );
    expect(storageBreach.overallOnTrackToExceed70Pct).toBe(true);
    expect(storageBreach.exceededMetric).toBe("storage");
  });

  it("requires fail-closed free-tier meter when production R2 Litestream is configured", () => {
    expect(
      r2FreeTierFailClosedRequired({
        NODE_ENV: "production",
        LITESTREAM_S3_ENDPOINT: "https://abc.r2.cloudflarestorage.com",
      })
    ).toBe(true);
    expect(
      r2FreeTierFailClosedRequired({
        LITESTREAM_REQUIRED: "true",
        LITESTREAM_S3_ENDPOINT: "https://abc.r2.cloudflarestorage.com",
      })
    ).toBe(true);
    expect(
      r2FreeTierFailClosedRequired({
        NODE_ENV: "development",
        LITESTREAM_S3_ENDPOINT: "https://abc.r2.cloudflarestorage.com",
      })
    ).toBe(false);
    expect(
      r2FreeTierFailClosedRequired({
        NODE_ENV: "production",
        LITESTREAM_S3_ENDPOINT: "https://garage.example:9443",
      })
    ).toBe(false);
  });

  it("fail-closes and disables R2 when production credentials are missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "LITESTREAM_S3_ENDPOINT",
      "https://acct.r2.cloudflarestorage.com"
    );

    const mockFetch = vi.fn();
    const assessment = await runR2UsageCheck(
      mockFetch as unknown as typeof fetch,
      new Date("2026-08-04T12:00:00.000Z")
    );

    expect(assessment.metricsSource).toBe("unavailable");
    expect(isR2AutoDisabled()).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("classifies Class A/B actions with conservative unknown-as-A default", () => {
    expect(classifyR2Action("PutObject")).toBe("A");
    expect(classifyR2Action("ListObjects")).toBe("A");
    expect(classifyR2Action("GetObject")).toBe("B");
    expect(classifyR2Action("HeadBucket")).toBe("B");
    expect(classifyR2Action("SomeFutureWriteOp")).toBe("A");
  });

  it("loads fleet accounts for any configured UM/ST/CT/Old env pair", () => {
    const accounts = loadR2FleetAccounts({
      CLOUDFLARE_JAY_ACCOUNT_ID: "jay-account-id-12345678",
      CLOUDFLARE_JAY_API_TOKEN: "jay-token",
      CLOUDFLARE_ST_ACCOUNT_ID: "st-account-id-abcdef01",
      CLOUDFLARE_ST_API_TOKEN: "st-token",
      CLOUDFLARE_OLD_ACCOUNT_ID: "old-account-id-254301ba",
      CLOUDFLARE_OLD_API_TOKEN: "old-token",
    });
    expect(accounts.map((a) => a.id)).toEqual(["um", "st", "old"]);
    expect(accounts.find((a) => a.id === "um")?.label).toBe("Usage Monitor");
    expect(accounts.find((a) => a.id === "st")?.label).toBe("Socratic Trade");
    expect(accounts.find((a) => a.id === "old")?.label).toBe("Jay (Old)");
  });

  it("returns unconfigured fleet slots without calling GraphQL", async () => {
    const mockFetch = vi.fn();
    const summary = await fetchR2FleetSummary(
      mockFetch as unknown as typeof fetch,
      new Date("2026-08-05T12:00:00.000Z"),
      {}
    );
    expect(summary.configured).toBe(false);
    expect(summary.accounts).toHaveLength(4);
    expect(summary.accounts.every((a) => a.status === "unconfigured")).toBe(true);
    expect(summary.accounts.map((a) => a.id)).toEqual(["um", "st", "ct", "old"]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("detects Cloudflare R2 endpoints and ignores Garage", () => {
    expect(
      isLitestreamR2Endpoint(
        "https://abc123.r2.cloudflarestorage.com"
      )
    ).toBe(true);
    expect(
      isLitestreamR2Endpoint("https://abc123.r2.cloudflarestorage.com/path")
    ).toBe(true);
    expect(
      isLitestreamR2Endpoint("https://garage.example.com:9443")
    ).toBe(false);
    // Substring spoofs must not count as R2 (hostname is parsed).
    expect(
      isLitestreamR2Endpoint(
        "https://evil.example/r2.cloudflarestorage.com"
      )
    ).toBe(false);
    expect(
      isLitestreamR2Endpoint(
        "https://r2.cloudflarestorage.com.evil.example"
      )
    ).toBe(false);
    expect(isLitestreamR2Endpoint("")).toBe(false);
    expect(isLitestreamR2Endpoint(undefined)).toBe(false);
  });

  it("resolves usage credentials from env with R2_USAGE_* preferred", () => {
    expect(resolveR2UsageCredentials({})).toBeNull();
    expect(
      resolveR2UsageCredentials({
        CLOUDFLARE_JAY_ACCOUNT_ID: "acct",
        CLOUDFLARE_JAY_API_TOKEN: "tok",
      })
    ).toEqual({ accountId: "acct", apiToken: "tok" });
    expect(
      resolveR2UsageCredentials({
        R2_USAGE_ACCOUNT_ID: "r2acct",
        R2_USAGE_API_TOKEN: "r2tok",
        CLOUDFLARE_JAY_ACCOUNT_ID: "acct",
        CLOUDFLARE_JAY_API_TOKEN: "tok",
      })
    ).toEqual({ accountId: "r2acct", apiToken: "r2tok" });
  });

  it("parses GraphQL analytics into storage + Class A/B totals", () => {
    const metrics = parseR2GraphqlUsage({
      data: {
        viewer: {
          accounts: [
            {
              r2OperationsAdaptiveGroups: [
                {
                  sum: { requests: 1000 },
                  dimensions: { actionType: "PutObject" },
                },
                {
                  sum: { requests: 2000 },
                  dimensions: { actionType: "ListObjects" },
                },
                {
                  sum: { requests: 500 },
                  dimensions: { actionType: "GetObject" },
                },
              ],
              r2StorageAdaptiveGroups: [
                {
                  max: {
                    payloadSize: 5 * 1024 * 1024 * 1024,
                    metadataSize: 1024,
                    objectCount: 10,
                  },
                  dimensions: {
                    datetime: "2026-08-03T12:00:00Z",
                    bucketName: "usage-monitor-bucket",
                  },
                },
                {
                  max: {
                    payloadSize: 1 * 1024 * 1024 * 1024,
                    metadataSize: 0,
                    objectCount: 2,
                  },
                  dimensions: {
                    datetime: "2026-08-03T11:00:00Z",
                    bucketName: "usage-monitor-bucket",
                  },
                },
                {
                  max: {
                    payloadSize: 100,
                    metadataSize: 0,
                    objectCount: 1,
                  },
                  dimensions: {
                    datetime: "2026-08-03T12:00:00Z",
                    bucketName: "usage-monitor-receipts",
                  },
                },
              ],
            },
          ],
        },
      },
    });

    expect(metrics.classAOps).toBe(3000);
    expect(metrics.classBOps).toBe(500);
    // Latest sample only per bucket (datetime_DESC order in fixture).
    expect(metrics.storageBytes).toBe(5 * 1024 * 1024 * 1024 + 1024 + 100);
    expect(metrics.buckets).toHaveLength(2);
    expect(metrics.buckets[0].bucketName).toBe("usage-monitor-bucket");
  });

  it("keeps month-window orphan buckets and prefers a fresher 24h sample after prune", () => {
    const gib = 1024 * 1024 * 1024;
    const metrics = parseR2GraphqlUsage({
      data: {
        viewer: {
          accounts: [
            {
              r2OperationsAdaptiveGroups: [],
              r2StorageByBucket: [
                {
                  max: { payloadSize: 15 * gib, metadataSize: 0, objectCount: 10 },
                  dimensions: { bucketName: "usage-monitor-bucket" },
                },
                {
                  max: { payloadSize: 9 * gib, metadataSize: 0, objectCount: 5 },
                  dimensions: { bucketName: "usage-monitor-prod-v3" },
                },
                {
                  max: { payloadSize: 5 * gib, metadataSize: 0, objectCount: 2 },
                  dimensions: { bucketName: "weekly-archive" },
                },
              ],
              r2StorageAdaptiveGroups: [
                {
                  max: { payloadSize: 2 * 1024 * 1024, metadataSize: 0, objectCount: 1 },
                  dimensions: {
                    datetime: "2026-08-25T00:00:00Z",
                    bucketName: "weekly-archive",
                  },
                },
              ],
            },
          ],
        },
      },
    });

    expect(metrics.buckets).toHaveLength(3);
    expect(metrics.storageBytes).toBe(24 * gib + 2 * 1024 * 1024);
    const weekly = metrics.buckets.find((b) => b.bucketName === "weekly-archive");
    expect(weekly?.bytes).toBe(2 * 1024 * 1024);
    expect(weekly?.asOf).toBe("2026-08-25T00:00:00Z");
    expect(metrics.currentBytes).toBe(24 * gib + 2 * 1024 * 1024);
    expect(metrics.gbMonthBytes).toBeNull();
    expect(metrics.storageBytes).toBe(metrics.currentBytes);
    expect(metrics.monthPeakBytes).toBe(29 * gib);
  });

  it("bills GB-month instead of a post-prune 24h snapshot after a gigabyte month", () => {
    const gib = 1024 * 1024 * 1024;
    const now = new Date("2026-08-25T20:00:00.000Z");
    const metrics = parseR2GraphqlUsage(
      {
        data: {
          viewer: {
            accounts: [
              {
                r2OperationsAdaptiveGroups: [],
                r2StorageByBucket: [
                  {
                    max: { payloadSize: 15 * gib, metadataSize: 0, objectCount: 10 },
                    dimensions: { bucketName: "usage-monitor-bucket" },
                  },
                  {
                    max: { payloadSize: 9 * gib, metadataSize: 0, objectCount: 5 },
                    dimensions: { bucketName: "usage-monitor-prod-v3" },
                  },
                ],
                r2StorageAdaptiveGroups: [
                  {
                    max: { payloadSize: 0, metadataSize: 0, objectCount: 0 },
                    dimensions: {
                      datetime: "2026-08-25T12:00:00Z",
                      bucketName: "usage-monitor-bucket",
                    },
                  },
                  {
                    max: { payloadSize: 0.28 * gib, metadataSize: 0, objectCount: 2 },
                    dimensions: {
                      datetime: "2026-08-25T12:00:00Z",
                      bucketName: "usage-monitor-prod-v3",
                    },
                  },
                ],
                r2StorageByDay: [
                  {
                    max: { payloadSize: 22 * gib, metadataSize: 0, objectCount: 20 },
                    dimensions: { date: "2026-08-05", bucketName: "usage-monitor-bucket" },
                  },
                  {
                    max: { payloadSize: 0.28 * gib, metadataSize: 0, objectCount: 2 },
                    dimensions: { date: "2026-08-25", bucketName: "usage-monitor-prod-v3" },
                  },
                ],
              },
            ],
          },
        },
      },
      now
    );

    expect(metrics.currentBytes).toBeCloseTo(0.28 * gib, 0);
    expect(metrics.monthPeakBytes).toBe(22 * gib);
    expect(metrics.monthPeakDate).toBe("2026-08-05");
    expect(metrics.gbMonthBytes).toBeCloseTo((22 * gib + 0.28 * gib) / 25, 0);
    expect(metrics.storageBytes).toBe(metrics.gbMonthBytes);
    expect(metrics.storageBytes).toBeGreaterThan(metrics.currentBytes);
    expect(metrics.previousWeekPeakBytes).toBeCloseTo(0.28 * gib, 0);
  });

  it("resolveBillingStorageBytes prefers GB-month over a tiny live snapshot", () => {
    const gib = 1024 * 1024 * 1024;
    expect(resolveBillingStorageBytes(0.28 * gib, 2.6 * gib)).toBeCloseTo(2.6 * gib, 0);
    expect(resolveBillingStorageBytes(8 * gib, 2.6 * gib)).toBe(8 * gib);
    expect(resolveBillingStorageBytes(0.28 * gib, null)).toBeCloseTo(0.28 * gib, 0);
  });

  it("applyStorageOverlay keeps GB-month billing after a live prune", () => {
    const gib = 1024 * 1024 * 1024;
    const overlaid = applyStorageOverlay(
      {
        storageBytes: 9 * gib,
        currentBytes: 9 * gib,
        gbMonthBytes: 2.6 * gib,
        monthPeakBytes: 22 * gib,
        monthPeakDate: "2026-08-05",
        previousWeekGbMonthBytes: 0.21 * gib,
        previousWeekPeakBytes: 0.28 * gib,
        classAOps: 0,
        classBOps: 0,
        buckets: [
          {
            bucketName: "usage-monitor-prod-v3",
            bytes: 9 * gib,
            objectCount: 5,
            asOf: "2026-08-05T00:00:00Z",
          },
        ],
        rawActionCounts: {},
      },
      {
        buckets: [
          {
            bucketName: "usage-monitor-prod-v3",
            bytes: 0.28 * gib,
            objectCount: 2,
            asOf: "2026-08-25T12:00:00Z",
          },
        ],
      }
    );
    expect(overlaid.currentBytes).toBeCloseTo(0.28 * gib, 0);
    expect(overlaid.billingBytes).toBeCloseTo(2.6 * gib, 0);
    expect(overlaid.storageIsLive).toBe(true);
  });

  it("summarizeR2DailyStorage averages the whole month so one 22 GiB day is not 220%", () => {
    const gib = 1024 * 1024 * 1024;
    const summary = summarizeR2DailyStorage(
      [
        {
          max: { payloadSize: 22 * gib },
          dimensions: { date: "2026-08-05", bucketName: "usage-monitor-bucket" },
        },
        {
          max: { payloadSize: 0.28 * gib },
          dimensions: { date: "2026-08-25", bucketName: "usage-monitor-prod-v3" },
        },
      ],
      new Date("2026-08-25T20:00:00.000Z")
    );
    expect(summary).not.toBeNull();
    expect(summary?.monthPeakBytes).toBe(22 * gib);
    expect(summary?.monthPeakDate).toBe("2026-08-05");
    expect(summary?.gbMonthBytes).toBeCloseTo((22 * gib + 0.28 * gib) / 25, 0);
    expect(summary?.previousWeekPeakBytes).toBeCloseTo(0.28 * gib, 0);
    expect(summary?.previousWeekGbMonthBytes).toBeCloseTo((0.28 * gib) / 7, 0);
  });

  it("mergeGraphqlStorageWithLiveOverlay keeps orphan buckets when live list is partial", () => {
    const graphqlBuckets = [
      {
        bucketName: "usage-monitor-bucket",
        bytes: 15 * 1024 * 1024 * 1024,
        objectCount: 100,
        asOf: "2026-08-23T00:00:00Z",
      },
      {
        bucketName: "usage-monitor-prod-v3",
        bytes: 9 * 1024 * 1024 * 1024,
        objectCount: 50,
        asOf: "2026-08-23T00:00:00Z",
      },
    ];
    const live = {
      buckets: [
        {
          bucketName: "usage-monitor-prod-v3",
          bytes: 300 * 1024 * 1024,
          objectCount: 2,
          asOf: "2026-08-23T12:00:00Z",
        },
      ],
    };
    const merged = mergeGraphqlStorageWithLiveOverlay(graphqlBuckets, live);
    expect(merged.storageIsLive).toBe(true);
    expect(merged.metricsSource).toBe("live_s3_storage+graphql_ops");
    expect(merged.storageBytes).toBe(
      15 * 1024 * 1024 * 1024 + 300 * 1024 * 1024
    );
    expect(merged.buckets.find((b) => b.bucketName === "usage-monitor-bucket")?.bytes).toBe(
      15 * 1024 * 1024 * 1024
    );
    expect(merged.buckets.find((b) => b.bucketName === "usage-monitor-prod-v3")?.bytes).toBe(
      300 * 1024 * 1024
    );
  });

  it("formatFleetR2DigestLines summarizes configured fleet accounts", () => {
    const lines = formatFleetR2DigestLines({
      configured: true,
      thresholdPct: 70,
      freeTier: DEFAULT_R2_FREE_TIER_LIMITS,
      accounts: [
        {
          id: "um",
          label: "Usage Monitor",
          accountIdSuffix: "12345678",
          configured: true,
          status: "ok",
          storage: {
            actual: 5 * 1024 * 1024 * 1024,
            limit: 10 * 1024 * 1024 * 1024,
            mtdPct: 50,
            projected: 50,
            projectedPct: 50,
            onTrackToExceed: false,
          },
          classA: null,
          classB: null,
          overallOnTrackToExceed70Pct: false,
          metricsSource: "cloudflare_graphql",
          buckets: [],
          currentBytes: 0.28 * 1024 * 1024 * 1024,
          monthPeakBytes: 22 * 1024 * 1024 * 1024,
          monthPeakDate: "2026-08-05",
          previousWeekGbMonthBytes: 0.21 * 1024 * 1024 * 1024,
        },
        {
          id: "st",
          label: "Socratic Trade",
          accountIdSuffix: "abcdef01",
          configured: true,
          status: "ok",
          storage: {
            actual: 8 * 1024 * 1024 * 1024,
            limit: 10 * 1024 * 1024 * 1024,
            mtdPct: 80,
            projected: 85,
            projectedPct: 85,
            onTrackToExceed: true,
          },
          classA: null,
          classB: null,
          overallOnTrackToExceed70Pct: true,
          metricsSource: "cloudflare_graphql",
          buckets: [],
        },
      ],
      anyOnTrackToExceed: true,
      fetchedAt: "2026-08-23T12:00:00Z",
      localBackup: { autoDisabled: false, litestreamUsesR2: false },
    });
    expect(lines[0]).toContain("Fleet R2");
    expect(lines.some((l) => l.includes("Usage Monitor") && l.includes("5.00 GiB"))).toBe(true);
    expect(lines.some((l) => l.includes("Usage Monitor") && l.includes("peak 22.00 GiB 2026-08-05"))).toBe(
      true
    );
    expect(lines.some((l) => l.includes("Socratic Trade") && l.includes("⚠️"))).toBe(true);
  });

  it("asks GraphQL for a short fresh window plus a month-long per-bucket group", async () => {
    const now = new Date("2026-08-14T18:00:00.000Z");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: {
            viewer: {
              accounts: [
                {
                  r2OperationsAdaptiveGroups: [],
                  r2StorageAdaptiveGroups: [],
                },
              ],
            },
          },
        }),
    });

    await fetchR2UsageMetrics(
      { accountId: "acct-um", apiToken: "tok-um" },
      now,
      mockFetch as unknown as typeof fetch
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const init = mockFetch.mock.calls[0][1] as { body: string };
    const body = JSON.parse(init.body) as {
      query: string;
      variables: { startDate: string; endDate: string; storageStartDate: string };
    };
    expect(body.variables.startDate).toBe("2026-08-01T00:00:00.000Z");
    expect(body.variables.endDate).toBe(now.toISOString());
    expect(body.variables.storageStartDate).toBe(utcStorageLookbackIso(now));
    expect(Date.parse(body.variables.storageStartDate)).toBe(
      now.getTime() - R2_STORAGE_GRAPHQL_LOOKBACK_MS
    );
    expect(body.query).toContain(`limit: ${R2_STORAGE_GRAPHQL_GROUP_LIMIT}`);
    expect(body.query).toContain("datetime_geq: $storageStartDate");
    expect(body.query).toContain("r2StorageByBucket:");
    expect(body.query).toContain("r2StorageByDay:");
    expect(body.query).toContain("dimensions {");
    expect(body.query).toContain("date");
    expect(body.query).toContain(`limit: ${R2_STORAGE_GRAPHQL_BUCKET_LIMIT}`);
    expect(body.query).toContain(`limit: ${R2_STORAGE_GRAPHQL_DAY_LIMIT}`);
    expect(R2_STORAGE_GRAPHQL_LOOKBACK_MS).toBe(24 * 60 * 60 * 1000);
    expect(R2_STORAGE_GRAPHQL_GROUP_LIMIT).toBeLessThan(1000);
    expect(R2_STORAGE_GRAPHQL_BUCKET_LIMIT).toBeLessThan(200);
    expect(R2_STORAGE_GRAPHQL_DAY_LIMIT).toBeLessThan(1000);
  });

  it("keeps GraphQL storage when the UM live S3 overlay throws", async () => {
    const now = new Date("2026-08-14T18:00:00.000Z");
    const storageBytes = 2 * 1024 * 1024 * 1024;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("graphql")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              data: {
                viewer: {
                  accounts: [
                    {
                      r2OperationsAdaptiveGroups: [
                        {
                          sum: { requests: 10 },
                          dimensions: { actionType: "PutObject" },
                        },
                      ],
                      r2StorageAdaptiveGroups: [
                        {
                          max: {
                            payloadSize: storageBytes,
                            metadataSize: 0,
                            objectCount: 4,
                          },
                          dimensions: {
                            datetime: now.toISOString(),
                            bucketName: "usage-monitor-prod-v3",
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            }),
        };
      }
      throw new Error("S3 list exploded");
    });

    const summary = await fetchR2FleetSummary(
      mockFetch as unknown as typeof fetch,
      now,
      {
        R2_USAGE_ACCOUNT_ID: "acct-um-12345678",
        R2_USAGE_API_TOKEN: "tok-um",
        LITESTREAM_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
        LITESTREAM_S3_ACCESS_KEY_ID: "AKIAEXAMPLE",
        LITESTREAM_S3_SECRET_ACCESS_KEY: "secret-example",
        LITESTREAM_S3_BUCKET: "usage-monitor-prod-v3",
      }
    );

    const um = summary.accounts.find((a) => a.id === "um");
    expect(um?.status).toBe("ok");
    expect(um?.metricsSource).toBe("cloudflare_graphql");
    expect(um?.storage?.actual).toBe(storageBytes);
  });

  it("recognizes Cloudflare 10042 as R2-not-enabled", () => {
    expect(
      isR2ProductDisabledPayload({
        success: false,
        errors: [{ code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." }],
      })
    ).toBe(true);
    expect(
      isR2ProductDisabledPayload({
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
      })
    ).toBe(false);
  });

  it("treats GraphQL leftovers as unused when REST says R2 is not enabled", async () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    const ghostBytes = 116 * 1024 * 1024 * 1024;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("/r2/buckets")) {
        return {
          ok: false,
          status: 403,
          text: async () =>
            JSON.stringify({
              success: false,
              errors: [
                {
                  code: 10042,
                  message: "Please enable R2 through the Cloudflare Dashboard.",
                },
              ],
            }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              viewer: {
                accounts: [
                  {
                    r2OperationsAdaptiveGroups: [],
                    r2StorageAdaptiveGroups: [
                      {
                        max: { payloadSize: ghostBytes, metadataSize: 0, objectCount: 4 },
                        dimensions: {
                          datetime: now.toISOString(),
                          bucketName: "api-usage-monitor",
                        },
                      },
                    ],
                  },
                ],
              },
            },
          }),
      };
    });

    const summary = await fetchR2FleetSummary(
      mockFetch as unknown as typeof fetch,
      now,
      {
        CLOUDFLARE_OLD_ACCOUNT_ID: "254301ba6b6323381932ddbca9608c73",
        CLOUDFLARE_OLD_API_TOKEN: "old-token",
      }
    );
    const old = summary.accounts.find((a) => a.id === "old");
    expect(old?.status).toBe("ok");
    expect(old?.metricsSource).toBe("r2_not_enabled");
    expect(old?.overallOnTrackToExceed70Pct).toBe(false);
    expect(old?.storage).toBeNull();
    expect(summary.anyOnTrackToExceed).toBe(false);
    expect(mockFetch.mock.calls.some((call) => String(call[0]).includes("/r2/buckets"))).toBe(
      true
    );
  });

  it("does not ListBuckets for an under-threshold live account", async () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("/r2/buckets")) {
        throw new Error("ListBuckets should not run under the storage guard");
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              viewer: {
                accounts: [
                  {
                    r2OperationsAdaptiveGroups: [],
                    r2StorageAdaptiveGroups: [
                      {
                        max: {
                          payloadSize: 500 * 1024 * 1024,
                          metadataSize: 0,
                          objectCount: 2,
                        },
                        dimensions: {
                          datetime: now.toISOString(),
                          bucketName: "usage-monitor-prod-v3",
                        },
                      },
                    ],
                  },
                ],
              },
            },
          }),
      };
    });

    const summary = await fetchR2FleetSummary(
      mockFetch as unknown as typeof fetch,
      now,
      {
        R2_USAGE_ACCOUNT_ID: "3a9368057468d0909cafaa85df12d1b7",
        R2_USAGE_API_TOKEN: "um-token",
      }
    );
    const um = summary.accounts.find((a) => a.id === "um");
    expect(um?.metricsSource).toBe("cloudflare_graphql");
    expect(um?.storage?.actual).toBe(500 * 1024 * 1024);
    expect(mockFetch.mock.calls.every((call) => String(call[0]).includes("graphql"))).toBe(
      true
    );
  });

  it("parses bucket names from both Cloudflare ListBuckets payload shapes", () => {
    expect(
      parseR2BucketNames({
        result: { buckets: [{ name: "a" }, { name: "b" }] },
      })
    ).toEqual(["a", "b"]);
    expect(parseR2BucketNames({ result: [{ name: "solo" }] })).toEqual(["solo"]);
    expect(parseR2BucketNames({ buckets: [{ name: "x" }] })).toEqual(["x"]);
    expect(parseR2BucketNames({ errors: [{ code: 10000 }] })).toBeNull();
    expect(parseR2BucketNames("garbage")).toBeNull();
  });

  // Regression: usage-monitor-bucket was deleted mid-August 2026, but its
  // GraphQL month-window row (15 GiB) kept the fleet card at 154% of the free
  // tier for the rest of the month.  When ListBuckets confirms a bucket no
  // longer exists, it must drop out of the CURRENT snapshot (GB-month billing
  // history is separate and untouched).
  it("drops deleted ghost buckets from the current snapshot when ListBuckets confirms", async () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    const ghostBytes = 15 * 1024 * 1024 * 1024;
    const liveBytes = 500 * 1024 * 1024;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("/r2/buckets")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              success: true,
              result: { buckets: [{ name: "usage-monitor-prod-v3" }] },
            }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              viewer: {
                accounts: [
                  {
                    r2OperationsAdaptiveGroups: [],
                    r2StorageAdaptiveGroups: [
                      {
                        max: { payloadSize: liveBytes, metadataSize: 0, objectCount: 2 },
                        dimensions: {
                          datetime: now.toISOString(),
                          bucketName: "usage-monitor-prod-v3",
                        },
                      },
                    ],
                    r2StorageByBucket: [
                      {
                        max: { payloadSize: ghostBytes, metadataSize: 0, objectCount: 4 },
                        dimensions: { bucketName: "usage-monitor-bucket" },
                      },
                      {
                        max: { payloadSize: liveBytes, metadataSize: 0, objectCount: 2 },
                        dimensions: { bucketName: "usage-monitor-prod-v3" },
                      },
                    ],
                  },
                ],
              },
            },
          }),
      };
    });

    const summary = await fetchR2FleetSummary(
      mockFetch as unknown as typeof fetch,
      now,
      {
        R2_USAGE_ACCOUNT_ID: "acct-um-ghost-12345678",
        R2_USAGE_API_TOKEN: "um-token",
      }
    );
    const um = summary.accounts.find((a) => a.id === "um");
    expect(um?.status).toBe("ok");
    expect(um?.ghostBuckets).toEqual(["usage-monitor-bucket"]);
    expect(um?.currentBytes).toBe(liveBytes);
    expect(um?.storage?.actual).toBe(liveBytes);
    expect(um?.buckets?.map((b) => b.bucketName)).toEqual(["usage-monitor-prod-v3"]);
    expect(um?.overallOnTrackToExceed70Pct).toBe(false);
    expect(summary.anyOnTrackToExceed).toBe(false);
  });

  it("keeps existing buckets intact when ListBuckets confirms they are live", async () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    const bigBytes = 9 * 1024 * 1024 * 1024;
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("/r2/buckets")) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              success: true,
              result: { buckets: [{ name: "socratic-trade-bucket" }] },
            }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              viewer: {
                accounts: [
                  {
                    r2OperationsAdaptiveGroups: [],
                    r2StorageAdaptiveGroups: [
                      {
                        max: { payloadSize: bigBytes, metadataSize: 0, objectCount: 90 },
                        dimensions: {
                          datetime: now.toISOString(),
                          bucketName: "socratic-trade-bucket",
                        },
                      },
                    ],
                  },
                ],
              },
            },
          }),
      };
    });

    const summary = await fetchR2FleetSummary(
      mockFetch as unknown as typeof fetch,
      now,
      {
        CLOUDFLARE_ST_ACCOUNT_ID: "acct-st-live-12345678",
        CLOUDFLARE_ST_API_TOKEN: "st-token",
      }
    );
    const st = summary.accounts.find((a) => a.id === "st");
    expect(st?.status).toBe("ok");
    expect(st?.ghostBuckets).toBeUndefined();
    expect(st?.storage?.actual).toBe(bigBytes);
    expect(st?.overallOnTrackToExceed70Pct).toBe(true);
  });

  it("preserves B2 replication while enforcing the independent R2 archive kill", async () => {
    expect(isR2AutoDisabled()).toBe(false);

    process.env.LITESTREAM_ACTIVE = "true";
    process.env.LITESTREAM_S3_ENDPOINT = "s3.us-west-004.backblazeb2.com";
    const setCheckpoint = vi.fn(async () => {});
    (globalThis as Record<string, unknown>)["__apiUsageMonitorSetWalAutocheckpoint"] = setCheckpoint;
    await enforceR2AutoDisable("Test 90% breach");
    expect(isR2AutoDisabled()).toBe(true);
    expect(process.env.LITESTREAM_EMERGENCY_DISABLE).toBe("true");
    expect(process.env.R2_WRITES_DISABLED).toBe("true");
    expect(process.env.LITESTREAM_ACTIVE).toBe("true");
    expect(setCheckpoint).not.toHaveBeenCalled();
    expect(fs.existsSync(__getR2FlagFilePathForTests(R2_DISABLED_FLAG_FILENAME))).toBe(true);
  });

  // Regression: production sat kill-switched from 2026-08-04 to 2026-08-12
  // with storage at 4.4% of the free tier, because the switch was pinned as a
  // deploy-config env var. clearR2AutoDisable() only mutated process.env, so
  // every maintenance-cycle resume died with the process and the next restart
  // re-injected the variable. The resume has to outlive the process.
  describe("durable auto-resume over an env-pinned kill switch", () => {
    function configureManagedR2Supervisor(active: boolean, watcherActive = active): void {
      process.env.APP_STARTUP_WRAPPER = "start-with-litestream-v2";
      process.env.LITESTREAM_R2_SUPERVISOR_ACTIVE = watcherActive ? "true" : "false";
      process.env.LITESTREAM_S3_BUCKET = "test-r2-bucket";
      process.env.LITESTREAM_S3_ENDPOINT = "account.r2.cloudflarestorage.com";
      process.env.LITESTREAM_S3_ACCESS_KEY_ID = "test-access-key";
      process.env.LITESTREAM_S3_SECRET_ACCESS_KEY = "test-secret-key";
      process.env.LITESTREAM_ACTIVE = active ? "true" : "false";
    }

    // These write isolated flag files; clean them up explicitly between cases.
    afterEach(() => {
      for (const name of [R2_DISABLED_FLAG_FILENAME, R2_AUTO_RESUMED_FLAG_FILENAME]) {
        try {
          fs.rmSync(__getR2FlagFilePathForTests(name), { force: true });
        } catch {
          // best-effort
        }
      }
    });

    it("keeps an env-set kill switch engaged when nothing has resumed it", () => {
      process.env.LITESTREAM_EMERGENCY_DISABLE = "true";
      expect(hasR2AutoResumeMarker()).toBe(false);
      expect(isR2AutoDisabled()).toBe(true);
    });

    it("hands checkpoint ownership to and from the R2 supervisor around kill and resume", async () => {
      configureManagedR2Supervisor(true);
      const checkpointChanges: number[] = [];
      (globalThis as Record<string, unknown>)["__apiUsageMonitorSetWalAutocheckpoint"] =
        async (pages: number) => {
          checkpointChanges.push(pages);
        };

      await enforceR2AutoDisable("test R2 threshold");
      expect(checkpointChanges).toEqual([1_000]);
      expect(process.env.LITESTREAM_ACTIVE).toBe("false");
      expect(isR2AutoDisabled()).toBe(true);

      await clearR2AutoDisable("test R2 recovery");
      expect(checkpointChanges).toEqual([1_000, 0]);
      expect(process.env.LITESTREAM_ACTIVE).toBe("true");
      expect(isR2AutoDisabled()).toBe(false);
      expect(hasR2AutoResumeMarker()).toBe(true);
    });

    it("defers resume until restart when R2 booted without its watcher", async () => {
      configureManagedR2Supervisor(false, false);
      process.env.LITESTREAM_EMERGENCY_DISABLE = "true";
      process.env.R2_WRITES_DISABLED = "true";
      fs.writeFileSync(
        __getR2FlagFilePathForTests(R2_DISABLED_FLAG_FILENAME),
        "disabled at boot\n",
        { encoding: "utf8", mode: 0o600 }
      );
      const checkpointChanges: number[] = [];
      (globalThis as Record<string, unknown>)["__apiUsageMonitorSetWalAutocheckpoint"] =
        async (pages: number) => {
          checkpointChanges.push(pages);
        };

      await clearR2AutoDisable("boot recovery");

      expect(checkpointChanges).toEqual([]);
      expect(hasR2AutoResumeMarker()).toBe(true);
      expect(process.env.LITESTREAM_ACTIVE).toBe("false");
      expect(isR2AutoDisabled()).toBe(false);
    });

    it("does not claim R2 replication resumed without the managed supervisor config", async () => {
      process.env.LITESTREAM_S3_ENDPOINT = "account.r2.cloudflarestorage.com";
      process.env.APP_STARTUP_WRAPPER = "start-with-litestream-v2";
      process.env.LITESTREAM_R2_SUPERVISOR_ACTIVE = "false";
      process.env.LITESTREAM_ACTIVE = "false";
      process.env.LITESTREAM_EMERGENCY_DISABLE = "true";
      process.env.R2_WRITES_DISABLED = "true";
      fs.writeFileSync(
        __getR2FlagFilePathForTests(R2_DISABLED_FLAG_FILENAME),
        "disabled at boot\n",
        { encoding: "utf8", mode: 0o600 }
      );
      const checkpoint = vi.fn(async () => {});
      (globalThis as Record<string, unknown>)["__apiUsageMonitorSetWalAutocheckpoint"] = checkpoint;

      await clearR2AutoDisable("resume with no supervisor");

      expect(checkpoint).not.toHaveBeenCalled();
      expect(process.env.LITESTREAM_ACTIVE).toBe("false");
      expect(isR2AutoDisabled()).toBe(false);
    });

    it("keeps the R2 kill engaged and inactive when a checkpoint transition fails", async () => {
      configureManagedR2Supervisor(true);
      const checkpoint = vi.fn(async () => {
        throw new Error("sqlite pragma rejected");
      });
      (globalThis as Record<string, unknown>)["__apiUsageMonitorSetWalAutocheckpoint"] = checkpoint;

      await expect(enforceR2AutoDisable("test R2 threshold")).rejects.toThrow(
        "R2 kill persisted but SQLite checkpoint handoff failed"
      );
      expect(checkpoint).toHaveBeenCalledWith(1_000);
      expect(process.env.LITESTREAM_ACTIVE).toBe("false");
      expect(isR2AutoDisabled()).toBe(true);

      await expect(clearR2AutoDisable("test R2 recovery")).rejects.toThrow(
        "sqlite pragma rejected"
      );
      expect(checkpoint).toHaveBeenCalledWith(0);
      expect(process.env.LITESTREAM_ACTIVE).toBe("false");
      expect(isR2AutoDisabled()).toBe(true);
      expect(hasR2AutoResumeMarker()).toBe(false);
    });

    it("retries a failed kill checkpoint handoff at the next maintenance check", async () => {
      configureManagedR2Supervisor(true);
      let failFirstHandoff = true;
      const checkpointChanges: number[] = [];
      (globalThis as Record<string, unknown>)["__apiUsageMonitorSetWalAutocheckpoint"] =
        async (pages: number) => {
          checkpointChanges.push(pages);
          if (pages === 1_000 && failFirstHandoff) {
            failFirstHandoff = false;
            throw new Error("transient pragma failure");
          }
        };

      await expect(enforceR2AutoDisable("transient checkpoint failure")).rejects.toThrow(
        "R2 kill persisted but SQLite checkpoint handoff failed"
      );
      expect(process.env.LITESTREAM_ACTIVE).toBe("false");
      expect(isR2AutoDisabled()).toBe(true);

      const deniedListRequest: typeof fetch = async () =>
        new Response("AccessDenied", { status: 403 });
      await runR2UsageCheck(deniedListRequest);
      expect(checkpointChanges).toEqual([1_000, 1_000]);

      await runR2UsageCheck(deniedListRequest);
      expect(checkpointChanges).toEqual([1_000, 1_000]);
      expect(isR2AutoDisabled()).toBe(true);
    });

    it("rolls checkpoint ownership back when atomic resume-marker preparation fails", async () => {
      configureManagedR2Supervisor(true);
      const disabledPath = __getR2FlagFilePathForTests(R2_DISABLED_FLAG_FILENAME);
      fs.writeFileSync(disabledPath, "disabled before resume\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      const checkpointChanges: number[] = [];
      (globalThis as Record<string, unknown>)["__apiUsageMonitorSetWalAutocheckpoint"] =
        async (pages: number) => {
          checkpointChanges.push(pages);
        };
      const write = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
        throw new Error("disk full");
      });

      await expect(clearR2AutoDisable("marker write failure")).rejects.toThrow(
        "Failed writing R2 auto-resume marker"
      );
      write.mockRestore();

      expect(checkpointChanges).toEqual([0, 1_000]);
      expect(fs.existsSync(disabledPath)).toBe(true);
      expect(hasR2AutoResumeMarker()).toBe(false);
      expect(process.env.LITESTREAM_ACTIVE).toBe("false");
      expect(isR2AutoDisabled()).toBe(true);
    });

    it("rolls back an uncommitted resume when old kill-flag cleanup fails", async () => {
      configureManagedR2Supervisor(true);
      const disabledPath = __getR2FlagFilePathForTests(R2_DISABLED_FLAG_FILENAME);
      fs.writeFileSync(disabledPath, "disabled before resume\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      const checkpointChanges: number[] = [];
      (globalThis as Record<string, unknown>)["__apiUsageMonitorSetWalAutocheckpoint"] =
        async (pages: number) => {
          checkpointChanges.push(pages);
        };
      const unlink = fs.unlinkSync.bind(fs);
      const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((filePath) => {
        if (String(filePath) === disabledPath) throw new Error("permission denied");
        return unlink(filePath);
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(clearR2AutoDisable("kill-flag cleanup failure")).rejects.toThrow(
        "Failed clearing R2 emergency disable flag"
      );
      unlinkSpy.mockRestore();
      log.mockRestore();

      expect(checkpointChanges).toEqual([0, 1_000]);
      expect(fs.existsSync(disabledPath)).toBe(true);
      expect(hasR2AutoResumeMarker()).toBe(false);
      expect(process.env.LITESTREAM_ACTIVE).toBe("false");
      expect(isR2AutoDisabled()).toBe(true);
    });

    it("keeps a fresh kill authoritative if removing an old resume marker fails", async () => {
      configureManagedR2Supervisor(true);
      const markerPath = __getR2FlagFilePathForTests(R2_AUTO_RESUMED_FLAG_FILENAME);
      const disabledPath = __getR2FlagFilePathForTests(R2_DISABLED_FLAG_FILENAME);
      fs.writeFileSync(markerPath, "older resume\n", { encoding: "utf8", mode: 0o600 });
      const checkpointChanges: number[] = [];
      (globalThis as Record<string, unknown>)["__apiUsageMonitorSetWalAutocheckpoint"] =
        async (pages: number) => {
          checkpointChanges.push(pages);
        };
      const unlink = fs.unlinkSync.bind(fs);
      const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((filePath) => {
        if (String(filePath) === markerPath) throw new Error("permission denied");
        return unlink(filePath);
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});

      await enforceR2AutoDisable("fresh kill after resume");
      unlinkSpy.mockRestore();
      log.mockRestore();

      expect(checkpointChanges).toEqual([1_000]);
      expect(fs.existsSync(markerPath)).toBe(true);
      expect(fs.existsSync(disabledPath)).toBe(true);
      expect(process.env.LITESTREAM_ACTIVE).toBe("false");
      expect(isR2AutoDisabled()).toBe(true);
    });

    it("serializes an in-flight resume before a newer kill transition", async () => {
      configureManagedR2Supervisor(true);
      let releaseCheckpoint!: () => void;
      const checkpointStarted = new Promise<void>((resolve) => {
        releaseCheckpoint = resolve;
      });
      let markCheckpointReady!: () => void;
      const checkpointReady = new Promise<void>((resolve) => {
        markCheckpointReady = resolve;
      });
      const checkpointChanges: number[] = [];
      (globalThis as Record<string, unknown>)["__apiUsageMonitorSetWalAutocheckpoint"] =
        async (pages: number) => {
          checkpointChanges.push(pages);
          if (pages === 0) {
            markCheckpointReady();
            await checkpointStarted;
          }
        };

      const resume = clearR2AutoDisable("older resume");
      await checkpointReady;
      const kill = enforceR2AutoDisable("newer kill");
      releaseCheckpoint();
      await Promise.all([resume, kill]);

      expect(checkpointChanges).toEqual([0, 1_000]);
      expect(hasR2AutoResumeMarker()).toBe(false);
      expect(process.env.LITESTREAM_ACTIVE).toBe("false");
      expect(isR2AutoDisabled()).toBe(true);
    });

    it("overrides an env-set kill switch once auto-resume has recorded a marker", async () => {
      process.env.LITESTREAM_EMERGENCY_DISABLE = "true";
      process.env.R2_WRITES_DISABLED = "true";
      expect(isR2AutoDisabled()).toBe(true);

      await clearR2AutoDisable("storage 4.4% < 85% resume threshold");
      expect(hasR2AutoResumeMarker()).toBe(true);
      expect(isR2AutoDisabled()).toBe(false);

      // The restart: deploy config re-injects the variables over a fresh
      // process.env. Without the persisted marker this is where the resume
      // used to silently evaporate.
      process.env.LITESTREAM_EMERGENCY_DISABLE = "true";
      process.env.R2_WRITES_DISABLED = "true";
      expect(isR2AutoDisabled()).toBe(false);
    });

    it("lets a fresh breach supersede an earlier resume", async () => {
      await clearR2AutoDisable("first resume");
      expect(isR2AutoDisabled()).toBe(false);

      await enforceR2AutoDisable("storage back over 90%");
      expect(hasR2AutoResumeMarker()).toBe(false);
      expect(isR2AutoDisabled()).toBe(true);

      // ...and a re-injected env var on the next restart must not be undone
      // by the marker that the breach just deleted.
      delete process.env.LITESTREAM_EMERGENCY_DISABLE;
      delete process.env.R2_WRITES_DISABLED;
      expect(isR2AutoDisabled()).toBe(true);
    });

    it("lets an explicit persisted kill flag win over a stale resume marker", async () => {
      await clearR2AutoDisable("resumed earlier");
      expect(isR2AutoDisabled()).toBe(false);

      // Hand-written flag file, the documented operator override — the marker
      // must not be able to veto it.
      fs.writeFileSync(
        __getR2FlagFilePathForTests(R2_DISABLED_FLAG_FILENAME),
        "operator kill\n",
        { encoding: "utf8", mode: 0o600 }
      );
      expect(hasR2AutoResumeMarker()).toBe(true);
      expect(isR2AutoDisabled()).toBe(true);
    });

    it(
      "writes the resume marker owner-only, with the reason and how to undo it",
      async () => {
        await clearR2AutoDisable("storage 4.4% < 85% resume threshold");

        const markerPath = __getR2FlagFilePathForTests(R2_AUTO_RESUMED_FLAG_FILENAME);
        const fd = fs.openSync(markerPath, "r");
        try {
          expect(fs.fstatSync(fd).mode & 0o777).toBe(0o600);
          const body = fs.readFileSync(fd, "utf8");
          expect(body).toContain("storage 4.4% < 85% resume threshold");
          expect(body).toContain("LITESTREAM_EMERGENCY_DISABLE");
          expect(body).toContain("Delete this file");
        } finally {
          fs.closeSync(fd);
        }
      }
    );
  });

  it(
    "places fallback flag files in a private per-process mkdtemp directory, not a predictable shared temp path",
    () => {
      const flagPath = __getR2FlagFilePathForTests(R2_DISABLED_FLAG_FILENAME);

      expect(flagPath).not.toBe(path.join(os.tmpdir(), R2_DISABLED_FLAG_FILENAME));
      expect(flagPath).not.toBe(`/tmp/${R2_DISABLED_FLAG_FILENAME}`);

      const flagDir = path.dirname(flagPath);
      expect(path.dirname(flagDir)).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(flagDir).startsWith("um-r2-")).toBe(true);
      expect(fs.statSync(flagDir).mode & 0o777).toBe(0o700);
      expect(__getR2FlagFilePathForTests(R2_DISABLED_FLAG_FILENAME)).toBe(
        flagPath
      );
    }
  );

  it("keeps test flag files isolated when a test enables production behavior", () => {
    vi.stubEnv("NODE_ENV", "production");

    const flagPath = __getR2FlagFilePathForTests(R2_DISABLED_FLAG_FILENAME);

    expect(flagPath).not.toBe(path.join("/data", R2_DISABLED_FLAG_FILENAME));
    expect(path.dirname(path.dirname(flagPath))).toBe(path.resolve(os.tmpdir()));
  });

  it(
    "writes flag files with owner-only permissions and the expected content",
    async () => {
      await enforceR2AutoDisable("perm check reason");

      const flagPath = __getR2FlagFilePathForTests(R2_DISABLED_FLAG_FILENAME);
      const fd = fs.openSync(flagPath, "r");
      try {
        expect(fs.fstatSync(fd).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(fd, "utf8")).toContain("perm check reason");
      } finally {
        fs.closeSync(fd);
      }
    }
  );

  it("sends Pushover notifications via HTTP POST to Pushover API", async () => {
    process.env.PUSHOVER_USER_KEY = "test_user_key";
    process.env.PUSHOVER_USAGE_API_TOKEN = "test_usage_api_token";
    process.env.PUSHOVER_API_TOKEN = "test_api_token";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"status":1}',
    });

    const res = await sendPushoverNotification(
      "Test Title",
      "Test Message",
      0,
      mockFetch as unknown as typeof fetch
    );

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://api.pushover.net/1/messages.json"
    );
    const body = String(mockFetch.mock.calls[0][1]?.body ?? "");
    // Prefer PUSHOVER_USAGE_API_TOKEN over generic PUSHOVER_API_TOKEN.
    expect(body).toContain("token=test_usage_api_token");
    expect(body).not.toContain("token=test_api_token");
    const params = new URLSearchParams(body);
    // Own free tier under UM logo — no sent-from footer.
    expect(params.get("message")).not.toContain("(sent from");
  });

  it("formats daily Pushover summary message cleanly", () => {
    const testDate = new Date("2026-07-15T12:00:00.000Z");
    const assessment = assessR2Usage(
      2 * 1024 * 1024 * 1024,
      50_000,
      100_000,
      DEFAULT_R2_FREE_TIER_LIMITS,
      testDate
    );

    const { title, body } = formatDailyPushoverMessage(assessment, false);
    expect(title).toContain("Cloudflare R2");
    expect(body).toContain("R2 Storage:");
    expect(body).toContain("Class A Ops:");
    expect(body).toContain("Status: ✅ OK");
    expect(body).toContain("Backup:");
    expect(body).toContain("Hetzner");
    expect(body).not.toContain("month peak:");
  });

  it.each([
    [false, false, "✅ OK (Under 90% free-tier pace)"],
    [true, false, "🛑 DISABLED (Auto-killed at 90% threshold)"],
    [false, true, "⚠️ WARNING (Pace/MTD >= 90%)"],
  ])("uses the current policy in Pushover status (disabled=%s, breached=%s)", (disabled, breached, status) => {
    const assessment = assessR2Usage(
      DEFAULT_R2_FREE_TIER_LIMITS.storageBytes * (breached ? 0.95 : 0.8),
      0,
      0,
      DEFAULT_R2_FREE_TIER_LIMITS,
      new Date("2026-08-15T12:00:00.000Z")
    );
    const { body } = formatDailyPushoverMessage(assessment, disabled);
    expect(body).toContain(status);
    expect(body).not.toContain("70%");
  });

  it("formats daily Pushover with current snapshot, month peak, and last 7 days", () => {
    const gib = 1024 * 1024 * 1024;
    const testDate = new Date("2026-08-25T12:00:00.000Z");
    const assessment = assessR2Usage(
      2.6 * gib,
      50_000,
      100_000,
      DEFAULT_R2_FREE_TIER_LIMITS,
      testDate,
      {
        currentBytes: 0.28 * gib,
        gbMonthBytes: 2.6 * gib,
        monthPeakBytes: 22 * gib,
        monthPeakDate: "2026-08-05",
        previousWeekGbMonthBytes: 0.21 * gib,
        previousWeekPeakBytes: 0.28 * gib,
      }
    );
    const { body } = formatDailyPushoverMessage(assessment, false);
    expect(body).toContain("current snapshot: 0.28 GiB");
    expect(body).toContain("month peak: 22.00 GiB (2026-08-05)");
    expect(body).toContain("last 7 days: 0.21 GiB avg");
    expect(body).toContain("peak 0.28 GiB");
  });

  it("does not auto-disable when GraphQL credentials are missing", async () => {
    process.env.PUSHOVER_USER_KEY = "test_user_key";
    process.env.PUSHOVER_USAGE_API_TOKEN = "test_usage_api_token";
    process.env.PUSHOVER_API_TOKEN = "test_api_token";

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '{"status":1}',
    });

    const assessment = await runR2UsageCheck(
      mockFetch as unknown as typeof fetch,
      new Date("2026-07-15T12:00:00.000Z")
    );

    expect(assessment.metricsSource).toBe("unavailable");
    expect(assessment.metricsError).toMatch(/credentials/i);
    expect(isR2AutoDisabled()).toBe(false);
    // Daily pushover still attempted; no GraphQL call.
    expect(
      mockFetch.mock.calls.some(
        (c) => c[0] === "https://api.cloudflare.com/client/v4/graphql"
      )
    ).toBe(false);
  });

  it("auto-disables from real GraphQL metrics when storage is over 90%", async () => {
    process.env.R2_USAGE_ACCOUNT_ID = "acct-test";
    process.env.R2_USAGE_API_TOKEN = "tok-test";
    process.env.PUSHOVER_USER_KEY = "test_user_key";
    process.env.PUSHOVER_USAGE_API_TOKEN = "test_usage_api_token";
    process.env.PUSHOVER_API_TOKEN = "test_api_token";
    process.env.LITESTREAM_S3_ENDPOINT =
      "https://acct.r2.cloudflarestorage.com";

    const storageBytes = 9.3 * 1024 * 1024 * 1024; // ~93% of 10 GiB
    const graphqlBody = {
      data: {
        viewer: {
          accounts: [
            {
              r2OperationsAdaptiveGroups: [
                {
                  sum: { requests: 50_000 },
                  dimensions: { actionType: "PutObject" },
                },
                {
                  sum: { requests: 2_000 },
                  dimensions: { actionType: "GetObject" },
                },
              ],
              r2StorageAdaptiveGroups: [
                {
                  max: {
                    payloadSize: storageBytes,
                    metadataSize: 0,
                    objectCount: 1200,
                  },
                  dimensions: {
                    datetime: "2026-08-03T12:00:00Z",
                    bucketName: "usage-monitor-bucket",
                  },
                },
              ],
            },
          ],
        },
      },
    };

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("graphql")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify(graphqlBody),
        };
      }
      // Pushover
      return {
        ok: true,
        status: 200,
        text: async () => '{"status":1}',
      };
    });

    const now = new Date("2026-08-03T12:00:00.000Z");
    const assessment = await runR2UsageCheck(
      mockFetch as unknown as typeof fetch,
      now
    );

    expect(assessment.metricsSource).toBe("cloudflare_graphql");
    expect(assessment.storage.mtdPct).toBeGreaterThan(90);
    expect(assessment.overallOnTrackToExceed70Pct).toBe(true);
    expect(assessment.exceededMetric).toBe("storage");
    expect(isR2AutoDisabled()).toBe(true);
    expect(assessment.autoDisabled).toBe(true);
    expect(assessment.litestreamUsesR2).toBe(true);
    expect(assessment.buckets?.[0]?.bucketName).toBe("usage-monitor-bucket");

    const graphqlCall = mockFetch.mock.calls.find((c) =>
      String(c[0]).includes("graphql")
    );
    expect(graphqlCall).toBeTruthy();
    expect(graphqlCall?.[1]?.headers?.authorization).toBe("Bearer tok-test");
  });

  it("does not disable when GraphQL reports healthy free-tier usage", async () => {
    process.env.R2_USAGE_ACCOUNT_ID = "acct-test";
    process.env.R2_USAGE_API_TOKEN = "tok-test";

    const graphqlBody = {
      data: {
        viewer: {
          accounts: [
            {
              r2OperationsAdaptiveGroups: [
                {
                  sum: { requests: 1_000 },
                  dimensions: { actionType: "PutObject" },
                },
              ],
              r2StorageAdaptiveGroups: [
                {
                  max: {
                    payloadSize: 0.5 * 1024 * 1024 * 1024,
                    metadataSize: 0,
                    objectCount: 5,
                  },
                  dimensions: {
                    datetime: "2026-08-15T12:00:00Z",
                    bucketName: "small-bucket",
                  },
                },
              ],
            },
          ],
        },
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(graphqlBody),
    });

    // Mid-month, low storage → under 90% projected and MTD
    const assessment = await runR2UsageCheck(
      mockFetch as unknown as typeof fetch,
      new Date("2026-08-15T12:00:00.000Z")
    );

    expect(assessment.metricsSource).toBe("cloudflare_graphql");
    expect(assessment.overallOnTrackToExceed70Pct).toBe(false);
    expect(isR2AutoDisabled()).toBe(false);
  });

  it("treats GraphQL storage samples older than 90 minutes as stale", () => {
    const now = new Date("2026-08-05T00:30:00.000Z");
    expect(
      graphqlStorageSamplesAreFresh(
        [
          {
            bucketName: "usage-monitor-bucket",
            bytes: 15 * 1024 ** 3,
            objectCount: 600,
            asOf: "2026-08-05T00:00:00.000Z",
          },
        ],
        now
      )
    ).toBe(true);
    expect(
      graphqlStorageSamplesAreFresh(
        [
          {
            bucketName: "usage-monitor-bucket",
            bytes: 15 * 1024 ** 3,
            objectCount: 600,
            asOf: "2026-08-04T22:00:00.000Z",
          },
        ],
        now
      )
    ).toBe(false);
  });

  it("ignores orphan buckets with no current sample in the freshness check", () => {
    const now = new Date("2026-08-05T00:30:00.000Z");
    const fresh = {
      bucketName: "usage-monitor-bucket",
      bytes: 15 * 1024 ** 3,
      objectCount: 600,
      asOf: "2026-08-05T00:00:00.000Z",
    };
    const orphan = {
      bucketName: "deleted-ghost-bucket",
      bytes: 2 * 1024 ** 3,
      objectCount: 40,
      asOf: null,
    };
    // Ghost bucket alone must not flip a fresh set to stale (Seer #1706).
    expect(graphqlStorageSamplesAreFresh([fresh, orphan], now)).toBe(true);
    // But with no sampled bucket at all there is no fresh data.
    expect(graphqlStorageSamplesAreFresh([orphan], now)).toBe(false);
  });

  it("does not kill on stale GraphQL storage when live S3 list is unavailable", async () => {
    process.env.R2_USAGE_ACCOUNT_ID = "acct-test";
    process.env.R2_USAGE_API_TOKEN = "tok-test";
    delete process.env.LITESTREAM_S3_ENDPOINT;
    delete process.env.LITESTREAM_S3_ACCESS_KEY_ID;
    delete process.env.LITESTREAM_S3_SECRET_ACCESS_KEY;

    const storageBytes = 15 * 1024 * 1024 * 1024;
    const graphqlBody = {
      data: {
        viewer: {
          accounts: [
            {
              r2OperationsAdaptiveGroups: [
                {
                  sum: { requests: 1000 },
                  dimensions: { actionType: "PutObject" },
                },
              ],
              r2StorageAdaptiveGroups: [
                {
                  max: {
                    payloadSize: storageBytes,
                    metadataSize: 0,
                    objectCount: 600,
                  },
                  dimensions: {
                    datetime: "2026-08-05T00:00:00Z",
                    bucketName: "usage-monitor-bucket",
                  },
                },
              ],
            },
          ],
        },
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(graphqlBody),
    });

    // Sample is 3.5h old → stale
    const now = new Date("2026-08-05T03:30:00.000Z");
    const assessment = await runR2UsageCheck(
      mockFetch as unknown as typeof fetch,
      now
    );

    expect(assessment.storageSampleStale).toBe(true);
    expect(isR2AutoDisabled()).toBe(false);
  });

  describe("auto-resume via fresh GraphQL storage (UM-1609)", () => {
    const freshGraphqlBody = (storageBytes: number, datetime: string) => ({
      data: {
        viewer: {
          accounts: [
            {
              r2OperationsAdaptiveGroups: [
                {
                  sum: { requests: 50_000 },
                  dimensions: { actionType: "PutObject" },
                },
                {
                  sum: { requests: 2_000 },
                  dimensions: { actionType: "GetObject" },
                },
              ],
              r2StorageAdaptiveGroups: [
                {
                  max: {
                    payloadSize: storageBytes,
                    metadataSize: 0,
                    objectCount: 1200,
                  },
                  dimensions: { datetime, bucketName: "usage-monitor-prod-v3" },
                },
              ],
            },
          ],
        },
      },
    });

    const graphqlFetch = (body: unknown) =>
      vi.fn().mockImplementation(async (url: string) => {
        if (url.includes("graphql")) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(body),
          };
        }
        return { ok: true, status: 200, text: async () => '{"status":1}' };
      });

    beforeEach(() => {
      for (const name of [R2_DISABLED_FLAG_FILENAME, R2_AUTO_RESUMED_FLAG_FILENAME]) {
        try {
          fs.unlinkSync(__getR2FlagFilePathForTests(name));
        } catch {
          // absent is fine
        }
      }
    });

    it("auto-resumes from fresh GraphQL storage when no live S3 list is configured", async () => {
      process.env.R2_USAGE_ACCOUNT_ID = "acct-test";
      process.env.R2_USAGE_API_TOKEN = "tok-test";
      // No LITESTREAM_S3_*/AWS_* env: post-B2-cutover deploy shape.
      await enforceR2AutoDisable("test kill");
      expect(isR2AutoDisabled()).toBe(true);

      const storageBytes = 4.6 * 1024 * 1024 * 1024; // ~46% of 10 GiB
      const body = freshGraphqlBody(storageBytes, "2026-08-05T00:00:00Z");
      const now = new Date("2026-08-05T00:30:00.000Z"); // sample 30 min old: fresh
      const assessment = await runR2UsageCheck(
        graphqlFetch(body) as unknown as typeof fetch,
        now
      );

      expect(assessment.metricsSource).toBe("cloudflare_graphql");
      expect(assessment.storageSampleStale).toBe(false);
      expect(assessment.storage.mtdPct).toBeLessThan(85);
      expect(isR2AutoDisabled()).toBe(false);
      expect(hasR2AutoResumeMarker()).toBe(true);
    });

    it("does not auto-resume on stale GraphQL storage without a live list", async () => {
      process.env.R2_USAGE_ACCOUNT_ID = "acct-test";
      process.env.R2_USAGE_API_TOKEN = "tok-test";
      await enforceR2AutoDisable("test kill");
      expect(isR2AutoDisabled()).toBe(true);

      const storageBytes = 4.6 * 1024 * 1024 * 1024;
      const body = freshGraphqlBody(storageBytes, "2026-08-05T00:00:00Z");
      const now = new Date("2026-08-05T03:30:00.000Z"); // 3.5h old: stale
      const assessment = await runR2UsageCheck(
        graphqlFetch(body) as unknown as typeof fetch,
        now
      );

      expect(assessment.storageSampleStale).toBe(true);
      expect(isR2AutoDisabled()).toBe(true);
      expect(hasR2AutoResumeMarker()).toBe(false);
    });

    it("drops an orphan bucket's stale size instead of killing on it", async () => {
      process.env.R2_USAGE_ACCOUNT_ID = "acct-test";
      process.env.R2_USAGE_API_TOKEN = "tok-test";

      // Live bucket is small; the deleted ghost alone would exceed the kill
      // threshold, and it has no 24h sample (asOf null).
      const liveBytes = 2 * 1024 * 1024 * 1024;
      const body = {
        data: {
          viewer: {
            accounts: [
              {
                r2OperationsAdaptiveGroups: [
                  {
                    sum: { requests: 50_000 },
                    dimensions: { actionType: "PutObject" },
                  },
                ],
                r2StorageAdaptiveGroups: [
                  {
                    max: {
                      payloadSize: liveBytes,
                      metadataSize: 0,
                      objectCount: 1200,
                    },
                    dimensions: {
                      datetime: "2026-08-05T00:00:00Z",
                      bucketName: "usage-monitor-prod-v3",
                    },
                  },
                ],
                // Month-window row for a deleted bucket: no datetime
                // dimension, so asOf is null (the orphan shape).
                r2StorageByBucket: [
                  {
                    max: {
                      payloadSize: liveBytes,
                      metadataSize: 0,
                      objectCount: 1200,
                    },
                    dimensions: { bucketName: "usage-monitor-prod-v3" },
                  },
                  {
                    max: {
                      payloadSize: 9 * 1024 * 1024 * 1024,
                      metadataSize: 0,
                      objectCount: 900,
                    },
                    dimensions: { bucketName: "deleted-ghost-bucket" },
                  },
                ],
              },
            ],
          },
        },
      };
      const now = new Date("2026-08-05T00:30:00.000Z");
      const assessment = await runR2UsageCheck(
        graphqlFetch(body) as unknown as typeof fetch,
        now
      );

      expect(assessment.storageSampleStale).toBe(false);
      expect(assessment.buckets?.map((b) => b.bucketName)).toEqual([
        "usage-monitor-prod-v3",
      ]);
      expect(assessment.storage.mtdPct).toBeLessThan(R2_THRESHOLD_PCT);
      expect(isR2AutoDisabled()).toBe(false);
    });

    it("does not auto-resume when metrics are unavailable", async () => {
      // No R2/Cloudflare creds at all.
      await enforceR2AutoDisable("test kill");
      expect(isR2AutoDisabled()).toBe(true);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '{"status":1}',
      });
      const assessment = await runR2UsageCheck(
        mockFetch as unknown as typeof fetch,
        new Date("2026-08-05T00:30:00.000Z")
      );

      expect(assessment.metricsSource).toBe("unavailable");
      expect(isR2AutoDisabled()).toBe(true);
      expect(hasR2AutoResumeMarker()).toBe(false);
    });
  });
});
