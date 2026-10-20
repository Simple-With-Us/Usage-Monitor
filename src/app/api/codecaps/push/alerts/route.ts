import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readBoundedJsonBody, RequestBodyTooLargeError } from "@/lib/bounded-request-body";
import {
  apnsSoundForCodeCapsPreference,
  CODECAPS_PUSH_MAX_ALERT_AGE_MS,
  CODECAPS_PUSH_RECEIPT_RETENTION_DAYS,
  CodeCapsPushAlertSchema,
  CodeCapsPushPreferencesSchema,
  loadCodeCapsApnsConfig,
} from "@/lib/codecaps-push";
import { resolveUsageIngestCredential } from "@/lib/ingest-auth";
import { getIngestIdentityRateLimitKey, getNamedRateLimiter } from "@/lib/rate-limit";
import { sendApnsPush } from "@/lib/apns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ALERTS_PER_REQUEST = 50;
const MAX_FUTURE_SKEW_MS = 60_000;
const DELIVERY_RETRY_LIMIT = 3;
const DELIVERY_LEASE_MS = 5 * 60_000;
const ALERT_BODY_BYTES = 64 * 1024;
const alertIngestLimiter = getNamedRateLimiter("codecaps-push-alert-ingest", 60_000, 30);

function isUniqueConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error &&
    (error as { code?: unknown }).code === "P2002");
}

function tokenAllowsCodeCaps(allowed: ReadonlySet<string> | null): boolean {
  // A scoped producer token must be explicitly minted for CodeCaps. A legacy
  // unscoped token remains governed by USAGE_INGEST_REQUIRE_SCOPED_TOKENS.
  return allowed === null || allowed.has("codecaps");
}

