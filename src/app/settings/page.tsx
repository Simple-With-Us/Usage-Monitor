"use client";

import { Suspense, useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import AddProviderModal from "@/components/AddProviderModal";
import AddProjectModal, { Project } from "@/components/AddProjectModal";
import AddSubscriptionModal, { type SubscriptionFormValue } from "@/components/AddSubscriptionModal";
import SubscriptionsPanel, { type SubscriptionRow } from "@/components/SubscriptionsPanel";
import ProviderTable from "@/components/ProviderTable";
import ProjectTable from "@/components/ProjectTable";
import type { ExternalBillingRecord } from "@/components/ExternalBillingDetails";

export type BillingMode = "actual" | "estimated" | "manual";
type SettingsTab = "providers" | "projects" | "subscriptions";

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
  plan: ProviderPlan | null;
  allocations: { projectId: string; percentage: number }[];
  externalBilling?: ExternalBillingRecord[];
  secretConfigMeta?: { configured: boolean; fields: string[]; readable: boolean };
  alerts: ProviderAlert[];
  estimatedMonthlyCostUsd: number;
  spentUsd?: number;
  projectedEomUsd?: number;
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
  return value === "projects" || value === "subscriptions" ? value : "providers";
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
      setError("");
      const res = await fetch("/api/providers");
      if (!res.ok) throw new Error("Failed to fetch providers");
      const data = await res.json();
      setProviders(data);
      providersLoaded.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchProjects = useCallback(async () => {
    try {
      if (!projectsLoaded.current) setProjectsLoading(true);
      setError("");
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error("Failed to fetch projects");
      const data = await res.json();
      setProjects(data);
      projectsLoaded.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  const fetchSubscriptions = useCallback(async () => {
    try {
      if (!subscriptionsLoaded.current) setSubscriptionsLoading(true);
      setError("");
      const res = await fetch("/api/subscriptions");
      if (!res.ok) throw new Error("Failed to fetch subscriptions");
      const data = await res.json();
      setSubscriptions(data);
      subscriptionsLoaded.current = true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load subscriptions");
    } finally {
      setSubscriptionsLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetching on mount
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
    label?: string | null;
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
          label: provider.label,
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
      if (!res.ok) throw new Error("Failed to fetch");
      await fetchProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setActionLoading(null);
    }
  };

  if (
    (loading && activeTab === "providers") ||
    (projectsLoading && activeTab === "projects") ||
    (subscriptionsLoading && activeTab === "subscriptions")
  ) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="flex items-center justify-between">
          <div className="h-8 w-32 bg-gray-200 rounded"></div>
          <div className="h-10 w-32 bg-gray-200 rounded-lg"></div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="h-12 bg-gray-50 border-b border-gray-100"></div>
          <div className="divide-y divide-gray-50">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-20 bg-white"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
        {activeTab === "providers" ? (
          <button
            type="button"
            onClick={() => {
              setEditProvider(null);
              setModalOpen(true);
            }}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Add Provider
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
            Add Project
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setEditSubscription(null);
              setSubscriptionModalOpen(true);
            }}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Add Subscription
          </button>
        )}
      </div>

      <nav aria-label="Settings sections" className="flex overflow-x-auto border-b border-gray-200">
        <Link
          href="/settings?tab=providers"
          id="settings-tab-providers"
          aria-current={activeTab === "providers" ? "page" : undefined}
          className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "providers"
              ? "border-blue-500 text-blue-600"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Providers
        </Link>
        <Link
          href="/settings?tab=projects"
          id="settings-tab-projects"
          aria-current={activeTab === "projects" ? "page" : undefined}
          className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "projects"
              ? "border-blue-500 text-blue-600"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Projects
        </Link>
        <Link
          href="/settings?tab=subscriptions"
          id="settings-tab-subscriptions"
          aria-current={activeTab === "subscriptions" ? "page" : undefined}
          className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors ${
            activeTab === "subscriptions"
              ? "border-blue-500 text-blue-600"
              : "border-transparent text-gray-500 hover:text-gray-700"
          }`}
        >
          Subscriptions
        </Link>
      </nav>

      {error && (
        <p role="alert" className="text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">
          {error}
        </p>
      )}

      <section id={`settings-panel-${activeTab}`} aria-label={`${activeTab} settings`}>
      {activeTab === "providers" ? (
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
      ) : activeTab === "projects" ? (
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
      ) : (
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
              notes: sub.notes,
            });
            setSubscriptionModalOpen(true);
          }}
          onDelete={handleDeleteSubscription}
          deleteConfirm={deleteSubscriptionConfirm}
          setDeleteConfirm={setDeleteSubscriptionConfirm}
          actionLoading={actionLoading}
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
