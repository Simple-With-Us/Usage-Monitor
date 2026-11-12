import { prisma } from "@/lib/prisma";
import { canonicalProjectKey } from "@/lib/provider-identity";
import { splitProviderConfig } from "@/lib/provider-secret-config";
import { bustBudgetStatusCache } from "@/lib/budget-status";
import { Prisma } from "@prisma/client";

export const WORKSPACE_EXPORT_FORMAT = "usage-monitor-local-export";
export const WORKSPACE_EXPORT_VERSION = 1;

const MAX_SNAPSHOTS = 200;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stripSecretsFromPublicConfig(
  config: unknown
): Record<string, unknown> {
  return splitProviderConfig(config).publicConfig;
}

export interface WorkspaceExportPayload {
  format: typeof WORKSPACE_EXPORT_FORMAT;
  formatVersion: typeof WORKSPACE_EXPORT_VERSION;
  source: "usage-monitor-remote";
  exportedAt: string;
  note: string;
  copyInstructions: string;
  projects: Array<Record<string, unknown>>;
  providers: Array<Record<string, unknown>>;
  plans: Array<Record<string, unknown>>;
  subscriptions: Array<Record<string, unknown>>;
  charges: Array<Record<string, unknown>>;
  snapshots: Array<Record<string, unknown>>;
  allocations: Array<Record<string, unknown>>;
}

export async function buildWorkspaceExport(): Promise<WorkspaceExportPayload> {
  const [projects, providers, subscriptions] = await Promise.all([
    prisma.project.findMany({ orderBy: { name: "asc" } }),
    prisma.provider.findMany({
      include: {
        plan: true,
        allocations: true,
      },
      orderBy: { displayName: "asc" },
    }),
    prisma.subscription.findMany({
      orderBy: { name: "asc" },
    }),
  ]);

  const providerIds = providers.map((provider) => provider.id);
  const snapshots =
    providerIds.length === 0
      ? []
      : await prisma.usageSnapshot.findMany({
          where: { providerId: { in: providerIds } },
          orderBy: { fetchedAt: "desc" },
          take: MAX_SNAPSHOTS,
          select: {
            id: true,
            providerId: true,
            fetchedAt: true,
            balance: true,
            totalCost: true,
            fixedCostIncludedUsd: true,
            credits: true,
          },
        });

  return {
    format: WORKSPACE_EXPORT_FORMAT,
    formatVersion: WORKSPACE_EXPORT_VERSION,
    source: "usage-monitor-remote",
    exportedAt: new Date().toISOString(),
    note: "No API keys or secrets.  Re-enter keys after import on a new device or local instance.  There is no bundle key for this file.",
    copyInstructions:
      "This JSON is the Usage Monitor Local package.  In Usage Monitor Local: Settings → Import Package, then pick this file.  There is no bundle key or passphrase.  API keys are not included.  Optional: a separate Mac .umkeys file is only for Import Keys.",
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description,
      monthlyBudgetUsd: project.monthlyBudgetUsd,
    })),
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      displayName: provider.displayName,
      type: provider.type,
      adapterKind: provider.name,
      category: provider.category,
      isActive: false,
      refreshIntervalMin: provider.refreshIntervalMin,
      label: provider.label,
      hasKeychainCredential: Boolean(provider.apiKey || provider.secretConfig),
      publicConfig: stripSecretsFromPublicConfig(provider.config),
    })),
    plans: providers.flatMap((provider) =>
      provider.plan
        ? [
            {
              providerId: provider.id,
              billingMode: provider.plan.billingMode,
              fixedMonthlyCostUsd: provider.plan.fixedMonthlyCostUsd,
              monthlyBudgetUsd: provider.plan.monthlyBudgetUsd,
              monthlyRequestLimit: provider.plan.monthlyRequestLimit,
              billingInterval: provider.plan.billingInterval,
              notes: provider.plan.notes,
            },
          ]
        : []
    ),
    subscriptions: subscriptions.map((subscription) => ({
      id: subscription.id,
      providerId: subscription.providerId,
      projectId: subscription.projectId,
      name: subscription.name,
      costUsd: subscription.costUsd,
      interval: subscription.interval,
      status: subscription.status,
      currentPeriodStart: iso(subscription.currentPeriodStart),
      nextRenewalAt: iso(subscription.nextRenewalAt),
    })),
    charges: [],
    snapshots: snapshots.map((snapshot) => ({
      id: snapshot.id,
      providerId: snapshot.providerId,
      fetchedAt: iso(snapshot.fetchedAt),
      balance: snapshot.balance,
      totalCost: snapshot.totalCost,
      fixedCostIncludedUsd: snapshot.fixedCostIncludedUsd,
      credits: snapshot.credits,
    })),
    allocations: providers.flatMap((provider) =>
      provider.allocations.map((allocation) => ({
        providerId: provider.id,
        projectId: allocation.projectId,
        percentage: allocation.percentage,
      }))
    ),
  };
}

