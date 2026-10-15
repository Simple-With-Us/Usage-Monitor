import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/b2-app-usage", () => ({
  runB2UsageCheck: vi.fn(async () => ({
    assessment: { configured: false, apps: [], dailySeries: [], alerts: {} },
    pushoverSent: false,
  })),
}));
import {
  AlertNotificationSummaryPersistenceTimeout,
  type AlertDeliveryResult,
} from "../alert-delivery";
import type { ScheduledRetentionSkipped } from "../data-retention";
import type { RollForwardProviderRenewalsResult } from "../provider-renewals";
import type { MaterializeSubscriptionsResult } from "../subscription-materializer";
import type { AdoptExternalBillingSubscriptionsResult } from "../external-billing-subscription-adoption";
import {
  isUsageMaintenanceHealthy,
  runUsageMaintenance,
  type UsageMaintenanceDependencies,
} from "../usage-maintenance";
import { tryAcquireIngestAdmission } from "../ingest-admission";

const subscriptions: MaterializeSubscriptionsResult = {
  examined: 2,
  charged: 1,
  eventsWritten: 1,
  ambiguousPaused: 0,
};
const subscriptionAdoption: AdoptExternalBillingSubscriptionsResult = {
  examined: 2,
  eligible: 1,
  adopted: 1,
  existing: 0,
  ambiguous: 0,
  reconciled: 0,
  deactivated: 0,
  raced: 0,
  cloudflareLegacyHandoff: "disabled",
};
const successfulSubscriptionAdoption = {
  ...subscriptionAdoption,
  degradedError: null,
};
const providerRenewals: RollForwardProviderRenewalsResult = {
  examined: 1,
  advanced: 1,
};
const retention: ScheduledRetentionSkipped = { skipped: true, reason: "interval" };
const deliveredAlerts: AlertDeliveryResult = {
  evaluatedProviders: 4,
  activeAlerts: 2,
  sent: 1,
  resolved: 1,
  skipped: 0,
  errors: [],
  persistenceDegraded: [],
};

function dependencies(
  deliverAlerts: UsageMaintenanceDependencies["deliverAlerts"]
): UsageMaintenanceDependencies {
  return {
    quarantineMistralSnapshots: vi.fn(async () => ({
      examined: 0,
      quarantined: 0,
      externalBillingExamined: 0,
      externalBillingQuarantined: 0,
      truncated: false,
    })),
    pauseSeededGhosts: vi.fn(async () => ({ paused: 0, retracted: 0 })),
    adoptSubscriptions: vi.fn(async () => subscriptionAdoption),
    materializeSubscriptions: vi.fn(async () => subscriptions),
    rollForwardRenewals: vi.fn(async () => providerRenewals),
    runRetention: vi.fn(async () => retention),
    deliverAlerts,
    verifyOpenRouterGenerations: vi.fn(async () => ({
      examined: 0,
      matched: 0,
      discrepancies: 0,
      errors: 0,
      exhausted: 0,
      verifiedCount: 0,
      truncated: false,
      degraded: false,
    })),
    reconcileProviderUsage: vi.fn(async () => ({
      examined: 0,
      reconciled: 0,
      discrepancies: 0,
      unverifiable: 0,
      pending: 0,
      reconciledCount: 0,
    })),
  };
}

