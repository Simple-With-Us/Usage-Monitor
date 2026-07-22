"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Search,
  Settings,
} from "lucide-react";
import type { ExternalBillingRecord } from "@/components/ExternalBillingDetails";
import type {
  ProviderCostCoverage,
  ProviderCostCoverageCaveat,
} from "@/components/ProviderCard";
import type { SubscriptionRow } from "@/components/SubscriptionsPanel";
import SortHeader, { type SortDirection } from "@/components/table/SortHeader";
import { costCoverageHelpText } from "@/lib/cost-coverage-help";
import {
  useDisplayDensity,
  setStoredDisplayDensity,
  getStoredDisplayDensity,
  type DisplayDensity,
} from "@/lib/display-density";
import { providerFinancialSemantics } from "@/lib/provider-financial-semantics";
import { aggregateProviderFamilyMoney } from "@/lib/provider-money-aggregation";
import { canonicalProviderKey } from "@/lib/provider-identity";

interface WorkspaceProvider {
  id: string;
  name: string;
  displayName: string;
  type: string;
  isActive: boolean;
  groupId: string | null;
  billingAccount?: {
    matchKey: string;
    evidence: "explicit_account" | "shared_credential";
  } | null;
  label: string | null;
  keyPreview?: string | null;
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
  estimatedMonthlyCostUsd: number;
  projectedEomUsd: number;
  spentUsd?: number;
  receiptCashPaidUsd?: number;
  receiptCashEventCount?: number;
  observedVariableUsageUsd?: number;
  snapshotCostUsd?: number | null;
  snapshotCostFetchedAt?: string | null;
  snapshotCostWindowStart?: string | null;
  snapshotCostWindowEnd?: string | null;
  snapshotCostScope?: string | null;
  pushedMonthToDateUsd?: number;
  subscriptionMonthToDateUsd?: number;
  fixedMonthlyCostUsd?: number;
  linkedFixedDedupeUsd?: number;
  forecastedSubscriptionRenewalsUsd?: number;
  snapshotFixedCostIncludedUsd?: number;
  estimatedApiEquivalentUsd?: number;
  spendCoverage: ProviderCostCoverage;
  costCoverageCaveat?: ProviderCostCoverageCaveat | null;
  pushedCostCoverage: ProviderCostCoverage;
  pushedPricedEventCount: number;
  pushedUnpricedEventCount: number;
  pushedUnclassifiedCostEventCount: number;
  externalBilling?: ExternalBillingRecord[];
  externalBillingHiddenCount?: number;
  plan: {
    fixedMonthlyCostUsd: number | null;
    monthlyBudgetUsd: number | null;
    monthlyRequestLimit: number | null;
    renewalDate: string | null;
    billingInterval: string | null;
    notes: string | null;
  } | null;
  billingMode: "actual" | "estimated" | "manual";
  alerts: {
    severity: "critical" | "warning" | "info";
    message: string;
  }[];
  latestSnapshot: {
    balance: number | null;
    totalCost: number | null;
    totalRequests: number | null;
    credits: number | null;
    fetchedAt: string;
  } | null;
}

interface ProviderFamily {
  key: string;
  detailsId: string;
  displayName: string;
  providerName: string;
  providers: WorkspaceProvider[];
  subscriptions: SubscriptionRow[];
  providerExternalBilling: FamilyExternalBillingRecord[];
  hiddenExternalBillingCount: number;
  searchableExternalBilling: FamilyExternalBillingRecord[];
  financialsAggregated: boolean;
  spentUsd: number | null;
  projectedUsd: number | null;
  budgetUsd: number | null;
  spendSortUsd: number;
  credits: number | null;
  balance: number | null;
  alertCount: number;
  criticalCount: number;
  activeCount: number;
  incompleteCostCount: number;
  // Count of active member providers with a costCoverageCaveat set. Kept
  // separate from incompleteCostCount above (spendCoverage) - a caveat is a
  // distinct "totalCost is known-incomplete for a specific reason" signal
  // that must stay visible on its own even if spendCoverage reads
  // "complete". Filtered to isActive, same as incompleteCostCount: a
  // deactivated provider is no longer polled (fetchAllDueProviders only
  // covers isActive providers), so its last-recorded caveat can never be
  // cleared by a fresh snapshot and must not keep the badge showing.
  costCoverageCaveatCount: number;
  // First active member's caveat message, shown as the family-level
  // warning's tooltip/detail text. Families are almost always a single
  // account per provider today, so "first" is effectively "the" caveat in
  // practice.
  costCoverageCaveatMessage: string | null;
  nextRenewalAt: string | null;
  latestFetchedAt: string | null;
}

interface FamilyExternalBillingRecord {
  key: string;
  providerId: string;
  providerDisplayName: string;
  record: ExternalBillingRecord;
}

interface DashboardProviderWorkspaceProps {
  providers: WorkspaceProvider[];
  subscriptions: SubscriptionRow[];
  initiallyExpanded?: boolean;
}

export type WorkspaceSortField =
  | "attention"
  | "name"
  | "spend"
  | "credits"
  | "services"
  | "health"
  | "lastSync";

export type FilterChip = "all" | "alerts" | "active" | "incomplete";

type Density = "compact" | "comfortable";

const WORKSPACE_SORT_FIELDS: readonly WorkspaceSortField[] = [
  "attention",
  "name",
  "spend",
  "credits",
  "services",
  "health",
  "lastSync",
];

// Per-column INITIAL sort direction. Deliberate deviation from a uniform
// new-field->asc pattern: the retired dashboard "Spend" preset was one-click
// DESC, and persistence (see below) would otherwise pin a $0-rows-first order
// across sessions for spend/health/credits.
export const INITIAL_SORT_DIRECTION = {
  name: "asc",
  services: "asc",
  lastSync: "asc",
  spend: "desc",
  health: "desc",
  credits: "desc",
} as const;

const SORT_STORAGE_KEY = "usage-monitor:dashboard-sort";
/** Legacy key — migrated once into the global display-density store (Wave D / D3). */
const LEGACY_DENSITY_STORAGE_KEY = "usage-monitor:dashboard-density";

const FILTER_CHIPS: ReadonlyArray<readonly [FilterChip, string]> = [
  ["all", "All"],
  ["alerts", "Alerts only"],
  ["active", "Active only"],
  ["incomplete", "Incomplete cost"],
];

function familyKey(provider: WorkspaceProvider): string {
  return canonicalProviderKey(provider.name) || provider.type.trim().toLowerCase() || provider.id;
}

