import { z } from "zod";
import { appSettings } from "@/lib/app-settings";
import { safeEqual, tokenFromRequest } from "@/lib/ingest-auth";
import { loadApnsConfig, type ApnsConfig } from "@/lib/apns";
import type { NextRequest } from "next/server";

export const CODECAPS_PUSH_BUNDLE_ID = "com.simplewithus.codecaps.ios";
export const CODECAPS_PUSH_RECEIPT_RETENTION_DAYS = 30;
export const CODECAPS_PUSH_MAX_ALERT_AGE_MS = 15 * 60_000;

export const CODECAPS_ALERT_KINDS = [
  "anomaly",
  "runaway",
  "vendorReset",
  "quotaReset",
  "quotaExhaustion",
] as const;

export const CODECAPS_PUSH_SOUNDS = [
  "system.default",
  "Glass",
  "Submarine",
  "Frog",
  "Blow",
  "Bottle",
  "Tink",
  "Sosumi",
  "silent",
] as const;

const alertKindSchema = z.enum(CODECAPS_ALERT_KINDS);
const soundSchema = z.enum(CODECAPS_PUSH_SOUNDS);
const optionSchema = z.object({
  enabled: z.boolean(),
  notification: z.boolean(),
  popup: z.boolean(),
  sound: soundSchema,
}).strict();
const resetProvidersSchema = z.object({
  all: z.boolean(),
  providerIDs: z.array(z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,99}$/)).max(100)
    .refine((providerIDs) => new Set(providerIDs).size === providerIDs.length),
}).strict();
const resetProviderPools: Readonly<Record<string, ReadonlySet<string>>> = {
  "google-antigravity": new Set(["gemini", "third-party"]),
};

export const CodeCapsPushPreferencesSchema = z.object({
  options: z.record(alertKindSchema, optionSchema),
  // Older registrations remain valid and continue receiving resets for all providers.
  resetProviders: resetProvidersSchema.optional(),
  sourceInstanceId: z.string().uuid().optional(),
}).strict();

export const CodeCapsPushAlertSchema = z.object({
  id: z.string().trim().min(1).max(200),
  kind: alertKindSchema,
  providerKey: z.string().trim().min(1).max(100),
  providerTitle: z.string().trim().min(1).max(160),
  windowLabel: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(500),
  occurredAt: z.string().min(1).max(64).refine((value) => Number.isFinite(Date.parse(value))),
}).strict();

export const CodeCapsPushDeviceRegistrationSchema = z.object({
  installationId: z.string().uuid(),
  generation: z.number().int().nonnegative().safe(),
  deviceToken: z.string().regex(/^[A-Fa-f0-9]{64,512}$/),
  environment: z.enum(["sandbox", "production"]),
  preferences: CodeCapsPushPreferencesSchema,
}).strict();

export const CodeCapsPushDeviceRemovalSchema = z.object({
  installationId: z.string().uuid(),
  generation: z.number().int().nonnegative().safe(),
}).strict();

export type CodeCapsPushPreferences = z.infer<typeof CodeCapsPushPreferencesSchema>;
export type CodeCapsPushAlert = z.infer<typeof CodeCapsPushAlertSchema>;
export type CodeCapsPushSound = (typeof CODECAPS_PUSH_SOUNDS)[number];

export function codeCapsPushSourceInstanceId(alertId: string): string | null {
  const separator = alertId.indexOf("|");
  if (separator <= 0) return null;
  const sourceInstanceId = alertId.slice(0, separator);
  const occurrenceHash = alertId.slice(separator + 1);
  if (!/^[a-f\d]{64}$/i.test(occurrenceHash)) return null;
  const parsed = z.string().uuid().safeParse(sourceInstanceId);
  return parsed.success ? parsed.data.toLowerCase() : null;
}

export function codeCapsPushPreferenceAllowsAlert(
  preferences: CodeCapsPushPreferences,
  alert: Pick<CodeCapsPushAlert, "id" | "kind" | "providerKey">,
): boolean {
  if (preferences.sourceInstanceId) {
    const sourceInstanceId = codeCapsPushSourceInstanceId(alert.id);
    if (!sourceInstanceId || sourceInstanceId !== preferences.sourceInstanceId.toLowerCase()) return false;
  }

  if (alert.kind === "quotaReset" || alert.kind === "vendorReset") {
    const resetProviders = preferences.resetProviders ?? { all: true, providerIDs: [] };
    const [providerID, poolKey, ...extra] = alert.providerKey.split(":");
    const knownPoolProviderID = poolKey && extra.length === 0 && resetProviderPools[providerID]?.has(poolKey)
      ? providerID
      : alert.providerKey;
    if (!resetProviders.all && !resetProviders.providerIDs.includes(knownPoolProviderID)) return false;
  }
  return true;
}

export function isCodeCapsPushRegistrationAuthorized(request: NextRequest): boolean {
  const expected = appSettings.settingsEnv().CODECAPS_PUSH_REGISTRATION_TOKEN?.trim() ?? "";
  if (!expected) return false;
  const actual = tokenFromRequest(request, "x-codecaps-push-registration-token");
  return Boolean(actual) && safeEqual(actual, expected);
}

export function codeCapsPushRegistrationConfigured(): boolean {
  return Boolean(appSettings.settingsEnv().CODECAPS_PUSH_REGISTRATION_TOKEN?.trim());
}

export function loadCodeCapsApnsConfig(): ApnsConfig | null {
  const config = loadApnsConfig(appSettings.settingsEnv());
  return config ? { ...config, bundleId: CODECAPS_PUSH_BUNDLE_ID } : null;
}

export function apnsSoundForCodeCapsPreference(sound: CodeCapsPushSound): string | null {
  if (sound === "system.default") return "default";
  if (sound === "silent") return null;
  return `alarm-${sound.toLowerCase()}.wav`;
}
