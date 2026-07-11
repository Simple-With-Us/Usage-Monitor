import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildProviderAlertState, type AlertSeverity, type ProviderAlert } from "@/lib/provider-alerts";
import { computeBudgetStatus } from "@/lib/budget-status";

export type AlertDeliveryChannel =
  | { kind: "slack"; url: string }
  | { kind: "webhook"; url: string }
  | { kind: "email"; apiKey: string; from: string; to: string }
  | { kind: "pagerduty"; routingKey: string };

export interface AlertDeliveryConfig {
  channels: AlertDeliveryChannel[];
  minSeverity: AlertSeverity;
  reminderHours: number;
}

export interface AlertDeliveryResult {
  evaluatedProviders: number;
  activeAlerts: number;
  sent: number;
  resolved: number;
  skipped: number;
  errors: Array<{ providerId: string; alertCode: string; channel: string; error: string }>;
}

type PrismaLike = Pick<PrismaClient, "provider" | "providerAlertNotification">;

const DEFAULT_REMINDER_HOURS = 24;
const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export function readAlertDeliveryConfig(env: NodeJS.ProcessEnv = process.env): AlertDeliveryConfig {
  const channels: AlertDeliveryChannel[] = [];
  const slackUrl = env.ALERT_SLACK_WEBHOOK_URL?.trim();
  const webhookUrl = env.ALERT_WEBHOOK_URL?.trim();
  const emailApiKey = env.ALERT_RESEND_API_KEY?.trim();
  const emailFrom = env.ALERT_EMAIL_FROM?.trim();
  const emailTo = env.ALERT_EMAIL_TO?.trim();
  const pagerdutyRoutingKey = env.ALERT_PAGERDUTY_ROUTING_KEY?.trim();

  if (slackUrl) channels.push({ kind: "slack", url: slackUrl });
  if (webhookUrl) channels.push({ kind: "webhook", url: webhookUrl });
  if (emailApiKey && emailFrom && emailTo) {
    channels.push({ kind: "email", apiKey: emailApiKey, from: emailFrom, to: emailTo });
  }
  if (pagerdutyRoutingKey) {
    channels.push({ kind: "pagerduty", routingKey: pagerdutyRoutingKey });
  }

  const minSeverity = normalizeSeverity(env.ALERT_MIN_SEVERITY) ?? "warning";
  const reminderHours = normalizePositiveNumber(env.ALERT_REMINDER_HOURS) ?? DEFAULT_REMINDER_HOURS;
  return { channels, minSeverity, reminderHours };
}

export function hasAlertDeliveryChannels(config = readAlertDeliveryConfig()): boolean {
  return config.channels.length > 0;
}

function normalizeSeverity(value: string | undefined): AlertSeverity | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "info" || normalized === "warning" || normalized === "critical") return normalized;
  return null;
}

function normalizePositiveNumber(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function shouldDeliverSeverity(severity: AlertSeverity, minSeverity: AlertSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minSeverity];
}

function stateKey(providerId: string, alert: ProviderAlert): string {
  return `${providerId}:${alert.code}`;
}

function dueForReminder(lastSentAt: Date | null, now: Date, reminderHours: number): boolean {
  if (!lastSentAt) return true;
  return now.getTime() - lastSentAt.getTime() >= reminderHours * 60 * 60 * 1000;
}

function alertText(provider: { displayName: string; name: string }, alert: ProviderAlert): string {
  return `[${alert.severity.toUpperCase()}] ${provider.displayName || provider.name}: ${alert.message}`;
}

