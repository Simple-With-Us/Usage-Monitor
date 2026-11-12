import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Proves the scheduler-side wiring of the budget-breach control layer:
//   - with controls OFF the poll set is byte-identical (a pause-marked provider
//     is still polled),
//   - with controls ON an opted-in + paused provider is cleanly SKIPPED (never
//     fetched), exactly like an interval-gated skip,
//   - the skip requires BOTH the master flag AND the per-provider opt-in AND a
//     durable pause.
//
// prisma, the adapter layer, and the credential/seed helpers are mocked so no
// DB or network is touched — the test isolates the skip decision.

const findMany = vi.fn();
const snapshotGroupBy = vi.fn();
const snapshotFindMany = vi.fn();
const queryRaw = vi.fn();
const create = vi.fn();
const fetchProviderUsage = vi.fn();
const bootstrapStGeminiCredentialToInfisical = vi.fn();
const syncProviderCredentialsFromInfisical = vi.fn();
const ensureAg***S**cProviderSeeded = vi.fn();
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

vi.mock("@/lib/ensure-ag***-s**c-provider", () => ({
  ensureAg***S**cProviderSeeded: () => ensureAg***S**cProviderSeeded(),
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

function providerRow(
  name: string,
  control: { budgetControlsEnabled?: boolean; budgetPausedAt?: Date | null } = {}
) {
  return {
    id: `id-${name}`,
    name,
    refreshIntervalMin: 60,
    budgetControlsEnabled: control.budgetControlsEnabled ?? false,
    budgetPausedAt: control.budgetPausedAt ?? null,
    // no prior snapshots => always "due"
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

describe("fetchAllDueProviders budget-breach pause skip", () => {
  beforeEach(() => {
    vi.resetModules();
    findMany.mockReset();
    snapshotGroupBy.mockReset();
    snapshotGroupBy.mockResolvedValue([]);
    snapshotFindMany.mockReset();
    snapshotFindMany.mockResolvedValue([]);
    queryRaw.mockReset();
    queryRaw.mockResolvedValue([]);
    create.mockReset();
    create.mockResolvedValue({ id: "snap" });
    fetchProviderUsage.mockReset();
    fetchProviderUsage.mockResolvedValue(OK_USAGE);
    ensureAg***S**cProviderSeeded.mockReset();
    ensureAg***S**cProviderSeeded.mockResolvedValue(undefined);
    ensureRoicProviderSeeded.mockReset();
    ensureRoicProviderSeeded.mockResolvedValue(undefined);
    ensureCloudflareFleetProvidersSeeded.mockReset();
    ensureCloudflareFleetProvidersSeeded.mockResolvedValue(undefined);
    bootstrapStGeminiCredentialToInfisical.mockReset();
    bootstrapStGeminiCredentialToInfisical.mockResolvedValue({
      enabled: false,
      attempted: false,
      providerId: "4a888d41-3988-4774-86d8-67d7aa14d7e2",
      status: "disabled",
    });
    syncProviderCredentialsFromInfisical.mockReset();
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
    delete process.env.BUDGET_AUTO_CONTROLS_ENABLED;
  });

  afterEach(() => {
    delete process.env.BUDGET_AUTO_CONTROLS_ENABLED;
  });

  it("controls OFF: a pause-marked provider is still polled (byte-identical poll set)", async () => {
    findMany.mockResolvedValue([
      providerRow("normal"),
      providerRow("marked", {
        budgetControlsEnabled: true,
        budgetPausedAt: new Date(),
      }),
    ]);

    const { fetchAllDueProviders } = await import("@/lib/usage-recorder");
    const result = await fetchAllDueProviders();

    expect(fetchProviderUsage).toHaveBeenCalledTimes(2);
    expect(result.successes).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it("controls ON: an opted-in + paused provider is skipped and never fetched", async () => {
    process.env.BUDGET_AUTO_CONTROLS_ENABLED = "true";
    findMany.mockResolvedValue([
      providerRow("active"),
      providerRow("paused", {
        budgetControlsEnabled: true,
        budgetPausedAt: new Date(),
      }),
    ]);

    const { fetchAllDueProviders } = await import("@/lib/usage-recorder");
    const result = await fetchAllDueProviders();

    expect(fetchProviderUsage).toHaveBeenCalledTimes(1);
    expect(fetchProviderUsage).toHaveBeenCalledWith(
      expect.objectContaining({ name: "active" })
    );
    expect(result.successes).toBe(1);
    expect(result.skipped).toBe(1);
    const pausedOutcome = result.outcomes.find((o) => o.name === "paused");
    expect(pausedOutcome?.status).toBe("skipped");
  });

  it("controls ON: a paused provider that never opted in is still polled", async () => {
    process.env.BUDGET_AUTO_CONTROLS_ENABLED = "true";
    findMany.mockResolvedValue([
      providerRow("not-opted-in", {
        budgetControlsEnabled: false,
        budgetPausedAt: new Date(),
      }),
    ]);

    const { fetchAllDueProviders } = await import("@/lib/usage-recorder");
    const result = await fetchAllDueProviders();

    expect(fetchProviderUsage).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(0);
  });

  it("controls ON: an opted-in provider that is not paused is polled", async () => {
    process.env.BUDGET_AUTO_CONTROLS_ENABLED = "true";
    findMany.mockResolvedValue([
      providerRow("opted-not-paused", {
        budgetControlsEnabled: true,
        budgetPausedAt: null,
      }),
    ]);

    const { fetchAllDueProviders } = await import("@/lib/usage-recorder");
    const result = await fetchAllDueProviders();

    expect(fetchProviderUsage).toHaveBeenCalledTimes(1);
    expect(result.skipped).toBe(0);
  });
});
