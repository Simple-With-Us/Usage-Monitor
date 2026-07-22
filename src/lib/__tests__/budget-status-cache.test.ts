import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { setupPrismaSqliteTestDb } from "./setup-test-db";

// Covers the stale-while-revalidate cache wrapped around computeBudgetStatus
// and computeProjectBudgetStatus (see the "Stale-while-revalidate cache for
// computeBudgetStatus and computeProjectBudgetStatus" block in
// ../budget-status.ts, and the shared createStaleWhileRevalidateCache helper
// it's built on). That cache exists because computeBudgetStatus's
// sumMonthToDateExternalCostByProvider call - and computeProjectBudgetStatus's
// own, separate sumMonthToDateExternalCostAttribution call - were each
// measured at ~11.4s in production - effectively all of GET /api/providers's
// AND GET /api/projects's / GET /api/budget-status's latency - because they
// live-group the ENTIRE current month of raw ExternalUsageEvent rows on
// every call. These tests prove each cache serves a memoized instance within
// TTL, refreshes in the background once stale without ever blocking the
// caller on the slow recompute, busts at a UTC month boundary (including
// when that rollover races an in-flight refresh for the prior month), dedupes
// concurrent cold callers onto a single compute, and never lets a failed
// background refresh either crash the process or evict a good cached value -
// all without changing what a fresh compute would itself produce (the money
// math is untouched; only each function's output is memoized).
//
// Both caches are disabled by default under `vitest run` (see `enabled()` in
// createStaleWhileRevalidateCache) so the rest of the suite - which calls
// computeBudgetStatus/computeProjectBudgetStatus repeatedly with a fixed
// `now` across many distinct DB fixtures in the same file - keeps getting a
// fresh compute every time, exactly as before this change.
// __setBudgetStatusCacheOverrideForTests(true) /
// __setProjectBudgetStatusCacheOverrideForTests(true) below force them on
// for this file only.
let prisma: typeof import("@/lib/prisma").prisma;
let computeBudgetStatus: typeof import("../budget-status").computeBudgetStatus;
let computeProjectBudgetStatus: typeof import("../budget-status").computeProjectBudgetStatus;
let __setBudgetStatusCacheOverrideForTests: typeof import("../budget-status").__setBudgetStatusCacheOverrideForTests;
let __resetBudgetStatusCacheForTests: typeof import("../budget-status").__resetBudgetStatusCacheForTests;
let __setProjectBudgetStatusCacheOverrideForTests: typeof import("../budget-status").__setProjectBudgetStatusCacheOverrideForTests;
let __resetProjectBudgetStatusCacheForTests: typeof import("../budget-status").__resetProjectBudgetStatusCacheForTests;
let budgetStatusCacheTtlMs: typeof import("../budget-status").budgetStatusCacheTtlMs;
let bustBudgetStatusCache: typeof import("../budget-status").bustBudgetStatusCache;
let markBudgetStatusSoftStale: typeof import("../budget-status").markBudgetStatusSoftStale;

let testDir: string;

