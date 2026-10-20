/** Selective authenticated quota-response projection of CodeCaps scalar plan metadata. */
export interface QuotaPlanMetadata {
  detectedPlanName?: string;
  userPlanName?: string;
  userCostUsd?: string;
  userRenewalDateText?: string;
  userSubtitle?: string;
  showCostAndRenewal?: boolean;
  hasMismatch: boolean;
}

export const PLAN_METADATA_STRING_LIMITS: Record<string, number> = {
  planDetectedName: 256,
  planUserName: 256,
  planUserCostUsd: 128,
  planUserRenewalDateText: 512,
  planUserSubtitle: 1024,
};

export function projectQuotaPlanMetadata(meta: Record<string, unknown>): QuotaPlanMetadata | undefined {
  const result: QuotaPlanMetadata = { hasMismatch: meta.planHasMismatch === true };
  let present = typeof meta.planHasMismatch === "boolean";
  for (const [key, field] of [
    ["planDetectedName", "detectedPlanName"],
    ["planUserName", "userPlanName"],
    ["planUserCostUsd", "userCostUsd"],
    ["planUserRenewalDateText", "userRenewalDateText"],
    ["planUserSubtitle", "userSubtitle"],
  ] as const) {
    const value = meta[key];
    if (typeof value !== "string" || !value.trim()) continue;
    result[field] = value.slice(0, PLAN_METADATA_STRING_LIMITS[key]);
    present = true;
  }
  if (typeof meta.planShowCostAndRenewal === "boolean") {
    result.showCostAndRenewal = meta.planShowCostAndRenewal;
    present = true;
  }
  return present ? result : undefined;
}
