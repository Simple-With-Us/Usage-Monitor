import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    provider: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    providerExternalBilling: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

import {
  aggregateReportRows,
  parseUsageReportCsv,
  resolveBucketAppId,
  resetB2AppUsageCacheForTests,
  fetchB2AppUsageBreakdown,
} from "../b2-app-usage";

describe("b2-app-usage", () => {
  beforeEach(() => {
    resetB2AppUsageCacheForTests();
    vi.restoreAllMocks();
  });

  it("maps fleet buckets to app ids", () => {
    expect(resolveBucketAppId("jays-socratic-trade-eu")).toBe("socratic-trade");
    expect(resolveBucketAppId("jays-congress-trade-eu")).toBe("congress-trade");
    expect(resolveBucketAppId("api-usage-monitor")).toBe("usage-monitor");
    expect(resolveBucketAppId("jays-fleet-eu")).toBe("fleet-infra");
  });

  it("parses usage report CSV rows", () => {
    const csv = `bucket_name,date,stored_gb,downloaded_gb,api_txn_class_c,api_txn_class_b
jays-socratic-trade-eu,2026-08-24,150.0,2.5,1200,50
jays-congress-trade-eu,2026-08-24,30.5,0.2,400,10`;
    const rows = parseUsageReportCsv(csv);
    expect(rows).toHaveLength(2);
    const agg = aggregateReportRows(rows, "2026-08-24");
    expect(agg.buckets).toHaveLength(2);
    expect(agg.accountClassCTotal).toBe(1600);
    expect(agg.accountDownloadedGb).toBeCloseTo(2.7);
  });

  it("returns unconfigured payload without credentials", async () => {
    const prev = { ...process.env };
    delete process.env.BACKBLAZE_APPLICATION_KEY_ID;
    delete process.env.BACKBLAZE_APPLICATION_KEY;
    delete process.env.B2_MONITOR_KEY_ID;
    delete process.env.B2_APPLICATION_KEY;

    const payload = await fetchB2AppUsageBreakdown();
    expect(payload.configured).toBe(false);
    expect(payload.apps).toEqual([]);
    process.env = prev;
  });
});

// aggregateReportRows is not exported - fix test
