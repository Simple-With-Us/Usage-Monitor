import { z } from "zod";

export const quotaSourceFreshnessSchema = z.enum(["fresh", "stale", "old"]);

/** Client-side validation for `/api/quota-windows` source rows (quotaGroups + legacy). */
export const quotaSourceReadingSchema = z.object({
  source: z.string(),
  sourceLabel: z.string(),
  machine: z.string().nullable(),
  collector: z.string().nullable(),
  remainingPercent: z.number().nullable(),
  remainingUnknown: z.boolean(),
  isExhausted: z.boolean(),
  resetAt: z.string().nullable(),
  reportedAt: z.string(),
  freshness: quotaSourceFreshnessSchema,
  detail: z.string().nullable().optional(),
});

const quotaGroupWindowSchema = z
  .object({
    windowKey: z.string(),
    displayName: z.string(),
    rawKey: z.string(),
    platformTitle: z.string().nullable(),
    primary: quotaSourceReadingSchema,
    sources: z.array(quotaSourceReadingSchema),
  })
  .passthrough();

const quotaProviderQuotaGroupSchema = z
  .object({
    provider: z.string(),
    providerLabel: z.string(),
    windows: z.array(quotaGroupWindowSchema),
  })
  .passthrough();

const quotaWindowRowSchema = z.record(z.string(), z.unknown());

const quotaProviderGroupRowSchema = z.record(z.string(), z.unknown());

const skipModelTypeSchema = z.object({
  instanceId: z.string(),
  model: z.string(),
});

/**
 * Permissive envelope for quota-windows JSON: validates shape and nested
 * `quotaGroups` when present; individual `windows` / `providerGroups` rows
 * stay loosely typed because legacy clients normalize them field-by-field.
 */
export const quotaWindowsClientResponseSchema = z
  .object({
    generatedAt: z.string().optional(),
    windows: z.array(quotaWindowRowSchema).default([]),
    quotaGroups: z.array(quotaProviderQuotaGroupSchema).optional(),
    providerGroups: z.array(quotaProviderGroupRowSchema).optional(),
    skipModelTypes: z.array(skipModelTypeSchema).optional(),
  })
  .passthrough();
