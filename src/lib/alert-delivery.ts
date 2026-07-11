import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
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
  /** Per HTTP attempt. Defaults to 10 seconds and is hard-capped at 60 seconds. */
  timeoutMs?: number;
  /** Includes the first attempt. Defaults to 3 and is hard-capped at 5. */
  maxAttempts?: number;
  /** Exponential retry base. Defaults to 250ms; individual waits cap at 5s. */
  retryBaseMs?: number;
}

export interface AlertDeliveryResult {
  evaluatedProviders: number;
  activeAlerts: number;
  sent: number;
  resolved: number;
  skipped: number;
  errors: Array<{ providerId: string; alertCode: string; channel: string; error: string }>;
}

type PrismaLike = Pick<
  PrismaClient,
  "provider" | "providerAlertNotification" | "providerAlertChannelDelivery"
>;

const DEFAULT_REMINDER_HOURS = 24;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 250;
const MAX_RETRY_BASE_MS = 5_000;
const MAX_RETRY_DELAY_MS = 5_000;
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
  const timeoutMs = boundedPositiveNumber(
    env.ALERT_DELIVERY_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS
  );
  const maxAttempts = Math.floor(
    boundedPositiveNumber(
      env.ALERT_DELIVERY_MAX_ATTEMPTS,
      DEFAULT_MAX_ATTEMPTS,
      MAX_ATTEMPTS
    )
  );
  const retryBaseMs = boundedNonNegativeNumber(
    env.ALERT_DELIVERY_RETRY_BASE_MS,
    DEFAULT_RETRY_BASE_MS,
    MAX_RETRY_BASE_MS
  );
  return { channels, minSeverity, reminderHours, timeoutMs, maxAttempts, retryBaseMs };
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

function boundedPositiveNumber(
  value: string | number | undefined,
  fallback: number,
  maximum: number
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function boundedNonNegativeNumber(
  value: string | number | undefined,
  fallback: number,
  maximum: number
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback;
}

function shouldDeliverSeverity(severity: AlertSeverity, minSeverity: AlertSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minSeverity];
}

function stateKey(providerId: string, alert: ProviderAlert): string {
  return `${providerId}:${alert.code}`;
}

function dueForChannel(
  lastSucceededAt: Date | null,
  incidentStartedAt: Date,
  now: Date,
  reminderHours: number
): boolean {
  if (!lastSucceededAt || lastSucceededAt < incidentStartedAt) return true;
  return now.getTime() - lastSucceededAt.getTime() >= reminderHours * 60 * 60 * 1000;
}

function alertText(provider: { displayName: string; name: string }, alert: ProviderAlert): string {
  return `[${alert.severity.toUpperCase()}] ${provider.displayName || provider.name}: ${alert.message}`;
}

function channelKey(channel: AlertDeliveryChannel): string {
  const destination =
    channel.kind === "email"
      ? `${channel.from}\0${channel.to}`
      : channel.kind === "pagerduty"
        ? channel.routingKey
        : channel.url;
  const digest = createHash("sha256")
    .update(`${channel.kind}\0${destination}`)
    .digest("hex");
  return `${channel.kind}:${digest}`;
}

function pagerDutyDedupKey(providerId: string, alertCode: string): string {
  return `api-usage-monitor:${providerId}:${alertCode}`;
}

class ChannelHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ChannelHttpError";
  }
}

class ChannelTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Alert delivery timed out after ${timeoutMs}ms`);
    this.name = "ChannelTimeoutError";
  }
}

class ChannelDeliveryFailure extends Error {
  constructor(
    message: string,
    readonly attempts: number
  ) {
    super(message);
    this.name = "ChannelDeliveryFailure";
  }
}

function isRetryableDeliveryError(error: unknown): boolean {
  if (!(error instanceof ChannelHttpError)) return true;
  return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ChannelTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchImpl(input, { ...init, signal: controller.signal }),
      timeoutPromise,
    ]);
  } catch (error) {
    if (timedOut && !(error instanceof ChannelTimeoutError)) {
      throw new ChannelTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function postJson(
  label: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<void> {
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    timeoutMs
  );
  const { ok, status } = response;
  try {
    await response.body?.cancel();
  } catch {
    // Delivery outcome is determined by HTTP status; body cleanup is best-effort.
  }
  if (!ok) throw new ChannelHttpError(`${label} HTTP ${status}`, status);
}

async function sendToChannelOnce(
  channel: AlertDeliveryChannel,
  provider: { id: string; name: string; displayName: string },
  alert: ProviderAlert,
  now: Date,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  action: "trigger" | "resolve"
): Promise<void> {
  if (action === "resolve" && channel.kind !== "pagerduty") return;

  if (channel.kind === "slack") {
    await postJson(
      "Slack webhook",
      channel.url,
      { "content-type": "application/json" },
      { text: alertText(provider, alert) },
      fetchImpl,
      timeoutMs
    );
    return;
  }

  if (channel.kind === "email") {
    await postJson(
      "Resend API",
      "https://api.resend.com/emails",
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${channel.apiKey}`,
      },
      {
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
      },
      fetchImpl,
      timeoutMs
    );
    return;
  }

  if (channel.kind === "pagerduty") {
    const pdSeverity = alert.severity === "critical" ? "critical" : "warning";
    const dedupKey = pagerDutyDedupKey(provider.id, alert.code);
    await postJson(
      "PagerDuty API",
      "https://events.pagerduty.com/v2/enqueue",
      { "Content-Type": "application/json" },
      action === "resolve"
        ? {
            routing_key: channel.routingKey,
            event_action: "resolve",
            dedup_key: dedupKey,
          }
        : {
            routing_key: channel.routingKey,
            event_action: "trigger",
            dedup_key: dedupKey,
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
          },
      fetchImpl,
      timeoutMs
    );
    return;
  }

  await postJson(
    "Alert webhook",
    channel.url,
    { "content-type": "application/json" },
    {
      type: "provider_alert",
      detectedAt: now.toISOString(),
      provider: {
        id: provider.id,
        name: provider.name,
        displayName: provider.displayName,
      },
      alert,
    },
    fetchImpl,
    timeoutMs
  );
}

