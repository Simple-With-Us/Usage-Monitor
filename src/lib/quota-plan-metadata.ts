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

/**
 * Read a quota event's `metadata` as a record.
 *
 * The primary read path is `prisma.$queryRaw`, which returns the SQLite JSON
 * column as raw TEXT, not as a deserialized object (verified against Prisma
 * 6.19 on SQLite).  Prisma's query builder deserializes `Json?`, but a raw
 * query does not, so `metadata` arrives as a JSON string there and as an object
 * on the `findMany` fallback.  A plain object check therefore yields `{}` on
 * the primary path and silently drops `planMetadata` / `planName` — the whole
 * point of this projection.  Parse the string shape and pass objects through.
 */
export function quotaMetadataRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* Malformed JSON is an empty record, never a thrown quota response. */
    }
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * Detected plan name for the public `planName` field, falling back to the legacy
 * `planType` / `planName` metadata keys when the typed field is absent.
 *
 * Rows stored before the code-point-safe truncation existed were cut with
 * `String.prototype.slice`, so a legacy value can still hold a lone surrogate.
 * The fallback must go through `truncatePlanText` too: it is published in the
 * same payload as the projected metadata, and one lone surrogate makes
 * Foundation's `JSONDecoder` reject the entire quota response.
 */
export function quotaDetectedPlanName(
  planMetadata: QuotaPlanMetadata | undefined,
  meta: Record<string, unknown>,
): string | null {
  const projected = planMetadata?.detectedPlanName;
  if (projected) return projected;
  // Pick the first *usable* candidate, not the first present one: a legacy row
  // can carry a blank or non-string `planType` ("" or 42), which `??` would
  // short-circuit on and silently drop a perfectly good `planName` behind it.
  for (const candidate of [meta.planType, meta.planName]) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    return truncatePlanText(candidate, PLAN_METADATA_STRING_LIMITS.planDetectedName);
  }
  return null;
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