function familyDisplayName(providers: WorkspaceProvider[]): string {
  const counts = new Map<string, number>();
  for (const provider of providers) {
    const name = provider.displayName.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? providers[0]?.displayName ?? "Provider";
}

function providerSpend(provider: WorkspaceProvider): number | null {
  if (
    provider.spendCoverage === "unknown" ||
    provider.spendCoverage === "legacy_unknown"
  ) {
    return null;
  }
  // Never treat estimated monthly cost as "spent" — that is a forecast, not MTD cash.
  if (provider.spentUsd != null) return provider.spentUsd;
  return null;
}

function providerSpendLabel(provider: WorkspaceProvider): string {
  const amount = providerSpend(provider);
  if (amount == null) return "Cost not reported";
  return `${formatCurrency(amount)}${
    provider.spendCoverage === "partial" ? " known" : ""
  } spent`;
}

function providerProjectionLabel(provider: WorkspaceProvider): string {
  return providerSpend(provider) == null
    ? "Projection unavailable"
    : `${formatCurrency(provider.projectedEomUsd)} projected`;
}

function latestDate(values: Array<string | null | undefined>): string | null {
  let latest: string | null = null;
  let latestTime = 0;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (Number.isFinite(time) && time > latestTime) {
      latest = value;
      latestTime = time;
    }
  }
  return latest;
}

function earliestFutureDate(
  values: Array<string | null | undefined>,
  now: number
): string | null {
  let earliest: string | null = null;
  let earliestTime = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (Number.isFinite(time) && time > now && time < earliestTime) {
      earliest = value;
      earliestTime = time;
    }
  }
  return earliest;
}