async function sendToChannel(
  channel: AlertDeliveryChannel,
  provider: { id: string; name: string; displayName: string },
  alert: ProviderAlert,
  now: Date,
  fetchImpl: typeof fetch,
  settings: { timeoutMs: number; maxAttempts: number; retryBaseMs: number },
  sleepImpl: (ms: number) => Promise<void>,
  action: "trigger" | "resolve" = "trigger"
): Promise<number> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
    try {
      await sendToChannelOnce(
        channel,
        provider,
        alert,
        now,
        fetchImpl,
        settings.timeoutMs,
        action
      );
      return attempt;
    } catch (error) {
      lastError = error;
      if (attempt >= settings.maxAttempts || !isRetryableDeliveryError(error)) {
        const message = error instanceof Error ? error.message : "Alert delivery failed";
        throw new ChannelDeliveryFailure(message, attempt);
      }
      const delayMs = Math.min(
        settings.retryBaseMs * 2 ** (attempt - 1),
        MAX_RETRY_DELAY_MS
      );
      if (delayMs > 0) await sleepImpl(delayMs);
    }
  }
  const message = lastError instanceof Error ? lastError.message : "Alert delivery failed";
  throw new ChannelDeliveryFailure(message, settings.maxAttempts);
}

function failureDetails(error: unknown): { attempts: number; message: string } {
  const attempts = error instanceof ChannelDeliveryFailure ? error.attempts : 1;
  const message = error instanceof Error ? error.message : "Alert delivery failed";
  return { attempts, message: message.slice(0, 500) };
}

async function recordTriggerOutcome(
  db: PrismaLike,
  notificationId: string,
  channel: AlertDeliveryChannel,
  now: Date,
  attempts: number,
  error: string | null
): Promise<void> {
  const key = channelKey(channel);
  await db.providerAlertChannelDelivery.upsert({
    where: {
      notificationId_channelKey: { notificationId, channelKey: key },
    },
    create: {
      notificationId,
      channelKey: key,
      channelKind: channel.kind,
      lastAttemptAt: now,
      ...(error ? {} : { lastSucceededAt: now, successCount: 1 }),
      attemptCount: attempts,
      lastError: error,
    },
    update: {
      channelKind: channel.kind,
      lastAttemptAt: now,
      attemptCount: { increment: attempts },
      ...(error
        ? { lastError: error }
        : {
            lastSucceededAt: now,
            successCount: { increment: 1 },
            lastError: null,
          }),
    },
  });
}