export async function POST(request: NextRequest) {
  const credential = resolveUsageIngestCredential(request);
  if (!credential) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!tokenAllowsCodeCaps(credential.allowedSourceApps)) {
    return NextResponse.json({ error: "Credential is not authorized for CodeCaps alerts" }, { status: 403 });
  }
  if (!alertIngestLimiter.check(getIngestIdentityRateLimitKey(credential.token))) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429, headers: { "Retry-After": "60" } });
  }

  const apnsConfig = loadCodeCapsApnsConfig();
  if (!apnsConfig) {
    return NextResponse.json({ error: "CodeCaps APNs delivery is not configured" }, { status: 503 });
  }

  const now = new Date();
  let alerts: unknown;
  try {
    const body = await readBoundedJsonBody(request, {
      maxBytes: ALERT_BODY_BYTES,
      label: "CodeCaps push alert batch",
    });
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("alerts" in body)) {
      return NextResponse.json({ error: "Invalid CodeCaps push alert batch" }, { status: 400 });
    }
    alerts = (body as { alerts?: unknown }).alerts;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Alert batch is too large" }, { status: 413 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    return NextResponse.json({ error: "Unable to read CodeCaps alert batch" }, { status: 400 });
  }

  if (!Array.isArray(alerts) || alerts.length === 0 || alerts.length > MAX_ALERTS_PER_REQUEST) {
    return NextResponse.json({ error: `alerts must contain 1 to ${MAX_ALERTS_PER_REQUEST} entries` }, { status: 400 });
  }
  const parsedAlerts = alerts.map((alert) => CodeCapsPushAlertSchema.safeParse(alert));
  if (parsedAlerts.some((parsed) => !parsed.success)) {
    return NextResponse.json({ error: "Invalid CodeCaps push alert" }, { status: 400 });
  }
  const validAlerts = parsedAlerts.flatMap((parsed) => parsed.success ? [parsed.data] : []);
  if (new Set(validAlerts.map((alert) => alert.id)).size !== validAlerts.length) {
    return NextResponse.json({ error: "Alert IDs must be unique within a batch" }, { status: 400 });
  }
  for (const alert of validAlerts) {
    const occurredAt = Date.parse(alert.occurredAt);
    const ageMs = now.getTime() - occurredAt;
    if (ageMs > CODECAPS_PUSH_MAX_ALERT_AGE_MS || ageMs < -MAX_FUTURE_SKEW_MS) {
      return NextResponse.json({ error: "Alert occurrence is outside the accepted time window" }, { status: 422 });
    }
  }

  try {
    const receiptCutoff = new Date(now.getTime() - CODECAPS_PUSH_RECEIPT_RETENTION_DAYS * 86_400_000);
    await prisma.codeCapsPushAlert.deleteMany({ where: { receivedAt: { lt: receiptCutoff } } });
    const devices = await prisma.codeCapsPushDevice.findMany({
      where: { isActive: true },
      select: { id: true, generation: true, deviceToken: true, environment: true, preferences: true },
    });

    const received = validAlerts.length;
    let duplicates = 0;
    let delivered = 0;
    let skippedByPreference = 0;
    let failed = 0;
    let retryableFailures = 0;
    let authFailures = 0;

    for (const alert of validAlerts) {
      try {
        await prisma.codeCapsPushAlert.create({
          data: {
            id: alert.id,
            kind: alert.kind,
            providerKey: alert.providerKey,
            providerTitle: alert.providerTitle,
            windowLabel: alert.windowLabel,
            summary: alert.summary,
            occurredAt: new Date(alert.occurredAt),
          },
        });
      } catch (error) {
        if (isUniqueConflict(error)) {
          duplicates += 1;
          const persisted = await prisma.codeCapsPushAlert.findUnique({ where: { id: alert.id } });
          if (!persisted || persisted.kind !== alert.kind || persisted.providerKey !== alert.providerKey ||
            persisted.providerTitle !== alert.providerTitle || persisted.windowLabel !== alert.windowLabel ||
            persisted.summary !== alert.summary || persisted.occurredAt.getTime() !== Date.parse(alert.occurredAt)) {
            return NextResponse.json({ error: "Alert ID conflicts with a previously received occurrence" }, { status: 409 });
          }
        } else {
          throw error;
        }
      }

      for (const device of devices) {
        const preferences = CodeCapsPushPreferencesSchema.safeParse(device.preferences);
        const option = preferences.success ? preferences.data.options[alert.kind] : undefined;
        if (!device.deviceToken || !option?.enabled || !option.notification) {
          skippedByPreference += 1;
          continue;
        }

        try {
          await prisma.codeCapsPushAlertDelivery.create({
            data: { alertId: alert.id, deviceId: device.id, outcome: "pending", attemptCount: 0 },
            select: { id: true },
          });
        } catch (error) {
          if (!isUniqueConflict(error)) throw error;
        }
        const claimTime = new Date();
        const claim = await prisma.codeCapsPushAlertDelivery.updateMany({
          where: {
            alertId: alert.id,
            deviceId: device.id,
            attemptCount: { lt: DELIVERY_RETRY_LIMIT },
            OR: [
              { outcome: { in: ["pending", "retryable", "auth_error", "preference_disabled"] } },
              { outcome: "sending", attemptedAt: { lt: new Date(claimTime.getTime() - DELIVERY_LEASE_MS) } },
            ],
          },
          data: { outcome: "sending", attemptCount: { increment: 1 }, attemptedAt: claimTime },
        });
        if (claim.count === 0) {
          const receipt = await prisma.codeCapsPushAlertDelivery.findFirst({
            where: { alertId: alert.id, deviceId: device.id },
            select: { outcome: true, attemptCount: true },
          });
          if (receipt && receipt.attemptCount >= DELIVERY_RETRY_LIMIT && receipt.outcome === "retryable") {
            failed += 1;
            retryableFailures += 1;
          } else if (receipt && receipt.attemptCount >= DELIVERY_RETRY_LIMIT && receipt.outcome === "auth_error") {
            failed += 1;
            authFailures += 1;
          } else if (receipt?.outcome === "sending") {
            failed += 1;
            retryableFailures += 1;
          }
          continue;
        }

        const currentDevice = await prisma.codeCapsPushDevice.findUnique({
          where: { id: device.id },
          select: { generation: true, isActive: true, deviceToken: true, environment: true, preferences: true },
        });
        const currentPreferences = CodeCapsPushPreferencesSchema.safeParse(currentDevice?.preferences);
        const currentOption = currentPreferences.success ? currentPreferences.data.options[alert.kind] : undefined;
        if (!currentDevice?.isActive || !currentDevice.deviceToken || !currentOption?.enabled || !currentOption.notification) {
          skippedByPreference += 1;
          await prisma.codeCapsPushAlertDelivery.updateMany({
            where: { alertId: alert.id, deviceId: device.id, outcome: "sending", attemptedAt: claimTime },
            data: { outcome: "preference_disabled" },
          });
          continue;
        }

        const providerTitle = `${alert.providerTitle} · ${alert.windowLabel}`;
        const collisionSafeId = createHash("sha256").update(alert.id).digest("hex").slice(0, 32);
        const result = await sendApnsPush({
          deviceToken: currentDevice.deviceToken,
          environment: currentDevice.environment === "sandbox" ? "sandbox" : "production",
          title: providerTitle,
          body: alert.summary,
          collapseId: `cc-${collisionSafeId}`,
          category: "CODECAPS_ALERT",
          sound: apnsSoundForCodeCapsPreference(currentOption.sound),
          interruptionLevel: currentOption.popup ? "active" : "passive",
          data: {
            alertId: alert.id,
            kind: alert.kind,
            providerKey: alert.providerKey,
            tab: "overview",
          },
        }, { config: apnsConfig });

        if (result.ok) {
          delivered += 1;
          await prisma.codeCapsPushAlertDelivery.updateMany({
            where: { alertId: alert.id, deviceId: device.id, outcome: "sending", attemptedAt: claimTime },
            data: { outcome: "delivered", deliveredAt: new Date() },
          });
        } else {
          failed += 1;
          if (result.disposition === "retryable") retryableFailures += 1;
          if (result.disposition === "auth_error") authFailures += 1;
          await prisma.codeCapsPushAlertDelivery.updateMany({
            where: { alertId: alert.id, deviceId: device.id, outcome: "sending", attemptedAt: claimTime },
            data: { outcome: result.disposition },
          });
          if (result.disposition === "token_dead") {
            await prisma.codeCapsPushDevice.updateMany({
              where: {
                id: device.id,
                generation: currentDevice.generation,
                deviceToken: currentDevice.deviceToken,
                isActive: true,
              },
              data: { isActive: false },
            });
          }
        }
      }
    }

    const response = {
      ok: true,
      received,
      persisted: received - duplicates,
      duplicates,
      delivered,
      skippedByPreference,
      failed,
      retryableFailures,
      authFailures,
      receiptRetentionDays: CODECAPS_PUSH_RECEIPT_RETENTION_DAYS,
    };
    return NextResponse.json(response, {
      status: retryableFailures > 0 || authFailures > 0 ? 503 : 200,
      headers: retryableFailures > 0 || authFailures > 0 ? { "Retry-After": "60" } : undefined,
    });
  } catch {
    return NextResponse.json({ error: "Failed to process CodeCaps push alerts" }, { status: 500 });
  }
}
