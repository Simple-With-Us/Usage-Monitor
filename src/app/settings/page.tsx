"use client";

import { Suspense, useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import AddProviderModal, {
  type ProviderSecretConfigOperation,
} from "@/components/AddProviderModal";
import AddProjectModal, { Project } from "@/components/AddProjectModal";
import AddSubscriptionModal, { type SubscriptionFormValue } from "@/components/AddSubscriptionModal";
import SubscriptionsPanel, { type SubscriptionRow } from "@/components/SubscriptionsPanel";
import ProviderTable from "@/components/ProviderTable";
import ProjectTable from "@/components/ProjectTable";
import type { ExternalBillingRecord } from "@/components/ExternalBillingDetails";
import PaidServicesPanel from "@/components/PaidServicesPanel";
import type {
  ProviderCostCoverage,
  ProviderCostCoverageCaveat,
} from "@/components/ProviderCard";

export type BillingMode = "actual" | "estimated" | "manual";
type SettingsTab = "connections" | "services" | "projects";

export interface ProviderPlan {
  billingMode: BillingMode;
  fixedMonthlyCostUsd: number | null;
  monthlyBudgetUsd: number | null;
  monthlyRequestLimit: number | null;
  lowBalanceUsd: number | null;
  lowCredits: number | null;
  renewalDate: string | null;
  billingInterval: string | null;
  mustKeepFunded: boolean;
  notes: string | null;
}

export interface ProviderAlert {
  severity: "critical" | "warning" | "info";
  message: string;
}

export interface Provider {
  id: string;
  name: string;
  displayName: string;
  type: string;
  config?: Record<string, unknown>;
  isActive: boolean;
  refreshIntervalMin: number;
  groupId: string | null;
  label: string | null;
  keyPreview?: string | null;
  anthropicAdminApiConfigured?: boolean;
  geminiKeyStatus?: {
    state: "valid" | "invalid" | "unreadable" | "unavailable" | "unchecked" | "not_configured";
    httpStatus: number | null;
    availableModelCount: number | null;
    checkedAt: string | null;
  } | null;
  geminiBillingStatus?: {
    state: "ready" | "pending" | "error" | "configuration_changed" | "unchecked" | "not_configured";
    errorCode: string | null;
    httpStatus: number | null;
    retryable: boolean;
    checkedAt: string | null;
  } | null;
  geminiMonitoringStatus?: {
    state: "ready" | "empty" | "partial" | "permission_denied" | "error" | "configuration_changed" | "project_required" | "credential_required" | "unchecked" | "not_configured";
    projectId: string | null;
    errorCode: string | null;
    httpStatus: number | null;
    retryable: boolean;
    checkedAt: string | null;
  } | null;
  plan: ProviderPlan | null;
  allocations: { projectId: string; percentage: number }[];
  externalBilling?: ExternalBillingRecord[];
  secretConfigMeta?: { configured: boolean; fields: string[]; readable: boolean };
  credentialManagement?: {
    source: "infisical";
    scope: "st-primary";
    label: string;
    status: "active" | "revoked";
    alias: boolean;
    readOnlyFields: readonly string[];
  } | null;
  alerts: ProviderAlert[];
  estimatedMonthlyCostUsd: number;
  spentUsd?: number;
  snapshotCostFetchedAt?: string | null;
  projectedEomUsd?: number;
  spendCoverage: ProviderCostCoverage;
  costCoverageCaveat?: ProviderCostCoverageCaveat | null;
  pushedCostCoverage: ProviderCostCoverage;
  pushedPricedEventCount: number;
  pushedUnpricedEventCount: number;
  pushedUnclassifiedCostEventCount: number;
  billingMode: BillingMode;
  createdAt: string;
  latestSnapshot: {
    balance: number | null;
    totalCost: number | null;
    totalRequests: number | null;
    credits: number | null;
    fetchedAt: string;
  } | null;
}

function parseSettingsTab(value: string | null): SettingsTab {
  if (value === "projects") return "projects";
  if (value === "services" || value === "billing") return "services";
  return "connections";
}

function SettingsPageContent() {
  const searchParams = useSearchParams();
  const activeTab = parseSettingsTab(searchParams.get("tab"));
  const [providers, setProviders] = useState<Provider[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [subscriptionsLoading, setSubscriptionsLoading] = useState(true);
  const [error, setError] = useState("");
  const [loadErrors, setLoadErrors] = useState<Partial<Record<SettingsTab, string>>>({});
  const [modalOpen, setModalOpen] = useState(false);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [subscriptionModalOpen, setSubscriptionModalOpen] = useState(false);
  const [editProvider, setEditProvider] = useState<Provider | null>(null);
  const [editProject, setEditProject] = useState<Project | null>(null);
  const [editSubscription, setEditSubscription] = useState<SubscriptionFormValue | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleteProjectConfirm, setDeleteProjectConfirm] = useState<string | null>(null);
  const [deleteSubscriptionConfirm, setDeleteSubscriptionConfirm] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const providersLoaded = useRef(false);
  const projectsLoaded = useRef(false);
  const subscriptionsLoaded = useRef(false);

  const fetchProviders = useCallback(async () => {
    try {
      if (!providersLoaded.current) setLoading(true);
      setLoadErrors((current) => ({ ...current, connections: undefined }));
      const res = await fetch("/api/providers");
      if (!res.ok) throw new Error("Failed to fetch providers");
      const data = await res.json();
      setProviders(data);
      providersLoaded.current = true;
    } catch (err) {
      setLoadErrors((current) => ({
        ...current,
        connections: err instanceof Error ? err.message : "Failed to load providers",
      }));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchProjects = useCallback(async () => {
    try {
      if (!projectsLoaded.current) setProjectsLoading(true);
      setLoadErrors((current) => ({ ...current, projects: undefined }));
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error("Failed to fetch projects");
      const data = await res.json();
      setProjects(data);
      projectsLoaded.current = true;
    } catch (err) {
      setLoadErrors((current) => ({
        ...current,
        projects: err instanceof Error ? err.message : "Failed to load projects",
      }));
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  const fetchSubscriptions = useCallback(async () => {
    try {
      if (!subscriptionsLoaded.current) setSubscriptionsLoading(true);
      setLoadErrors((current) => ({ ...current, services: undefined }));
      const res = await fetch("/api/subscriptions");
      if (!res.ok) throw new Error("Failed to fetch subscriptions");
      const data = await res.json();
      setSubscriptions(data);
      subscriptionsLoaded.current = true;
    } catch (err) {
      setLoadErrors((current) => ({
        ...current,
        services: err instanceof Error ? err.message : "Failed to load subscriptions",
      }));
    } finally {
      setSubscriptionsLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/exhaustive-deps -- data fetching on mount
    fetchProviders();
    fetchProjects();
    fetchSubscriptions();
  }, [fetchProviders, fetchProjects, fetchSubscriptions]);

  const handleSave = async (provider: {
    id?: string;
    name: string;
    displayName: string;
    type: string;
    apiKey?: string;
    config?: Record<string, unknown>;
    secretConfigOperations?: ProviderSecretConfigOperation[];
    label?: string | null;
    refreshIntervalMin?: number;
    plan?: ProviderPlan | null;
    allocations?: { projectId: string; percentage: number }[];
  }) => {
    if (provider.id) {
      const res = await fetch(`/api/providers/${provider.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: provider.displayName,
          apiKey: provider.apiKey,
          config: provider.config,
          secretConfigOperations: provider.secretConfigOperations,
          label: provider.label,
          refreshIntervalMin: provider.refreshIntervalMin,
          plan: provider.plan,
          allocations: provider.allocations ?? [],
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to update");
      }
    } else {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(provider),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create");
      }
    }
    await fetchProviders();
    setEditProvider(null);
  };

  const handleDelete = async (id: string) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      await fetchProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setActionLoading(null);
      setDeleteConfirm(null);
    }
  };

  const handleSaveProject = async (project: Project) => {
    if (project.id) {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(project),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to update project");
      }
    } else {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(project),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create project");
      }
    }
    await fetchProjects();
    setEditProject(null);
  };

  const handleDeleteProject = async (id: string) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete project");
      await fetchProjects();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete project");
    } finally {
      setActionLoading(null);
      setDeleteProjectConfirm(null);
    }
  };

  const handleSaveSubscription = async (subscription: SubscriptionFormValue) => {
    const url = subscription.id ? `/api/subscriptions/${subscription.id}` : "/api/subscriptions";
    const res = await fetch(url, {
      method: subscription.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to save subscription");
    }
    await fetchSubscriptions();
    setEditSubscription(null);
  };

  const handleDeleteSubscription = async (id: string) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/subscriptions/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete subscription");
      await fetchSubscriptions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete subscription");
    } finally {
      setActionLoading(null);
      setDeleteSubscriptionConfirm(null);
    }
  };

  const handleToggleActive = async (provider: Provider) => {
    setActionLoading(provider.id);
    try {
      const res = await fetch(`/api/providers/${provider.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !provider.isActive }),
      });
      if (!res.ok) throw new Error("Failed to update");
      await fetchProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setActionLoading(null);
    }
  };

  const handleFetchNow = async (id: string) => {
    setActionLoading(id);
    try {
      const res = await fetch(`/api/providers/${id}/fetch`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
          code?: unknown;
        } | null;
        const message =
          typeof body?.error === "string" && body.error.trim()
            ? body.error.trim()
            : "Failed to fetch provider";
        const code =
          typeof body?.code === "string" && body.code.trim()
            ? body.code.trim()
            : null;
        throw new Error(code ? `${message} (${code})` : message);
      }
      await fetchProviders();
    } catch (err) {
      // Some adapters persist safe partial connection health before surfacing
      // an independent billing or transient upstream failure.
      await fetchProviders();
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setActionLoading(null);
    }
  };

  if (
    (loading && activeTab === "connections") ||
    ((loading || subscriptionsLoading) && activeTab === "services") ||
    (projectsLoading && activeTab === "projects")
  ) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="flex items-center justify-between">
          <div className="h-8 w-32 bg-gray-200 dark:bg-gray-700 rounded"></div>
          <div className="h-10 w-32 bg-gray-200 dark:bg-gray-700 rounded-lg"></div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="h-12 bg-gray-50 dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800"></div>
          <div className="divide-y divide-gray-50 dark:divide-gray-800">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-20 bg-white dark:bg-gray-800"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Settings</h1>
      </div>

      <div className="sticky top-16 z-30 bg-gray-50 dark:bg-gray-900 pt-2 pb-px border-b border-gray-200 dark:border-gray-800 flex items-center justify-between gap-4">
        <nav aria-label="Settings sections" className="flex overflow-x-auto min-w-0 flex-1">
          <Link
            href="/settings?tab=connections"
            id="settings-tab-connections"
            aria-current={activeTab === "connections" ? "page" : undefined}
            className={`pb-2.5 px-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
              activeTab === "connections"
                ? "border-blue-500 text-blue-600 dark:text-blue-400"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            }`}
          >
            Connections
          </Link>
          <Link
            href="/settings?tab=services"
            id="settings-tab-services"
            aria-current={activeTab === "services" ? "page" : undefined}
            className={`pb-2.5 px-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
              activeTab === "services"
                ? "border-blue-500 text-blue-600 dark:text-blue-400"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            }`}
          >
            Paid services
          </Link>
          <Link
            href="/settings?tab=projects"
            id="settings-tab-projects"
            aria-current={activeTab === "projects" ? "page" : undefined}
            className={`pb-2.5 px-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
              activeTab === "projects"
                ? "border-blue-500 text-blue-600 dark:text-blue-400"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            }`}
          >
            Projects
          </Link>
        </nav>
        <div className="flex-shrink-0 pb-2">
          {activeTab === "connections" ? (
            <button
              type="button"
              onClick={() => {
                setEditProvider(null);
                setModalOpen(true);
              }}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Add provider
            </button>
          ) : activeTab === "services" ? (
            <button
              type="button"
              onClick={() => {
                setEditSubscription(null);
                setSubscriptionModalOpen(true);
              }}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Track paid service
            </button>
          ) : activeTab === "projects" ? (
            <button
              type="button"
              onClick={() => {
                setEditProject(null);
                setProjectModalOpen(true);
              }}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Add project
            </button>
          ) : null}
        </div>
      </div>

      {Object.values(loadErrors).some(Boolean) && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          <span>
            {Object.entries(loadErrors)
              .filter((entry): entry is [string, string] => Boolean(entry[1]))
              .map(([section, message]) => `${section}: ${message}`)
              .join(" ")}
          </span>
          <button
            type="button"
            onClick={() => {
              const retries: Promise<void>[] = [];
              if (loadErrors.connections) retries.push(fetchProviders());
              if (loadErrors.projects) retries.push(fetchProjects());
              if (loadErrors.services) retries.push(fetchSubscriptions());
              void Promise.all(retries);
            }}
            className="font-semibold underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          >
            Retry loading settings
          </button>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      )}

      <section id={`settings-panel-${activeTab}`} aria-label={`${activeTab} settings`}>
        {activeTab === "connections" ? (
          <div className="space-y-6">
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-5 dark:border-blue-800 dark:bg-blue-900/30">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-blue-900 dark:text-blue-100">
                How data gets here
              </h2>
              <div className="grid gap-4 text-sm text-blue-800 dark:text-blue-200 sm:grid-cols-3">
                <div className="space-y-1">
                  <p className="font-medium text-blue-900 dark:text-blue-100">Automatic account sync</p>
                  <p className="text-xs opacity-90">Read-only provider adapters fetch authoritative usage, billing, plan, and quota fields whenever the provider exposes them.</p>
                </div>
                <div className="space-y-1">
                  <p className="font-medium text-blue-900 dark:text-blue-100">Pushed telemetry</p>
                  <p className="text-xs opacity-90">Apps send metered usage and cost when a provider has no suitable account API or when project-level detail is needed.</p>
                </div>
                <div className="space-y-1">
                  <p className="font-medium text-blue-900 dark:text-blue-100">Manual plan tracking</p>
                  <p className="text-xs opacity-90">Dashboard-only subscriptions stay explicit instead of being inferred from API traffic, balances, or portfolio assets.</p>
                </div>
              </div>
            </div>
            <ProviderTable
              providers={providers}
              actionLoading={actionLoading}
              deleteConfirm={deleteConfirm}
              onEdit={(provider) => {
                setEditProvider(provider);
                setModalOpen(true);
              }}
              onDeleteConfirmStart={setDeleteConfirm}
              onDeleteConfirmCancel={() => setDeleteConfirm(null)}
              onDelete={handleDelete}
              onAddProvider={() => {
                setEditProvider(null);
                setModalOpen(true);
              }}
              onToggleActive={handleToggleActive}
              onFetchNow={handleFetchNow}
            />
          </div>
        ) : activeTab === "services" ? (
          <div className="space-y-8">
            <PaidServicesPanel
              providers={providers}
              subscriptions={subscriptions}
              variant="settings"
              showCoverage
            />

            <div className="space-y-3">
              <div>
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Tracked recurring costs</h2>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Edit dashboard-only subscriptions or link them to an automatically discovered provider record. Linked records render once and charge once.
                </p>
              </div>
              <SubscriptionsPanel
                subscriptions={subscriptions}
                onAdd={() => {
                  setEditSubscription(null);
                  setSubscriptionModalOpen(true);
                }}
                onEdit={(sub) => {
                  setEditSubscription({
                    id: sub.id,
                    providerId: sub.provider.id,
                    projectId: sub.project?.id ?? null,
                    name: sub.name,
                    description: sub.description,
                    costUsd: sub.costUsd,
                    currency: sub.currency,
                    interval: sub.interval,
                    intervalCount: sub.intervalCount,
                    anchorDay: sub.anchorDay,
                    startDate: sub.startDate,
                    autoRenew: sub.autoRenew,
                    status: sub.status,
                    effectiveStatus: sub.effectiveStatus,
                    notes: sub.notes,
                    externalBillingSource: sub.externalBillingSource,
                    externalBillingId: sub.externalBillingId,
                  });
                  setSubscriptionModalOpen(true);
                }}
                onDelete={handleDeleteSubscription}
                deleteConfirm={deleteSubscriptionConfirm}
                setDeleteConfirm={setDeleteSubscriptionConfirm}
                actionLoading={actionLoading}
              />
            </div>
          </div>
        ) : (
          <ProjectTable
            projects={projects}
            actionLoading={actionLoading}
            deleteProjectConfirm={deleteProjectConfirm}
            onEdit={(project) => {
              setEditProject(project);
              setProjectModalOpen(true);
            }}
            onDeleteConfirmStart={setDeleteProjectConfirm}
            onDeleteConfirmCancel={() => setDeleteProjectConfirm(null)}
            onDelete={handleDeleteProject}
            onAddProject={() => {
              setEditProject(null);
              setProjectModalOpen(true);
            }}
          />
        )}
      </section>

      <AddProviderModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditProvider(null);
        }}
        onSave={handleSave}
        editProvider={editProvider}
        existingProviders={providers}
      />
      
      <AddProjectModal
        open={projectModalOpen}
        onClose={() => {
          setProjectModalOpen(false);
          setEditProject(null);
        }}
        onSave={handleSaveProject}
        editProject={editProject}
      />

      <AddSubscriptionModal
        open={subscriptionModalOpen}
        onClose={() => {
          setSubscriptionModalOpen(false);
          setEditSubscription(null);
        }}
        onSave={handleSaveSubscription}
        editSubscription={editSubscription}
        providers={providers.map((p) => ({
          id: p.id,
          name: p.name,
          displayName: p.displayName,
          refreshIntervalMin: p.refreshIntervalMin,
          externalBilling: p.externalBilling,
        }))}
        projects={projects
          .filter((p): p is Project & { id: string } => Boolean(p.id))
          .map((p) => ({ id: p.id, name: p.name }))}
      />
    </div>
  );
}

function SettingsPageFallback() {
  return (
    <div className="space-y-6 animate-pulse" aria-label="Loading settings">
      <div className="flex items-center justify-between">
        <div className="h-8 w-32 bg-gray-200 rounded" />
        <div className="h-10 w-32 bg-gray-200 rounded-lg" />
      </div>
      <div className="h-12 rounded bg-gray-100" />
      <div className="h-64 rounded-xl border border-gray-200 bg-white" />
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<SettingsPageFallback />}>
      <SettingsPageContent />
    </Suspense>
  );
}