function formatCurrency(amount: number | null, currency = "USD"): string {
  if (amount == null) return "--";
  const normalizedCurrency = currency.trim().toUpperCase() || "UNKNOWN";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: normalizedCurrency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${normalizedCurrency}`;
  }
}

function formatNumber(amount: number | null): string {
  if (amount == null) return "--";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(amount);
}

function formatDate(value: string | null): string {
  if (!value) return "--";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "--";
  return new Date(time).toLocaleDateString(undefined, { timeZone: "UTC" });
}

/**
 * Short absolute date for a NON-relative context (e.g. a future renewal).
 * Never route a renewal or any future-dated value through
 * `formatRelativeTime` — its future/negative clamp collapses to "just now",
 * which is silently wrong for a renewal date.
 */
export function formatShortDate(value: string, nowMs: number): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "--";
  const date = new Date(time);
  const now = new Date(nowMs);
  const formatted = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return date.getUTCFullYear() === now.getUTCFullYear()
    ? formatted
    : `${formatted}, ${date.getUTCFullYear()}`;
}

/** "Last sync" relative-time formatter ONLY — see `formatShortDate` above. */
export function formatRelativeTime(value: string | null, nowMs: number): string {
  if (!value) return "--";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "--";
  const delta = nowMs - time;
  if (delta < 60_000) return "just now";
  const minutes = delta / 60_000;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = delta / 3_600_000;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = delta / 86_400_000;
  if (days < 7) return `${Math.floor(days)}d ago`;
  return formatShortDate(value, nowMs);
}

function costCoverageLabel(family: ProviderFamily): string {
  if (!family.financialsAggregated) return "Account identity unresolved";
  // Only a genuinely multi-account family needs this coarser "some member
  // isn't complete" signal — family.providers[0] is an arbitrary pick once
  // there's more than one, so per-coverage nuance (complete/partial/unknown/
  // legacy_unknown) is no longer meaningful at the family level. For a single
  // provider, family.providers[0] IS the authoritative account: defer to the
  // switch below so a fully "unknown" reading is never relabeled "Partial",
  // which would wrongly imply some known-good amount exists.
  if (family.providers.length > 1 && family.incompleteCostCount > 0) {
    return "Partial";
  }
  switch (family.providers[0]?.spendCoverage) {
    case "complete":
      return "Complete";
    case "partial":
      return "Partial";
    default:
      return "Unknown";
  }
}

/** Plain-language tooltip to pair with `costCoverageLabel` above - same
 * "Complete"/"Partial"/"Unknown" branching, but returning the coverage kind
 * `costCoverageHelpText` expects rather than the short display label. Null
 * for the "Account identity unresolved" case, which isn't one of the four
 * cost-coverage states and has its own explanation in the UI already. */
function familyCostCoverageKind(family: ProviderFamily): ProviderCostCoverage | null {
  if (!family.financialsAggregated) return null;
  if (family.providers.length > 1 && family.incompleteCostCount > 0) {
    return "partial";
  }
  return family.providers[0]?.spendCoverage ?? "unknown";
}

function childLabel(provider: WorkspaceProvider): string {
  return provider.label || provider.keyPreview || provider.displayName;
}

function effectiveSubscriptionStatus(subscription: SubscriptionRow): string {
  return (subscription.effectiveStatus ?? subscription.status).trim().toLowerCase();
}

function externalBillingIdentity(
  providerId: string,
  record: ExternalBillingRecord
): string | null {
  const source = record.source.trim();
  const externalId = record.externalId?.trim();
  return source && externalId
    ? JSON.stringify([providerId, source, externalId])
    : null;
}

function subscriptionBillingIdentity(subscription: SubscriptionRow): string | null {
  const source = subscription.externalBillingSource?.trim();
  const externalId = subscription.externalBillingId?.trim();
  return source && externalId
    ? JSON.stringify([subscription.provider.id, source, externalId])
    : null;
}

function linkedExternalBillingRecord(
  family: ProviderFamily,
  subscription: SubscriptionRow
): ExternalBillingRecord | null {
  const identity = subscriptionBillingIdentity(subscription);
  if (!identity) return null;
  return family.searchableExternalBilling.find(
    ({ providerId, record }) =>
      externalBillingIdentity(providerId, record) === identity
  )?.record ?? null;
}

function isLiveExternalBillingStatus(status: string | null): boolean {
  return ["active", "enabled", "paid", "trialing"].includes(
    status?.trim().toLowerCase() ?? ""
  );
}

function isExternalBillingRenewal(record: ExternalBillingRecord): boolean {
  const kind = record.kind.trim().toLowerCase();
  const rollupRole = record.rollupRole?.trim().toLowerCase() ?? "canonical";
  const dateKind = record.dateKind?.trim().toLowerCase() ?? null;
  return (
    ["plan", "subscription"].includes(kind) &&
    rollupRole === "canonical" &&
    isLiveExternalBillingStatus(record.status) &&
    (dateKind == null || dateKind === "renewal")
  );
}

function subscriptionDateSummary(subscription: SubscriptionRow, now: number): string {
  const date = Date.parse(subscription.nextRenewalAt);
  if (!Number.isFinite(date)) return "No date reported";
  const formattedDate = formatDate(subscription.nextRenewalAt);
  const status = effectiveSubscriptionStatus(subscription);

  if (status === "active" && subscription.autoRenew && date > now) {
    return `Renews ${formattedDate}`;
  }
  if (status === "active" && !subscription.autoRenew && date > now) {
    return `Term ends ${formattedDate}`;
  }
  if (status === "expired" && !subscription.autoRenew) {
    return `Term ended ${formattedDate}`;
  }
  if (status === "active" && subscription.autoRenew) {
    return `Renewal date passed ${formattedDate}`;
  }
  return `No active renewal / term ${formattedDate}`;
}

function externalBillingDateSummary(
  record: ExternalBillingRecord,
  now: number
): string {
  const value = record.nextRenewalAt ?? record.currentPeriodEnd;
  if (!value) return "No date reported";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "No date reported";
  const date = formatDate(value);
  const dateKind = record.dateKind?.trim().toLowerCase() ?? null;
  const hasEnded = time <= now;

  if ((dateKind == null || dateKind === "renewal") && isExternalBillingRenewal(record)) {
    return time > now ? `Renews ${date}` : `Renewal date passed ${date}`;
  }
  switch (dateKind) {
    case "contract_end":
      return `Term ${hasEnded ? "ended" : "ends"} ${date}`;
    case "period_end":
      return `Period ${hasEnded ? "ended" : "ends"} ${date}`;
    case "quota_reset":
      return `Quota ${hasEnded ? "reset" : "resets"} ${date}`;
    case "report_through":
      return `Reported through ${date}`;
    default:
      return `Next reported date ${date}`;
  }
}

/** Pure comparator for a single sortable column, ascending. `attention` is
 * handled separately as a fixed composite and never reaches this function. */
export function compareFamiliesBy(
  field: Exclude<WorkspaceSortField, "attention">,
  a: ProviderFamily,
  b: ProviderFamily
): number {
  switch (field) {
    case "name":
      return a.displayName.localeCompare(b.displayName);
    case "spend":
      return a.spendSortUsd - b.spendSortUsd;
    case "credits": {
      const creditsDiff = (a.credits ?? 0) - (b.credits ?? 0);
      if (creditsDiff !== 0) return creditsDiff;
      return (a.balance ?? 0) - (b.balance ?? 0);
    }
    case "services": {
      const left = a.nextRenewalAt ? Date.parse(a.nextRenewalAt) : Number.POSITIVE_INFINITY;
      const right = b.nextRenewalAt ? Date.parse(b.nextRenewalAt) : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(left) && !Number.isFinite(right)) return 0;
      return left - right;
    }
    case "health": {
      const criticalDiff = a.criticalCount - b.criticalCount;
      if (criticalDiff !== 0) return criticalDiff;
      return a.alertCount - b.alertCount;
    }
    case "lastSync": {
      const left = a.latestFetchedAt ? Date.parse(a.latestFetchedAt) : 0;
      const right = b.latestFetchedAt ? Date.parse(b.latestFetchedAt) : 0;
      return left - right;
    }
  }
}

/** Pure predicate backing the single-select filter chip group (§3.5). */
export function familyMatchesFilter(family: ProviderFamily, chip: FilterChip): boolean {
  switch (chip) {
    case "alerts":
      return family.alertCount > 0;
    case "active":
      return family.activeCount > 0;
    case "incomplete":
      return family.incompleteCostCount > 0;
    case "all":
    default:
      return true;
  }
}

/** Pure empty-state string builder (§3.6). */
export function emptyStateMessage(query: string, chip: FilterChip): string {
  const hasQuery = query.trim().length > 0;
  if (hasQuery) {
    return chip === "all"
      ? "No provider families match the current search."
      : "No provider families match the current search and filter.";
  }
  switch (chip) {
    case "alerts":
      return "No families with open alerts — all clear.";
    case "active":
      return "No families with active accounts.";
    case "incomplete":
      return "No families with incomplete cost coverage.";
    case "all":
    default:
      return "No provider families match the current search.";
  }
}

function toggleButtonClass(active: boolean): string {
  return `rounded-lg px-3 py-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:focus-visible:ring-blue-400 ${
    active
      ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
      : "border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
  }`;
}

function isWorkspaceSortField(value: unknown): value is WorkspaceSortField {
  return typeof value === "string" && (WORKSPACE_SORT_FIELDS as readonly string[]).includes(value);
}

function isSortDirection(value: unknown): value is SortDirection {
  return value === "asc" || value === "desc";
}

function isDensity(value: unknown): value is Density {
  return value === "compact" || value === "comfortable";
}

function coverageDotClass(family: ProviderFamily): string {
  return family.financialsAggregated && family.incompleteCostCount === 0
    ? "h-2 w-2 shrink-0 rounded-full bg-emerald-600 dark:bg-emerald-400"
    : "h-2 w-2 shrink-0 rounded-full bg-amber-600 dark:bg-amber-400";
}

function CompactFamilyCells({
  family,
  isCollapsed,
  onToggle,
  familySpendLabel,
  nowMs,
}: {
  family: ProviderFamily;
  isCollapsed: boolean;
  onToggle: () => void;
  familySpendLabel: string;
  nowMs: number;
}) {
  const accountCount = family.providers.length;
  const financialSemantics = providerFinancialSemantics(family.providerName);
  const dotClass = coverageDotClass(family);

  const budgetOrProjectionText =
    family.budgetUsd != null
      ? `${formatCurrency(family.budgetUsd)} budget`
      : family.projectedUsd != null
        ? `${formatCurrency(family.projectedUsd)} projected`
        : "Projection unavailable";
  const coverageKind = familyCostCoverageKind(family);
  const spendTitle = [
    budgetOrProjectionText,
    `Coverage: ${costCoverageLabel(family)}`,
    coverageKind && coverageKind !== "complete" ? costCoverageHelpText(coverageKind) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const creditsBalanceTitle = `${financialSemantics.creditsLabel} ${formatNumber(family.credits)} · ${financialSemantics.balanceLabel} ${formatCurrency(family.balance)}`;

  const recordCount = family.subscriptions.length + family.providerExternalBilling.length;
  const shortDate = family.nextRenewalAt ? formatShortDate(family.nextRenewalAt, nowMs) : null;
  const hiddenServicesSegment = family.hiddenExternalBillingCount > 0
    ? ` · ${family.hiddenExternalBillingCount} additional detail${family.hiddenExternalBillingCount === 1 ? "" : "s"} hidden`
    : "";
  const visibleQualifier = family.hiddenExternalBillingCount > 0 ? "visible " : "";
  const servicesTitle = `${recordCount} ${visibleQualifier}record${recordCount === 1 ? "" : "s"}${hiddenServicesSegment} · ${
    family.nextRenewalAt ? `Next renewal ${formatDate(family.nextRenewalAt)}` : "No active future renewal"
  }`;

  const alertPlural = family.alertCount === 1 ? "" : "s";
  const accountPlural = family.activeCount === 1 ? "" : "s";
  const criticalSegment = family.criticalCount > 0 ? `, ${family.criticalCount} critical` : "";
  const healthAriaLabel = `${family.alertCount} open alert${alertPlural}${criticalSegment}, ${family.activeCount} active account${accountPlural}`;
  const lastSyncTitle = family.latestFetchedAt
    ? `${new Date(family.latestFetchedAt).toLocaleString()} · ${family.providerName}`
    : family.providerName;

  return (
    <>
      <td data-label="Provider family" className="px-4 py-2 sm:px-6">
        <button
          type="button"
          aria-expanded={!isCollapsed}
          aria-controls={family.detailsId}
          aria-label={`${isCollapsed ? "Show" : "Hide"} ${family.displayName} account and service details`}
          onClick={onToggle}
          className="flex min-w-0 items-center gap-2 text-left"
        >
          {isCollapsed ? (
            <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
          )}
          <span
            className="block max-w-[16rem] truncate text-sm font-semibold text-gray-900 dark:text-gray-100"
            title={family.displayName}
          >
            {family.displayName}
          </span>
          {accountCount > 1 && (
            <span className="inline-flex shrink-0 items-center rounded-full bg-gray-100 px-1.5 text-[11px] font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300">
              <span aria-hidden="true">{accountCount}</span>
              <span className="sr-only">
                {accountCount} account{accountCount === 1 ? "" : "s"} / key{accountCount === 1 ? "" : "s"}
              </span>
            </span>
          )}
        </button>
      </td>
      <td data-label="Spend" className="px-4 py-2">
        {family.financialsAggregated ? (
          <div role="group" aria-label={spendTitle}>
            <p
              aria-label={`${family.displayName} month-to-date spend: ${familySpendLabel}`}
              className="flex items-center gap-1.5 text-sm sm:whitespace-nowrap"
            >
              <span className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">{familySpendLabel}</span>
              <span aria-hidden="true" className={dotClass} />
            </p>
            <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
              {family.budgetUsd != null
                ? `${formatCurrency(family.budgetUsd)} budget`
                : family.projectedUsd != null
                  ? `${formatCurrency(family.projectedUsd)} projected`
                  : "Projection unavailable"}
              {" · "}{costCoverageLabel(family)} coverage
            </p>
          </div>
        ) : (
          <span className="block">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-gray-100 sm:whitespace-nowrap">
              Account total unresolved <span aria-hidden="true" className={dotClass} />
              <span className="sr-only">Account identity unresolved</span>
            </span>
            <span className="block text-xs text-gray-500 dark:text-gray-400">See exact account values below</span>
          </span>
        )}
        {family.costCoverageCaveatCount > 0 && (
          <details className="mt-0.5 text-[11px] text-orange-700 dark:text-orange-300">
            <summary className="flex cursor-pointer list-none items-center gap-1 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 [&::-webkit-details-marker]:hidden">
              <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
              Cost coverage gap
            </summary>
            <p className="mt-1 max-w-xs leading-relaxed">
              {family.costCoverageCaveatMessage ?? "Usage-based costs are not fully visible for this provider."}
            </p>
          </details>
        )}
      </td>
      <td data-label="Funds / quota" className="px-4 py-2">
        {family.financialsAggregated ? (
          <p className="text-sm sm:whitespace-nowrap" aria-label={creditsBalanceTitle}>
            {family.credits == null && family.balance == null ? (
              <span className="text-gray-500 dark:text-gray-400">--</span>
            ) : family.credits != null && family.balance != null ? (
              <>
                <span className="font-medium tabular-nums text-gray-800 dark:text-gray-200">{formatNumber(family.credits)} {financialSemantics.creditsLabel}</span>
                <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400"> · {formatCurrency(family.balance)} {financialSemantics.balanceLabel}</span>
              </>
            ) : family.credits != null ? (
              <span className="font-medium tabular-nums text-gray-800 dark:text-gray-200">{formatNumber(family.credits)} {financialSemantics.creditsLabel}</span>
            ) : (
              <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">{formatCurrency(family.balance)} {financialSemantics.balanceLabel}</span>
            )}
          </p>
        ) : (
          <p
            className="text-sm text-gray-500 dark:text-gray-400 sm:whitespace-nowrap"
            title="Expand for exact key and account values"
          >
            See exact values
          </p>
        )}
      </td>
      <td data-label="Services" className="px-4 py-2">
        <p className="text-sm sm:whitespace-nowrap" aria-label={servicesTitle}>
          <span className="font-medium tabular-nums text-gray-800 dark:text-gray-200">{recordCount}</span>
          {" · "}
          <span className="text-xs text-gray-500 dark:text-gray-400">{shortDate ?? "--"}</span>
        </p>
      </td>
      <td data-label="Health" className="px-4 py-2">
        <span
          className="flex items-center gap-1.5 sm:whitespace-nowrap"
          aria-label={healthAriaLabel}
        >
          {family.alertCount > 0 ? (
            <>
              <span
                aria-hidden="true"
                className={`h-2 w-2 shrink-0 rounded-full ${family.criticalCount > 0 ? "bg-red-600 dark:bg-red-400" : "bg-amber-600 dark:bg-amber-400"}`}
              />
              <span className="text-sm font-medium tabular-nums text-gray-800 dark:text-gray-200">{family.alertCount}</span>
            </>
          ) : (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              <span className="sr-only">No open alerts</span>
            </>
          )}
        </span>
      </td>
      <td data-label="Last sync" className="px-4 py-2 sm:px-6">
        <p
          className="text-sm tabular-nums text-gray-800 dark:text-gray-200 sm:whitespace-nowrap"
          aria-label={lastSyncTitle}
        >
          {formatRelativeTime(family.latestFetchedAt, nowMs)}
        </p>
      </td>
    </>
  );
}

/** Byte-identical to the pre-density-redesign markup; gated behind
 * density === "comfortable". */
function ComfortableFamilyCells({
  family,
  isCollapsed,
  onToggle,
  familySpendLabel,
}: {
  family: ProviderFamily;
  isCollapsed: boolean;
  onToggle: () => void;
  familySpendLabel: string;
}) {
  const financialSemantics = providerFinancialSemantics(family.providerName);
  return (
    <>
      <td data-label="Provider family" className="px-4 py-4 sm:px-6">
        <button
          type="button"
          aria-expanded={!isCollapsed}
          aria-controls={family.detailsId}
          aria-label={`${isCollapsed ? "Show" : "Hide"} ${family.displayName} account and service details`}
          onClick={onToggle}
          className="flex min-w-0 items-start gap-2 text-left"
        >
          {isCollapsed ? (
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
          ) : (
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
          )}
          <span className="min-w-0">
            <span className="block truncate font-semibold text-gray-900 dark:text-gray-100">{family.displayName}</span>
            <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
              {family.providers.length} account{family.providers.length === 1 ? "" : "s"} / key{family.providers.length === 1 ? "" : "s"}
            </span>
          </span>
        </button>
      </td>
      <td data-label="Spend" className="px-4 py-4">
        {family.financialsAggregated ? (
          <>
            <p
              aria-label={`${family.displayName} month-to-date spend: ${familySpendLabel}`}
              className="font-semibold text-gray-900 dark:text-gray-100"
            >
              {familySpendLabel}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {family.budgetUsd != null
                ? `${formatCurrency(family.budgetUsd)} budget`
                : family.projectedUsd != null
                  ? `${formatCurrency(family.projectedUsd)} projected`
                  : "Projection unavailable"}
            </p>
          </>
        ) : (
          <>
            <p className="font-semibold text-gray-900 dark:text-gray-100">Account total unresolved</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              See exact account values below
            </p>
          </>
        )}
        <span
          className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
            family.financialsAggregated && family.incompleteCostCount === 0
              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
              : "bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
          }`}
          title={(() => {
            const kind = familyCostCoverageKind(family);
            return kind && kind !== "complete" ? costCoverageHelpText(kind) : undefined;
          })()}
        >
          {costCoverageLabel(family)}
        </span>
        {family.costCoverageCaveatCount > 0 && (
          <span
            className="mt-1 flex items-center gap-1 text-[11px] font-medium text-orange-700 dark:text-orange-300"
            title={family.costCoverageCaveatMessage ?? "Usage-based costs are not fully visible for this provider."}
          >
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
            Cost coverage gap
          </span>
        )}
      </td>
      <td data-label="Funds / quota" className="px-4 py-4">
        {family.financialsAggregated ? (
          <>
            <p className="font-medium text-gray-800 dark:text-gray-200">{formatNumber(family.credits)} {financialSemantics.creditsLabel}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">{formatCurrency(family.balance)} {financialSemantics.balanceLabel}</p>
          </>
        ) : (
          <>
            <p className="font-medium text-gray-800 dark:text-gray-200">See exact values</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">No unproven totals</p>
          </>
        )}
      </td>
      <td data-label="Services" className="px-4 py-4">
        <p className="font-medium text-gray-800 dark:text-gray-200">
          {family.subscriptions.length + family.providerExternalBilling.length} {family.hiddenExternalBillingCount > 0 ? "visible " : ""}record{family.subscriptions.length + family.providerExternalBilling.length === 1 ? "" : "s"}
        </p>
        {family.hiddenExternalBillingCount > 0 && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {family.hiddenExternalBillingCount} additional detail{family.hiddenExternalBillingCount === 1 ? "" : "s"} hidden
          </p>
        )}
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {family.nextRenewalAt
            ? `Next renewal ${formatDate(family.nextRenewalAt)}`
            : "No active future renewal"}
        </p>
      </td>
      <td data-label="Health" className="px-4 py-4">
        {family.alertCount > 0 ? (
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
            family.criticalCount > 0
              ? "bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300"
              : "bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
          }`}>
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            {family.alertCount} alert{family.alertCount === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="inline-flex rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
            Clear
          </span>
        )}
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{family.activeCount} active</p>
      </td>
      <td data-label="Last sync" className="px-4 py-4 sm:px-6">
        <p className="font-medium text-gray-800 dark:text-gray-200">{formatDate(family.latestFetchedAt)}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">{family.providerName}</p>
      </td>
    </>
  );
}

export default function DashboardProviderWorkspace({
  providers,
  subscriptions,
  initiallyExpanded = false,
}: DashboardProviderWorkspaceProps) {
  const [query, setQuery] = useState("");
  const [filterChip, setFilterChip] = useState<FilterChip>("all");
  // Unified with Nav global density (Wave D / D3). Legacy workspace key is
  // migrated once into DISPLAY_DENSITY_STORAGE_KEY on first mount.
  const density = useDisplayDensity();
  const setDensity = (next: DisplayDensity) => setStoredDisplayDensity(next);
  const [sortField, setSortField] = useState<WorkspaceSortField>("attention");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [referenceNow] = useState(() => Date.now());
  const [hydratedFromStorage, setHydratedFromStorage] = useState(false);

  // Post-mount read only (never during render, per the persistence contract).
  // The hydrate-from-storage-on-mount pattern below intentionally sets state
  // synchronously in this effect (same pattern as Nav.tsx's mounted flag).
  useEffect(() => {
    try {
      const rawSort = window.localStorage.getItem(SORT_STORAGE_KEY);
      if (rawSort) {
        const parsed: unknown = JSON.parse(rawSort);
        if (parsed && typeof parsed === "object") {
          const field = (parsed as { field?: unknown }).field;
          const direction = (parsed as { direction?: unknown }).direction;
          if (isWorkspaceSortField(field) && isSortDirection(direction)) {
            // eslint-disable-next-line react-hooks/exhaustive-deps
            setSortField(field);
            setSortDirection(direction);
          }
        }
      }
      // One-time migrate legacy workspace density into the global key.
      const legacy = window.localStorage.getItem(LEGACY_DENSITY_STORAGE_KEY);
      if (isDensity(legacy)) {
        const current = getStoredDisplayDensity();
        // Prefer explicit global if already set; otherwise adopt legacy.
        if (
          !window.localStorage.getItem("display-density") &&
          isDensity(legacy)
        ) {
          setStoredDisplayDensity(legacy);
        } else if (current) {
          // no-op — global already authoritative
        }
        try {
          window.localStorage.removeItem(LEGACY_DENSITY_STORAGE_KEY);
        } catch {
          // ignore
        }
      }
    } catch {
      // Ignore corrupted/unavailable storage — fall back to defaults.
    } finally {
      setHydratedFromStorage(true);
    }
  }, []);

  // Write is gated on the read above so mount doesn't clobber stored values.
  useEffect(() => {
    if (!hydratedFromStorage) return;
    try {
      window.localStorage.setItem(
        SORT_STORAGE_KEY,
        JSON.stringify({ field: sortField, direction: sortDirection })
      );
    } catch {
      // Ignore write failures (private mode, quota, etc.).
    }
  }, [sortField, sortDirection, hydratedFromStorage]);

  const handleSort = (field: WorkspaceSortField) => {
    if (field === "attention") {
      setSortField("attention");
      setSortDirection("desc");
      return;
    }
    if (sortField === field) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection(INITIAL_SORT_DIRECTION[field]);
    }
  };

  const sortHeaderProps = {
    activeField: sortField,
    direction: sortDirection,
    onSort: handleSort,
  };

  const families = useMemo<ProviderFamily[]>(() => {
    const providersByFamily = new Map<string, WorkspaceProvider[]>();
    for (const provider of providers) {
      const key = familyKey(provider);
      const group = providersByFamily.get(key);
      if (group) group.push(provider);
      else providersByFamily.set(key, [provider]);
    }

    return [...providersByFamily.entries()].map(([key, groupProviders]) => {
      const groupProviderIds = new Set(groupProviders.map((provider) => provider.id));
      const familySubscriptions = subscriptions.filter((subscription) =>
        groupProviderIds.has(subscription.provider.id)
      ).toSorted((a, b) => a.name.localeCompare(b.name));
      const linkedExternalBilling = new Set(
        familySubscriptions
          .map(subscriptionBillingIdentity)
          .filter((identity): identity is string => identity != null)
      );
      const seenExternalBilling = new Set<string>();
      const allProviderExternalBilling: FamilyExternalBillingRecord[] = [];
      for (const provider of groupProviders) {
        for (const [index, record] of (provider.externalBilling ?? []).entries()) {
          const canonicalIdentity = externalBillingIdentity(provider.id, record);
          const renderKey = canonicalIdentity ?? JSON.stringify([
            provider.id,
            record.source,
            record.kind,
            index,
          ]);
          if (seenExternalBilling.has(renderKey)) {
            continue;
          }
          seenExternalBilling.add(renderKey);
          allProviderExternalBilling.push({
            key: renderKey,
            providerId: provider.id,
            providerDisplayName: provider.displayName,
            record,
          });
        }
      }
      const providerExternalBilling = allProviderExternalBilling.filter(
        ({ providerId, record }) => {
          const identity = externalBillingIdentity(providerId, record);
          return identity == null || !linkedExternalBilling.has(identity);
        }
      );
      const orderedProviders = groupProviders.toSorted((a, b) =>
        a.displayName.localeCompare(b.displayName)
      );
      // Override each member's spentUsd with the coverage-aware value (null,
      // not a literal 0, when spendCoverage is unknown/legacy_unknown) so an
      // untrustworthy reading can never surface as an authoritative "$0.00"
      // once it flows through family-level aggregation.
      const moneyMembers = groupProviders.map((groupProvider) => ({
        ...groupProvider,
        spentUsd: providerSpend(groupProvider),
      }));
      const money = aggregateProviderFamilyMoney(
        moneyMembers,
        new Date(referenceNow)
      );
      const financialsAggregated = money.exact;
      const onlyProvider = groupProviders.length === 1 ? groupProviders[0] : null;
      const spendValues = groupProviders.map(providerSpend);
      const oneAccount = money.exact && money.accountCount === 1;
      const latestAccountProvider = oneAccount
        ? groupProviders.toSorted(
            (left, right) =>
              Date.parse(right.latestSnapshot?.fetchedAt ?? "") -
              Date.parse(left.latestSnapshot?.fetchedAt ?? "")
          )[0]
        : null;
      const externalRenewals = allProviderExternalBilling
        .filter(({ record }) => isExternalBillingRenewal(record))
        .map(({ record }) => record.nextRenewalAt);
      const subscriptionRenewals = familySubscriptions
        .filter(
          (subscription) =>
            effectiveSubscriptionStatus(subscription) === "active" &&
            subscription.autoRenew
        )
        .map((subscription) => subscription.nextRenewalAt);
      return {
        key,
        detailsId: `provider-family-details-${groupProviders[0]?.id ?? key}`,
        displayName: familyDisplayName(groupProviders),
        providerName: groupProviders[0]?.name ?? key,
        providers: orderedProviders,
        subscriptions: familySubscriptions,
        providerExternalBilling: providerExternalBilling.toSorted((a, b) =>
          (a.record.serviceName ?? a.record.planName ?? a.record.kind).localeCompare(
            b.record.serviceName ?? b.record.planName ?? b.record.kind
          )
        ),
        hiddenExternalBillingCount: groupProviders.reduce(
          (sum, provider) => sum + (provider.externalBillingHiddenCount ?? 0),
          0
        ),
        searchableExternalBilling: allProviderExternalBilling,
        financialsAggregated,
        spentUsd: money.spentUsd,
        projectedUsd: money.projectedEomUsd,
        // Multi-key families: sum member budgets when any are set (not only the singleton).
        budgetUsd: (() => {
          const budgets = groupProviders
            .map((p) => p.plan?.monthlyBudgetUsd)
            .filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
          if (budgets.length === 0) return null;
          return budgets.reduce((sum, v) => sum + v, 0);
        })(),
        spendSortUsd: money.exact
          ? money.spentUsd ?? 0
          : Math.max(
              0,
              ...spendValues.filter((value): value is number => value != null)
            ),
        credits: latestAccountProvider?.latestSnapshot?.credits ?? null,
        balance: latestAccountProvider?.latestSnapshot?.balance ?? null,
        alertCount: groupProviders.reduce(
          (sum, provider) => sum + provider.alerts.filter((alert) => alert.severity !== "info").length,
          0
        ),
        criticalCount: groupProviders.reduce(
          (sum, provider) => sum + provider.alerts.filter((alert) => alert.severity === "critical").length,
          0
        ),
        activeCount: groupProviders.filter((provider) => provider.isActive).length,
        incompleteCostCount: groupProviders.filter((provider) => provider.isActive && provider.spendCoverage !== "complete").length,
        costCoverageCaveatCount: groupProviders.filter((provider) => provider.isActive && provider.costCoverageCaveat != null).length,
        costCoverageCaveatMessage:
          groupProviders.find((provider) => provider.isActive && provider.costCoverageCaveat != null)
            ?.costCoverageCaveat?.message ?? null,
        nextRenewalAt: earliestFutureDate(
          [...subscriptionRenewals, ...externalRenewals],
          referenceNow
        ),
        latestFetchedAt: latestDate(groupProviders.map((provider) => provider.latestSnapshot?.fetchedAt)),
      };
    });
  }, [providers, referenceNow, subscriptions]);

  const visibleFamilies = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const searched = normalizedQuery
      ? families.filter((family) => {
          const haystack = [
            family.displayName,
            family.providerName,
            ...family.providers.flatMap((provider) => [
              provider.displayName,
              provider.label ?? "",
              provider.keyPreview ?? "",
              provider.type,
            ]),
            ...family.subscriptions.flatMap((subscription) => [
              subscription.name,
              subscription.description ?? "",
              subscription.currency,
              subscription.externalBillingSource ?? "",
              subscription.externalBillingId ?? "",
              subscription.project?.name ?? "",
            ]),
            ...family.searchableExternalBilling.flatMap(({ providerDisplayName, record }) => [
              providerDisplayName,
              record.source,
              record.externalId ?? "",
              record.kind,
              record.serviceName ?? "",
              record.planName ?? "",
              record.status ?? "",
              record.currency ?? "",
              record.billingInterval ?? "",
            ]),
          ].join(" ").toLowerCase();
          return haystack.includes(normalizedQuery);
        })
      : families;

    const filtered = searched.filter((family) => familyMatchesFilter(family, filterChip));

    return filtered.toSorted((a, b) => {
      if (sortField === "attention") {
        return (
          b.criticalCount - a.criticalCount ||
          b.alertCount - a.alertCount ||
          b.spendSortUsd - a.spendSortUsd ||
          a.displayName.localeCompare(b.displayName)
        );
      }
      const comparison = compareFamiliesBy(sortField, a, b);
      const directed = sortDirection === "asc" ? comparison : -comparison;
      return directed || a.displayName.localeCompare(b.displayName);
    });
  }, [families, query, filterChip, sortField, sortDirection]);

  if (providers.length === 0) {
    return (
      <section className="flex flex-col items-center justify-center gap-4 rounded-lg border border-gray-200 bg-white py-16 text-center dark:border-gray-700 dark:bg-gray-800">
        <p className="text-gray-500 dark:text-gray-400">No providers configured yet.</p>
        <Link
          href="/settings"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Add your first provider
        </Link>
      </section>
    );
  }

  // Deliberately NOT memoized/frozen (unlike `referenceNow` above): this
  // component only renders client-side after the initial fetch (page.tsx
  // SSRs the loading skeleton, so there is no hydration mismatch), and a
  // fresh `Date.now()` per render keeps "Last sync"/renewal labels current
  // across the 60s background refresh (see §3.3 of the density-redesign spec).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nowMs = Date.now();
  const resetFilters = () => {
    setQuery("");
    setFilterChip("all");
  };

  return (
    <section className="workspace-container rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800" aria-labelledby="provider-workspace-heading">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 px-4 py-4 dark:border-gray-700 sm:px-6">
        <div>
          <h2 id="provider-workspace-heading" className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Provider workspace
          </h2>
          <p className="mt-1 max-w-3xl text-xs text-gray-500 dark:text-gray-400">
            {families.length} provider families, {providers.length} configured accounts, {subscriptions.length} tracked services. Select a family to show account and service details.
          </p>
        </div>
        <Link href="/settings" className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700">
          <Settings className="h-3.5 w-3.5" aria-hidden="true" />
          Settings
        </Link>
      </div>

      <div className="flex flex-col gap-3 border-b border-gray-100 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800 sm:sticky sm:top-16 z-40 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <label className="relative block min-w-0 flex-1 sm:max-w-md">
          <span className="sr-only">Search provider families</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search providers, accounts, keys, services"
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:focus:ring-blue-950"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={sortField === "attention"}
            onClick={() => handleSort("attention")}
            className={toggleButtonClass(sortField === "attention")}
          >
            Attention
          </button>
          <div role="group" aria-label="Filter provider families" className="flex flex-wrap items-center gap-2">
            {FILTER_CHIPS.map(([chip, label]) => (
              <button
                key={chip}
                type="button"
                aria-pressed={filterChip === chip}
                onClick={() => setFilterChip(chip)}
                className={toggleButtonClass(filterChip === chip)}
              >
                {label}
              </button>
            ))}
          </div>
          <div role="group" aria-label="Row density" className="flex items-center gap-2 sm:border-l sm:border-gray-200 sm:pl-2 dark:sm:border-gray-700">
            <button
              type="button"
              aria-pressed={density === "compact"}
              onClick={() => setDensity("compact")}
              className={toggleButtonClass(density === "compact")}
            >
              Compact
            </button>
            <button
              type="button"
              aria-pressed={density === "comfortable"}
              onClick={() => setDensity("comfortable")}
              className={toggleButtonClass(density === "comfortable")}
            >
              Comfortable
            </button>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-b-lg">
        <table className="responsive-table w-full text-sm">
          <caption className="sr-only">Provider families with expandable account, service, usage, quota, renewal, and alert rows</caption>
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/60">
              <SortHeader {...sortHeaderProps} field="name" label="Provider family" paddingClassName="px-4 py-3 sm:px-6" labelClassName="text-xs" />
              <SortHeader {...sortHeaderProps} field="spend" label="Spend" paddingClassName="px-4 py-3" labelClassName="text-xs" />
              <SortHeader {...sortHeaderProps} field="credits" label="Funds / quota" paddingClassName="px-4 py-3" labelClassName="text-xs" />
              <SortHeader {...sortHeaderProps} field="services" label="Services" paddingClassName="px-4 py-3" labelClassName="text-xs" title="Sort by next renewal date" />
              <SortHeader {...sortHeaderProps} field="health" label="Health" paddingClassName="px-4 py-3" labelClassName="text-xs" />
              <SortHeader {...sortHeaderProps} field="lastSync" label="Last sync" paddingClassName="px-4 py-3 sm:px-6" labelClassName="text-xs" />
            </tr>
          </thead>
          <tbody>
            {visibleFamilies.map((family) => {
              const isCollapsed = collapsed[family.key] ?? !initiallyExpanded;
              const familyHasPartial = family.providers.some(
                (p) => p.isActive && p.spendCoverage === "partial"
              );
              const familySpendLabel = family.spentUsd == null
                ? "Cost not reported"
                : `${formatCurrency(family.spentUsd)}${
                    familyHasPartial || family.incompleteCostCount > 0 ? " known" : ""
                  }`;
              const onToggle = () =>
                setCollapsed((current) => ({ ...current, [family.key]: !isCollapsed }));
              return (
                <Fragment key={family.key}>
                  <tr
                    className={
                      density === "compact"
                        ? "border-b border-gray-100 align-middle hover:bg-gray-50/70 dark:border-gray-700 dark:hover:bg-gray-700/40"
                        : "border-b border-gray-100 align-top hover:bg-gray-50/70 dark:border-gray-700 dark:hover:bg-gray-700/40"
                    }
                  >
                    {density === "compact" ? (
                      <CompactFamilyCells
                        family={family}
                        isCollapsed={isCollapsed}
                        onToggle={onToggle}
                        familySpendLabel={familySpendLabel}
                        nowMs={nowMs}
                      />
                    ) : (
                      <ComfortableFamilyCells
                        family={family}
                        isCollapsed={isCollapsed}
                        onToggle={onToggle}
                        familySpendLabel={familySpendLabel}
                      />
                    )}
                  </tr>
                  <tr
                    id={family.detailsId}
                    hidden={isCollapsed}
                    style={isCollapsed ? { display: "none" } : undefined}
                    className="border-b border-gray-100 bg-gray-50/70 dark:border-gray-700 dark:bg-gray-900/30"
                  >
                    <td colSpan={6} className="table-group-cell px-4 py-3 sm:px-6">
                      {!isCollapsed && (
                        <div className="grid gap-2 lg:grid-cols-2">
                          {family.providers.map((provider) => (
                            <Link
                              key={provider.id}
                              href={`/providers/${provider.id}`}
                              className="flex min-w-0 items-start justify-between gap-3 rounded-lg border border-gray-200 bg-white px-3 py-3 hover:border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:hover:border-gray-600"
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{childLabel(provider)}</span>
                                <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                                  {provider.keyPreview && (
                                    <span className="inline-flex items-center gap-1 font-mono">
                                      <KeyRound className="h-3 w-3" aria-hidden="true" />
                                      {provider.keyPreview}
                                    </span>
                                  )}
                                  {provider.geminiKeyStatus && <span>{provider.geminiKeyStatus.state.replaceAll("_", " ")}</span>}
                                  {provider.geminiBillingStatus && <span>{provider.geminiBillingStatus.state.replaceAll("_", " ")}</span>}
                                  {provider.geminiMonitoringStatus && <span>usage {provider.geminiMonitoringStatus.state.replaceAll("_", " ")}</span>}
                                </span>
                              </span>
                              <span className="shrink-0 text-right">
                                <span
                                  aria-label={`${childLabel(provider)} month-to-date spend: ${providerSpendLabel(provider)}`}
                                  className="block text-sm font-semibold text-gray-900 dark:text-gray-100"
                                >
                                  {providerSpendLabel(provider)}
                                </span>
                                <span className="block text-xs text-gray-500 dark:text-gray-400">
                                  {providerProjectionLabel(provider)}
                                </span>
                                {(provider.receiptCashPaidUsd ?? 0) > 0 && (
                                  <span className="block text-xs text-emerald-700 dark:text-emerald-300">
                                    {formatCurrency(provider.receiptCashPaidUsd ?? 0)} receipt cash
                                  </span>
                                )}
                                {(provider.estimatedApiEquivalentUsd ?? 0) > 0 && (
                                  <span className="block text-xs text-amber-700 dark:text-amber-300">
                                    {formatCurrency(provider.estimatedApiEquivalentUsd ?? 0)} Claude estimate excluded
                                  </span>
                                )}
                                {provider.costCoverageCaveat && (
                                  <span className="block text-xs font-medium text-orange-700 dark:text-orange-300">
                                    {provider.costCoverageCaveat.message}
                                  </span>
                                )}
                                <span className="block text-xs text-gray-500 dark:text-gray-400">
                                  {formatCurrency(provider.plan?.monthlyBudgetUsd ?? null)} budget
                                </span>
                                <span className="block text-xs text-gray-500 dark:text-gray-400">
                                  {formatNumber(provider.latestSnapshot?.credits ?? null)} {providerFinancialSemantics(provider.name).creditsLabel} / {formatCurrency(provider.latestSnapshot?.balance ?? null)} {providerFinancialSemantics(provider.name).balanceLabel}
                                </span>
                                {(provider.externalBillingHiddenCount ?? 0) > 0 && (
                                  <span className="block text-xs text-violet-700 dark:text-violet-300">
                                    {provider.externalBillingHiddenCount} additional billing detail{provider.externalBillingHiddenCount === 1 ? "" : "s"} hidden; open to view all
                                  </span>
                                )}
                                {provider.plan?.renewalDate && (
                                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                                    Plan renewal {formatDate(provider.plan.renewalDate)}
                                  </span>
                                )}
                                <span className="block text-xs text-gray-500 dark:text-gray-400">
                                  {provider.alerts.filter((alert) => alert.severity !== "info").length} alerts
                                </span>
                              </span>
                            </Link>
                          ))}
                          {family.subscriptions.map((subscription) => {
                            const linkedRecord = linkedExternalBillingRecord(
                              family,
                              subscription
                            );
                            return (
                              <Link
                                key={subscription.id}
                                href="/settings?tab=services"
                                className="flex min-w-0 items-start justify-between gap-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-3 hover:border-blue-200 dark:border-blue-900 dark:bg-blue-950/30 dark:hover:border-blue-800"
                              >
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-semibold text-blue-950 dark:text-blue-100">{subscription.name}</span>
                                  <span className="mt-0.5 block text-xs text-blue-700 dark:text-blue-300">
                                    {effectiveSubscriptionStatus(subscription)} / {subscription.intervalCount === 1 ? subscription.interval : `${subscription.intervalCount} ${subscription.interval}`}
                                    {subscription.externalBillingSource
                                      ? ` / linked ${subscription.externalBillingSource}`
                                      : ""}
                                  </span>
                                  {linkedRecord && (
                                    <span className="mt-0.5 block text-xs text-blue-700 dark:text-blue-300">
                                      Provider: {linkedRecord.planName || linkedRecord.serviceName || linkedRecord.kind} / {externalBillingDateSummary(linkedRecord, referenceNow)}
                                    </span>
                                  )}
                                </span>
                                <span className="shrink-0 text-right">
                                  <span className="block text-sm font-semibold text-blue-950 dark:text-blue-100">
                                    {formatCurrency(subscription.costUsd, subscription.currency)}
                                  </span>
                                  <span className="block text-xs text-blue-700 dark:text-blue-300">
                                    {subscriptionDateSummary(subscription, referenceNow)}
                                  </span>
                                </span>
                              </Link>
                            );
                          })}
                          {family.providerExternalBilling.map(({ key, providerId, providerDisplayName, record }) => (
                            <Link
                              key={key}
                              href={`/providers/${providerId}`}
                              className="flex min-w-0 items-start justify-between gap-3 rounded-lg border border-violet-100 bg-violet-50 px-3 py-3 hover:border-violet-200 dark:border-violet-900 dark:bg-violet-950/30 dark:hover:border-violet-800"
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-semibold text-violet-950 dark:text-violet-100">
                                  {record.serviceName || record.planName || record.kind}
                                </span>
                                <span className="mt-0.5 block text-xs text-violet-700 dark:text-violet-300">
                                  {providerDisplayName} / {record.source} / {record.kind}
                                  {record.planName ? ` / ${record.planName}` : ""}
                                  {record.status ? ` / ${record.status}` : ""}
                                </span>
                              </span>
                              <span className="shrink-0 text-right">
                                <span className="block text-sm font-semibold text-violet-950 dark:text-violet-100">
                                  {formatCurrency(record.amountUsd, record.currency ?? "USD")}
                                  {record.billingInterval ? ` / ${record.billingInterval}` : ""}
                                </span>
                                <span className="block text-xs text-violet-700 dark:text-violet-300">
                                  {externalBillingDateSummary(record, referenceNow)}
                                </span>
                              </span>
                            </Link>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {visibleFamilies.length === 0 && families.length > 0 && (
        <div className="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400 sm:px-6">
          <p>{emptyStateMessage(query, filterChip)}</p>
          <button
            type="button"
            onClick={resetFilters}
            className={`mt-3 ${toggleButtonClass(false)}`}
          >
            Reset search & filters
          </button>
        </div>
      )}
    </section>
  );
}
