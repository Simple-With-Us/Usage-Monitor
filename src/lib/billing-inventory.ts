import { getProviderIntegrationProfile } from "@/lib/provider-integration-catalog";
import {
  canLinkSubscriptionToExternalBilling,
  externalBillingFreshnessWindowMs,
} from "@/lib/external-billing-link";
import { effectiveSubscriptionStatus } from "@/lib/subscriptions";
import { providerPollSnapshotExpected } from "@/lib/anthropic-credentials";
import { canonicalProviderKey } from "@/lib/provider-identity";
import {
  MAX_POLL_FRESHNESS_MS,
  resolveProviderSyncMode,
} from "@/lib/provider-sync-mode";

export interface BillingInventoryExternalRecord {
  source: string;
  externalId: string | null;
  kind: string;
  serviceName?: string | null;
  planName: string | null;
  status: string | null;
  amountUsd: number | null;
  currency: string | null;
  billingInterval: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  nextRenewalAt: string | null;
  requestLimit: number | null;
  requestLimitWindow: string | null;
  spendLimitUsd: number | null;
  spendLimitWindow: string | null;
  usageQuantity?: number | null;
  remainingQuantity?: number | null;
  usageUnit?: string | null;
  rollupRole?: string | null;
  dateKind?: string | null;
  syncedAt: string;
}

export interface BillingInventoryProvider {
  id: string;
  name: string;
  displayName: string;
  type?: string;
  label?: string | null;
  isActive?: boolean;
  refreshIntervalMin?: number;
  spentUsd?: number;
  projectedEomUsd?: number;
  billingMode?: "actual" | "estimated" | "manual";
  anthropicAdminApiConfigured?: boolean;
  plan?: {
    fixedMonthlyCostUsd: number | null;
    monthlyBudgetUsd: number | null;
    monthlyRequestLimit: number | null;
    renewalDate: string | null;
    billingInterval?: string | null;
    notes?: string | null;
  } | null;
  latestSnapshot?: {
    totalRequests: number | null;
    credits: number | null;
    fetchedAt: string;
  } | null;
  externalBilling?: BillingInventoryExternalRecord[];
}

export interface BillingInventorySubscription {
  id: string;
  name: string;
  description: string | null;
  costUsd: number;
  currency: string;
  interval: string;
  intervalCount: number;
  monthlyEquivalentUsd: number;
  nextRenewalAt: string;
  autoRenew: boolean;
  status: string;
  effectiveStatus?: string;
  externalBillingSource: string | null;
  externalBillingId: string | null;
  knobEnv: Record<string, string> | null;
  freeTierKnobEnv: Record<string, string> | null;
  provider: { id: string; name: string; displayName: string };
  project: { id: string; name: string } | null;
}

export type BillingInventoryProvenance =
  | "automatic"
  | "linked"
  | "tracked"
  | "provider-plan";

export type BillingInventoryCostKind = "recurring" | "current-period" | "none";

export interface BillingInventoryCapacityChange {
  key: string;
  label: string;
  freeTierValue: string | null;
  paidTierValue: string | null;
}

export interface BillingInventoryItem {
  id: string;
  providerId: string;
  providerName: string;
  providerDisplayName: string;
  providerLabel: string | null;
  serviceName: string;
  tierName: string | null;
  status: string;
  provenance: BillingInventoryProvenance;
  source: string | null;
  externalKind: string | null;
  amount: number | null;
  currency: string;
  cadence: string | null;
  monthlyEquivalentUsd: number | null;
  costKind: BillingInventoryCostKind;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  nextRenewalAt: string | null;
  autoRenew: boolean | null;
  requestUsage: number | null;
  requestLimit: number | null;
  requestLimitWindow: string | null;
  creditsRemaining: number | null;
  spendMonthToDateUsd: number | null;
  spendLimitUsd: number | null;
  spendLimitWindow: string | null;
  usageQuantity: number | null;
  remainingQuantity: number | null;
  usageUnit: string | null;
  rollupRole: string;
  dateKind: string | null;
  syncedAt: string | null;
  stale: boolean;
  projectName: string | null;
  capacityChanges: BillingInventoryCapacityChange[];
}