function summaryTimeout(
  message = "SQLite socket timeout",
  partialResult: AlertDeliveryResult = deliveredAlerts
): AlertNotificationSummaryPersistenceTimeout {
  const error = Object.assign(new Error(message), {
    code: "P1008",
    meta: { modelName: "ProviderAlertNotification" },
  });
  return new AlertNotificationSummaryPersistenceTimeout(error, partialResult);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("runUsageMaintenance", () => {
  it("adopts authoritative billing before materializing its current period", async () => {
    const calls: string[] = [];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const deps = dependencies(vi.fn(async () => deliveredAlerts));
    deps.quarantineMistralSnapshots = vi.fn(async () => {
      calls.push("quarantine-mistral");
      return {
        examined: 1,
        quarantined: 1,
        externalBillingExamined: 1,
        externalBillingQuarantined: 1,
        truncated: false,
      };
    });
    deps.adoptSubscriptions = vi.fn(async () => {
      calls.push("adopt");
      return subscriptionAdoption;
    });
    deps.materializeSubscriptions = vi.fn(async () => {
      calls.push("materialize");
      return subscriptions;
    });

    await runUsageMaintenance(deps);

    expect(calls).toEqual(["quarantine-mistral", "adopt", "materialize"]);
  });

  it("queues scheduler money-path writes behind an external ingest admission lease", async () => {
    const releaseExternal = tryAcquireIngestAdmission();
    expect(releaseExternal).not.toBeNull();

    const deliverAlerts = vi.fn(async () => deliveredAlerts);
    const deps = dependencies(deliverAlerts);
    const adoptSubscriptions = vi.fn(async () => subscriptionAdoption);
    const materializeSubscriptions = vi.fn(async () => subscriptions);
    const rollForwardRenewals = vi.fn(async () => providerRenewals);
    deps.adoptSubscriptions = adoptSubscriptions;
    deps.materializeSubscriptions = materializeSubscriptions;
    deps.rollForwardRenewals = rollForwardRenewals;

    const pending = runUsageMaintenance(deps);
    await Promise.resolve();
    expect(adoptSubscriptions).not.toHaveBeenCalled();
    expect(materializeSubscriptions).not.toHaveBeenCalled();

    releaseExternal?.();
    const result = await pending;
    expect(result.subscriptionAdoption).toEqual(successfulSubscriptionAdoption);
    expect(result.subscriptions).toEqual(subscriptions);
    expect(result.providerRenewals).toEqual(providerRenewals);
    expect(adoptSubscriptions).toHaveBeenCalledOnce();
    expect(materializeSubscriptions).toHaveBeenCalledOnce();
    expect(rollForwardRenewals).toHaveBeenCalledOnce();
  });

  it("does not hold scheduler admission across alert delivery dependencies", async () => {
    let resolveRelease!: (release: () => void) => void;
    const releaseReady = new Promise<() => void>((resolve) => {
      resolveRelease = resolve;
    });
    const deliverAlerts = vi.fn(async () => deliveredAlerts);
    const deps = dependencies(deliverAlerts);
    deps.runRetention = vi.fn(async () => {
      const releaseExternal = tryAcquireIngestAdmission();
      expect(releaseExternal).not.toBeNull();
      resolveRelease(releaseExternal ?? (() => undefined));
      return retention;
    });

    const pending = runUsageMaintenance(deps);
    const releaseExternal = await releaseReady;
    await Promise.resolve();
    await vi.waitFor(() => expect(deliverAlerts).toHaveBeenCalledOnce());

    releaseExternal();
    const result = await pending;
    expect(result.alerts).toEqual({ ...deliveredAlerts, deferredError: null });
    expect(deliverAlerts).toHaveBeenCalledOnce();
  });

  it("returns a structured degraded alert result without failing completed money-path stages", async () => {
    const error = summaryTimeout();
    const deliverAlerts = vi.fn(async () => {
      throw error;
    });
    const deps = dependencies(deliverAlerts);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runUsageMaintenance(deps);
    expect(result).toEqual({
      subscriptions,
      subscriptionAdoption: successfulSubscriptionAdoption,
      providerRenewals,
      retention,
      alerts: {
        ...deliveredAlerts,
        deferredError: {
          stage: "alerts",
          operation: "post_send_notification_summary",
          code: "P1008",
          model: "ProviderAlertNotification",
          message: "SQLite socket timeout",
        },
      },
      openrouterVerification: {
        examined: 0,
        matched: 0,
        discrepancies: 0,
        errors: 0,
        exhausted: 0,
        verifiedCount: 0,
        truncated: false,
        degraded: false,
      },
      reconciliation: {
        examined: 0,
        reconciled: 0,
        discrepancies: 0,
        unverifiable: 0,
        pending: 0,
        reconciledCount: 0,
      },
      // Budget-breach automated control layer (src/lib/budget-controls.ts) is
      // default-off; with BUDGET_AUTO_CONTROLS_ENABLED unset in the test env,
      // applyBudgetControls short-circuits to this zeroed, enabled:false shape.
      budgetControls: {
        enabled: false,
        evaluated: 0,
        breachesObserved: 0,
        paused: 0,
        resumed: 0,
        recommendationsRaised: 0,
        recommendationsCleared: 0,
        auditRowsWritten: 0,
        degraded: false,
      },
      r2UsageCheck: result.r2UsageCheck,
      b2UsageCheck: result.b2UsageCheck,
    });
    expect(isUsageMaintenanceHealthy(result)).toBe(false);
    expect(deliverAlerts).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
  });

  it("does not retry in the same cycle and retries normally on the next invocation", async () => {
    const deliverAlerts = vi
      .fn<() => Promise<AlertDeliveryResult>>()
      .mockRejectedValueOnce(summaryTimeout("busy"))
      .mockResolvedValueOnce(deliveredAlerts);
    const deps = dependencies(deliverAlerts);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = await runUsageMaintenance(deps);
    expect(first.alerts.deferredError?.code).toBe("P1008");
    expect(deliverAlerts).toHaveBeenCalledTimes(1);

    const second = await runUsageMaintenance(deps);
    expect(second.alerts).toEqual({ ...deliveredAlerts, deferredError: null });
    expect(isUsageMaintenanceHealthy(second)).toBe(true);
    expect(deliverAlerts).toHaveBeenCalledTimes(2);
  });

  it.each(["disabled", "handed_off", "already_managed"] as const)(
    "keeps the %s Cloudflare legacy-handoff status healthy",
    async (cloudflareLegacyHandoff) => {
      const deps = dependencies(vi.fn(async () => deliveredAlerts));
      deps.adoptSubscriptions = vi.fn(async () => ({
        ...subscriptionAdoption,
        cloudflareLegacyHandoff,
      }));
      expect(isUsageMaintenanceHealthy(await runUsageMaintenance(deps))).toBe(
        true
      );
    }
  );

  it.each([
    "invalid_target",
    "not_found",
    "wrong_provider",
    "wrong_identity",
    "owner_guard_present",
    "provider_plan_conflict",
    "external_billing_ineligible",
    "term_mismatch",
    "guard_collision",
    "charge_proof_missing",
    "not_run",
  ] as const)(
    "marks the configured %s Cloudflare legacy-handoff status unhealthy without creating a provider alert",
    async (cloudflareLegacyHandoff) => {
      const deps = dependencies(vi.fn(async () => deliveredAlerts));
      deps.adoptSubscriptions = vi.fn(async () => ({
        ...subscriptionAdoption,
        cloudflareLegacyHandoff,
      }));
      const result = await runUsageMaintenance(deps);
      expect(isUsageMaintenanceHealthy(result)).toBe(false);
      expect(result.alerts).toEqual({
        ...deliveredAlerts,
        deferredError: null,
      });
    }
  );

  it("marks channel-state persistence degradation unhealthy without a summary timeout", async () => {
    const degraded: AlertDeliveryResult = {
      ...deliveredAlerts,
      persistenceDegraded: [
        {
          stage: "channel_state",
          operation: "trigger_success_outcome",
          code: "P1008",
          model: "ProviderAlertChannelDelivery",
          providerId: "provider-1",
          alertCode: "balance_low",
          channel: "webhook",
          message: "channel state timed out",
        },
      ],
    };
    const result = await runUsageMaintenance(
      dependencies(vi.fn(async () => degraded))
    );

    expect(result.alerts.deferredError).toBeNull();
    expect(result.alerts.persistenceDegraded).toHaveLength(1);
    expect(isUsageMaintenanceHealthy(result)).toBe(false);
  });

  it("fails adoption closed but continues all existing maintenance stages", async () => {
    const calls: string[] = [];
    const failure = new Error("adoption transaction failed");
    const deps = dependencies(vi.fn(async () => {
      calls.push("alerts");
      return deliveredAlerts;
    }));
    deps.adoptSubscriptions = vi.fn(async () => {
      calls.push("adopt");
      throw failure;
    });
    deps.materializeSubscriptions = vi.fn(async () => {
      calls.push("materialize");
      return subscriptions;
    });
    deps.rollForwardRenewals = vi.fn(async () => {
      calls.push("renewals");
      return providerRenewals;
    });
    deps.runRetention = vi.fn(async () => {
      calls.push("retention");
      return retention;
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runUsageMaintenance(deps);

    expect(calls).toEqual([
      "adopt",
      "materialize",
      "renewals",
      "retention",
      "alerts",
    ]);
    expect(result.subscriptionAdoption).toMatchObject({
      adopted: 0,
      degradedError: {
        stage: "subscription_adoption",
        message: "adoption transaction failed",
      },
    });
    expect(result.subscriptions).toEqual(subscriptions);
    expect(isUsageMaintenanceHealthy(result)).toBe(false);
    expect(log).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent callers into one degraded alert pass and clears in-flight state", async () => {
    let rejectAlerts: ((error: Error) => void) | undefined;
    const deliverAlerts = vi.fn(
      () =>
        new Promise<AlertDeliveryResult>((_resolve, reject) => {
          rejectAlerts = reject;
        })
    );
    const deps = dependencies(deliverAlerts);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = runUsageMaintenance(deps);
    const second = runUsageMaintenance(deps);
    await vi.waitFor(() => expect(rejectAlerts).toBeTypeOf("function"));
    rejectAlerts?.(summaryTimeout("locked"));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(deliverAlerts).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();

    const nextDeliverAlerts = vi.fn(async () => deliveredAlerts);
    const next = await runUsageMaintenance(dependencies(nextDeliverAlerts));
    expect(next.alerts.deferredError).toBeNull();
    expect(nextDeliverAlerts).toHaveBeenCalledOnce();
  });

  it.each([
    "materializeSubscriptions",
    "rollForwardRenewals",
    "runRetention",
  ] as const)("keeps %s failures fatal", async (stage) => {
    const failure = new Error(`${stage} failed`);
    const deliverAlerts = vi.fn(async () => deliveredAlerts);
    const deps = dependencies(deliverAlerts);

    if (stage === "materializeSubscriptions") {
      deps.materializeSubscriptions = vi.fn(async () => {
        throw failure;
      });
    } else if (stage === "rollForwardRenewals") {
      deps.rollForwardRenewals = vi.fn(async () => {
        throw failure;
      });
    } else {
      deps.runRetention = vi.fn(async () => {
        throw failure;
      });
    }

    await expect(runUsageMaintenance(deps)).rejects.toBe(failure);
    expect(deliverAlerts).not.toHaveBeenCalled();
  });

  it.each([
    new TypeError("alert implementation bug"),
    Object.assign(new Error("schema missing"), {
      code: "P2021",
      meta: { modelName: "ProviderAlertNotification" },
    }),
    Object.assign(new Error("channel state timeout"), {
      code: "P1008",
      meta: { modelName: "ProviderAlertChannelDelivery" },
    }),
    Object.assign(new Error("notification read timeout"), {
      code: "P1008",
      meta: { modelName: "ProviderAlertNotification" },
    }),
  ])("keeps non-bookkeeping alert failures fatal", async (failure) => {
    const deliverAlerts = vi.fn(async () => {
      throw failure;
    });

    await expect(runUsageMaintenance(dependencies(deliverAlerts))).rejects.toBe(failure);

    const nextDeliverAlerts = vi.fn(async () => deliveredAlerts);
    const next = await runUsageMaintenance(dependencies(nextDeliverAlerts));
    expect(next.alerts.deferredError).toBeNull();
    expect(nextDeliverAlerts).toHaveBeenCalledOnce();
  });
});