export interface WorkspaceImportResult {
  projects: number;
  providers: number;
  plans: number;
  subscriptions: number;
  snapshots: number;
  allocations: number;
  skipped: number;
}

export async function importWorkspacePayload(
  payload: unknown,
  mode: "merge" | "replace" = "merge"
): Promise<WorkspaceImportResult> {
  const root = asRecord(payload);
  if (!root) throw new Error("Import body must be a JSON object");
  const format = asString(root.format);
  if (format !== WORKSPACE_EXPORT_FORMAT) {
    throw new Error("Unrecognized export format");
  }
  const version = asNumber(root.formatVersion) ?? 0;
  if (version !== WORKSPACE_EXPORT_VERSION) {
    throw new Error(`Unsupported export version ${version}`);
  }

  if (mode === "replace") {
    throw new Error(
      "Replace import is not offered on the server workspace. Use merge, which never overwrites existing rows."
    );
  }

  let skipped = 0;
  let nProjects = 0;
  let nProviders = 0;
  let nPlans = 0;
  let nSubs = 0;
  let nSnaps = 0;
  let nAlloc = 0;

  const projectIdMap = new Map<string, string>();
  const existingProjects = await prisma.project.findMany({
    select: { id: true, name: true, nameKey: true },
  });
  for (const row of existingProjects) {
    projectIdMap.set(row.id, row.id);
    projectIdMap.set(canonicalProjectKey(row.name), row.id);
  }

  const projects = Array.isArray(root.projects) ? root.projects : [];
  for (const raw of projects) {
    const row = asRecord(raw);
    if (!row) {
      skipped += 1;
      continue;
    }
    const name = asString(row.name);
    if (!name) {
      skipped += 1;
      continue;
    }
    const incomingId = asString(row.id);
    const key = canonicalProjectKey(name);
    const existingId =
      (incomingId ? projectIdMap.get(incomingId) : undefined) ??
      projectIdMap.get(key);
    if (existingId) {
      projectIdMap.set(key, existingId);
      if (incomingId) projectIdMap.set(incomingId, existingId);
      skipped += 1;
      continue;
    }
    const created = await prisma.project.create({
      data: {
        id: incomingId ?? undefined,
        name,
        nameKey: key,
        description: asString(row.description),
        monthlyBudgetUsd: asNumber(row.monthlyBudgetUsd),
      },
    });
    projectIdMap.set(created.id, created.id);
    projectIdMap.set(key, created.id);
    if (incomingId) projectIdMap.set(incomingId, created.id);
    nProjects += 1;
  }

  const providerIdMap = new Map<string, string>();
  const existingProviders = await prisma.provider.findMany({
    select: { id: true, name: true, displayName: true },
  });
  // Merge is add-missing only. An iOS Local export uses this same format and
  // omits null plan fields; upserting onto a live server would wipe budgets
  // and could attach extra local subscriptions/snapshots to existing rows.
  const preexistingProviderIds = new Set(
    existingProviders.map((row) => row.id)
  );
  for (const row of existingProviders) {
    providerIdMap.set(row.id, row.id);
    providerIdMap.set(`${row.name.toLowerCase()}::${row.displayName.toLowerCase()}`, row.id);
  }

  const providers = Array.isArray(root.providers) ? root.providers : [];
  for (const raw of providers) {
    const row = asRecord(raw);
    if (!row) {
      skipped += 1;
      continue;
    }
    const name = asString(row.name);
    const displayName = asString(row.displayName);
    if (!name || !displayName) {
      skipped += 1;
      continue;
    }
    const incomingId = asString(row.id);
    const identityKey = `${name.toLowerCase()}::${displayName.toLowerCase()}`;
    const existingId =
      (incomingId ? providerIdMap.get(incomingId) : undefined) ??
      providerIdMap.get(identityKey);
    const publicConfig = stripSecretsFromPublicConfig(
      row.publicConfig ?? row.config
    );
    if (existingId) {
      providerIdMap.set(identityKey, existingId);
      if (incomingId) providerIdMap.set(incomingId, existingId);
      skipped += 1;
      continue;
    }
    const created = await prisma.provider.create({
      data: {
        id: incomingId ?? undefined,
        name,
        displayName,
        type: asString(row.type) ?? "builtin",
        category: asString(row.category) ?? "api",
        isActive: false,
        refreshIntervalMin: asNumber(row.refreshIntervalMin) ?? 60,
        label: asString(row.label),
        config: publicConfig as Prisma.InputJsonValue,
      },
    });
    providerIdMap.set(created.id, created.id);
    providerIdMap.set(identityKey, created.id);
    if (incomingId) providerIdMap.set(incomingId, created.id);
    nProviders += 1;
  }

  const plans = Array.isArray(root.plans) ? root.plans : [];
  for (const raw of plans) {
    const row = asRecord(raw);
    if (!row) {
      skipped += 1;
      continue;
    }
    const incomingProviderId = asString(row.providerId);
    const providerId = incomingProviderId
      ? providerIdMap.get(incomingProviderId)
      : undefined;
    if (!providerId || preexistingProviderIds.has(providerId)) {
      skipped += 1;
      continue;
    }
    const existingPlan = await prisma.providerPlan.findUnique({
      where: { providerId },
    });
    if (existingPlan) {
      skipped += 1;
      continue;
    }
    await prisma.providerPlan.create({
      data: {
        providerId,
        billingMode: asString(row.billingMode) ?? "manual",
        fixedMonthlyCostUsd: asNumber(row.fixedMonthlyCostUsd),
        monthlyBudgetUsd: asNumber(row.monthlyBudgetUsd),
        monthlyRequestLimit: asNumber(row.monthlyRequestLimit),
        billingInterval: asString(row.billingInterval),
        notes: asString(row.notes),
      },
    });
    nPlans += 1;
  }

  const subscriptions = Array.isArray(root.subscriptions)
    ? root.subscriptions
    : [];
  for (const raw of subscriptions) {
    const row = asRecord(raw);
    if (!row) {
      skipped += 1;
      continue;
    }
    const incomingProviderId = asString(row.providerId);
    const providerId = incomingProviderId
      ? providerIdMap.get(incomingProviderId)
      : undefined;
    const name = asString(row.name);
    const costUsd = asNumber(row.costUsd);
    if (!providerId || preexistingProviderIds.has(providerId) || !name || costUsd == null) {
      skipped += 1;
      continue;
    }
    const incomingId = asString(row.id);
    const existing = incomingId
      ? await prisma.subscription.findUnique({ where: { id: incomingId } })
      : await prisma.subscription.findFirst({
          where: { providerId, name },
        });
    const periodStart =
      asString(row.currentPeriodStart) ?? new Date().toISOString();
    const nextRenewal =
      asString(row.nextRenewalAt) ?? new Date().toISOString();
    const incomingProjectId = asString(row.projectId);
    const projectId = incomingProjectId
      ? projectIdMap.get(incomingProjectId) ?? null
      : null;
    if (existing) {
      skipped += 1;
      continue;
    }
    await prisma.subscription.create({
      data: {
        id: incomingId ?? undefined,
        providerId,
        projectId,
        name,
        costUsd,
        interval: asString(row.interval) ?? "monthly",
        status: asString(row.status) ?? "active",
        startDate: new Date(periodStart),
        currentPeriodStart: new Date(periodStart),
        nextRenewalAt: new Date(nextRenewal),
      },
    });
    nSubs += 1;
  }

  const snapshots = Array.isArray(root.snapshots) ? root.snapshots : [];
  for (const raw of snapshots.slice(0, MAX_SNAPSHOTS)) {
    const row = asRecord(raw);
    if (!row) {
      skipped += 1;
      continue;
    }
    const incomingProviderId = asString(row.providerId);
    const providerId = incomingProviderId
      ? providerIdMap.get(incomingProviderId)
      : undefined;
    const fetchedAt = asString(row.fetchedAt);
    if (!providerId || preexistingProviderIds.has(providerId) || !fetchedAt) {
      skipped += 1;
      continue;
    }
    const incomingId = asString(row.id);
    if (incomingId) {
      const exists = await prisma.usageSnapshot.findUnique({
        where: { id: incomingId },
      });
      if (exists) {
        skipped += 1;
        continue;
      }
    }
    await prisma.usageSnapshot.create({
      data: {
        id: incomingId ?? undefined,
        providerId,
        fetchedAt: new Date(fetchedAt),
        balance: asNumber(row.balance),
        totalCost: asNumber(row.totalCost),
        fixedCostIncludedUsd: asNumber(row.fixedCostIncludedUsd),
        credits: asNumber(row.credits),
      },
    });
    nSnaps += 1;
  }

  const allocations = Array.isArray(root.allocations) ? root.allocations : [];
  for (const raw of allocations) {
    const row = asRecord(raw);
    if (!row) {
      skipped += 1;
      continue;
    }
    const incomingProviderId = asString(row.providerId);
    const incomingProjectId = asString(row.projectId);
    const providerId = incomingProviderId
      ? providerIdMap.get(incomingProviderId)
      : undefined;
    const projectId = incomingProjectId
      ? projectIdMap.get(incomingProjectId)
      : undefined;
    const percentage = asNumber(row.percentage);
    if (
      !providerId ||
      preexistingProviderIds.has(providerId) ||
      !projectId ||
      percentage == null
    ) {
      skipped += 1;
      continue;
    }
    const existing = await prisma.providerProjectAllocation.findFirst({
      where: { providerId, projectId },
    });
    if (existing) {
      skipped += 1;
      continue;
    }
    await prisma.providerProjectAllocation.create({
      data: { providerId, projectId, percentage },
    });
    nAlloc += 1;
  }

  bustBudgetStatusCache();
  return {
    projects: nProjects,
    providers: nProviders,
    plans: nPlans,
    subscriptions: nSubs,
    snapshots: nSnaps,
    allocations: nAlloc,
    skipped,
  };
}
