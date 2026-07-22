import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decrypt, encrypt, encryptJson } from "@/lib/crypto";
import { parseProviderUpdateInput, readJsonBody } from "@/lib/provider-input";
import { isDecommissionedProviderName } from "@/lib/provider-definitions";
import { buildProviderAlertState } from "@/lib/provider-alerts";
import { computeBudgetStatus, bustBudgetStatusCache } from "@/lib/budget-status";
import { toPrismaProviderPlanData } from "@/lib/provider-plan";
import { canonicalProviderKey } from "@/lib/provider-identity";
import { buildKeyPreview } from "@/lib/provider-key-preview";
import { getProviderComplianceSummary } from "@/lib/provider-compliance";
import {
  decryptProviderSecretConfig,
  hasProviderSecrets,
  mergeProviderConfig,
  providerConfigForClient,
  providerConfigForServer,
  splitProviderConfig,
} from "@/lib/provider-secret-config";
import {
  hasStoredAnthropicAdminApiKey,
  providerPollSnapshotExpected,
} from "@/lib/anthropic-credentials";
import {
  deriveGeminiBillingStatus,
  deriveGeminiKeyStatus,
  deriveGeminiMonitoringStatus,
} from "@/lib/gemini-key-status";
import { projectGeminiExternalBillingForClient } from "@/lib/gemini-external-billing";
import {
  containsProviderManagementClaim,
  hasStPrimaryCredentialOwnership,
  isReservedStPrimaryManagedLabel,
  providerCredentialManagementForClient,
} from "@/lib/managed-provider-credential";
import { snapshotCostCoverageCaveat } from "@/lib/snapshot-sync-status";
import {
  authoritativeProviderBillingCredential,
  hashProviderBillingAccountId,
  projectProviderBillingAccountMatches,
} from "@/lib/provider-billing-account";
import { hasValidDashboardSession, shouldEnforceDashboardSession } from "@/lib/auth";

function decryptKey(encryptedKey: string | null): string | null {
  if (!encryptedKey) return null;
  try {
    return decrypt(encryptedKey);
  } catch {
    return null;
  }
}