export type BillingCoverageStatus =
  | "automatic"
  | "stale"
  | "tracked"
  | "available"
  | "manual"
  | "not-applicable";

export interface BillingCoverageItem {
  providerId: string;
  providerName: string;
  providerDisplayName: string;
  category: string;
  status: BillingCoverageStatus;
  summary: string;
}

export interface BillingInventory {
  items: BillingInventoryItem[];
  coverage: BillingCoverageItem[];
  summary: {
    automaticRecords: number;
    trackedSubscriptions: number;
    activeServices: number;
    monthlyRecurringUsd: number;
    nextRenewalAt: string | null;
  };
}

const RECURRING_KINDS = new Set(["plan", "subscription", "service_plan"]);
const INACTIVE_STATUSES = new Set([
  "cancelled",
  "canceled",
  "expired",
  "failed",
  "inactive",
  "paused",
  "pending",
  "disabled",
  "unpaid",
  "unavailable",
]);

function cleanStatus(value: string | null | undefined, fallback = "active"): string {
  const normalized = value?.trim().toLowerCase();
  return normalized || fallback;
}

function externalKey(providerId: string, source: string, externalId: string): string {
  return `${providerId}\u0000${source}\u0000${externalId}`;
}

function humanize(value: string): string {
  return value
    .replace(/^PROVIDER_/, "")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function capacityChanges(
  effective: Record<string, string> | null,
  freeTier: Record<string, string> | null
): BillingInventoryCapacityChange[] {
  if (!effective && !freeTier) return [];
  const keys = new Set([
    ...Object.keys(freeTier ?? {}),
    ...Object.keys(effective ?? {}),
  ]);
  return [...keys]
    .sort()
    .filter((key) => (effective?.[key] ?? null) !== (freeTier?.[key] ?? null))
    .map((key) => ({
      key,
      label: humanize(key),
      freeTierValue: freeTier?.[key] ?? null,
      paidTierValue: effective?.[key] ?? null,
    }));
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * True only when this row can actually poll billing/usage. Push-only,
 * health-only, and no-API built-ins must never look like they "need setup".
 */
export function billingCoverageCanPoll(provider: BillingInventoryProvider): boolean {
  const profile = getProviderIntegrationProfile(provider.name, provider.type);
  if (
    profile.mode === "push-only" ||
    profile.mode === "manual" ||
    profile.mode === "health-only"
  ) {
    return false;
  }
  if (
    profile.billing.visibility === "none" ||
    profile.billing.visibility === "manual"
  ) {
    return false;
  }
  if (resolveProviderSyncMode(provider) !== "poll") return false;
  if (canonicalProviderKey(provider.name) === "anthropic") {
    return provider.anthropicAdminApiConfigured === true;
  }
  return providerPollSnapshotExpected({
    name: provider.name,
    type: provider.type,
  });
}

function isRecordStale(
  syncedAt: string | null,
  refreshIntervalMin: number,
  now: number
): boolean {
  const time = parseTime(syncedAt);
  if (time == null) return syncedAt != null;
  const staleAfterMs = externalBillingFreshnessWindowMs(refreshIntervalMin);
  return now - time > staleAfterMs;
}

function monthlyEquivalent(
  amount: number | null,
  currency: string,
  cadence: string | null
): number | null {
  if (amount == null || currency !== "USD" || !cadence) return null;
  const normalized = cadence.trim().toLowerCase();
  if (["month", "monthly"].includes(normalized)) return amount;
  if (["quarter", "quarterly"].includes(normalized)) return amount / 3;
  if (["year", "yearly", "annual", "annually"].includes(normalized)) return amount / 12;
  if (["week", "weekly"].includes(normalized)) return amount * (52 / 12);
  if (["day", "daily"].includes(normalized)) return amount * (365.25 / 12);
  return null;
}

function externalCostKind(kind: string): BillingInventoryCostKind {
  if (RECURRING_KINDS.has(kind)) return "recurring";
  if (["billing_period", "invoice"].includes(kind)) {
    return "current-period";
  }
  return "none";
}

export function isBillingInventoryItemActive(item: BillingInventoryItem): boolean {
  return !INACTIVE_STATUSES.has(item.status) && item.status !== "considering";
}

function itemIsSummaryService(item: BillingInventoryItem): boolean {
  return (
    isBillingInventoryItemActive(item) &&
    item.rollupRole !== "component" &&
    item.rollupRole !== "metadata"
  );
}

function chooseNextRenewal(items: BillingInventoryItem[], now: number): string | null {
  const sorted = items
    .filter(
      (item) =>
        isBillingInventoryItemActive(item) &&
        (item.dateKind == null || item.dateKind === "renewal")
    )
    .map((item) => item.nextRenewalAt)
    .filter((value): value is string => {
      const time = parseTime(value);
      return time != null && time >= now;
    })
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return sorted[0] ?? null;
}

function sortItems(items: BillingInventoryItem[]): BillingInventoryItem[] {
  const provenanceRank: Record<BillingInventoryProvenance, number> = {
    linked: 0,
    automatic: 1,
    tracked: 2,
    "provider-plan": 3,
  };
  return items.sort((left, right) => {
    const activeDifference =
      Number(isBillingInventoryItemActive(right)) -
      Number(isBillingInventoryItemActive(left));
    if (activeDifference) return activeDifference;
    const providerDifference = left.providerDisplayName.localeCompare(right.providerDisplayName);
    if (providerDifference) return providerDifference;
    const provenanceDifference = provenanceRank[left.provenance] - provenanceRank[right.provenance];
    if (provenanceDifference) return provenanceDifference;
    return left.serviceName.localeCompare(right.serviceName);
  });
}

export function buildBillingInventory(
  providers: BillingInventoryProvider[],
  subscriptions: BillingInventorySubscription[],
  now = Date.now()
): BillingInventory {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const externalByKey = new Map<string, BillingInventoryExternalRecord>();
  for (const provider of providers) {
    for (const record of provider.externalBilling ?? []) {
      if (record.externalId) {
        externalByKey.set(
          externalKey(provider.id, record.source, record.externalId),
          record
        );
      }
    }
  }

  const usedExternalKeys = new Set<string>();
  const items: BillingInventoryItem[] = [];

  for (const subscription of subscriptions) {
    const provider = providerById.get(subscription.provider.id);
    if (!provider) continue;
    const termEnd = subscription.nextRenewalAt;
    const status =
      subscription.effectiveStatus ??
      effectiveSubscriptionStatus(subscription, new Date(now));
    const linkKey =
      subscription.externalBillingSource && subscription.externalBillingId
        ? externalKey(
            provider.id,
            subscription.externalBillingSource,
            subscription.externalBillingId
          )
        : null;
    const identityRecord =
      linkKey && !usedExternalKeys.has(linkKey)
        ? externalByKey.get(linkKey) ?? null
        : null;
    const linkedRecord =
      identityRecord &&
      canLinkSubscriptionToExternalBilling(
        { ...subscription, status },
        identityRecord
      )
        ? identityRecord
        : null;
    if (linkKey && linkedRecord) usedExternalKeys.add(linkKey);
    const cadence =
      subscription.intervalCount === 1
        ? subscription.interval
        : `every ${subscription.intervalCount} ${subscription.interval}`;

    items.push({
      id: `subscription:${subscription.id}`,
      providerId: provider.id,
      providerName: provider.name,
      providerDisplayName: provider.displayName,
      providerLabel: provider.label ?? null,
      serviceName: subscription.name,
      tierName:
        linkedRecord?.planName && linkedRecord.planName !== subscription.name
          ? linkedRecord.planName
          : subscription.description,
      status,
      provenance: linkedRecord ? "linked" : "tracked",
      source: linkedRecord?.source ?? null,
      externalKind: linkedRecord?.kind ?? null,
      amount: subscription.costUsd,
      currency: subscription.currency,
      cadence,
      monthlyEquivalentUsd:
        subscription.currency === "USD" ? subscription.monthlyEquivalentUsd : null,
      costKind: "recurring",
      currentPeriodStart: linkedRecord?.currentPeriodStart ?? null,
      currentPeriodEnd: linkedRecord?.currentPeriodEnd ?? null,
      nextRenewalAt:
        subscription.autoRenew && status === "active"
          ? linkedRecord?.dateKind == null || linkedRecord.dateKind === "renewal"
            ? linkedRecord?.nextRenewalAt ?? subscription.nextRenewalAt
            : subscription.nextRenewalAt
          : subscription.autoRenew
            ? null
            : termEnd,
      autoRenew: subscription.autoRenew,
      requestUsage: null,
      requestLimit: linkedRecord?.requestLimit ?? null,
      requestLimitWindow: linkedRecord?.requestLimitWindow ?? null,
      creditsRemaining: null,
      spendMonthToDateUsd: null,
      spendLimitUsd: linkedRecord?.spendLimitUsd ?? null,
      spendLimitWindow: linkedRecord?.spendLimitWindow ?? null,
      usageQuantity: linkedRecord?.usageQuantity ?? null,
      remainingQuantity: linkedRecord?.remainingQuantity ?? null,
      usageUnit: linkedRecord?.usageUnit ?? null,
      rollupRole: linkedRecord?.rollupRole ?? "canonical",
      dateKind: subscription.autoRenew ? "renewal" : "contract_end",
      syncedAt: linkedRecord?.syncedAt ?? null,
      stale: linkedRecord
        ? isRecordStale(
            linkedRecord.syncedAt,
            provider.refreshIntervalMin ?? 60,
            now
          )
        : false,
      projectName: subscription.project?.name ?? null,
      capacityChanges: capacityChanges(
        subscription.knobEnv,
        subscription.freeTierKnobEnv
      ),
    });
  }

  for (const provider of providers) {
    const records = provider.externalBilling ?? [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const key = record.externalId
        ? externalKey(provider.id, record.source, record.externalId)
        : null;
      if (key && usedExternalKeys.has(key)) continue;
      const kind = record.kind.trim().toLowerCase();
      const costKind = externalCostKind(kind);
      const rollupRole =
        record.rollupRole ??
        (kind === "account" && costKind === "none" && record.amountUsd == null
          ? "metadata"
          : "canonical");
      const currency = record.currency?.trim().toUpperCase() || "UNKNOWN";
      const serviceName =
        record.serviceName?.trim() ||
        record.planName?.trim() ||
        humanize(kind) ||
        "Provider billing";
      items.push({
        id: `external:${provider.id}:${record.source}:${record.externalId ?? index}`,
        providerId: provider.id,
        providerName: provider.name,
        providerDisplayName: provider.displayName,
        providerLabel: provider.label ?? null,
        serviceName,
        tierName: record.planName,
        status: cleanStatus(record.status, costKind === "current-period" ? "open" : "active"),
        provenance: "automatic",
        source: record.source,
        externalKind: kind,
        amount: record.amountUsd,
        currency,
        cadence: record.billingInterval,
        monthlyEquivalentUsd:
          costKind === "recurring"
            ? monthlyEquivalent(record.amountUsd, currency, record.billingInterval)
            : null,
        costKind,
        currentPeriodStart: record.currentPeriodStart,
        currentPeriodEnd: record.currentPeriodEnd,
        nextRenewalAt: record.nextRenewalAt,
        autoRenew:
          RECURRING_KINDS.has(kind) &&
          record.nextRenewalAt != null &&
          (record.dateKind == null || record.dateKind === "renewal")
            ? true
            : null,
        requestUsage: null,
        requestLimit: record.requestLimit,
        requestLimitWindow: record.requestLimitWindow,
        creditsRemaining: null,
        spendMonthToDateUsd:
          costKind === "current-period" ? record.amountUsd : null,
        spendLimitUsd: record.spendLimitUsd,
        spendLimitWindow: record.spendLimitWindow,
        usageQuantity: record.usageQuantity ?? null,
        remainingQuantity: record.remainingQuantity ?? null,
        usageUnit: record.usageUnit ?? null,
        rollupRole,
        dateKind: record.dateKind ?? null,
        syncedAt: record.syncedAt,
        stale: isRecordStale(
          record.syncedAt,
          provider.refreshIntervalMin ?? 60,
          now
        ),
        projectName: null,
        capacityChanges: [],
      });
    }

    const providerItems = items.filter((item) => item.providerId === provider.id);
    const hasLocalRecurringService = providerItems.some(
      (item) =>
        isBillingInventoryItemActive(item) &&
        item.costKind === "recurring" &&
        (item.provenance === "tracked" || item.provenance === "linked")
    );
    const hasAutomaticRecurringCost = providerItems.some(
      (item) =>
        isBillingInventoryItemActive(item) &&
        item.provenance === "automatic" &&
        item.costKind === "recurring" &&
        item.rollupRole === "canonical" &&
        item.monthlyEquivalentUsd != null
    );
    const hasAutomaticRenewal = providerItems.some(
      (item) =>
        isBillingInventoryItemActive(item) &&
        item.provenance === "automatic" &&
        item.nextRenewalAt != null &&
        (item.dateKind == null || item.dateKind === "renewal")
    );
    const fixedMonthlyCostUsd = provider.plan?.fixedMonthlyCostUsd ?? null;
    const renewalDate = provider.plan?.renewalDate ?? null;
    const fallbackMonthlyCostUsd =
      !hasLocalRecurringService && !hasAutomaticRecurringCost
        ? fixedMonthlyCostUsd
        : null;
    const fallbackRenewalDate =
      !hasLocalRecurringService && !hasAutomaticRenewal
        ? renewalDate
        : null;
    if (fallbackMonthlyCostUsd != null || fallbackRenewalDate != null) {
      items.push({
        id: `provider-plan:${provider.id}`,
        providerId: provider.id,
        providerName: provider.name,
        providerDisplayName: provider.displayName,
        providerLabel: provider.label ?? null,
        serviceName: provider.label || `${provider.displayName} plan`,
        tierName: null,
        status: provider.isActive === false ? "inactive" : "active",
        provenance: "provider-plan",
        source: null,
        externalKind: "plan",
        amount: fallbackMonthlyCostUsd,
        currency: "USD",
        cadence: fallbackMonthlyCostUsd != null ? "month" : null,
        monthlyEquivalentUsd: fallbackMonthlyCostUsd,
        costKind: "recurring",
        currentPeriodStart: null,
        currentPeriodEnd: null,
        nextRenewalAt: fallbackRenewalDate,
        autoRenew: fallbackRenewalDate != null,
        requestUsage: provider.latestSnapshot?.totalRequests ?? null,
        requestLimit: provider.plan?.monthlyRequestLimit ?? null,
        requestLimitWindow:
          provider.plan?.monthlyRequestLimit != null ? "month" : null,
        creditsRemaining: provider.latestSnapshot?.credits ?? null,
        spendMonthToDateUsd: provider.spentUsd ?? null,
        spendLimitUsd: provider.plan?.monthlyBudgetUsd ?? null,
        spendLimitWindow:
          provider.plan?.monthlyBudgetUsd != null ? "month" : null,
        usageQuantity: null,
        remainingQuantity: null,
        usageUnit: null,
        rollupRole: "canonical",
        dateKind: fallbackRenewalDate != null ? "renewal" : null,
        syncedAt: null,
        stale: false,
        projectName: null,
        capacityChanges: [],
      });
    }
  }

  const coverage: BillingCoverageItem[] = providers
    .map((provider) => {
      const profile = getProviderIntegrationProfile(provider.name, provider.type);
      const providerItems = items.filter((item) => item.providerId === provider.id);
      let status: BillingCoverageStatus;
      let summary: string;
      const automaticBilling = providerItems.some(
        (item) =>
          provider.isActive !== false &&
          !item.stale &&
          (item.provenance === "automatic" || item.provenance === "linked") &&
          item.rollupRole !== "metadata" &&
          item.rollupRole !== "component" &&
          (item.costKind !== "none" || item.amount != null || item.nextRenewalAt != null)
      );
      const automaticMetadata = providerItems.some(
        (item) =>
          provider.isActive !== false &&
          !item.stale &&
          item.provenance === "automatic" &&
          (item.rollupRole === "metadata" ||
            (item.costKind === "none" && item.amount == null))
      );
      const locallyTracked = providerItems.some(
        (item) =>
          item.provenance === "tracked" ||
          item.provenance === "linked" ||
          item.provenance === "provider-plan"
      );
      const staleProviderConfirmation = providerItems.some(
        (item) =>
          (item.provenance === "automatic" || item.provenance === "linked") &&
          item.stale
      );
      const anthropicAdminConfigured =
        profile.name === "anthropic" &&
        (provider.anthropicAdminApiConfigured ?? false);
      const canPoll = billingCoverageCanPoll(provider);
      const snapshotFetchedAt = parseTime(provider.latestSnapshot?.fetchedAt);
      const snapshotFresh =
        snapshotFetchedAt != null && now - snapshotFetchedAt < MAX_POLL_FRESHNESS_MS;
      const manuallyOnlySummary =
        "MANUALLY ONLY. This account cannot be fetched. Enter plan or receipt numbers yourself, or push telemetry. Adding a key will not unlock polling.";
      if (!canPoll) {
        if (profile.billing.visibility === "none") {
          status = "not-applicable";
          summary = profile.billing.summary;
        } else if (locallyTracked) {
          status = "tracked";
          summary =
            "MANUALLY ONLY for provider fetch. Local subscription or receipt tracking is what you see here.";
        } else if (profile.name === "anthropic" && !anthropicAdminConfigured) {
          status = "manual";
          summary =
            "MANUALLY ONLY for individual Anthropic accounts. No organization Admin API key is configured, and individual accounts cannot obtain one. Reconcile pushed telemetry with the Anthropic Console and track Claude plans through Subscription or receipt records.";
        } else {
          status = "manual";
          summary = profile.billing.visibility === "manual"
            ? `${manuallyOnlySummary} ${profile.billing.summary}`
            : manuallyOnlySummary;
        }
      } else if (automaticBilling) {
        status = "automatic";
        summary = "Provider-reported billing or plan data is syncing.";
      } else if (
        ["metadata", "partial"].includes(profile.billing.visibility) &&
        automaticMetadata
      ) {
        status = "automatic";
        summary = "Provider-reported plan or quota metadata is syncing; invoice cost may remain manual.";
      } else if (staleProviderConfirmation && snapshotFresh) {
        status = locallyTracked ? "tracked" : "automatic";
        summary =
          "A billing confirmation is older than the freshness window. Usage Monitor is taking a new snapshot. This is not an alert.";
      } else if (staleProviderConfirmation) {
        status = "stale";
        summary =
          "The last usage snapshot is old. Usage Monitor is taking a new one on the next poll (at least hourly). This is not an alert.";
      } else if (locallyTracked) {
        status = "tracked";
        summary = "Billing is tracked locally; provider confirmation is not available.";
      } else if (provider.isActive === false) {
        status = "available";
        summary = "Connection is disabled; re-enable it to resume automatic billing sync.";
      } else {
        status = "available";
        summary =
          "This connector can poll. No billing record has landed yet. The next successful fetch will fill it.";
      }
      return {
        providerId: provider.id,
        providerName: provider.name,
        providerDisplayName: provider.displayName,
        category: profile.category,
        status,
        summary,
      };
    })
    .sort((left, right) =>
      left.category.localeCompare(right.category) ||
      left.providerDisplayName.localeCompare(right.providerDisplayName)
    );

  const sortedItems = sortItems(items);
  const recurringItems = sortedItems.filter(
    (item) =>
      item.costKind === "recurring" &&
      item.currency === "USD" &&
      item.monthlyEquivalentUsd != null &&
      item.rollupRole !== "component" &&
      item.rollupRole !== "metadata" &&
      isBillingInventoryItemActive(item)
  );

  return {
    items: sortedItems,
    coverage,
    summary: {
      automaticRecords: sortedItems.filter(
        (item) =>
          (item.provenance === "automatic" || item.provenance === "linked") &&
          item.rollupRole !== "component" &&
          item.rollupRole !== "metadata"
      ).length,
      trackedSubscriptions: subscriptions.length,
      activeServices: sortedItems.filter(itemIsSummaryService).length,
      monthlyRecurringUsd: recurringItems.reduce(
        (sum, item) => sum + (item.monthlyEquivalentUsd ?? 0),
        0
      ),
      nextRenewalAt: chooseNextRenewal(sortedItems, now),
    },
  };
}
