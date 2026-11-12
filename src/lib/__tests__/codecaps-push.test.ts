import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  apnsSoundForCodeCapsPreference,
  CodeCapsPushAlertSchema,
  CodeCapsPushDeviceRegistrationSchema,
  CodeCapsPushPreferencesSchema,
  codeCapsPushPreferenceAllowsAlert,
  codeCapsPushSourceInstanceId,
  isCodeCapsPushRegistrationAuthorized,
} from "../codecaps-push";

const installationId = "6a875ea5-28c8-4b80-8d24-2c383da87a65";
const preferences = {
  options: Object.fromEntries(
    ["anomaly", "runaway", "vendorReset", "quotaReset", "quotaExhaustion"].map((kind) => [kind, {
      enabled: true,
      notification: true,
      popup: true,
      sound: "system.default",
    }])
  ),
};

describe("CodeCaps push contract", () => {
  beforeEach(() => {
    process.env.CODECAPS_PUSH_REGISTRATION_TOKEN = "owner-supplied-test-token";
  });

  it("validates the APNs token and exact preference shape", () => {
    const registration = {
      installationId,
      generation: 1,
      deviceToken: "a".repeat(64),
      environment: "sandbox",
      preferences,
    };
    expect(CodeCapsPushDeviceRegistrationSchema.safeParse(registration).success).toBe(true);
    expect(CodeCapsPushDeviceRegistrationSchema.safeParse({
      ...registration,
      deviceToken: "not-hex",
    }).success).toBe(false);
    expect(CodeCapsPushPreferencesSchema.safeParse({ options: { unknown: preferences.options.runaway } }).success).toBe(false);
    expect(CodeCapsPushPreferencesSchema.safeParse({
      ...preferences,
      resetProviders: { all: false, providerIDs: ["anthropic", "google-antigravity"] },
      sourceInstanceId: "6a875ea5-28c8-4b80-8d24-2c383da87a65",
    }).success).toBe(true);
    expect(CodeCapsPushPreferencesSchema.safeParse({
      ...preferences,
      resetProviders: { all: false, providerIDs: ["anthropic", "anthropic"] },
    }).success).toBe(false);
  });

  it("accepts only the five current alert kinds", () => {
    const base = {
      id: "runaway|openai|5h|first-seen",
      kind: "runaway",
      providerKey: "openai",
      providerTitle: "Codex",
      windowLabel: "5h",
      summary: "Usage is unusually high.",
      occurredAt: new Date().toISOString(),
    };
    expect(CodeCapsPushAlertSchema.safeParse(base).success).toBe(true);
    expect(CodeCapsPushAlertSchema.safeParse({ ...base, kind: "reset" }).success).toBe(false);
  });

  it("maps the selected bundled WAV names and leaves silent sound absent", () => {
    expect(apnsSoundForCodeCapsPreference("Glass")).toBe("alarm-glass.wav");
    expect(apnsSoundForCodeCapsPreference("Sosumi")).toBe("alarm-sosumi.wav");
    expect(apnsSoundForCodeCapsPreference("system.default")).toBe("default");
    expect(apnsSoundForCodeCapsPreference("silent")).toBeNull();
  });

  it("requires the dedicated registration bearer token", () => {
    const request = (token: string) => new NextRequest("https://usage.jays.services/api/codecaps/push/devices", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(isCodeCapsPushRegistrationAuthorized(request("owner-supplied-test-token"))).toBe(true);
    expect(isCodeCapsPushRegistrationAuthorized(request("read-token"))).toBe(false);
  });

  it("defaults legacy reset preferences to all providers and preserves category switches", () => {
    const parsed = CodeCapsPushPreferencesSchema.parse(preferences);
    const reset = { id: "id", kind: "quotaReset", providerKey: "anthropic" } as const;
    expect(codeCapsPushPreferenceAllowsAlert(parsed, reset)).toBe(true);
    parsed.options.quotaReset.enabled = false;
    expect(parsed.options.quotaReset.enabled).toBe(false);
    expect(parsed.options.runaway.enabled).toBe(true);
  });

  it("filters only reset kinds to selected whole providers", () => {
    const parsed = CodeCapsPushPreferencesSchema.parse({
      ...preferences,
      resetProviders: { all: false, providerIDs: ["anthropic"] },
    });
    expect(codeCapsPushPreferenceAllowsAlert(parsed, {
      id: "event", kind: "quotaReset", providerKey: "anthropic",
    })).toBe(true);
    expect(codeCapsPushPreferenceAllowsAlert(parsed, {
      id: "event", kind: "vendorReset", providerKey: "openai",
    })).toBe(false);
    expect(codeCapsPushPreferenceAllowsAlert(parsed, {
      id: "event", kind: "runaway", providerKey: "openai",
    })).toBe(true);
  });

  it("matches only known Antigravity reset pool keys to its selected provider", () => {
    const parsed = CodeCapsPushPreferencesSchema.parse({
      ...preferences,
      resetProviders: { all: false, providerIDs: ["google-antigravity"] },
    });
    for (const pool of ["gemini", "third-party"]) {
      expect(codeCapsPushPreferenceAllowsAlert(parsed, {
        id: `event-${pool}`, kind: "quotaReset", providerKey: `google-antigravity:${pool}`,
      })).toBe(true);
    }
    expect(codeCapsPushPreferenceAllowsAlert(parsed, {
      id: "unknown-pool", kind: "vendorReset", providerKey: "google-antigravity:future-pool",
    })).toBe(false);
    expect(codeCapsPushPreferenceAllowsAlert(parsed, {
      id: "unknown-provider-scope", kind: "quotaReset", providerKey: "openai:future-pool",
    })).toBe(false);
  });

  it("filters by an explicit UUID alert-ID prefix without guessing from other fields", () => {
    const source = "6a875ea5-28c8-4b80-8d24-2c383da87a65";
    const parsed = CodeCapsPushPreferencesSchema.parse({ ...preferences, sourceInstanceId: source });
    const occurrenceHash = "a".repeat(64);
    expect(codeCapsPushSourceInstanceId(`${source}|${occurrenceHash}`)).toBe(source);
    expect(codeCapsPushPreferenceAllowsAlert(parsed, {
      id: `${source}|${occurrenceHash}`, kind: "anomaly", providerKey: "anthropic",
    })).toBe(true);
    expect(codeCapsPushPreferenceAllowsAlert(parsed, {
      id: "not-a-uuid|sha256", kind: "anomaly", providerKey: "anthropic",
    })).toBe(false);
    expect(codeCapsPushPreferenceAllowsAlert(parsed, {
      id: "machine-anthropic|sha256", kind: "anomaly", providerKey: "anthropic",
    })).toBe(false);
  });
});