async function sendToChannel(
  channel: AlertDeliveryChannel,
  provider: { id: string; name: string; displayName: string },
  alert: ProviderAlert,
  now: Date,
  fetchImpl: typeof fetch
): Promise<void> {
  if (channel.kind === "slack") {
    const response = await fetchImpl(channel.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: alertText(provider, alert) }),
    });
    if (!response.ok) throw new Error(`Slack webhook HTTP ${response.status}`);
    return;
  }

  if (channel.kind === "email") {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${channel.apiKey}`,
      },
      body: JSON.stringify({
        from: channel.from,
        to: channel.to,
        subject: `[${alert.severity.toUpperCase()}] Alert for ${provider.displayName || provider.name}`,
        html: `
          <h2>API Usage Monitor Alert</h2>
          <p><strong>Provider:</strong> ${provider.displayName || provider.name}</p>
          <p><strong>Severity:</strong> ${alert.severity}</p>
          <p><strong>Message:</strong> ${alert.message}</p>
          <p><strong>Detected At:</strong> ${now.toISOString()}</p>
        `,
      }),
    });
    if (!response.ok) throw new Error(`Resend API HTTP ${response.status}`);
    return;
  }

  if (channel.kind === "pagerduty") {
    const pdSeverity = alert.severity === "critical" ? "critical" : "warning";
    const response = await fetchImpl("https://events.pagerduty.com/v2/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routing_key: channel.routingKey,
        event_action: "trigger",
        payload: {
          summary: alertText(provider, alert),
          source: "API Usage Monitor",
          severity: pdSeverity,
          component: provider.name,
          custom_details: {
            provider_id: provider.id,
            alert_code: alert.code,
            detected_at: now.toISOString(),
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`PagerDuty API HTTP ${response.status}`);
    return;
  }

  const response = await fetchImpl(channel.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "provider_alert",
      detectedAt: now.toISOString(),
      provider: {
        id: provider.id,
        name: provider.name,
        displayName: provider.displayName,
      },
      alert,
    }),
  });
  if (!response.ok) throw new Error(`Alert webhook HTTP ${response.status}`);
}

export async function deliverProviderAlerts(options: {
  now?: Date;
  config?: AlertDeliveryConfig;
  db?: PrismaLike;
  fetchImpl?: typeof fetch;
} = {}): Promise<AlertDeliveryResult> {
  const now = options.now ?? new Date();
  const config = options.config ?? readAlertDeliveryConfig();
  const db = options.db ?? prisma;
  const fetchImpl = options.fetchImpl ?? fetch;
  const result: AlertDeliveryResult = {
    evaluatedProviders: 0,
    activeAlerts: 0,
    sent: 0,
    resolved: 0,
    skipped: 0,
    errors: [],
  };

  const providers = await db.provider.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      displayName: true,
      isActive: true,
      refreshIntervalMin: true,
      plan: {
        select: {
          billingMode: true,
          fixedMonthlyCostUsd: true,
          monthlyBudgetUsd: true,
          monthlyRequestLimit: true,
          lowBalanceUsd: true,
          lowCredits: true,
          renewalDate: true,
          billingInterval: true,
          mustKeepFunded: true,
        },
      },
      snapshots: {
        orderBy: { fetchedAt: "desc" },
        take: 1,
        select: { balance: true, totalCost: true, totalRequests: true, credits: true, fetchedAt: true },
      },
    },
  });
  // Production delivery uses the same canonical poll+pushed+subscription
  // computation as /api/budget-status. Tests/callers that inject a partial DB
  // retain the legacy snapshot-only path because that DB may not expose the
  // external-event tables required by computeBudgetStatus.
  const canonicalByProviderId = options.db
    ? new Map<string, Awaited<ReturnType<typeof computeBudgetStatus>>["providers"][number]>()
    : new Map(
        (await computeBudgetStatus(now)).providers.map((status) => [status.id, status])
      );

  result.evaluatedProviders = providers.length;

  for (const provider of providers) {
    const alertState = buildProviderAlertState(
      {
        isActive: provider.isActive,
        refreshIntervalMin: provider.refreshIntervalMin,
        plan: provider.plan,
        latestSnapshot: provider.snapshots[0] ?? null,
      },
      now
    );
    const canonical = canonicalByProviderId.get(provider.id);
    if (canonical) {
      const nonBudgetAlerts = alertState.alerts.filter(
        (alert) => alert.code !== "budget_exceeded" && alert.code !== "budget_warning"
      );
      alertState.alerts = [...nonBudgetAlerts, ...canonical.alerts];
    }
    const deliverableAlerts = alertState.alerts.filter((alert) =>
      shouldDeliverSeverity(alert.severity, config.minSeverity)
    );
    result.activeAlerts += deliverableAlerts.length;

    const activeKeys = new Set(deliverableAlerts.map((alert) => stateKey(provider.id, alert)));
    const openNotifications = await db.providerAlertNotification.findMany({
      where: { providerId: provider.id, resolvedAt: null },
      select: { id: true, stateKey: true },
    });
    for (const notification of openNotifications) {
      if (!activeKeys.has(notification.stateKey)) {
        await db.providerAlertNotification.update({
          where: { id: notification.id },
          data: { resolvedAt: now },
        });
        result.resolved += 1;
      }
    }

    for (const alert of deliverableAlerts) {
      const key = stateKey(provider.id, alert);
      const existing = await db.providerAlertNotification.findUnique({ where: { stateKey: key } });
      const shouldSend =
        config.channels.length > 0 &&
        (!existing || existing.resolvedAt || dueForReminder(existing.lastSentAt, now, config.reminderHours));

      const notification = existing
        ? await db.providerAlertNotification.update({
            where: { id: existing.id },
            data: {
              severity: alert.severity,
              message: alert.message,
              lastDetectedAt: now,
              resolvedAt: null,
              ...(existing.resolvedAt ? { firstDetectedAt: now } : {}),
            },
          })
        : await db.providerAlertNotification.create({
            data: {
              providerId: provider.id,
              stateKey: key,
              alertCode: alert.code,
              severity: alert.severity,
              providerName: provider.name,
              providerDisplayName: provider.displayName,
              message: alert.message,
              firstDetectedAt: now,
              lastDetectedAt: now,
            },
          });

      if (!shouldSend) {
        result.skipped += 1;
        continue;
      }

      let allChannelsSent = true;
      for (const channel of config.channels) {
        try {
          await sendToChannel(channel, provider, alert, now, fetchImpl);
        } catch (error) {
          allChannelsSent = false;
          result.errors.push({
            providerId: provider.id,
            alertCode: alert.code,
            channel: channel.kind,
            error: error instanceof Error ? error.message : "Alert delivery failed",
          });
        }
      }

      if (allChannelsSent) {
        await db.providerAlertNotification.update({
          where: { id: notification.id },
          data: { lastSentAt: now, sendCount: { increment: 1 } },
        });
        result.sent += 1;
      }
    }
  }

  return result;
}
