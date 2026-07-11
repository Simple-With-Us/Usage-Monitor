import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encrypt, encryptJson } from "@/lib/crypto";
import { parseProviderUpdateInput, readJsonBody } from "@/lib/provider-input";
import { buildProviderAlertState } from "@/lib/provider-alerts";
import { computeBudgetStatus } from "@/lib/budget-status";
import { toPrismaProviderPlanData } from "@/lib/provider-plan";
import {
  decryptProviderSecretConfig,
  hasProviderSecrets,
  mergeProviderConfig,
  providerConfigForClient,
  splitProviderConfig,
} from "@/lib/provider-secret-config";

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

  const { snapshots, config, secretConfig, ...rest } = provider;
  const clientConfig = providerConfigForClient(config, secretConfig);
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
    latestSnapshot,
    alerts: canonicalBudget?.alerts ?? alertState.alerts,
    estimatedMonthlyCostUsd: alertState.estimatedMonthlyCostUsd,
    spentUsd: canonicalBudget?.spentUsd ?? latestSnapshot?.totalCost ?? 0,
    snapshotCostUsd:
      canonicalBudget?.snapshotCostUsd ?? latestSnapshot?.totalCost ?? null,
    pushedMonthToDateUsd: canonicalBudget?.pushedMonthToDateUsd ?? 0,
    fixedMonthlyCostUsd: canonicalBudget?.fixedMonthlyCostUsd ?? 0,
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
  if (input.displayName !== undefined) updateData.displayName = input.displayName;
  if (input.config !== undefined) {
    if (input.config === null) {
      updateData.config = Prisma.JsonNull;
      updateData.secretConfig = null;
    } else {
      const incoming = splitProviderConfig(input.config);
      updateData.config = Object.keys(incoming.publicConfig).length > 0
        ? (incoming.publicConfig as Prisma.InputJsonObject)
        : Prisma.JsonNull;

      // Hidden secret values are omitted by the edit UI, so updates merge any
      // newly supplied values into the existing encrypted/legacy secret set.
      // Explicit `config: null` above is the deliberate clear-all operation.
      const legacySecrets = splitProviderConfig(existing.config).secretConfig;
      let existingSecrets = legacySecrets;
      if (existing.secretConfig) {
        try {
          existingSecrets = mergeProviderConfig(
            legacySecrets,
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
      updateData.secretConfig = hasProviderSecrets(mergedSecrets)
        ? encryptJson(mergedSecrets)
        : null;
    }
  }
  if (input.isActive !== undefined) updateData.isActive = input.isActive;
  if (input.refreshIntervalMin !== undefined) {
    updateData.refreshIntervalMin = input.refreshIntervalMin;
  }
  if (input.groupId !== undefined) updateData.groupId = input.groupId;
  if (input.label !== undefined) updateData.label = input.label;
  if (input.apiKey !== undefined) {
    updateData.apiKey = encrypt(input.apiKey);
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
