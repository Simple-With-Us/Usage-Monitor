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
const findFirst = vi.fn();
const create = vi.fn();
const fetchProviderUsage = vi.fn();
const runUsageMaintenance = vi.fn();
const bootstrapStGeminiCredentialToInfisical = vi.fn();
const syncProviderCredentialsFromInfisical = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    provider: { findMany: () => findMany(), create: vi.fn() },
    usageSnapshot: {
      create: (args: unknown) => create(args),
      findFirst: (args: unknown) => findFirst(args),
    },
    $transaction: (run: (tx: unknown) => unknown) =>
      run({ usageSnapshot: { create: (args: unknown) => create(args) } }),
  },
}));

vi.mock("@/lib/adapters", () => ({
  fetchProviderUsage: (provider: unknown) => fetchProviderUsage(provider),
}));

vi.mock("@/lib/usage-maintenance", () => ({
  runUsageMaintenance: () => runUsageMaintenance(),
  isUsageMaintenanceHealthy: (result: {
    subscriptionAdoption: {
      degradedError: unknown;
      cloudflareLegacyHandoff: string;
    };
    alerts: { deferredError: unknown; persistenceDegraded: unknown[] };
  }) =>
    result.subscriptionAdoption.degradedError === null &&
    ["disabled", "handed_off", "already_managed"].includes(
      result.subscriptionAdoption.cloudflareLegacyHandoff
    ) &&
    result.alerts.deferredError === null &&
    result.alerts.persistenceDegraded.length === 0,
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
    // no prior snapshots => always "due"
    snapshots: [],
  };
}

// A minimal maintenance result that isUsageMaintenanceHealthy accepts as
// healthy, so tests below can isolate the provider-fetch-degraded signal
// from maintenance health.
function healthyMaintenanceResult() {
  return {
    subscriptionAdoption: {
      examined: 0,
      eligible: 0,
      adopted: 0,
      existing: 0,
      ambiguous: 0,
      reconciled: 0,
      deactivated: 0,
      raced: 0,
      cloudflareLegacyHandoff: "disabled" as const,
      degradedError: null,
    },
    subscriptions: { examined: 0, charged: 0, eventsWritten: 0 },
    providerRenewals: { examined: 0, advanced: 0 },
    retention: { skipped: true as const, reason: "interval" as const },
    alerts: {
      evaluatedProviders: 0,
      activeAlerts: 0,
      sent: 0,
      resolved: 0,
      skipped: 0,
      errors: [],
      persistenceDegraded: [],
      deferredError: null,
    },
  };
}

describe("fetchAllDueProviders per-provider timeout budget", () => {
  beforeEach(() => {
    vi.resetModules();
    findMany.mockReset();
    findFirst.mockReset();
    findFirst.mockResolvedValue(null);
    create.mockReset();
    fetchProviderUsage.mockReset();
    runUsageMaintenance.mockReset();
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
    process.env.ADAPTER_PROVIDER_TIMEOUT_MS = "5000";
    create.mockResolvedValue({ id: "snap" });
  });

  it.each([
    ["created", false],
    ["already_present_same", false],
    ["conflict", true],
    ["ineligible", true],
    ["error", true],
    ["unconfigured", true],
  ] as const)(
    "runs a %s bootstrap before the normal pull with the expected ST Gemini safety gate",
    async (status, suppressStGemini) => {
      findMany.mockResolvedValue([]);
      bootstrapStGeminiCredentialToInfisical.mockResolvedValue({
        enabled: true,
        attempted: status === "created",
        providerId: "4a888d41-3988-4774-86d8-67d7aa14d7e2",
        status,
      });
      const order: string[] = [];
      bootstrapStGeminiCredentialToInfisical.mockImplementationOnce(async () => {
        order.push("bootstrap");
        return {
          enabled: true,
          attempted: status === "created",
          providerId: "4a888d41-3988-4774-86d8-67d7aa14d7e2",
          status,
        };
      });
      syncProviderCredentialsFromInfisical.mockImplementationOnce(
        async () => {
          order.push("pull");
          return {
            enabled: true,
            configured: true,
            sources: [],
            created: 0,
            updated: 0,
            unchanged: 0,
            missing: 0,
            failed: 0,
            suppressed: suppressStGemini ? 1 : 0,
          };
        }
      );

      const { fetchAllDueProviders } = await import("@/lib/usage-recorder");
      const result = await fetchAllDueProviders();

      expect(order).toEqual(["bootstrap", "pull"]);
      expect(syncProviderCredentialsFromInfisical).toHaveBeenCalledWith({
        suppressStGemini,
      });
      expect(result.credentialBootstrap).toMatchObject({ status });
    }
  );

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

  it("classifies an intentionally unsupported push-only poll as skipped", async () => {
    findMany.mockResolvedValue([providerRow("push-only")]);
    const { AdapterError } = await import("@/lib/adapters/helpers");
    fetchProviderUsage.mockRejectedValue(
      new AdapterError("Use pushed telemetry or a manual plan.", {
        code: "UNSUPPORTED",
      })
    );

    const { fetchAllDueProviders } = await import("@/lib/usage-recorder");
    const result = await fetchAllDueProviders();

    expect(result).toMatchObject({
      total: 1,
      successes: 0,
      failures: 0,
      skipped: 1,
      errors: [],
    });
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        name: "push-only",
        status: "skipped",
        errorCode: "UNSUPPORTED",
      }),
    ]);
  });

  it("rolls back a late result after a newer attempt supersedes it", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    let resolveSecond: ((value: unknown) => void) | undefined;
    fetchProviderUsage
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveFirst = resolve; })
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveSecond = resolve; })
      );
    const usage = {
      balance: 1,
      totalCost: 10,
      totalRequests: 1,
      credits: null,
      rawData: {},
    };
    const { recordProviderUsage } = await import("@/lib/usage-recorder");
    const provider = providerRow("race");
    const first = recordProviderUsage(provider as never);
    const second = recordProviderUsage(provider as never);

    resolveSecond?.(usage);
    await expect(second).resolves.toEqual({ id: "snap" });
    resolveFirst?.({ ...usage, totalCost: 999 });
    await expect(first).rejects.toMatchObject({ code: "SUPERSEDED" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ totalCost: 10 }),
      })
    );
  });

  it("marks the first handoff-only maintenance failure unhealthy and exposes only its bounded reason", async () => {
    const markTickStarted = vi.fn();
    const markTickCompleted = vi.fn();
    const fetchProviders = vi.fn(async () => ({
      total: 2,
      successes: 1,
      failures: 1,
      skipped: 0,
      errors: [],
      outcomes: [],
    }));
    const runMaintenance = vi.fn(async () => ({
      subscriptionAdoption: {
        examined: 0,
        eligible: 0,
        adopted: 0,
        existing: 0,
        ambiguous: 0,
        reconciled: 0,
        deactivated: 0,
        raced: 0,
        cloudflareLegacyHandoff: "charge_proof_missing" as const,
        unsafeDiagnosticThatMustNotEscape: {
          targetId: "must-not-leak-target-id",
          rawEnv: "must-not-leak-env-value",
          billingPayload: "must-not-leak-billing-payload",
          providerError: "must-not-leak-provider-error",
        },
        degradedError: null,
      },
      subscriptions: { examined: 0, charged: 0, eventsWritten: 0 },
      providerRenewals: { examined: 0, advanced: 0 },
      retention: { skipped: true as const, reason: "interval" as const },
      alerts: {
        evaluatedProviders: 2,
        activeAlerts: 0,
        sent: 0,
        resolved: 0,
        skipped: 0,
        errors: [],
        persistenceDegraded: [],
        deferredError: null,
      },
    }));
    const { runUsagePollingSchedulerTick } = await import("@/lib/usage-recorder");

    await runUsagePollingSchedulerTick({
      fetchProviders,
      runMaintenance,
      markTickStarted,
      markTickCompleted,
    });

    expect(markTickStarted).toHaveBeenCalledOnce();
    // 1 failure / 2 attempted = 0.5, meeting the default
    // PROVIDER_FETCH_DEGRADED_FAILURE_RATIO - this tick is also
    // provider-fetch degraded, independently of maintenanceHealthy.
    expect(markTickCompleted).toHaveBeenCalledWith(false, {
      total: 2,
      successes: 1,
      failures: 1,
      skipped: 0,
      maintenanceHealthy: false,
      providerFetchDegraded: true,
      cloudflareLegacyHandoff: "charge_proof_missing",
    });
    expect(JSON.stringify(markTickCompleted.mock.calls)).not.toContain(
      "must-not-leak"
    );
  });

  it("marks a completed scheduler tick unhealthy on channel-state persistence degradation", async () => {
    const markTickStarted = vi.fn();
    const markTickCompleted = vi.fn();
    const fetchProviders = vi.fn(async () => ({
      total: 1,
      successes: 1,
      failures: 0,
      skipped: 0,
      errors: [],
      outcomes: [],
    }));
    const runMaintenance = vi.fn(async () => ({
      subscriptionAdoption: {
        examined: 0,
        eligible: 0,
        adopted: 0,
        existing: 0,
        ambiguous: 0,
        reconciled: 0,
        deactivated: 0,
        raced: 0,
        cloudflareLegacyHandoff: "disabled" as const,
        degradedError: null,
      },
      subscriptions: { examined: 0, charged: 0, eventsWritten: 0 },
      providerRenewals: { examined: 0, advanced: 0 },
      retention: { skipped: true as const, reason: "interval" as const },
      alerts: {
        evaluatedProviders: 1,
        activeAlerts: 1,
        sent: 0,
        resolved: 0,
        skipped: 0,
        errors: [],
        persistenceDegraded: [
          {
            stage: "channel_state" as const,
            operation: "trigger_success_outcome" as const,
            code: "P1008" as const,
            model: "ProviderAlertChannelDelivery" as const,
            providerId: "id-one",
            alertCode: "balance_low",
            channel: "webhook" as const,
            message: "busy",
          },
        ],
        deferredError: null,
      },
    }));
    const { runUsagePollingSchedulerTick } = await import("@/lib/usage-recorder");

    await runUsagePollingSchedulerTick({
      fetchProviders,
      runMaintenance,
      markTickStarted,
      markTickCompleted,
    });

    expect(markTickCompleted).toHaveBeenCalledWith(false, {
      total: 1,
      successes: 1,
      failures: 0,
      skipped: 0,
      maintenanceHealthy: false,
      providerFetchDegraded: false,
      cloudflareLegacyHandoff: "disabled",
    });
  });

  it("persists a safe partial snapshot before surfacing postPersistError", async () => {
    const { AdapterError } = await import("@/lib/adapters/helpers");
    const postPersistError = new AdapterError(
      "Billing sync failed: secret-that-must-not-persist",
      {
        code: "HTTP_ERROR",
        status: 503,
        retryable: true,
      }
    );
    fetchProviderUsage.mockResolvedValue({
      balance: null,
      totalCost: null,
      totalRequests: null,
      credits: 90,
      rawData: {
        keyValidation: { outcome: "valid", status: 200 },
        billing: { configured: true, status: "error" },
      },
      postPersistError,
    });

    const { recordProviderUsage } = await import("@/lib/usage-recorder");

    await expect(
      recordProviderUsage(providerRow("partial") as never)
    ).rejects.toBe(postPersistError);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerId: "id-partial",
          totalCost: null,
          credits: 90,
          rawData: expect.objectContaining({
            keyValidation: { outcome: "valid", status: 200 },
            billing: { configured: true, status: "error" },
            __apiUsageMonitor: {
              version: 1,
              partialFailure: {
                code: "HTTP_ERROR",
                status: 503,
                retryable: true,
              },
            },
          }),
        }),
      })
    );
    const persistedRawData = create.mock.calls[0]?.[0]?.data?.rawData;
    expect(JSON.stringify(persistedRawData)).not.toContain(
      "secret-that-must-not-persist"
    );
    expect(JSON.stringify(persistedRawData)).not.toContain("Billing sync failed");
  });

  it("retries a fresh retryable partial snapshot on the next scheduler tick", async () => {
    const { AdapterError } = await import("@/lib/adapters/helpers");
    fetchProviderUsage.mockResolvedValueOnce({
      balance: null,
      totalCost: null,
      totalRequests: null,
      credits: 90,
      rawData: { billing: { configured: true, status: "error" } },
      postPersistError: new AdapterError("Temporary billing outage", {
        code: "HTTP_ERROR",
        status: 503,
        retryable: true,
      }),
    });

    const { fetchAllDueProviders, recordProviderUsage } = await import(
      "@/lib/usage-recorder"
    );
    await expect(
      recordProviderUsage(providerRow("partial-retry") as never)
    ).rejects.toMatchObject({ code: "HTTP_ERROR", retryable: true });

    const firstWrite = create.mock.calls[0]?.[0]?.data;
    findMany.mockResolvedValue([
      {
        ...providerRow("partial-retry"),
        snapshots: [
          {
            fetchedAt: new Date(firstWrite.fetchedAt.getTime() + 1_000),
            rawData: null,
          },
        ],
      },
    ]);
    findFirst.mockResolvedValueOnce({
      fetchedAt: firstWrite.fetchedAt,
      rawData: firstWrite.rawData,
    });
    fetchProviderUsage.mockResolvedValueOnce({
      balance: 1,
      totalCost: 2,
      totalRequests: 3,
      credits: 4,
      rawData: {},
    });
    create.mockClear();

    const result = await fetchAllDueProviders();

    expect(result).toMatchObject({
      total: 1,
      successes: 1,
      failures: 0,
      skipped: 0,
    });
    expect(fetchProviderUsage).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        providerId: { in: ["id-partial-retry"] },
        rawData: { not: expect.anything() },
      },
      orderBy: { fetchedAt: "desc" },
      select: { fetchedAt: true, rawData: true },
    });
  });

  it("does not let a fresh pushed snapshot hide a stale poll", async () => {
    const now = new Date();
    findMany.mockResolvedValue([
      {
        ...providerRow("stale-poll"),
        snapshots: [{ fetchedAt: now, rawData: null }],
      },
    ]);
    findFirst.mockResolvedValueOnce({
      fetchedAt: new Date(now.getTime() - 61 * 60 * 1000),
      rawData: { providerPoll: "complete" },
    });
    fetchProviderUsage.mockResolvedValueOnce({
      balance: 1,
      totalCost: 2,
      totalRequests: 3,
      credits: 4,
      rawData: {},
    });

    const { fetchAllDueProviders } = await import("@/lib/usage-recorder");
    const result = await fetchAllDueProviders();

    expect(result).toMatchObject({
      total: 1,
      successes: 1,
      failures: 0,
      skipped: 0,
    });
    expect(fetchProviderUsage).toHaveBeenCalledOnce();
  });

  it("uses a fresh poll behind a pushed snapshot for interval skipping", async () => {
    const now = new Date();
    findMany.mockResolvedValue([
      {
        ...providerRow("fresh-poll"),
        snapshots: [{ fetchedAt: now, rawData: null }],
      },
    ]);
    findFirst.mockResolvedValueOnce({
      fetchedAt: new Date(now.getTime() - 30 * 60 * 1000),
      rawData: { providerPoll: "complete" },
    });

    const { fetchAllDueProviders } = await import("@/lib/usage-recorder");
    const result = await fetchAllDueProviders();

    expect(result).toMatchObject({
      total: 1,
      successes: 0,
      failures: 0,
      skipped: 1,
    });
    expect(fetchProviderUsage).not.toHaveBeenCalled();
  });

  it("respects the normal interval after a nonretryable partial snapshot", async () => {
    findMany.mockResolvedValue([
      {
        ...providerRow("partial-terminal"),
        snapshots: [
          {
            fetchedAt: new Date(),
            rawData: {
              __apiUsageMonitor: {
                version: 1,
                partialFailure: {
                  code: "HTTP_ERROR",
                  status: 404,
                  retryable: false,
                },
              },
            },
          },
        ],
      },
    ]);

    const { fetchAllDueProviders } = await import("@/lib/usage-recorder");
    const result = await fetchAllDueProviders();

    expect(result).toMatchObject({
      total: 1,
      successes: 0,
      failures: 0,
      skipped: 1,
    });
    expect(fetchProviderUsage).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("strips adapter-supplied retry metadata instead of trusting it", async () => {
    fetchProviderUsage.mockResolvedValue({
      balance: null,
      totalCost: null,
      totalRequests: null,
      credits: null,
      rawData: {
        providerField: "preserved",
        __apiUsageMonitor: {
          version: 1,
          partialFailure: {
            code: "HTTP_ERROR",
            status: 503,
            retryable: true,
          },
        },
      },
    });

    const { recordProviderUsage } = await import("@/lib/usage-recorder");
    await recordProviderUsage(providerRow("spoof") as never);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rawData: { providerField: "preserved" },
        }),
      })
    );
  });

  it("drops a provider result aborted while its database write is queued", async () => {
    fetchProviderUsage.mockResolvedValue({
      balance: 1,
      totalCost: 2,
      totalRequests: 3,
      credits: null,
      rawData: {},
    });

    const [{ recordProviderUsage }, { tryAcquireIngestAdmission }] = await Promise.all([
      import("@/lib/usage-recorder"),
      import("@/lib/ingest-admission"),
    ]);
    const releaseHttpWriter = tryAcquireIngestAdmission();
    expect(releaseHttpWriter).not.toBeNull();

    const controller = new AbortController();
    const pending = recordProviderUsage(
      providerRow("queued-abort") as never,
      controller.signal
    );
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    releaseHttpWriter?.();

    await expect(pending).rejects.toMatchObject({ code: "SUPERSEDED" });
    expect(create).not.toHaveBeenCalled();
    const releaseAfterAbort = tryAcquireIngestAdmission();
    expect(releaseAfterAbort).not.toBeNull();
    releaseAfterAbort?.();
  });

  describe("isProviderFetchTickDegraded", () => {
    afterEach(() => {
      delete process.env.PROVIDER_FETCH_DEGRADED_FAILURE_RATIO;
    });

    it("is not degraded when nothing was attempted (all skipped)", async () => {
      const { isProviderFetchTickDegraded } = await import("@/lib/usage-recorder");
      expect(
        isProviderFetchTickDegraded({ successes: 0, failures: 0 })
      ).toBe(false);
    });

    it("hits the total-outage fast path even if the configured ratio is out of range", async () => {
      process.env.PROVIDER_FETCH_DEGRADED_FAILURE_RATIO = "2"; // outside (0,1], ignored
      const { isProviderFetchTickDegraded } = await import("@/lib/usage-recorder");
      expect(
        isProviderFetchTickDegraded({ successes: 0, failures: 1 })
      ).toBe(true);
    });

    it("is degraded once the failure ratio meets the default 0.5 threshold", async () => {
      const { isProviderFetchTickDegraded } = await import("@/lib/usage-recorder");
      expect(isProviderFetchTickDegraded({ successes: 1, failures: 5 })).toBe(
        true
      ); // 5/6 attempted
      expect(isProviderFetchTickDegraded({ successes: 1, failures: 1 })).toBe(
        true
      ); // 1/2 == 0.5
      expect(isProviderFetchTickDegraded({ successes: 3, failures: 1 })).toBe(
        false
      ); // 1/4 < 0.5
    });

    it("honors a configured PROVIDER_FETCH_DEGRADED_FAILURE_RATIO", async () => {
      process.env.PROVIDER_FETCH_DEGRADED_FAILURE_RATIO = "0.25";
      const { isProviderFetchTickDegraded } = await import("@/lib/usage-recorder");
      expect(isProviderFetchTickDegraded({ successes: 3, failures: 1 })).toBe(
        true
      ); // 1/4 == 0.25
    });
  });

  it("marks a tick provider-fetch degraded via the total-outage fast path, independent of tick success", async () => {
    const markTickStarted = vi.fn();
    const markTickCompleted = vi.fn();
    const fetchProviders = vi.fn(async () => ({
      total: 3,
      successes: 0,
      failures: 3,
      skipped: 0,
      errors: [],
      outcomes: [],
    }));
    const runMaintenance = vi.fn(async () => healthyMaintenanceResult());
    const { runUsagePollingSchedulerTick } = await import("@/lib/usage-recorder");

    await runUsagePollingSchedulerTick({
      fetchProviders,
      runMaintenance,
      markTickStarted,
      markTickCompleted,
    });

    // maintenanceHealthy (and therefore `succeeded`) stays true - a
    // provider-fetch outage must not flip lastTickSucceeded/
    // consecutiveFailures on its own.
    expect(markTickCompleted).toHaveBeenCalledWith(true, {
      total: 3,
      successes: 0,
      failures: 3,
      skipped: 0,
      maintenanceHealthy: true,
      providerFetchDegraded: true,
      cloudflareLegacyHandoff: "disabled",
    });
  });

  it("does not mark a skipped-only tick (nothing attempted) as provider-fetch degraded", async () => {
    const markTickStarted = vi.fn();
    const markTickCompleted = vi.fn();
    const fetchProviders = vi.fn(async () => ({
      total: 3,
      successes: 0,
      failures: 0,
      skipped: 3,
      errors: [],
      outcomes: [],
    }));
    const runMaintenance = vi.fn(async () => healthyMaintenanceResult());
    const { runUsagePollingSchedulerTick } = await import("@/lib/usage-recorder");

    await runUsagePollingSchedulerTick({
      fetchProviders,
      runMaintenance,
      markTickStarted,
      markTickCompleted,
    });

    expect(markTickCompleted).toHaveBeenCalledWith(true, {
      total: 3,
      successes: 0,
      failures: 0,
      skipped: 3,
      maintenanceHealthy: true,
      providerFetchDegraded: false,
      cloudflareLegacyHandoff: "disabled",
    });
  });
});
