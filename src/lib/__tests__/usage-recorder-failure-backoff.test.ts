import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Wave C7: consecutive poll failures apply cross-tick exponential backoff
// (15m → 30m → … cap 2h). Success and UNSUPPORTED clear the backoff.
// AdapterError must be imported AFTER vi.resetModules() so instanceof matches
// the usage-recorder module graph.

const findMany = vi.fn();
const snapshotGroupBy = vi.fn();
const snapshotFindMany = vi.fn();
const queryRaw = vi.fn();
const create = vi.fn();
const fetchProviderUsage = vi.fn();
const bootstrapStGeminiCredentialToInfisical = vi.fn();
const syncProviderCredentialsFromInfisical = vi.fn();
const ensureSimpleToolsProviderSeeded = vi.fn();
const ensureRoicProviderSeeded = vi.fn();
const ensureCloudflareFleetProvidersSeeded = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    provider: { findMany: () => findMany(), create: vi.fn() },
    usageSnapshot: {
      create: (args: unknown) => create(args),
      groupBy: (args: unknown) => snapshotGroupBy(args),
      findMany: (args: unknown) => snapshotFindMany(args),
    },
    $queryRaw: (args: unknown) => queryRaw(args),
    $transaction: (run: (tx: unknown) => unknown) =>
      run({ usageSnapshot: { create: (args: unknown) => create(args) } }),
  },
}));

vi.mock("@/lib/adapters", () => ({
  fetchProviderUsage: (provider: unknown) => fetchProviderUsage(provider),
}));

vi.mock("@/lib/ensure-simple-tools-provider", () => ({
  ensureSimpleToolsProviderSeeded: () => ensureSimpleToolsProviderSeeded(),
}));

vi.mock("@/lib/ensure-roic-provider", () => ({
  ensureRoicProviderSeeded: () => ensureRoicProviderSeeded(),
}));

vi.mock("@/lib/ensure-cloudflare-fleet-providers", () => ({
  ensureCloudflareFleetProvidersSeeded: () =>
    ensureCloudflareFleetProvidersSeeded(),
}));

vi.mock("@/lib/infisical-provider-sync", () => ({
  bootstrapStGeminiCredentialToInfisical: () =>
    bootstrapStGeminiCredentialToInfisical(),
  syncProviderCredentialsFromInfisical: (options: unknown) =>
    syncProviderCredentialsFromInfisical(options),
}));

function providerRow(name: string) {
  return {
    id: `id-${name}`,
    name,
    refreshIntervalMin: 60,
    budgetControlsEnabled: false,
    budgetPausedAt: null,
    snapshots: [],
  };
}

const OK_USAGE = {
  balance: 1,
  totalCost: null,
  totalRequests: null,
  credits: null,
  rawData: {},
};

function stubBootstrapMocks() {
  ensureSimpleToolsProviderSeeded.mockResolvedValue(undefined);
  ensureRoicProviderSeeded.mockResolvedValue(undefined);
  ensureCloudflareFleetProvidersSeeded.mockResolvedValue(undefined);
  bootstrapStGeminiCredentialToInfisical.mockResolvedValue({
    enabled: false,
    attempted: false,
    providerId: "4a888d41-3988-4774-86d8-67d7aa14d7e2",
    status: "disabled",
  });
  syncProviderCredentialsFromInfisical.mockResolvedValue({
    enabled: true,
    configured: false,
    sources: [],
    created: 0,
    updated: 0,
    unchanged: 0,
    missing: 0,
    failed: 0,
    suppressed: 0,
  });
  snapshotGroupBy.mockResolvedValue([]);
  snapshotFindMany.mockResolvedValue([]);
  queryRaw.mockResolvedValue([]);
  create.mockResolvedValue({ id: "snap" });
}
describe("fetchAllDueProviders failure backoff (C7)", () => {
  beforeEach(() => {
    vi.resetModules();
    findMany.mockReset();
    snapshotGroupBy.mockReset();
    snapshotFindMany.mockReset();
    queryRaw.mockReset();
    create.mockReset();
    fetchProviderUsage.mockReset();
    ensureSimpleToolsProviderSeeded.mockReset();
    ensureRoicProviderSeeded.mockReset();
    ensureCloudflareFleetProvidersSeeded.mockReset();
    bootstrapStGeminiCredentialToInfisical.mockReset();
    syncProviderCredentialsFromInfisical.mockReset();
    stubBootstrapMocks();
    delete process.env.BUDGET_AUTO_CONTROLS_ENABLED;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips a provider still inside failure backoff after a failed poll", async () => {
    findMany.mockResolvedValue([providerRow("flaky")]);
    const { AdapterError } = await import("@/lib/adapters/helpers");
    fetchProviderUsage.mockRejectedValue(
      new AdapterError("upstream 429", {
        code: "HTTP_ERROR",
        retryable: true,
        status: 429,
      })
    );

    const { fetchAllDueProviders } = await import("@/lib/usage-recorder");

    const first = await fetchAllDueProviders();
    expect(first.failures).toBe(1);
    expect(fetchProviderUsage).toHaveBeenCalledTimes(1);

    fetchProviderUsage.mockClear();
    const second = await fetchAllDueProviders();
    expect(second.skipped).toBe(1);
    expect(second.failures).toBe(0);
    expect(fetchProviderUsage).not.toHaveBeenCalled();
  });

  it("clears backoff after a successful poll so the next tick runs again", async () => {
    findMany.mockResolvedValue([providerRow("recover")]);
    const { AdapterError } = await import("@/lib/adapters/helpers");
    fetchProviderUsage
      .mockRejectedValueOnce(
        new AdapterError("timeout", { code: "TIMEOUT", retryable: true })
      )
      .mockResolvedValue(OK_USAGE);

    const { fetchAllDueProviders } = await import("@/lib/usage-recorder");

    expect((await fetchAllDueProviders()).failures).toBe(1);

    // Force backoff to expire by advancing time past the first 15m window.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);

    const recovered = await fetchAllDueProviders();
    expect(recovered.successes).toBe(1);
    expect(fetchProviderUsage).toHaveBeenCalledTimes(2);

    // Immediate next tick should not be skipped (success cleared backoff).
    fetchProviderUsage.mockClear();
    // Still "due" because refreshInterval is 60m and we only advanced 16m —
    // but no failure backoff, so interval gate still applies. Advance past interval.
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    // Provide a recent poll snapshot so interval skip would apply unless we
    // leave snapshots empty (providerRow uses empty snapshots).
    findMany.mockResolvedValue([providerRow("recover")]);
    const again = await fetchAllDueProviders();
    expect(fetchProviderUsage).toHaveBeenCalledTimes(1);
    expect(again.successes).toBe(1);
  });

  it("does not backoff UNSUPPORTED push-only adapters", async () => {
    findMany.mockResolvedValue([providerRow("blind")]);
    const { AdapterError } = await import("@/lib/adapters/helpers");
    fetchProviderUsage.mockRejectedValue(
      new AdapterError("no poll API", { code: "UNSUPPORTED", retryable: false })
    );

    const { fetchAllDueProviders } = await import("@/lib/usage-recorder");

    expect((await fetchAllDueProviders()).skipped).toBe(1);
    fetchProviderUsage.mockClear();
    // Second tick still invokes the adapter (UNSUPPORTED is not a failure streak).
    expect((await fetchAllDueProviders()).skipped).toBe(1);
    expect(fetchProviderUsage).toHaveBeenCalledTimes(1);
  });
});
