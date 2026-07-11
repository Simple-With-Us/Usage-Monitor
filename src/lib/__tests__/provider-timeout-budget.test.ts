import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Verifies that fetchAllDueProviders enforces a per-provider time budget: a
// single hung provider is counted as a failure (with a "timed out after Nms"
// error) and the sequential loop continues to the next provider instead of
// stalling the whole poll pass.
//
// prisma and the adapter layer are mocked so no DB or network is touched, and
// the per-provider timeout is driven with Vitest fake timers so nothing waits
// the real 90s budget.

const findMany = vi.fn();
const create = vi.fn();
const fetchProviderUsage = vi.fn();
const runUsageMaintenance = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    provider: { findMany: () => findMany(), create: vi.fn() },
    usageSnapshot: { create: (args: unknown) => create(args) },
    $transaction: (run: (tx: unknown) => unknown) =>
      run({ usageSnapshot: { create: (args: unknown) => create(args) } }),
  },
}));

vi.mock("@/lib/adapters", () => ({
  fetchProviderUsage: (provider: unknown) => fetchProviderUsage(provider),
}));

vi.mock("@/lib/usage-maintenance", () => ({
  runUsageMaintenance: () => runUsageMaintenance(),
}));

function providerRow(name: string) {
  return {
    id: `id-${name}`,
    name,
    refreshIntervalMin: 60,
    // no prior snapshots => always "due"
    snapshots: [],
  };
}

describe("fetchAllDueProviders per-provider timeout budget", () => {
  beforeEach(() => {
    vi.resetModules();
    findMany.mockReset();
    create.mockReset();
    fetchProviderUsage.mockReset();
    runUsageMaintenance.mockReset();
    process.env.ADAPTER_PROVIDER_TIMEOUT_MS = "5000";
    create.mockResolvedValue({ id: "snap" });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ADAPTER_PROVIDER_TIMEOUT_MS;
  });

  it("counts a hung provider as a timeout failure and still processes the others", async () => {
    vi.useFakeTimers();
    findMany.mockResolvedValue([providerRow("fast"), providerRow("hung")]);

    // "fast" resolves immediately; "hung" never resolves so the 5s budget wins.
    fetchProviderUsage.mockImplementation((provider: { name: string }) => {
      if (provider.name === "hung") {
        return new Promise(() => {
          /* never resolves */
        });
      }
      return Promise.resolve({
        balance: 1,
        totalCost: null,
        totalRequests: null,
        credits: null,
        rawData: {},
      });
    });

    const { fetchAllDueProviders } = await import("@/lib/usage-recorder");
    const promise = fetchAllDueProviders();
    // Let the "fast" provider settle, then blow past the 5s budget for "hung".
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result.total).toBe(2);
    expect(result.successes).toBe(1);
    expect(result.failures).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].name).toBe("hung");
    expect(result.errors[0].error).toBe("Provider hung timed out after 5000ms");
    expect(result.errors[0]).toMatchObject({
      code: "TIMEOUT",
      status: null,
      retryable: true,
    });
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      "success",
      "failure",
    ]);
  });
});
