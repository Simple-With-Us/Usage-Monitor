import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encrypt, encryptJson } from "@/lib/crypto";
import { parseProviderUpdateInput, readJsonBody } from "@/lib/provider-input";
import { buildProviderAlertState } from "@/lib/provider-alerts";
import { computeBudgetStatus } from "@/lib/budget-status";
import { toPrismaProviderPlanData } from "@/lib/provider-plan";
import {
  applyProviderSecretConfigOperations,
  decryptProviderSecretConfig,
  hasProviderSecrets,
  mergeProviderConfig,
  providerConfigForClient,
  splitProviderConfig,
} from "@/lib/provider-secret-config";
import { providerApiKeyState } from "@/lib/provider-api-key-state";

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

  const { snapshots, apiKey, config, secretConfig, ...rest } = provider;
  const clientConfig = providerConfigForClient(config, secretConfig);
  const apiKeyState = providerApiKeyState(apiKey);
  const latestSnapshot = snapshots[0] ?? null;
  const alertState = buildProviderAlertState({
    isActive: provider.isActive,
    refreshIntervalMin: provider.refreshIntervalMin,
    plan: provider.plan,
    latestSnapshot,
  });
  const canonicalBudget = budget.providers.find((entry) => entry.id === id);
  const duplicateProviderIds = providerNames
    .filter(
      (entry) =>
        entry.name.trim().toLowerCase() === provider.name.trim().toLowerCase()
    )
    .map((entry) => entry.id)
    .sort();

  return NextResponse.json({
    ...rest,
    ...clientConfig,
    ...apiKeyState,
    latestSnapshot,
    alerts: canonicalBudget?.alerts ?? alertState.alerts,
    estimatedMonthlyCostUsd: alertState.estimatedMonthlyCostUsd,
    spentUsd: canonicalBudget?.spentUsd ?? latestSnapshot?.totalCost ?? 0,
    snapshotCostUsd:
      canonicalBudget?.snapshotCostUsd ?? latestSnapshot?.totalCost ?? null,
    snapshotCostFetchedAt: canonicalBudget?.snapshotCostFetchedAt ?? null,
    snapshotFixedCostIncludedUsd:
      canonicalBudget?.snapshotFixedCostIncludedUsd ?? 0,
    snapshotCostIncludesUnknownFixed:
      canonicalBudget?.snapshotCostIncludesUnknownFixed ?? false,
    pushedMonthToDateUsd: canonicalBudget?.pushedMonthToDateUsd ?? 0,
    subscriptionMonthToDateUsd:
      canonicalBudget?.subscriptionMonthToDateUsd ?? 0,
    fixedMonthlyCostUsd: canonicalBudget?.fixedMonthlyCostUsd ?? 0,
    fixedAccruedUsd: canonicalBudget?.fixedAccruedUsd ?? 0,
    linkedFixedDedupeUsd: canonicalBudget?.linkedFixedDedupeUsd ?? 0,
    fixedCostConflict: canonicalBudget?.fixedCostConflict ?? false,
    forecastedSubscriptionRenewalsUsd:
      canonicalBudget?.forecastedSubscriptionRenewalsUsd ?? 0,
    projectedEomUsd:
      canonicalBudget?.projectedEomUsd ?? alertState.projectedEomUsd,
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
  const { id } = await params;

  const existing = await prisma.provider.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let input;
  try {
    input = parseProviderUpdateInput(await readJsonBody(request));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: 400 }
    );
  }

  const updateData: Prisma.ProviderUpdateInput = {};
  if (input.allocations?.length) {
    const projectIds = input.allocations.map((allocation) => allocation.projectId);
    const projects = await prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true },
    });
    if (projects.length !== projectIds.length) {
      return NextResponse.json(
        { error: "allocations contains an unknown projectId" },
        { status: 400 }
      );
    }
  }
  if (input.displayName !== undefined) updateData.displayName = input.displayName;
  if (input.config !== undefined) {
    if (input.config === null) {
      updateData.config = Prisma.JsonNull;
      updateData.secretConfig = null;
    }
  }
  const hasSecretOperations = (input.secretConfigOperations?.length ?? 0) > 0;
  if (input.config !== null && (input.config !== undefined || hasSecretOperations)) {
    const legacy = splitProviderConfig(existing.config);
    const incoming = splitProviderConfig(input.config);
    const publicConfig = input.config !== undefined
      ? incoming.publicConfig
      : legacy.publicConfig;
    updateData.config = Object.keys(publicConfig).length > 0
      ? (publicConfig as Prisma.InputJsonObject)
      : Prisma.JsonNull;

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

    const nextSecrets = applyProviderSecretConfigOperations(
      existingSecrets,
      incoming.secretConfig,
      input.secretConfigOperations
    );
    updateData.secretConfig = hasProviderSecrets(nextSecrets)
      ? encryptJson(nextSecrets)
      : null;
  }
  if (input.isActive !== undefined) updateData.isActive = input.isActive;
  if (input.refreshIntervalMin !== undefined) {
    updateData.refreshIntervalMin = input.refreshIntervalMin;
  }
  if (input.groupId !== undefined) updateData.groupId = input.groupId;
  if (input.label !== undefined) updateData.label = input.label;
  if (input.apiKeyOperation.action === "replace") {
    updateData.apiKey = encrypt(input.apiKeyOperation.value);
  } else if (input.apiKeyOperation.action === "clear") {
    updateData.apiKey = null;
  }
  if (input.plan !== undefined) {
    const planData = toPrismaProviderPlanData(input.plan);
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

  return NextResponse.json(provider);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const existing = await prisma.provider.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.provider.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