async function recordResolveOutcome(
  db: PrismaLike,
  notificationId: string,
  channel: Extract<AlertDeliveryChannel, { kind: "pagerduty" }>,
  now: Date,
  attempts: number,
  error: string | null
): Promise<void> {
  const key = channelKey(channel);
  await db.providerAlertChannelDelivery.upsert({
    where: {
      notificationId_channelKey: { notificationId, channelKey: key },
    },
    create: {
      notificationId,
      channelKey: key,
      channelKind: channel.kind,
      lastResolveAttemptAt: now,
      ...(error ? {} : { lastResolvedAt: now }),
      resolveAttemptCount: attempts,
      lastError: error,
    },
    update: {
      channelKind: channel.kind,
      lastResolveAttemptAt: now,
      resolveAttemptCount: { increment: attempts },
      ...(error ? { lastError: error } : { lastResolvedAt: now, lastError: null }),
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function deliverProviderAlerts(options: {
  now?: Date;
  config?: AlertDeliveryConfig;
  db?: PrismaLike;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
} = {}): Promise<AlertDeliveryResult> {
  const now = options.now ?? new Date();
  const config = options.config ?? readAlertDeliveryConfig();
  const db = options.db ?? prisma;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  const settings = {
    timeoutMs: boundedPositiveNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxAttempts: Math.max(
      1,
      Math.floor(boundedPositiveNumber(config.maxAttempts, DEFAULT_MAX_ATTEMPTS, MAX_ATTEMPTS))
    ),
    retryBaseMs: boundedNonNegativeNumber(
      config.retryBaseMs,
      DEFAULT_RETRY_BASE_MS,
      MAX_RETRY_BASE_MS
    ),
  };
  // The env reader emits one destination of each kind, but injected test/config
  // objects may repeat a destination. De-duplicate by the same persistent key so
  // one maintenance pass never sends it twice.
  const channels = [...new Map(config.channels.map((channel) => [channelKey(channel), channel])).values()];
  const pagerDutyChannels = channels.filter(
    (channel): channel is Extract<AlertDeliveryChannel, { kind: "pagerduty" }> =>
      channel.kind === "pagerduty"
  );
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
      select: {
        id: true,
        stateKey: true,
        alertCode: true,
        severity: true,
        message: true,
        firstDetectedAt: true,
      },
    });
    for (const notification of openNotifications) {
      if (!activeKeys.has(notification.stateKey)) {
        const pagerDutyStates = await db.providerAlertChannelDelivery.findMany({
          where: {
            notificationId: notification.id,
            channelKind: "pagerduty",
          },
          select: {
            channelKey: true,
            lastSucceededAt: true,
            lastResolvedAt: true,
          },
        });
        const pagerDutyTriggeredThisIncident = pagerDutyStates.some(
          (state) =>
            state.lastSucceededAt !== null &&
            state.lastSucceededAt >= notification.firstDetectedAt
        );

        if (pagerDutyTriggeredThisIncident && pagerDutyChannels.length === 0) {
          // Keep the notification open so restoring the routing key lets the
          // next maintenance tick close the external incident instead of
          // silently losing the only retry handle.
          result.errors.push({
            providerId: provider.id,
            alertCode: notification.alertCode,
            channel: "pagerduty",
            error: "PagerDuty resolve pending because no routing key is configured",
          });
          continue;
        }

        let allPagerDutyResolvesSent = true;
        if (pagerDutyTriggeredThisIncident) {
          const resolvedAlert: ProviderAlert = {
            code: notification.alertCode as ProviderAlert["code"],
            severity: normalizeSeverity(notification.severity) ?? "warning",
            message: notification.message,
          };
          for (const channel of pagerDutyChannels) {
            const key = channelKey(channel);
            const state = pagerDutyStates.find((entry) => entry.channelKey === key);
            if (state?.lastResolvedAt && state.lastResolvedAt >= notification.firstDetectedAt) {
              continue;
            }
            try {
              const attempts = await sendToChannel(
                channel,
                provider,
                resolvedAlert,
                now,
                fetchImpl,
                settings,
                sleepImpl,
                "resolve"
              );
              await recordResolveOutcome(
                db,
                notification.id,
                channel,
                now,
                attempts,
                null
              );
            } catch (error) {
              allPagerDutyResolvesSent = false;
              const failure = failureDetails(error);
              await recordResolveOutcome(
                db,
                notification.id,
                channel,
                now,
                failure.attempts,
                failure.message
              );
              result.errors.push({
                providerId: provider.id,
                alertCode: notification.alertCode,
                channel: channel.kind,
                error: failure.message,
              });
            }
          }
        }

        if (!allPagerDutyResolvesSent) continue;
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

      if (channels.length === 0) {
        result.skipped += 1;
        continue;
      }

      const channelStates = await db.providerAlertChannelDelivery.findMany({
        where: { notificationId: notification.id },
        select: { channelKey: true, lastSucceededAt: true },
      });
      const stateByChannelKey = new Map(
        channelStates.map((state) => [state.channelKey, state])
      );
      const dueChannels = channels.filter((channel) => {
        const persisted = stateByChannelKey.get(channelKey(channel));
        // lastSentAt is a migration bridge for rows written before channel
        // state existed. It prevents a one-time replay of every successful
        // legacy notification immediately after this additive table ships.
        const lastSucceededAt = persisted?.lastSucceededAt ?? notification.lastSentAt;
        return dueForChannel(
          lastSucceededAt,
          notification.firstDetectedAt,
          now,
          config.reminderHours
        );
      });

      if (dueChannels.length === 0) {
        result.skipped += 1;
        continue;
      }

      let allDueChannelsSent = true;
      let anyChannelSent = false;
      for (const channel of dueChannels) {
        try {
          const attempts = await sendToChannel(
            channel,
            provider,
            alert,
            now,
            fetchImpl,
            settings,
            sleepImpl
          );
          await recordTriggerOutcome(
            db,
            notification.id,
            channel,
            now,
            attempts,
            null
          );
          anyChannelSent = true;
        } catch (error) {
          allDueChannelsSent = false;
          const failure = failureDetails(error);
          await recordTriggerOutcome(
            db,
            notification.id,
            channel,
            now,
            failure.attempts,
            failure.message
          );
          result.errors.push({
            providerId: provider.id,
            alertCode: alert.code,
            channel: channel.kind,
            error: failure.message,
          });
        }
      }

      if (allDueChannelsSent && anyChannelSent) {
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
