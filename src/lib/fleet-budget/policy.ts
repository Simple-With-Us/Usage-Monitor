import { createHash } from "node:crypto";
import { z } from "zod";

export const DEFAULT_FLEET_POLICY = {
  timeZone: "America/Chicago" as const,
  softLimitMicros: 500_000,
  hardLimitMicros: 1_500_000,
};
const boundedInt = z.number().int().min(0).max(1_000_000_000);
// Permits a conservative full-context reservation without rounding "1M" down.
// DeepSeek Flash's documented input+output context is 1,048,576 tokens:
// https://api-docs.deepseek.com/api/list-models/ (verified 2026-10-07).
// This is a schema ceiling, not active provider configuration or pricing.
const maxReservationInputTokens = 1_048_576;
export const pricingSchema = z.object({
  model: z.string().regex(/^[a-zA-Z0-9._/-]{1,100}$/),
  // USD micro-units per million tokens, including all reasoning output.
  inputMicrosPerMillion: boundedInt.positive(),
  cachedInputMicrosPerMillion: boundedInt,
  outputMicrosPerMillion: boundedInt.positive(),
  maxInputTokens: z.number().int().min(1).max(maxReservationInputTokens),
  maxOutputTokens: z.number().int().min(1).max(100_000),
  source: z.string().url().max(500).refine((v) => {
    try { const url = new URL(v); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; }
    catch { return false; }
  }),
  verifiedAt: z.string().datetime(),
  validUntil: z.string().datetime(),
}).strict().refine((v) => Date.parse(v.validUntil) > Date.parse(v.verifiedAt)
  && Date.parse(v.validUntil) - Date.parse(v.verifiedAt) <= 7 * 86400_000,
"Pricing freshness may cover at most seven days");
export const policySchema = z.object({
  softLimitMicros: boundedInt.positive().max(DEFAULT_FLEET_POLICY.softLimitMicros).default(DEFAULT_FLEET_POLICY.softLimitMicros),
  hardLimitMicros: boundedInt.positive().max(DEFAULT_FLEET_POLICY.hardLimitMicros).default(DEFAULT_FLEET_POLICY.hardLimitMicros),
  deepseek: pricingSchema,
  minimax: pricingSchema,
}).strict().refine((v) => v.softLimitMicros <= v.hardLimitMicros);
export type Pricing = z.infer<typeof pricingSchema>;
export type FleetPolicy = z.infer<typeof policySchema>;
export type Provider = "deepseek" | "minimax";
export const requestSchema = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9._:-]{1,160}$/),
  maxInputTokens: z.number().int().min(1).max(maxReservationInputTokens),
  maxOutputTokens: z.number().int().min(1).max(100_000),
  route: z.enum(["primary", "fallback"]).default("primary"),
}).strict();
export type ReservationInput = z.infer<typeof requestSchema>;
export const usageSchema = z.object({
  inputTokens: z.number().int().min(0).max(10_000_000),
  cachedInputTokens: z.number().int().min(0).max(10_000_000),
  outputTokens: z.number().int().min(0).max(1_000_000),
  // An authenticated producer assertion, not independently verified cash.
  providerReportedCostMicros: boundedInt.optional(),
}).strict().refine((v) => v.cachedInputTokens <= v.inputTokens);
export type Usage = z.infer<typeof usageSchema>;

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
const chicagoDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: DEFAULT_FLEET_POLICY.timeZone, year: "numeric", month: "2-digit", day: "2-digit",
});
export function dayKey(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid clock");
  return chicagoDate.format(now);
}
/** First millisecond in the next Chicago day, including 23/25-hour DST days. */
export function nextDayStart(now: Date): Date {
  const day = dayKey(now);
  let low = now.getTime(), high = low + 26 * 3600_000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (dayKey(new Date(middle)) === day) low = middle;
    else high = middle;
  }
  return new Date(high);
}
export function priceFresh(price: Pricing, now: Date): boolean {
  return Date.parse(price.verifiedAt) <= now.getTime() && now.getTime() < Date.parse(price.validUntil);
}
function ceilMillion(n: bigint): bigint {
  return (n + BigInt(999_999)) / BigInt(1_000_000);
}
export function upperBound(price: Pricing, input: ReservationInput): bigint {
  return ceilMillion(BigInt(input.maxInputTokens) * BigInt(Math.max(price.inputMicrosPerMillion, price.cachedInputMicrosPerMillion))
    + BigInt(input.maxOutputTokens) * BigInt(price.outputMicrosPerMillion));
}
export function usageCost(price: Pricing, usage: Usage): bigint {
  return ceilMillion(BigInt(usage.inputTokens - usage.cachedInputTokens) * BigInt(price.inputMicrosPerMillion)
    + BigInt(usage.cachedInputTokens) * BigInt(price.cachedInputMicrosPerMillion)
    + BigInt(usage.outputTokens) * BigInt(price.outputMicrosPerMillion));
}