function serverConfig(
  config: unknown,
  encryptedSecretConfig: string | null
): Record<string, unknown> | null {
  try {
    return providerConfigForServer(config, encryptedSecretConfig);
  } catch {
    return null;
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const [provider, budget, providerNames] = await Promise.all([prisma.provider.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      displayName: true,
      type: true,
      apiKey: true,
      isActive: true,
      config: true,
      secretConfig: true,
      refreshIntervalMin: true,
      groupId: true,
      billingAccountIdentity: true,
      label: true,
      allocations: {
        select: {
          projectId: true,
          percentage: true,
        },
      },
      plan: true,
      externalBilling: {
        orderBy: [{ source: "asc" }, { externalId: "asc" }],
        select: {
          source: true,
          externalId: true,
          kind: true,
          serviceName: true,
          planName: true,
          status: true,
          amountUsd: true,
          currency: true,
          billingInterval: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          nextRenewalAt: true,
          requestLimit: true,
          requestLimitWindow: true,
          spendLimitUsd: true,
          spendLimitWindow: true,
          usageQuantity: true,
          remainingQuantity: true,
          usageUnit: true,
          rollupRole: true,
          dateKind: true,
          syncedAt: true,
        },
      },
      snapshots: {
        orderBy: { fetchedAt: "desc" },
        take: 1,
        select: {
          balance: true,
          totalCost: true,
          fixedCostIncludedUsd: true,
          costWindowStart: true,
          costWindowEnd: true,
          costScope: true,
          costIncludesUnknownFixed: true,
          totalRequests: true,
          credits: true,
          rawData: true,
          fetchedAt: true,
        },
      },
      createdAt: true,
    },
  }), computeBudgetStatus(), prisma.provider.findMany({
    select: { id: true, name: true },
  })]);

  if (!provider) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const geminiStatusSnapshot =
    provider.type.trim().toLowerCase() === "builtin" &&
    canonicalProviderKey(provider.name) === "google-ai"
      ? await prisma.usageSnapshot.findFirst({
          where: {
            providerId: provider.id,
            rawData: { not: Prisma.DbNull },
          },
          orderBy: { fetchedAt: "desc" },
          select: { rawData: true, fetchedAt: true },
        })
      : null;

  const {
    snapshots,
    apiKey,
    config,
    secretConfig,
    billingAccountIdentity,
    ...rest
  } = provider;
  const clientConfig = providerConfigForClient(config, secretConfig);
  const credentialManagement = providerCredentialManagementForClient(
    config,
    secretConfig
  );
  const credentialManaged = hasStPrimaryCredentialOwnership(
    config,
    secretConfig,
    provider.label
  );
  const latestSnapshotWithRawData = snapshots[0] ?? null;
  const latestSnapshot = latestSnapshotWithRawData
    ? {
        balance: latestSnapshotWithRawData.balance,
        totalCost: latestSnapshotWithRawData.totalCost,
        fixedCostIncludedUsd: latestSnapshotWithRawData.fixedCostIncludedUsd,
        costWindowStart: latestSnapshotWithRawData.costWindowStart,
        costWindowEnd: latestSnapshotWithRawData.costWindowEnd,
        costScope: latestSnapshotWithRawData.costScope,
        costIncludesUnknownFixed:
          latestSnapshotWithRawData.costIncludesUnknownFixed,
        totalRequests: latestSnapshotWithRawData.totalRequests,
        credits: latestSnapshotWithRawData.credits,
        fetchedAt: latestSnapshotWithRawData.fetchedAt,
      }
    : null;
  // Derived from the existing rawData JSON blob rather than a new DB
  // column - see snapshot-sync-status.ts's __apiUsageMonitor metadata bag.
  const costCoverageCaveat = snapshotCostCoverageCaveat(
    latestSnapshotWithRawData?.rawData ?? null
  );
  // Display-only read-back of the §3c/§3d audit layer. Never feeds budgets,
  // alerts, or the max() spend logic; a failure here must not take down the
  // provider page, so it degrades to null.
  const compliance = await getProviderComplianceSummary({
    id: provider.id,
    name: provider.name,
    type: provider.type,
  }).catch((error) => {
    console.error("[providers] compliance summary failed:", error);
    return null;
  });
  const decryptedKey = decryptKey(apiKey);
  const adapterConfig = serverConfig(config, secretConfig);
  const billingAccount = projectProviderBillingAccountMatches([
    {
      id: provider.id,
      name: provider.name,
      billingAccountIdentity,
      decryptedCredential: authoritativeProviderBillingCredential({
        providerName: provider.name,
        primaryCredential: decryptedKey,
        serverConfig: adapterConfig,
      }),
    },
  ]).get(provider.id) ?? null;
  const geminiBillingStatus = deriveGeminiBillingStatus({
    providerName: provider.name,
    providerType: provider.type,
    billingConfig: adapterConfig,
    latestSnapshot: geminiStatusSnapshot,
  });
  const geminiKeyStatus = deriveGeminiKeyStatus({
    providerName: provider.name,
    providerType: provider.type,
    apiKey: decryptedKey,
    apiKeyConfigured: apiKey != null,
    latestSnapshot: geminiStatusSnapshot,
  });
  const geminiMonitoringStatus = deriveGeminiMonitoringStatus({
    providerName: provider.name,
    providerType: provider.type,
    monitoringConfig: adapterConfig,
    latestSnapshot: geminiStatusSnapshot,
  });
  const externalBilling = projectGeminiExternalBillingForClient(
    rest.externalBilling,
    geminiBillingStatus,
    geminiKeyStatus
  );
  const alertState = buildProviderAlertState({
    isActive: provider.isActive,
    refreshIntervalMin: provider.refreshIntervalMin,
    snapshotExpected: providerPollSnapshotExpected({
      name: provider.name,
      type: provider.type,
      apiKey,
      config,
      secretConfig,
    }),
    plan: provider.plan,
    latestSnapshot,
  });
  const canonicalBudget = budget.providers.find((entry) => entry.id === id);
  const nonBudgetAlerts = alertState.alerts.filter(
    (alert) =>
      alert.code !== "budget_exceeded" && alert.code !== "budget_warning"
  );
  const alerts =
    canonicalBudget && provider.isActive
      ? [...nonBudgetAlerts, ...canonicalBudget.alerts]
      : alertState.alerts;
  const duplicateProviderIds = providerNames
    .filter(
      (entry) =>
        canonicalProviderKey(entry.name) === canonicalProviderKey(provider.name)
    )
    .map((entry) => entry.id)
    .sort();

  return NextResponse.json({
    ...rest,
    externalBilling,
    ...clientConfig,
    credentialManagement,
    billingAccount,
    billingAccountIdentityConfigured: billingAccountIdentity != null,
    // A client-safe preview identifies this individual validated managed key
    // without exposing the full key or the source list it came from. A
    // malformed/unreadable ownership envelope must stay fully redacted.
    keyPreview:
      credentialManaged && credentialManagement == null
        ? null
        : buildKeyPreview(decryptedKey),
    geminiKeyStatus,
    geminiBillingStatus,
    geminiMonitoringStatus,
    anthropicAdminApiConfigured: hasStoredAnthropicAdminApiKey({
      name: provider.name,
      apiKey,
      config,
      secretConfig,
    }),
    latestSnapshot,
    // Distinct from spendCoverage/pushedCostCoverage below - see
    // CostCoverageCaveat in adapters/helpers.ts for why these must not be
    // conflated.
    costCoverageCaveat,
    compliance,
    alerts,
    estimatedMonthlyCostUsd:
      canonicalBudget != null
        ? (canonicalBudget.spentUsd ?? alertState.estimatedMonthlyCostUsd)
        : null,
    // Fail closed: never invent complete $0 from a bare snapshot.
    spentUsd: canonicalBudget?.spentUsd ?? null,
    snapshotCostUsd: canonicalBudget?.snapshotCostUsd ?? null,
    snapshotCostFetchedAt: canonicalBudget?.snapshotCostFetchedAt ?? null,
    snapshotCostWindowStart: canonicalBudget?.snapshotCostWindowStart ?? null,
    snapshotCostWindowEnd: canonicalBudget?.snapshotCostWindowEnd ?? null,
    snapshotCostScope: canonicalBudget?.snapshotCostScope ?? null,
    snapshotFixedCostIncludedUsd:
      canonicalBudget?.snapshotFixedCostIncludedUsd ?? 0,
    snapshotCostIncludesUnknownFixed:
      canonicalBudget?.snapshotCostIncludesUnknownFixed ?? false,
    pushedMonthToDateUsd: canonicalBudget?.pushedMonthToDateUsd ?? 0,
    receiptCashPaidUsd: canonicalBudget?.receiptCashPaidUsd ?? 0,
    receiptCashEventCount: canonicalBudget?.receiptCashEventCount ?? 0,
    observedVariableUsageUsd:
      canonicalBudget?.observedVariableUsageUsd ?? 0,
    estimatedApiEquivalentUsd:
      canonicalBudget?.estimatedApiEquivalentUsd ?? 0,
    pushedCostCoverage: canonicalBudget?.pushedCostCoverage ?? "unknown",
    pushedPricedEventCount: canonicalBudget?.pushedPricedEventCount ?? 0,
    pushedUnpricedEventCount: canonicalBudget?.pushedUnpricedEventCount ?? 0,
    pushedUnclassifiedCostEventCount:
      canonicalBudget?.pushedUnclassifiedCostEventCount ?? 0,
    spendCoverage: canonicalBudget?.spendCoverage ?? "unknown",
    subscriptionMonthToDateUsd:
      canonicalBudget?.subscriptionMonthToDateUsd ?? 0,
    fixedMonthlyCostUsd: canonicalBudget?.fixedMonthlyCostUsd ?? 0,
    fixedAccruedUsd: canonicalBudget?.fixedAccruedUsd ?? 0,
    linkedFixedDedupeUsd: canonicalBudget?.linkedFixedDedupeUsd ?? 0,
    fixedCostConflict: canonicalBudget?.fixedCostConflict ?? false,
    forecastedSubscriptionRenewalsUsd:
      canonicalBudget?.forecastedSubscriptionRenewalsUsd ?? 0,
    projectedEomUsd:
      canonicalBudget?.projectedEomUsd ??
      (canonicalBudget != null ? alertState.projectedEomUsd : null),
    billingMode: alertState.billingMode,
    duplicateNameWarning:
      duplicateProviderIds.length > 1
        ? { providerIds: duplicateProviderIds }
        : null,
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (shouldEnforceDashboardSession() && !hasValidDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const existing = await prisma.provider.findUnique({
    where: { id },
    include: { plan: { select: { fixedMonthlyCostUsd: true } } },
  });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let input;
  try {
    input = parseProviderUpdateInput(await readJsonBody(request), existing.name);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: 400 }
    );
  }

  if (input.isActive === true && isDecommissionedProviderName(existing.name)) {
    return NextResponse.json(
      { error: "This built-in provider is dormant or retired and cannot be reactivated" },
      { status: 409 }
    );
  }

  const credentialManaged = hasStPrimaryCredentialOwnership(
    existing.config,
    existing.secretConfig,
    existing.label
  );
  if (credentialManaged) {
    const clearsManagedBinding =
      input.config === null ||
      input.secretConfigOperations?.some(
        (operation) => operation.path[0] === "infisicalCredential"
      );
    const changesManagedLabel =
      input.label !== undefined && input.label !== existing.label;
    if (
      input.apiKey !== undefined ||
      input.isActive !== undefined ||
      clearsManagedBinding ||
      changesManagedLabel
    ) {
      return NextResponse.json(
        {
          error:
            "This provider's credential, active state, and label are managed by Infisical",
        },
        { status: 409 }
      );
    }
  }
  if (
    containsProviderManagementClaim(input.config) ||
    (!credentialManaged && isReservedStPrimaryManagedLabel(input.label))
  ) {
    return NextResponse.json(
      { error: "Provider credential-management metadata is server-only" },
      { status: 400 }
    );
  }

  const updateData: Prisma.ProviderUpdateInput = {};
  if (input.displayName !== undefined) updateData.displayName = input.displayName;
  if (input.config !== undefined) {
    if (input.config === null) {
      updateData.config = Prisma.JsonNull;
      updateData.secretConfig = null;
    }
  }
  const hasSecretConfigOperations =
    (input.secretConfigOperations?.length ?? 0) > 0;
  if (
    input.config !== null &&
    (input.config !== undefined || hasSecretConfigOperations)
  ) {
    const legacy = splitProviderConfig(existing.config);
    const incoming = splitProviderConfig(input.config);
    const publicConfig =
      input.config !== undefined ? incoming.publicConfig : legacy.publicConfig;
    updateData.config = Object.keys(publicConfig).length > 0
      ? (publicConfig as Prisma.InputJsonObject)
      : Prisma.JsonNull;

    // Hidden secret values are omitted by the edit UI, so updates merge any
    // newly supplied values into the existing encrypted/legacy secret set.
    // Explicit per-field clear operations run last and cannot erase siblings.
    let existingSecrets = legacy.secretConfig;
    if (existing.secretConfig) {
      try {
        existingSecrets = mergeProviderConfig(
          legacy.secretConfig,
          decryptProviderSecretConfig(existing.secretConfig)
        );
      } catch {
        return NextResponse.json(
          { error: "Stored provider secret configuration cannot be decrypted" },
          { status: 500 }
        );
      }
    }

    const mergedSecrets = mergeProviderConfig(
      existingSecrets,
      incoming.secretConfig
    );
    for (const operation of input.secretConfigOperations ?? []) {
      let current: Record<string, unknown> | undefined = mergedSecrets;
      for (let i = 0; i < operation.path.length - 1; i++) {
        if (current && typeof current === "object" && !Array.isArray(current)) {
          current = current[operation.path[i]] as Record<string, unknown> | undefined;
        } else {
          current = undefined;
          break;
        }
      }
      if (current && typeof current === "object" && !Array.isArray(current)) {
        delete current[operation.path[operation.path.length - 1]];
      }
    }
    updateData.secretConfig = hasProviderSecrets(mergedSecrets)
      ? encryptJson(mergedSecrets)
      : null;
  }
  if (input.isActive !== undefined) updateData.isActive = input.isActive;
  if (input.refreshIntervalMin !== undefined) {
    updateData.refreshIntervalMin = input.refreshIntervalMin;
  }
  if (input.groupId !== undefined) updateData.groupId = input.groupId;
  if (input.billingAccountId !== undefined) {
    updateData.billingAccountIdentity = input.billingAccountId
      ? hashProviderBillingAccountId(existing.name, input.billingAccountId)
      : null;
  }
  if (input.label !== undefined) updateData.label = input.label;
  if (input.apiKey !== undefined) {
    updateData.apiKey = input.apiKey === null ? null : encrypt(input.apiKey);
  }
  if (input.plan !== undefined) {
    const planData = toPrismaProviderPlanData(input.plan);
    const nextFixed =
      planData.fixedMonthlyCostUsd === undefined
        ? existing.plan?.fixedMonthlyCostUsd
        : planData.fixedMonthlyCostUsd;
    if (nextFixed != null && Number(nextFixed) > 0) {
      const activeSubscription = await prisma.subscription.findFirst({
        where: {
          providerId: id,
          status: { in: ["active", "considering"] },
        },
        select: { id: true },
      });
      if (activeSubscription) {
        return NextResponse.json(
          {
            error:
              "This provider already has an active/considering Subscription. Clear Plan price / mo or cancel the Subscription — modeling the same fee both ways double-counts spend.",
          },
          { status: 400 }
        );
      }
    }
    updateData.plan = {
      upsert: {
        create: planData,
        update: planData,
      },
    };
  }
  if (input.allocations !== undefined) {
    updateData.allocations = {
      deleteMany: {},
      create: input.allocations.map((a) => ({
        projectId: a.projectId,
        percentage: a.percentage,
      })),
    };
  }
  if (
    input.isActive !== undefined ||
    input.refreshIntervalMin !== undefined ||
    input.plan !== undefined ||
    input.apiKey !== undefined ||
    input.config !== undefined ||
    hasSecretConfigOperations
  ) {
    // Keep the alert revision in the same provider update as every config
    // field that can change the evaluated alert set without a new snapshot.
    updateData.alertConfigGeneration = { increment: 1 };
  }

  const provider = await prisma.provider.update({
    where: { id },
    data: updateData,
    select: {
      id: true,
      name: true,
      displayName: true,
      type: true,
      isActive: true,
      refreshIntervalMin: true,
      groupId: true,
      label: true,
      allocations: {
        select: {
          projectId: true,
          percentage: true,
        },
      },
      plan: true,
      createdAt: true,
    },
  });

  bustBudgetStatusCache();

  return NextResponse.json(provider);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (shouldEnforceDashboardSession() && !hasValidDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const existing = await prisma.provider.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (hasStPrimaryCredentialOwnership(
    existing.config,
    existing.secretConfig,
    existing.label
  )) {
    return NextResponse.json(
      { error: "Infisical-managed providers cannot be deleted" },
      { status: 409 }
    );
  }

  await prisma.provider.delete({ where: { id } });
  bustBudgetStatusCache();
  return NextResponse.json({ success: true });
}
