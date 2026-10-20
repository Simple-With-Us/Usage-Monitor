import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  apnsSoundForCodeCapsPreference,
  CodeCapsPushAlertSchema,
  CodeCapsPushDeviceRegistrationSchema,
  CodeCapsPushPreferencesSchema,
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
});
