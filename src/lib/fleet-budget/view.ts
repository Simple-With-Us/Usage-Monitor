import { z } from "zod";

const micros = z.string().regex(/^\d{1,16}$/).refine((v) => /^\d{1,16}$/.test(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER));
const count = z.number().int().nonnegative().safe();
const providerCost = z.object({
  provider: z.enum(["deepseek", "minimax"]), policyWeight: z.union([z.literal(0), z.literal(1)]),
  settledCalls: count, outstandingCalls: count, outstandingMaximumCostMicros: micros,
  estimatedCalls: count, knownEstimatedCostMicros: micros.nullable(),
  providerReportedCalls: count, knownProviderReportedCostMicros: micros.nullable(),
  providerReportedCostVerified: z.literal(false),
}).refine((row) => row.policyWeight === (row.provider === "deepseek" ? 1 : 0)
  && row.estimatedCalls <= row.settledCalls && row.providerReportedCalls <= row.settledCalls
  && (row.estimatedCalls === 0) === (row.knownEstimatedCostMicros === null)
  && (row.providerReportedCalls === 0) === (row.knownProviderReportedCostMicros === null));
export const budgetViewSchema = z.object({
  ok: z.literal(true), generatedAt: z.string().datetime(), enabled: z.boolean(), admissionEnabled: z.boolean(),
  snapshot: z.object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timeZone: z.literal("America/Chicago"),
    configured: z.boolean(), settledPolicyMicros: micros, reservedPolicyMicros: micros,
    softLimitMicros: micros.nullable(), hardLimitMicros: micros.nullable(),
    blocked: z.boolean(), estimatesAreCash: z.literal(false),
    providerCosts: z.array(providerCost).length(2).refine((rows) => new Set(rows.map((r) => r.provider)).size === 2),
  }),
});
export type FleetBudgetView = z.infer<typeof budgetViewSchema>;

export function formatBudgetMicros(value: string | null): string {
  if (value === null || !micros.safeParse(value).success) return "Unknown";
  const amount = BigInt(value), million = BigInt(1_000_000);
  const dollars = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(amount / million);
  const fraction = (amount % million).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `$${dollars}.${fraction}`;
}
