import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";
import { SLOW_SCAN_TIMING_LOG_THRESHOLD_MS } from "../slow-scan-timing";

let dbPath: string;
let prisma: typeof import("@/lib/prisma").prisma;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slow-scan-wiring-"));
  dbPath = path.join(dir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.ENCRYPTION_KEY = "44".repeat(32);
  setupPrismaSqliteTestDb(dbPath);
  ({ prisma } = await import("@/lib/prisma"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (dbPath && fs.existsSync(dbPath)) {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

beforeEach(async () => {
  vi.restoreAllMocks();
  await prisma.externalUsageEventDailyRollup.deleteMany();
  await prisma.externalUsageEvent.deleteMany();
});

describe("slow-scan timing wiring", () => {
  it("logs MTD cold scan aggregates only when the groupBy path is slow", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const clock = vi.spyOn(performance, "now");
    const groupBy = vi.spyOn(prisma.externalUsageEvent, "groupBy").mockResolvedValue([]);

    const { sumMonthToDateExternalCostByProvider } = await import(
      "../external-usage-events"
    );
    const monthStart = new Date("2026-10-01T00:00:00.000Z");
    const rawCutoff = new Date("2026-10-20T00:00:00.000Z");
    const now = new Date("2026-10-27T12:00:00.000Z");

    let perfCalls = 0;
    clock.mockImplementation(() => {
      perfCalls += 1;
      if (perfCalls === 1) return 0;
      return SLOW_SCAN_TIMING_LOG_THRESHOLD_MS + 100;
    });

    const result = await sumMonthToDateExternalCostByProvider(monthStart, rawCutoff, now);

    expect(result).toBeInstanceOf(Map);
    expect(groupBy).toHaveBeenCalled();
    const mtdLog = info.mock.calls.find((call) => call[0] === "[external-events-mtd-scan]");
    expect(mtdLog).toBeDefined();
    const payload = JSON.parse(String(mtdLog![1]));
    expect(payload).toEqual({
      durationMs: SLOW_SCAN_TIMING_LOG_THRESHOLD_MS + 100,
      rawGroups: 0,
      rollupRows: 0,
    });

    clock.mockRestore();
    groupBy.mockRestore();
  });

  it("keeps deliverProviderAlerts silent on the injected-db path", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let tick = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      tick += 1;
      return tick * 5_000;
    });

    const budgetStatus = await import("../budget-status");
    const computeBudgetStatus = vi
      .spyOn(budgetStatus, "computeBudgetStatus")
      .mockRejectedValue(new Error("should not run with injected db"));

    const provider = await prisma.provider.create({
      data: {
        name: "wiring-test",
        displayName: "Wiring Test",
        type: "builtin",
        refreshIntervalMin: 60,
        plan: { create: { billingMode: "actual" } },
      },
    });

    const { deliverProviderAlerts } = await import("../alert-delivery");
    await deliverProviderAlerts({
      now: new Date("2026-10-27T12:00:00.000Z"),
      config: { channels: [], minSeverity: "info", reminderHours: 24 },
      fetchImpl: vi.fn(),
      db: prisma,
    });

    expect(computeBudgetStatus).not.toHaveBeenCalled();
    const budgetScanLogs = info.mock.calls.filter((call) =>
      String(call[0]).includes("budget-scan")
    );
    expect(budgetScanLogs).toHaveLength(0);
  });

  it("logs provider-budget-scan when computeBudgetStatus is slow on the production path", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let perfTick = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      perfTick += 1;
      return perfTick === 1 ? 0 : 1_800;
    });

    const budgetStatus = await import("../budget-status");
    vi.spyOn(budgetStatus, "computeBudgetStatus").mockResolvedValue({
      providers: [],
    } as unknown as Awaited<ReturnType<typeof budgetStatus.computeBudgetStatus>>);

    const { deliverProviderAlerts } = await import("../alert-delivery");
    await deliverProviderAlerts({
      now: new Date("2026-10-27T12:00:00.000Z"),
      config: { channels: [], minSeverity: "info", reminderHours: 24 },
      fetchImpl: vi.fn(),
    });

    const providerLog = info.mock.calls.find(
      (call) => call[0] === "[provider-budget-scan]"
    );
    expect(providerLog).toBeDefined();
    expect(JSON.parse(String(providerLog![1]))).toEqual({ durationMs: 1_800 });
  });
});
