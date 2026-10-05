import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readAlertDeliveryConfig } from "@/lib/alert-delivery";
import { apnsConfigured, loadApnsConfig } from "@/lib/apns";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { appSettings } from "@/lib/app-settings";
import { isUsageReadAuthorized, resolveUsageReadToken } from "@/lib/ingest-auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Trust boundary: validate the untrusted body with a strict Zod schema
// (unknown fields rejected) instead of destructuring raw JSON.  All fields
// are optional; present fields are still type-checked before any write.
const SettingsUpdateSchema = z
  .object({
    emailEnabled: z.boolean().optional(),
    minSeverity: z.enum(["info", "warning", "critical"]).optional(),
    pushoverUserKey: z.string().optional(),
    pushoverApiToken: z.string().optional(),
  })
  .strict();

function isDashboardSession(request: NextRequest): boolean {
  return verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
}

function isReadAuthorized(request: NextRequest): boolean {
  if (isDashboardSession(request)) return true;
  if (!resolveUsageReadToken()) return false;
  return isUsageReadAuthorized(request);
}

export async function GET(request: NextRequest) {
  if (!isReadAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const config = readAlertDeliveryConfig();
  const apnsTokenCount = await prisma.apnsDeviceToken.count({
    where: { isActive: true },
  });

  const hasPushover = config.channels.some((c) => c.kind === "pushover");
  const hasEmail = config.channels.some((c) => c.kind === "email");
  const hasSlack = config.channels.some((c) => c.kind === "slack");
  const hasPagerDuty = config.channels.some((c) => c.kind === "pagerduty");

  return NextResponse.json({
    notifications: {
      pushoverConfigured: hasPushover,
      emailConfigured: hasEmail,
      slackConfigured: hasSlack,
      pagerdutyConfigured: hasPagerDuty,
      apnsConfigured: apnsConfigured(loadApnsConfig()),
      activeApnsDeviceCount: apnsTokenCount,
      minSeverity: config.minSeverity,
      reminderHours: config.reminderHours,
      channels: config.channels.map((c) => ({
        kind: c.kind,
        ...(c.kind === "pushover" ? { userKeyPreview: `${c.userKey.slice(0, 4)}...` } : {}),
        ...(c.kind === "email" && isDashboardSession(request)
          ? { from: c.from, to: c.to }
          : {}),
      })),
    },
  });
}

export async function PUT(request: NextRequest) {
  if (!isDashboardSession(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = SettingsUpdateSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const { emailEnabled, minSeverity, pushoverUserKey, pushoverApiToken } = parsed.data;

    if (typeof emailEnabled === "boolean") {
      // Write-through to Infisical (the SOT) for non-secret knobs: Infisical
      // FIRST, then the local cache.  A failed Infisical write fails the save
      // so the cache and Infisical never diverge silently.  In env-fallback
      // mode (local dev, no creds) set() writes process.env.
      // One logical toggle, two keys: if the second write fails after the
      // first succeeded, roll the first back so the pair never diverges
      // (e.g. ENABLED=true with DISABLE=true would silently keep email off).
      const previousEnabled = appSettings.get("ALERT_EMAIL_ENABLED");
      const previousDisable = appSettings.get("ALERT_DISABLE_EMAIL");
      try {
        await appSettings.set("ALERT_EMAIL_ENABLED", emailEnabled ? "true" : "false");
        await appSettings.set("ALERT_DISABLE_EMAIL", emailEnabled ? "false" : "true");
      } catch (error) {
        // Best-effort rollback so the pair never diverges after a partial write.
        // A failed rollback is logged LOUDLY, never swallowed: when the same
        // outage breaks the compensating write, the pair IS diverged and the
        // operator must know.
        for (const [key, previous] of [
          ["ALERT_EMAIL_ENABLED", previousEnabled],
          ["ALERT_DISABLE_EMAIL", previousDisable],
        ] as const) {
          if (previous !== undefined) {
            await appSettings.set(key, previous).catch((rollbackError: unknown) =>
              console.error(
                `[app-settings] rollback of ${key} failed after partial write:`,
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
              )
            );
          }
        }
        throw error;
      }
    }

    if (minSeverity !== undefined) {
      await appSettings.set("ALERT_MIN_SEVERITY", minSeverity);
    }

    if (typeof pushoverUserKey === "string" && pushoverUserKey.trim()) {
      process.env.PUSHOVER_USER_KEY = pushoverUserKey.trim();
      process.env.ALERT_PUSHOVER_USER_KEY = pushoverUserKey.trim();
    }

    if (typeof pushoverApiToken === "string" && pushoverApiToken.trim()) {
      process.env.PUSHOVER_API_TOKEN = pushoverApiToken.trim();
      process.env.ALERT_PUSHOVER_API_TOKEN = pushoverApiToken.trim();
    }

    const updatedConfig = readAlertDeliveryConfig();
    const apnsTokenCount = await prisma.apnsDeviceToken.count({
      where: { isActive: true },
    });

    return NextResponse.json({
      ok: true,
      notifications: {
        pushoverConfigured: updatedConfig.channels.some((c) => c.kind === "pushover"),
        emailConfigured: updatedConfig.channels.some((c) => c.kind === "email"),
        apnsConfigured: updatedConfig.channels.some((c) => c.kind === "apns"),
        minSeverity: updatedConfig.minSeverity,
        activeApnsDeviceCount: apnsTokenCount,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update settings" },
      { status: 500 }
    );
  }
}