async function waitUntil(
  predicate: () => Promise<boolean>,
  { timeoutMs = 3000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error("waitUntil: condition not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

beforeAll(async () => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-status-cache-test-"));
  const dbPath = path.join(testDir, "test.db");
  process.env.DATABASE_URL = `file:${dbPath}`;
  setupPrismaSqliteTestDb(dbPath);

  ({ prisma } = await import("@/lib/prisma"));
  ({
    computeBudgetStatus,
    computeProjectBudgetStatus,
    __setBudgetStatusCacheOverrideForTests,
    __resetBudgetStatusCacheForTests,
    __setProjectBudgetStatusCacheOverrideForTests,
    __resetProjectBudgetStatusCacheForTests,
    budgetStatusCacheTtlMs,
    bustBudgetStatusCache,
    markBudgetStatusSoftStale,
  } = await import("../budget-status"));
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { clearMtdScanMemo } = await import("../mtd-scan-memo");
  clearMtdScanMemo();
  await prisma.provider.deleteMany();
  __setBudgetStatusCacheOverrideForTests(true);
  __resetBudgetStatusCacheForTests();
  __setProjectBudgetStatusCacheOverrideForTests(true);
  __resetProjectBudgetStatusCacheForTests();
  delete process.env.BUDGET_STATUS_CACHE_TTL_MS;
});

afterEach(() => {
  vi.restoreAllMocks();
  __setBudgetStatusCacheOverrideForTests(null);
  __resetBudgetStatusCacheForTests();
  __setProjectBudgetStatusCacheOverrideForTests(null);
  __resetProjectBudgetStatusCacheForTests();
  delete process.env.BUDGET_STATUS_CACHE_TTL_MS;
});

async function createProviderWithCost(name: string, totalCost: number, fetchedAt: Date) {
  return prisma.provider.create({
    data: {
      name,
      displayName: name,
      type: "builtin",
      refreshIntervalMin: 60,
      snapshots: { create: { fetchedAt, totalCost } },
    },
  });
}

describe("computeBudgetStatus stale-while-revalidate cache", () => {
  it("returns the exact cached instance within TTL, without reflecting a DB change made since", async () => {
    const NOW = new Date("2026-03-10T12:00:00.000Z");
    const provider = await createProviderWithCost(
      "cache-ttl-provider",
      5,
      new Date("2026-03-10T10:00:00.000Z")
    );

    const first = await computeBudgetStatus(NOW);
    expect(first.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(5);

    // A fresh compute would see this; a cache hit must not.
    await prisma.usageSnapshot.updateMany({
      where: { providerId: provider.id },
      data: { totalCost: 999 },
    });

    const second = await computeBudgetStatus(NOW);
    expect(second).toBe(first);
    expect(second.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(5);
  });

  it("serves the stale value immediately past TTL, then refreshes in the background", async () => {
    process.env.BUDGET_STATUS_CACHE_TTL_MS = "10";
    // Each test in this file uses a distinct UTC month for `now`. The TTL
    // here is deliberately shorter than this test's own poll interval, so
    // waitUntil's repeated cache hits keep re-triggering "stale" background
    // refreshes for a bit after the assertions below are satisfied. Giving
    // every test its own month means any such dangling refresh can only ever
    // write back to THIS test's cache key, never bleed into another test's
    // expectations - regardless of exactly when it lands.
    const NOW = new Date("2026-04-10T12:00:00.000Z");
    const provider = await createProviderWithCost(
      "cache-refresh-provider",
      5,
      new Date("2026-04-10T10:00:00.000Z")
    );

    const first = await computeBudgetStatus(NOW);
    expect(first.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(5);

    await prisma.usageSnapshot.updateMany({
      where: { providerId: provider.id },
      data: { totalCost: 42 },
    });

    // Past the 10ms TTL: the entry is now stale.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const stale = await computeBudgetStatus(NOW);
    // SWR contract: still the OLD cached instance, returned immediately -
    // this call never blocks on the recompute.
    expect(stale).toBe(first);
    expect(stale.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(5);

    // The stale hit above kicked off a background refresh; once it lands,
    // a later call picks up the new value without any caller having waited
    // on the recompute directly.
    await waitUntil(async () => {
      const probe = await computeBudgetStatus(NOW);
      return probe.providers.find((p) => p.id === provider.id)?.spentUsd === 42;
    });

    const refreshed = await computeBudgetStatus(NOW);
    expect(refreshed).not.toBe(first);
    expect(refreshed.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(42);
  });

  it("busts the cache at a UTC month boundary instead of serving the prior month's numbers", async () => {
    const provider = await createProviderWithCost(
      "cache-month-boundary-provider",
      7,
      new Date("2026-06-15T00:00:00.000Z")
    );

    const june = await computeBudgetStatus(new Date("2026-06-30T23:59:59.000Z"));
    expect(june.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(7);

    const july = await computeBudgetStatus(new Date("2026-07-01T00:00:01.000Z"));
    expect(july).not.toBe(june);
    // The June snapshot falls outside July's month window - a different
    // (lower) number proves this genuinely recomputed rather than reusing
    // June's cache entry under a stale key.
    expect(july.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(0);
  });

  it("keeps serving the last good value when a background refresh fails, and recovers on the next one", async () => {
    process.env.BUDGET_STATUS_CACHE_TTL_MS = "10";
    // Distinct month (see the comment in the previous test) so a dangling
    // background refresh from this test's own tight poll loop can never be
    // mistaken by a later test for that later test's cold-start cache entry.
    const NOW = new Date("2026-05-10T12:00:00.000Z");
    const provider = await createProviderWithCost(
      "cache-error-provider",
      5,
      new Date("2026-05-10T10:00:00.000Z")
    );

    const first = await computeBudgetStatus(NOW);
    expect(first.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(5);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(prisma.provider, "findMany").mockRejectedValueOnce(
      new Error("simulated background refresh failure")
    );

    await new Promise((resolve) => setTimeout(resolve, 30)); // past TTL

    const duringFailedRefresh = await computeBudgetStatus(NOW);
    expect(duringFailedRefresh).toBe(first);
    expect(duringFailedRefresh.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(5);

    // Let the failed background refresh settle (it must not reject
    // unhandled, and must not crash/hang the module).
    await waitUntil(async () => warnSpy.mock.calls.length > 0);
    expect(warnSpy).toHaveBeenCalledWith(
      "[budget-status-cache] refresh failed; serving last good value if available",
      expect.any(Error)
    );

    // A subsequent (non-mocked) refresh succeeds and replaces the cache.
    await prisma.usageSnapshot.updateMany({
      where: { providerId: provider.id },
      data: { totalCost: 9 },
    });
    await new Promise((resolve) => setTimeout(resolve, 30)); // past TTL again
    await waitUntil(async () => {
      const probe = await computeBudgetStatus(NOW);
      return probe.providers.find((p) => p.id === provider.id)?.spentUsd === 9;
    });
  });

  it("propagates the error on a cold cache instead of silently swallowing it", async () => {
    // Distinct month, same reasoning as above.
    const NOW = new Date("2026-08-10T12:00:00.000Z");
    await createProviderWithCost(
      "cache-coldstart-provider",
      5,
      new Date("2026-08-10T10:00:00.000Z")
    );

    vi.spyOn(prisma.provider, "findMany").mockRejectedValueOnce(
      new Error("simulated cold-start failure")
    );

    await expect(computeBudgetStatus(NOW)).rejects.toThrow("simulated cold-start failure");
  });

  it("dedupes concurrent cold callers onto a single underlying compute and the same cached instance", async () => {
    // Distinct month, same reasoning as above.
    const NOW = new Date("2026-02-10T12:00:00.000Z");
    const provider = await createProviderWithCost(
      "cache-dedup-provider",
      6,
      new Date("2026-02-10T10:00:00.000Z")
    );

    const findManySpy = vi.spyOn(prisma.provider, "findMany");

    // Two concurrent cold callers for the same key must share ONE in-flight
    // compute rather than each kicking off their own ~11s query.
    const [first, second] = await Promise.all([
      computeBudgetStatus(NOW),
      computeBudgetStatus(NOW),
    ]);

    expect(findManySpy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(6);
  });

  it("returns the requested month's own data - never an in-flight prior month's - when a rollover request lands mid-refresh", async () => {
    // Regression test for the cross-key piggyback bug: the in-flight refresh
    // promise used to be a single unkeyed module-level slot, so a request for
    // month N+1 landing while month N's refresh was still in flight could
    // await N's promise and come back with N's (mislabeled) data for as long
    // as that compute took.
    const NOW_N = new Date("2026-09-15T12:00:00.000Z");
    const NOW_N1 = new Date("2026-10-01T00:00:00.500Z");
    const providerN = await createProviderWithCost(
      "cross-key-n-provider",
      11,
      new Date("2026-09-15T10:00:00.000Z")
    );

    // Kick off (but do not await) a cold compute for month N - its refresh
    // promise is left in flight.
    const pendingN = computeBudgetStatus(NOW_N);

    // While N's refresh is still in flight, a request for month N+1 lands.
    // It must start its own fresh compute instead of piggybacking on N's
    // in-flight promise, and must return ITS OWN month's data.
    const resultN1 = await computeBudgetStatus(NOW_N1);
    expect(resultN1.month).toBe("2026-10");
    expect(resultN1.providers.find((p) => p.id === providerN.id)?.spentUsd).toBe(0);

    // N's own request must still resolve to N's data, never N+1's.
    const resultN = await pendingN;
    expect(resultN.month).toBe("2026-09");
    expect(resultN.providers.find((p) => p.id === providerN.id)?.spentUsd).toBe(11);
  });
});

describe("budgetStatusCacheTtlMs", () => {
  afterEach(() => {
    delete process.env.BUDGET_STATUS_CACHE_TTL_MS;
  });

  it("defaults to 60s when unset", () => {
    delete process.env.BUDGET_STATUS_CACHE_TTL_MS;
    expect(budgetStatusCacheTtlMs()).toBe(60_000);
  });

  it("defaults to 60s for an empty string instead of parsing Number('') as 0", () => {
    process.env.BUDGET_STATUS_CACHE_TTL_MS = "";
    expect(budgetStatusCacheTtlMs()).toBe(60_000);
  });

  it("defaults to 60s for a whitespace-only value instead of parsing Number('   ') as 0", () => {
    process.env.BUDGET_STATUS_CACHE_TTL_MS = "   ";
    expect(budgetStatusCacheTtlMs()).toBe(60_000);
  });

  it("honors an explicit numeric override", () => {
    process.env.BUDGET_STATUS_CACHE_TTL_MS = "5000";
    expect(budgetStatusCacheTtlMs()).toBe(5000);
  });

  it("falls back to 60s for a negative or non-numeric override", () => {
    process.env.BUDGET_STATUS_CACHE_TTL_MS = "-5";
    expect(budgetStatusCacheTtlMs()).toBe(60_000);

    process.env.BUDGET_STATUS_CACHE_TTL_MS = "not-a-number";
    expect(budgetStatusCacheTtlMs()).toBe(60_000);
  });
});

describe("computeProjectBudgetStatus stale-while-revalidate cache", () => {
  it("serializes stale provider and project external-cost refreshes without blocking stale callers", async () => {
    const NOW = new Date("2027-03-10T12:00:00.000Z");
    await createProviderWithCost(
      "stale-overlap-provider",
      17,
      new Date("2027-03-10T10:00:00.000Z")
    );

    // Prime both caches while they are fresh. The project compute also primes
    // the nested provider cache; capture each exact cached object so the stale
    // calls below can prove they remain immediate SWR hits.
    process.env.BUDGET_STATUS_CACHE_TTL_MS = "60000";
    const firstProject = await computeProjectBudgetStatus(NOW);
    const firstProvider = await computeBudgetStatus(NOW);

    let releaseMtdScan!: (rows: never[]) => void;
    const blockedMtdScan = new Promise<never[]>((resolve) => {
      releaseMtdScan = resolve;
    });
    const originalGroupBy = prisma.externalUsageEvent.groupBy.bind(
      prisma.externalUsageEvent
    );
    const groupBySpy = vi.spyOn(prisma.externalUsageEvent, "groupBy");
    let mtdScanBlocked = false;
    // Wave H / E1: provider + attribution share one groupBy that always
    // includes projectId. Block the first such heavy scan only.
    groupBySpy.mockImplementation((args) => {
      const by = Array.isArray(args.by) ? args.by : [];
      if (
        !mtdScanBlocked &&
        by.includes("provider") &&
        by.includes("projectId")
      ) {
        mtdScanBlocked = true;
        return blockedMtdScan as never;
      }
      return originalGroupBy(args as never) as never;
    });
    const heavyAggregationCallCount = () =>
      groupBySpy.mock.calls.filter(([args]) => {
        const by = Array.isArray(args.by) ? args.by : [];
        return by.includes("provider") && by.includes("projectId");
      }).length;

    // Drop the Wave H MTD scan memo so the background refresh must re-scan
    // (otherwise the 5s memo from the warm prime would skip groupBy entirely).
    const { clearMtdScanMemo } = await import("../mtd-scan-memo");
    clearMtdScanMemo();

    // Make both entries stale. The provider call returns its cached object and
    // starts a background refresh whose heavy groupBy is deliberately held.
    process.env.BUDGET_STATUS_CACHE_TTL_MS = "0";
    const staleProvider = await computeBudgetStatus(NOW);
    expect(staleProvider).toBe(firstProvider);
    await waitUntil(async () => heavyAggregationCallCount() === 1);

    // The stale project call must also return immediately. Its background
    // refresh reaches the shared MTD scan, but the exclusive lease keeps it
    // behind the still-held first scan (and the 5s memo means it will not
    // open a second groupBy once the first completes).
    const staleProject = await computeProjectBudgetStatus(NOW);
    expect(staleProject).toBe(firstProject);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heavyAggregationCallCount()).toBe(1);

    // Stop further zero-TTL refreshes, release the blocked scan. Under vitest
    // the process memo is disabled, so the queued project refresh pays a
    // second groupBy after the lease releases (still serialized, never
    // concurrent). Production keeps the 5s memo so cold provider+project
    // only scan once.
    process.env.BUDGET_STATUS_CACHE_TTL_MS = "60000";
    releaseMtdScan([]);
    await waitUntil(async () => heavyAggregationCallCount() === 2);
    await waitUntil(async () =>
      (await computeProjectBudgetStatus(NOW)) !== firstProject
    );
  });

  it("dedupes concurrent cold callers onto a single underlying compute and the same cached instance", async () => {
    const NOW = new Date("2026-11-10T12:00:00.000Z");
    const provider = await createProviderWithCost(
      "project-cache-dedup-provider",
      9,
      new Date("2026-11-10T10:00:00.000Z")
    );

    // prisma.project.findMany is only ever called from
    // computeProjectBudgetStatusUncached, never from computeBudgetStatus, so
    // this isolates the PROJECT cache's own dedup from the nested (already
    // separately tested) budget-status cache.
    const findManySpy = vi.spyOn(prisma.project, "findMany");

    const [first, second] = await Promise.all([
      computeProjectBudgetStatus(NOW),
      computeProjectBudgetStatus(NOW),
    ]);

    expect(findManySpy).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(9);
  });

  it("returns the requested month's own data - never an in-flight prior month's - when a rollover request lands mid-refresh", async () => {
    const NOW_N = new Date("2026-12-15T12:00:00.000Z");
    const NOW_N1 = new Date("2027-01-01T00:00:00.500Z");
    const provider = await createProviderWithCost(
      "project-cross-key-provider",
      13,
      new Date("2026-12-15T10:00:00.000Z")
    );

    const pendingN = computeProjectBudgetStatus(NOW_N);

    const resultN1 = await computeProjectBudgetStatus(NOW_N1);
    expect(resultN1.month).toBe("2027-01");
    expect(resultN1.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(0);

    const resultN = await pendingN;
    expect(resultN.month).toBe("2026-12");
    expect(resultN.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(13);
  });

  it("keeps serving the last good project value when a background refresh fails, and recovers on the next one", async () => {
    process.env.BUDGET_STATUS_CACHE_TTL_MS = "10";
    const NOW = new Date("2027-02-10T12:00:00.000Z");
    const provider = await createProviderWithCost(
      "project-cache-error-provider",
      5,
      new Date("2027-02-10T10:00:00.000Z")
    );

    const first = await computeProjectBudgetStatus(NOW);
    expect(first.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(5);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(prisma.project, "findMany").mockRejectedValueOnce(
      new Error("simulated project background refresh failure")
    );

    await new Promise((resolve) => setTimeout(resolve, 30)); // past TTL

    const duringFailedRefresh = await computeProjectBudgetStatus(NOW);
    expect(duringFailedRefresh).toBe(first);
    expect(duringFailedRefresh.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(5);

    // Let the failed background refresh settle (it must not reject
    // unhandled, and must not crash/hang the module).
    await waitUntil(async () => warnSpy.mock.calls.length > 0);
    expect(warnSpy).toHaveBeenCalledWith(
      "[project-budget-status-cache] refresh failed; serving last good value if available",
      expect.any(Error)
    );

    // A subsequent (non-mocked) refresh succeeds and replaces the cache.
    await prisma.usageSnapshot.updateMany({
      where: { providerId: provider.id },
      data: { totalCost: 9 },
    });
    await waitUntil(async () => {
      const probe = await computeProjectBudgetStatus(NOW);
      return probe.providers.find((p) => p.id === provider.id)?.spentUsd === 9;
    });
  });

  describe("markBudgetStatusSoftStale", () => {
    it("serves last-good immediately then background-refreshes (Wave F / E7)", async () => {
      // Soft-stale must NOT drop the entry the way hard bust does — ingest
      // callers need last-good without waiting on the ~11s recompute.
      const NOW = new Date("2026-12-10T12:00:00.000Z");
      const provider = await createProviderWithCost(
        "soft-stale-test-provider",
        15,
        new Date("2026-12-10T10:00:00.000Z")
      );

      const first = await computeBudgetStatus(NOW);
      expect(first.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(15);

      await prisma.usageSnapshot.updateMany({
        where: { providerId: provider.id },
        data: { totalCost: 42 },
      });

      // Still inside TTL — without soft-stale, cache would keep 15 forever
      // until TTL expires. Soft-stale forces a background refresh while still
      // returning the last-good instance immediately.
      markBudgetStatusSoftStale();

      const afterSoft = await computeBudgetStatus(NOW);
      expect(afterSoft).toBe(first);
      expect(afterSoft.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(15);

      await waitUntil(async () => {
        const probe = await computeBudgetStatus(NOW);
        return probe.providers.find((p) => p.id === provider.id)?.spentUsd === 42;
      });

      const refreshed = await computeBudgetStatus(NOW);
      expect(refreshed).not.toBe(first);
      expect(refreshed.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(42);
    });
  });

  describe("bustBudgetStatusCache", () => {
    it("should invalidate computeBudgetStatus and computeProjectBudgetStatus caches", async () => {
      const NOW = new Date("2026-11-10T12:00:00.000Z");
      const provider = await createProviderWithCost(
        "bust-cache-test-provider",
        15,
        new Date("2026-11-10T10:00:00.000Z")
      );

      // Warm up both caches
      const firstBudget = await computeBudgetStatus(NOW);
      const firstProject = await computeProjectBudgetStatus(NOW);

      expect(firstBudget.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(15);
      expect(firstProject.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(15);

      // Directly update the DB without waiting for TTL
      await prisma.usageSnapshot.updateMany({
        where: { providerId: provider.id },
        data: { totalCost: 35 },
      });

      // Assert that cache still returns stale values (15) because it hasn't expired yet
      const secondBudget = await computeBudgetStatus(NOW);
      const secondProject = await computeProjectBudgetStatus(NOW);
      expect(secondBudget.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(15);
      expect(secondProject.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(15);

      // Now bust the cache!
      bustBudgetStatusCache();

      // Assert that fresh call returns updated values (35) immediately
      const thirdBudget = await computeBudgetStatus(NOW);
      const thirdProject = await computeProjectBudgetStatus(NOW);
      expect(thirdBudget.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(35);
      expect(thirdProject.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(35);
    });

    it("discards a refresh that started before the bust instead of letting it repopulate the cache", async () => {
      // Regression test for the "invalidation loses to an in-flight refresh"
      // bug. Ownership of the in-flight slot used to be keyed ONLY on the
      // month-start string, which a bust does not change - so a refresh that
      // began before the mutation could still see `refreshKey === key` at
      // completion (because a post-bust caller had re-claimed the slot for the
      // same month), write its PRE-mutation snapshot into the freshly-busted
      // cache, and clear the slot out from under the post-bust refresh - whose
      // own correct result was then discarded. Net effect for the owner: the
      // project they just deleted reappeared, and stayed for another full TTL.
      const NOW = new Date("2027-05-10T12:00:00.000Z");
      process.env.BUDGET_STATUS_CACHE_TTL_MS = "60000";
      const provider = await createProviderWithCost(
        "bust-vs-inflight-provider",
        15,
        new Date("2027-05-10T10:00:00.000Z")
      );

      // Warm the cache with the pre-mutation value.
      const warm = await computeBudgetStatus(NOW);
      expect(warm.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(15);

      // Gate usageSnapshot.findMany - the `latestCostSnapshots` read that
      // actually feeds spentUsd, and the last read of it in the compute.
      // Call 0 = the pre-bust background refresh, call 1 = the post-bust one.
      // Each compute is parked AFTER its read resolves, so the pre-bust
      // refresh genuinely holds a PRE-mutation view; parking before the read
      // would let it pick the post-mutation value up on release and hide the
      // bug entirely.
      const originalFindMany = prisma.usageSnapshot.findMany.bind(prisma.usageSnapshot);
      const gates: Array<() => void> = [];
      const gateFor = (index: number) =>
        new Promise<void>((resolve) => {
          gates[index] = resolve;
        });
      const preBustGate = gateFor(0);
      const postBustGate = gateFor(1);
      let findManyCalls = 0;
      // Counted AFTER the read resolves, so the test can sequence the mutation
      // strictly after the pre-bust refresh has already read the old rows.
      // Counting only at call entry would leave that a real race.
      let findManyReads = 0;
      vi.spyOn(prisma.usageSnapshot, "findMany").mockImplementation((async (args: never) => {
        const call = findManyCalls++;
        const rows = await originalFindMany(args);
        findManyReads++;
        if (call === 0) await preBustGate;
        if (call === 1) await postBustGate;
        return rows;
      }) as never);

      // Go stale -> the SWR hit returns 15 immediately and starts refresh R,
      // which is now parked inside usageSnapshot.findMany.
      process.env.BUDGET_STATUS_CACHE_TTL_MS = "0";
      expect(await computeBudgetStatus(NOW)).toBe(warm);
      await waitUntil(async () => findManyReads === 1);
      // Stop further staleness so no extra refreshes muddy the sequence.
      process.env.BUDGET_STATUS_CACHE_TTL_MS = "60000";

      // The mutation the owner just made, followed by its invalidation.
      await prisma.usageSnapshot.updateMany({
        where: { providerId: provider.id },
        data: { totalCost: 35 },
      });
      bustBudgetStatusCache();

      // A post-bust read lands (cold cache) and claims the in-flight slot for
      // the SAME month key. Its own compute R2 parks at the second gate.
      const postBustRead = computeBudgetStatus(NOW);
      await waitUntil(async () => findManyReads === 2);

      // R (pre-bust, pre-mutation) now completes while R2 still owns the slot.
      gates[0]();

      // Wait for R to land. Under the bug it repopulates the busted cache, so
      // a probe returns immediately; under the fix nothing is ever written and
      // the probe stays parked behind R2, so the race falls through to its
      // timeout. Either way we only proceed once R has had every chance to
      // write - which is what makes the buggy interleaving deterministic
      // rather than a matter of who wins a real race.
      const probeCacheEntry = () =>
        Promise.race([
          computeBudgetStatus(NOW).then(
            (r) => r.providers.find((p) => p.id === provider.id)?.spentUsd
          ),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 60)),
        ]);
      const probeDeadline = Date.now() + 500;
      while (Date.now() < probeDeadline) {
        if ((await probeCacheEntry()) !== undefined) break;
      }

      // R2 (post-bust, post-mutation) completes second.
      gates[1]();

      // The post-bust read must see its own post-mutation number, never the
      // pre-bust refresh's stale one.
      const result = await postBustRead;
      expect(result.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(35);

      // ...and the cache must be left holding the fresh value, so the next
      // reader isn't served the stale one for another full TTL.
      const next = await computeBudgetStatus(NOW);
      expect(next.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(35);
    });

    it("does not let a post-bust caller piggyback on a pre-bust in-flight compute", async () => {
      // Same root cause, cold-cache variant: a caller arriving after the bust
      // must start its own compute rather than awaiting an in-flight promise
      // whose DB reads predate the mutation.
      const NOW = new Date("2027-06-10T12:00:00.000Z");
      process.env.BUDGET_STATUS_CACHE_TTL_MS = "60000";
      const provider = await createProviderWithCost(
        "bust-vs-piggyback-provider",
        21,
        new Date("2027-06-10T10:00:00.000Z")
      );

      const originalFindMany = prisma.provider.findMany.bind(prisma.provider);
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let findManyCalls = 0;
      vi.spyOn(prisma.provider, "findMany").mockImplementation((async (args: never) => {
        if (findManyCalls++ === 0) await firstGate;
        return originalFindMany(args);
      }) as never);

      // Cold compute in flight, parked before it reads any rows.
      const pending = computeBudgetStatus(NOW);
      await waitUntil(async () => findManyCalls === 1);

      // Mutate + invalidate while that compute is still parked.
      await prisma.usageSnapshot.updateMany({
        where: { providerId: provider.id },
        data: { totalCost: 42 },
      });
      bustBudgetStatusCache();

      // Release the pre-bust compute and let it settle.
      releaseFirst();
      await pending.catch(() => {});

      // A read after the bust must reflect the mutation.
      const after = await computeBudgetStatus(NOW);
      expect(after.providers.find((p) => p.id === provider.id)?.spentUsd).toBe(42);
    });
  });
});
