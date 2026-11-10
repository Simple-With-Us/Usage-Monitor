/**
 * Internal Provider rows that exist only as persistence anchors for features
 * that are not real API connections (alert FKs, catalog seeds, etc.).
 *
 * They must never appear in Connections / Providers / money portfolio UI, and
 * must never be activated or polled. Alert-delivery still reads them by name.
 */

import { canonicalProviderKey } from "@/lib/provider-identity";

/** Sentinel that carries per-project budget/anomaly incidents (scope = project id). */
export const PROJECT_BUDGETS_PROVIDER_NAME = "project-budgets";
export const PROJECT_BUDGETS_PROVIDER_DISPLAY_NAME = "Project Budgets";

/**
 * Names that are implementation detail, not operator-managed connections.
 * Keep simple-tools-relay off this list: it is a real (inactive) catalog row
 * operators may still see in historical inventories.
 */
const INTERNAL_SYSTEM_PROVIDER_NAMES = new Set([
  canonicalProviderKey(PROJECT_BUDGETS_PROVIDER_NAME),
]);

export function isInternalSystemProviderName(
  name: string | null | undefined
): boolean {
  if (!name?.trim()) return false;
  return INTERNAL_SYSTEM_PROVIDER_NAMES.has(canonicalProviderKey(name));
}

/** Prisma `where` fragment: exclude internal system rows from operator lists. */
export function excludeInternalSystemProvidersWhere(): {
  name: { notIn: string[] };
} {
  return {
    name: {
      notIn: [PROJECT_BUDGETS_PROVIDER_NAME],
    },
  };
}

export function filterOutInternalSystemProviders<T extends { name: string }>(
  providers: readonly T[]
): T[] {
  return providers.filter((p) => !isInternalSystemProviderName(p.name));
}
