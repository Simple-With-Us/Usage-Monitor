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

/**
 * Code-point-safe truncation.  `String.prototype.slice` cuts on UTF-16 code
 * units, so an astral character (an emoji, say) straddling the boundary leaves
 * a lone surrogate.  `JSON.stringify` then emits that as an invalid escape and
 * Foundation's `JSONDecoder` rejects the whole payload, costing the iOS client
 * the entire quota response rather than just this optional field.
 */
export function truncatePlanText(value: string, limit: number): string {
  let result = "";
  for (const point of value) {
    const code = point.charCodeAt(0);
    // Iteration combines valid pairs; single surrogate units are invalid legacy input.
    if (point.length === 1 && code >= 0xd800 && code <= 0xdfff) continue;
    if (result.length + point.length > limit) break;
    result += point;
  }
  return result;
}

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
    result[field] = truncatePlanText(value, PLAN_METADATA_STRING_LIMITS[key]);
    present = true;
  }
  if (typeof meta.planShowCostAndRenewal === "boolean") {
    result.showCostAndRenewal = meta.planShowCostAndRenewal;
    present = true;
  }
  return present ? result : undefined;
}
