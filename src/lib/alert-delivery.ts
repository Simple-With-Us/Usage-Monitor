import type { Prisma, PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  buildProviderAlertState,
  buildProjectBudgetAlerts,
  PROVIDER_ALERT_CODES,
  providerSnapshotStaleAt,
  type AlertSeverity,
  type BudgetAlertTier,
  type ProviderAlert,
  type ProviderAlertCode,
} from "@/lib/provider-alerts";
import { computeBudgetStatus, computeProjectBudgetStatus } from "@/lib/budget-status";
import { providerPollSnapshotExpected } from "@/lib/anthropic-credentials";
import { withInternalUsageWriteAdmission } from "@/lib/ingest-admission";
import { resolveAnomalyConfig } from "@/lib/anomaly-detection";
import { appSettings } from "@/lib/app-settings";
import { loadSpendAnomaliesByProjectId } from "@/lib/anomaly-loader";
import { loadSubscriptionInsightAlerts } from "@/lib/subscription-insights";
import {
  PROJECT_BUDGETS_PROVIDER_DISPLAY_NAME as PROJECT_ALERTS_PROVIDER_DISPLAY_NAME,
  PROJECT_BUDGETS_PROVIDER_NAME as PROJECT_ALERTS_PROVIDER_NAME,
} from "@/lib/system-providers";
import { formatAlertEmailHtml } from "@/lib/alert-email";
import {
  apnsConfigured,
  fanOutApnsAlert,
  loadApnsConfig,
  type ApnsConfig,
  type ApnsTransport,
} from "@/lib/apns";

export type AlertDeliveryChannel =
  | { kind: "slack"; url: string }
  | { kind: "webhook"; url: string }
  | { kind: "email"; apiKey: string; from: string; to: string }
  | { kind: "pagerduty"; routingKey: string }
  | { kind: "pushover"; userKey: string; apiToken: string }
  | { kind: "apns"; config: ApnsConfig; transport?: ApnsTransport };

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
  /**
   * S12: per-alert-code severity overrides (env ALERT_CODE_SEVERITY_OVERRIDES,
   * e.g. '{"stale_snapshot":"info"}'). Applied to both the persisted incident
   * and delivery eligibility so the incident, its text, and policy agree.
   */
  severityOverrides?: Partial<Record<ProviderAlertCode, AlertSeverity>>;
  /**
   * S12: per-alert-code channel-kind routing (env ALERT_CODE_CHANNEL_ROUTING,
   * e.g. '{"budget_exceeded":["slack","pagerduty"],"stale_snapshot":[]}').
   * Trigger-side only: an open incident always RESOLVES on the channel it
   * originally triggered on, so re-routing never strands a PagerDuty incident.
   * An empty array suppresses external delivery for that code entirely.
   */
  channelRouting?: Partial<Record<ProviderAlertCode, AlertDeliveryChannel["kind"][]>>;
}

export interface AlertDeliveryResult {
  evaluatedProviders: number;
  activeAlerts: number;
  sent: number;
  resolved: number;
  skipped: number;
  errors: Array<{ providerId: string; alertCode: string; channel: string; error: string }>;
  persistenceDegraded: AlertPersistenceDegradation[];
}

export type AlertPersistenceOperation =
  | "trigger_unknown_outcome"
  | "trigger_rejected_outcome"
  | "trigger_success_outcome"
  | "resolve_failure_outcome"
  | "resolve_success_outcome";

export interface AlertPersistenceDegradation {
  stage: "channel_state";
  operation: AlertPersistenceOperation;
  code: "P1008";
  model: "ProviderAlertChannelDelivery";
  providerId: string;
  alertCode: string;
  channel: AlertDeliveryChannel["kind"];
  message: string;
}

export type AlertNotificationSummaryOperation = "post_send_notification_summary";

export class AlertNotificationSummaryPersistenceTimeout extends Error {
  readonly code = "P1008" as const;
  readonly model = "ProviderAlertNotification" as const;
  readonly operation: AlertNotificationSummaryOperation =
    "post_send_notification_summary";

  constructor(
    readonly originalError: Error,
    readonly partialResult: AlertDeliveryResult
  ) {
    super(originalError.message);
    this.name = "AlertNotificationSummaryPersistenceTimeout";
  }
}

type PrismaLike = Pick<
  PrismaClient,
  "provider" | "providerAlertNotification" | "providerAlertChannelDelivery"
>;

type DelegateWriteMethod = (...args: never[]) => Promise<unknown>;

function wrapDelegateWrite<T extends DelegateWriteMethod>(method: T): T {
  return ((...args: Parameters<T>) =>
    withInternalUsageWriteAdmission(() => method(...args))) as T;
}

function withAlertPersistenceAdmission(db: PrismaLike): PrismaLike {
  const providerAlertNotification = {
    findMany: db.providerAlertNotification.findMany.bind(
      db.providerAlertNotification
    ),
    findUnique: db.providerAlertNotification.findUnique.bind(
      db.providerAlertNotification
    ),
    findUniqueOrThrow: db.providerAlertNotification.findUniqueOrThrow.bind(
      db.providerAlertNotification
    ),
    create: wrapDelegateWrite(
      db.providerAlertNotification.create.bind(db.providerAlertNotification)
    ),
    updateMany: wrapDelegateWrite(
      db.providerAlertNotification.updateMany.bind(db.providerAlertNotification)
    ),
  };
  const providerAlertChannelDelivery = {
    findFirst: db.providerAlertChannelDelivery.findFirst.bind(
      db.providerAlertChannelDelivery
    ),
    findMany: db.providerAlertChannelDelivery.findMany.bind(
      db.providerAlertChannelDelivery
    ),
    findUnique: db.providerAlertChannelDelivery.findUnique.bind(
      db.providerAlertChannelDelivery
    ),
    upsert: wrapDelegateWrite(
      db.providerAlertChannelDelivery.upsert.bind(
        db.providerAlertChannelDelivery
      )
    ),
    updateMany: wrapDelegateWrite(
      db.providerAlertChannelDelivery.updateMany.bind(
        db.providerAlertChannelDelivery
      )
    ),
  };

  return {
    provider: db.provider,
    providerAlertNotification:
      providerAlertNotification as unknown as PrismaLike["providerAlertNotification"],
    providerAlertChannelDelivery:
      providerAlertChannelDelivery as unknown as PrismaLike["providerAlertChannelDelivery"],
  };
}

const DEFAULT_REMINDER_HOURS = 24;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 250;
const MAX_RETRY_BASE_MS = 5_000;
const MAX_RETRY_DELAY_MS = 5_000;
const TRIGGER_OUTCOME_UNKNOWN_MARKER = "delivery_outcome_unknown";
const TRIGGER_OUTCOME_UNKNOWN_MESSAGE =
  "Delivery outcome is unknown; automatic retry is deferred until the reminder interval";
const TRIGGER_CLAIM_IN_PROGRESS_MESSAGE =
  "Delivery is already claimed by another worker; duplicate send suppressed";
const TRIGGER_TRANSPORT_UNKNOWN_MESSAGE =
  "Transport ended without a definitive HTTP rejection; delivery may have been accepted and automatic retry is deferred until the reminder interval";
const TRIGGER_SUCCESS_PERSISTENCE_TIMEOUT_MESSAGE =
  "Delivery was accepted, but channel success persistence timed out; automatic retry is deferred until the reminder interval";
const PAGERDUTY_TRIGGER_IN_PROGRESS_RESOLVE_MESSAGE =
  "PagerDuty resolve is deferred until the in-flight trigger claim completes or expires";
const PAGERDUTY_RESOLVE_IN_PROGRESS_MESSAGE =
  "PagerDuty resolve is already claimed by another worker; duplicate resolve suppressed";
const PAGERDUTY_LEGACY_AUDIT_PENDING_MESSAGE =
  "PagerDuty legacy incident audit is pending because no routing key is configured";
const NOTIFICATION_OPERATION_IN_PROGRESS_MESSAGE =
  "Alert incident is already claimed by another worker; activation/resolution race suppressed";
const STALE_ALERT_EVIDENCE_MESSAGE =
  "Alert evidence is older than the durable incident watermark; stale transition suppressed";
const RESOLVE_OUTCOME_UNKNOWN_MARKER = "resolve_outcome_unknown";
const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

// --- S1: project budget/anomaly alerts -------------------------------------
// ProviderAlertNotification.providerId is a REQUIRED foreign key to Provider,
// so project-scoped alerts cannot persist (and therefore cannot dedup,
// hysteresis, remind, or resolve) without a real Provider row. This dedicated
// inactive system row — same pattern as the self-seeded "Agent Sync Relay"
// catalog row (ensure-agent-sync-provider.ts) — carries every per-project
// incident with `scope` = project id, reusing the machinery unchanged.
// Name constants: PROJECT_ALERTS_PROVIDER_* from @/lib/system-providers.
// S1c: unassigned-spend info alerts only fire above this default floor (and
// only once at least one project exists — with zero projects, ALL spend is
// unassigned by definition and alerting would be pure noise).
const DEFAULT_UNASSIGNED_SPEND_FLOOR_USD = 25;
const MAX_UNASSIGNED_SPEND_FLOOR_USD = 1_000_000;

// Shared select for alert-evaluation provider rows so the project-budgets
// system provider can be fetched with the exact same shape as the main query.
const ALERT_EVALUATION_PROVIDER_SELECT = {
  id: true,
  name: true,
  type: true,
  displayName: true,
  apiKey: true,
  config: true,
  secretConfig: true,
  isActive: true,
  alertConfigGeneration: true,
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
    orderBy: { fetchedAt: "desc" as const },
    take: 1,
    select: { balance: true, totalCost: true, totalRequests: true, credits: true, fetchedAt: true },
  },
  usageReconciliations: {
    orderBy: { createdAt: "desc" as const },
    take: 1,
    select: { deltaUsd: true, status: true },
  },
} satisfies Prisma.ProviderSelect;

type AlertEvaluationProvider = Prisma.ProviderGetPayload<{
  select: typeof ALERT_EVALUATION_PROVIDER_SELECT;
}>;

function readBoolEnvValue(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw == null || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

/** Resend costs money.  Drop email when Pushover is already configured. */
export function suppressEmailWhenPushoverConfigured(
  channels: AlertDeliveryChannel[]
): AlertDeliveryChannel[] {
  return channels.some((c) => c.kind === "pushover")
    ? channels.filter((c) => c.kind !== "email")
    : channels;
}

export function readAlertDeliveryConfig(
  env: NodeJS.ProcessEnv = appSettings.settingsEnv()
): AlertDeliveryConfig {
  const channels: AlertDeliveryChannel[] = [];
  const slackUrl = env.ALERT_SLACK_WEBHOOK_URL?.trim();
  const webhookUrl = env.ALERT_WEBHOOK_URL?.trim();
  const emailApiKey = env.ALERT_RESEND_API_KEY?.trim();
  const emailFrom = env.ALERT_EMAIL_FROM?.trim();
  const emailTo = env.ALERT_EMAIL_TO?.trim();
  const pagerdutyRoutingKey = env.ALERT_PAGERDUTY_ROUTING_KEY?.trim();
  const pushoverUserKey = (env.ALERT_PUSHOVER_USER_KEY || env.PUSHOVER_USER_KEY)?.trim();
  const pushoverApiToken = (
    env.ALERT_PUSHOVER_API_TOKEN ||
    env.PUSHOVER_USAGE_API_TOKEN ||
    env.PUSHOVER_API_TOKEN
  )?.trim();

  if (slackUrl) channels.push({ kind: "slack", url: slackUrl });
  if (webhookUrl) channels.push({ kind: "webhook", url: webhookUrl });

  const emailEnabled =
    readBoolEnvValue(env, "ALERT_EMAIL_ENABLED", true) &&
    !readBoolEnvValue(env, "ALERT_DISABLE_EMAIL", false);

  if (emailEnabled && emailApiKey && emailFrom && emailTo) {
    channels.push({ kind: "email", apiKey: emailApiKey, from: emailFrom, to: emailTo });
  }
  if (pagerdutyRoutingKey) {
    channels.push({ kind: "pagerduty", routingKey: pagerdutyRoutingKey });
  }
  if (pushoverUserKey && pushoverApiToken) {
    channels.push({ kind: "pushover", userKey: pushoverUserKey, apiToken: pushoverApiToken });
  }
  const apns = loadApnsConfig(env);
  if (apnsConfigured(apns)) {
    channels.push({ kind: "apns", config: apns });
  }

  const preferred = suppressEmailWhenPushoverConfigured(channels);

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
  const severityOverrides = parseCodeSeverityOverrides(env.ALERT_CODE_SEVERITY_OVERRIDES);
  const channelRouting = parseCodeChannelRouting(env.ALERT_CODE_CHANNEL_ROUTING);
  return {
    channels: preferred,
    minSeverity,
    reminderHours,
    timeoutMs,
    maxAttempts,
    retryBaseMs,
    ...(severityOverrides ? { severityOverrides } : {}),
    ...(channelRouting ? { channelRouting } : {}),
  };
}

const PROVIDER_ALERT_CODE_SET: ReadonlySet<string> = new Set(PROVIDER_ALERT_CODES);
const ALERT_CHANNEL_KIND_SET: ReadonlySet<string> = new Set([
  "slack",
  "webhook",
  "email",
  "pagerduty",
  "pushover",
  "apns",
]);

function parseJsonObjectEnv(raw: string | undefined, envName: string): Record<string, unknown> | null {
  if (!raw?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn(`[alert-delivery] ${envName} is not valid JSON; ignoring it`, error);
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn(`[alert-delivery] ${envName} must be a JSON object; ignoring it`);
    return null;
  }
  return parsed as Record<string, unknown>;
}

/**
 * S12: parse ALERT_CODE_SEVERITY_OVERRIDES ('{"stale_snapshot":"info"}').
 * Unknown codes and invalid severities are dropped with a warning so a typo
 * can never silently change unrelated alert behavior.
 */
function parseCodeSeverityOverrides(
  raw: string | undefined
): Partial<Record<ProviderAlertCode, AlertSeverity>> | undefined {
  const parsed = parseJsonObjectEnv(raw, "ALERT_CODE_SEVERITY_OVERRIDES");
  if (!parsed) return undefined;
  const overrides: Partial<Record<ProviderAlertCode, AlertSeverity>> = {};
  for (const [code, value] of Object.entries(parsed)) {
    if (!PROVIDER_ALERT_CODE_SET.has(code)) {
      console.warn(`[alert-delivery] ALERT_CODE_SEVERITY_OVERRIDES: unknown alert code "${code}"; ignoring`);
      continue;
    }
    const severity = normalizeSeverity(typeof value === "string" ? value : undefined);
    if (!severity) {
      console.warn(
        `[alert-delivery] ALERT_CODE_SEVERITY_OVERRIDES: invalid severity for "${code}" (want info|warning|critical); ignoring`
      );
      continue;
    }
    overrides[code as ProviderAlertCode] = severity;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/**
 * S12: parse ALERT_CODE_CHANNEL_ROUTING ('{"budget_exceeded":["pagerduty"]}').
 * Values must be arrays of known channel kinds; an empty array is meaningful
 * (suppresses external delivery for that code) and is preserved.
 */
function parseCodeChannelRouting(
  raw: string | undefined
): Partial<Record<ProviderAlertCode, AlertDeliveryChannel["kind"][]>> | undefined {
  const parsed = parseJsonObjectEnv(raw, "ALERT_CODE_CHANNEL_ROUTING");
  if (!parsed) return undefined;
  const routing: Partial<Record<ProviderAlertCode, AlertDeliveryChannel["kind"][]>> = {};
  for (const [code, value] of Object.entries(parsed)) {
    if (!PROVIDER_ALERT_CODE_SET.has(code)) {
      console.warn(`[alert-delivery] ALERT_CODE_CHANNEL_ROUTING: unknown alert code "${code}"; ignoring`);
      continue;
    }
    if (!Array.isArray(value)) {
      console.warn(`[alert-delivery] ALERT_CODE_CHANNEL_ROUTING: value for "${code}" must be an array; ignoring`);
      continue;
    }
    const kinds = new Set<AlertDeliveryChannel["kind"]>();
    for (const entry of value) {
      if (typeof entry !== "string" || !ALERT_CHANNEL_KIND_SET.has(entry)) {
        console.warn(
          `[alert-delivery] ALERT_CODE_CHANNEL_ROUTING: unknown channel kind "${String(entry)}" for "${code}"; ignoring that entry`
        );
        continue;
      }
      kinds.add(entry as AlertDeliveryChannel["kind"]);
    }
    // A non-empty array whose entries were ALL invalid is a misconfiguration,
    // not a deliberate suppress-all — skip it rather than muting the code.
    if (value.length > 0 && kinds.size === 0) continue;
    routing[code as ProviderAlertCode] = [...kinds];
  }
  return Object.keys(routing).length > 0 ? routing : undefined;
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
  // Scoped alerts (per-project on the project-budgets provider, per-
  // subscription insights) get one durable incident EACH; unscoped alerts
  // keep the legacy `providerId:code` key byte-for-byte.
  return alert.scope
    ? `${providerId}:${alert.code}:${alert.scope}`
    : `${providerId}:${alert.code}`;
}

/**
 * Recover a persisted notification's scope segment (the inverse of stateKey).
 * Needed on the resolve path, where only the notification row is available.
 */
function notificationAlertScope(notification: {
  providerId: string;
  alertCode: string;
  stateKey: string;
}): string | undefined {
  const prefix = `${notification.providerId}:${notification.alertCode}:`;
  return notification.stateKey.startsWith(prefix)
    ? notification.stateKey.slice(prefix.length)
    : undefined;
}

const SNAPSHOT_EVIDENCE_ALERT_CODES = new Set<ProviderAlert["code"]>([
  "missing_snapshot",
  "balance_low",
  "credits_low",
  "request_limit",
  "request_limit_warning",
  "stale_snapshot",
  "missing_balance_visibility",
]);
const NO_SNAPSHOT_EVIDENCE_AT = new Date(0);

type AlertEvidenceState = "active" | "clear";

interface AlertEvidence {
  configGeneration: number;
  sourceAt: Date;
  at: Date;
  state: AlertEvidenceState;
}

interface PersistedAlertEvidence {
  evidenceConfigGeneration: number;
  evidenceSourceAt: Date | null;
  evidenceWatermarkAt: Date | null;
  evidenceWatermarkState: string;
}

interface NotificationVersion extends PersistedAlertEvidence {
  severity: string;
  message: string;
}

const EVIDENCE_STATE_RANK: Record<string, number> = {
  legacy: 0,
  active: 1,
  clear: 2,
};

function compareEvidence(
  persisted: PersistedAlertEvidence,
  candidate: AlertEvidence
): number {
  if (persisted.evidenceConfigGeneration !== candidate.configGeneration) {
    return persisted.evidenceConfigGeneration - candidate.configGeneration;
  }
  const persistedSourceAt =
    persisted.evidenceSourceAt?.getTime() ??
    persisted.evidenceWatermarkAt?.getTime() ??
    -1;
  const candidateSourceAt = candidate.sourceAt.getTime();
  if (persistedSourceAt !== candidateSourceAt) {
    return persistedSourceAt - candidateSourceAt;
  }
  const persistedAt = persisted.evidenceWatermarkAt?.getTime() ?? -1;
  const candidateAt = candidate.at.getTime();
  if (persistedAt !== candidateAt) return persistedAt - candidateAt;
  return (
    (EVIDENCE_STATE_RANK[persisted.evidenceWatermarkState] ?? 0) -
    EVIDENCE_STATE_RANK[candidate.state]
  );
}

function exactNotificationVersionWhere(
  version: NotificationVersion
): Prisma.ProviderAlertNotificationWhereInput {
  return {
    evidenceConfigGeneration: version.evidenceConfigGeneration,
    evidenceSourceAt: version.evidenceSourceAt,
    evidenceWatermarkAt: version.evidenceWatermarkAt,
    evidenceWatermarkState: version.evidenceWatermarkState,
    severity: version.severity,
    message: version.message,
  };
}

function notificationVersionOf(
  notification: NotificationVersion
): NotificationVersion {
  return {
    evidenceConfigGeneration: notification.evidenceConfigGeneration,
    evidenceSourceAt: notification.evidenceSourceAt,
    evidenceWatermarkAt: notification.evidenceWatermarkAt,
    evidenceWatermarkState: notification.evidenceWatermarkState,
    severity: notification.severity,
    message: notification.message,
  };
}

function alertEvidenceTimes(
  provider: {
    isActive: boolean;
    refreshIntervalMin: number;
    snapshots: Array<{ fetchedAt: Date }>;
  },
  alertCode: ProviderAlert["code"],
  evaluatedAt: Date
): { sourceAt: Date; at: Date } {
  if (
    provider.isActive &&
    SNAPSHOT_EVIDENCE_ALERT_CODES.has(alertCode)
  ) {
    // Absence predates every real snapshot. Using evaluatedAt here would let
    // a worker that read "no snapshot" at a later wall-clock time outrank a
    // newly inserted snapshot whose provider fetchedAt is earlier.
    const snapshot = provider.snapshots[0];
    if (!snapshot) {
      return {
        sourceAt: NO_SNAPSHOT_EVIDENCE_AT,
        at: NO_SNAPSHOT_EVIDENCE_AT,
      };
    }
    // A stale alert is a deterministic transition derived from S itself.
    // Source time is compared first, so any newer snapshot wins even when the
    // older snapshot's stale deadline is later.
    //
    // BOTH states stamp the stale deadline, deliberately. The clear case used
    // to report `fetchedAt`, which is STRICTLY EARLIER than the deadline the
    // active transition had already persisted; on the same snapshot (equal
    // sourceAt) compareEvidence then ranked the persisted active watermark
    // ahead of the clear candidate and rejected the resolution as stale
    // evidence, so the PagerDuty resolve was never sent and the incident could
    // never close. Equal watermarks let the "clear" > "active" state rank break
    // the tie in the resolution's favour — exactly the ordering
    // EVIDENCE_STATE_RANK exists to express.
    //
    // Consequence to know before re-enabling stale_snapshot emission (it is
    // deliberately NOT emitted today — see provider-alerts.ts): one snapshot
    // now yields ONE stale incident, because a re-trigger from the identical
    // (sourceAt, deadline) pair is correctly suppressed by the persisted clear.
    // A new snapshot or an alert-config generation bump still re-opens.
    if (alertCode === "stale_snapshot") {
      return {
        sourceAt: snapshot.fetchedAt,
        at: providerSnapshotStaleAt(
          snapshot.fetchedAt,
          provider.refreshIntervalMin
        ),
      };
    }
    return { sourceAt: snapshot.fetchedAt, at: snapshot.fetchedAt };
  }
  return { sourceAt: evaluatedAt, at: evaluatedAt };
}

function alertEvidence(
  provider: {
    isActive: boolean;
    alertConfigGeneration: number;
    refreshIntervalMin: number;
    snapshots: Array<{ fetchedAt: Date }>;
  },
  alertCode: ProviderAlert["code"],
  evaluatedAt: Date,
  state: AlertEvidenceState
): AlertEvidence {
  // The times are state-independent by construction: active and clear MUST
  // stamp the same watermark or compareEvidence deadlocks the transition.
  const times = alertEvidenceTimes(provider, alertCode, evaluatedAt);
  return {
    configGeneration: provider.alertConfigGeneration,
    ...times,
    state,
  };
}

function noEarlierThan(candidate: Date, floor: Date): Date {
  return candidate >= floor ? candidate : floor;
}

function latestDate(...dates: Date[]): Date {
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

function dueForChannel(
  lastSucceededAt: Date | null,
  lastSucceededIncidentGeneration: number | null,
  incidentGeneration: number,
  incidentStartedAt: Date,
  now: Date,
  reminderHours: number
): boolean {
  const belongsToIncident =
    lastSucceededIncidentGeneration === incidentGeneration ||
    (lastSucceededIncidentGeneration === null &&
      incidentGeneration === 1 &&
      lastSucceededAt !== null &&
      lastSucceededAt >= incidentStartedAt);
  if (!lastSucceededAt || !belongsToIncident) return true;
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
        : channel.kind === "pushover"
          ? `${channel.userKey}\0${channel.apiToken}`
          : channel.kind === "apns"
            ? `${channel.config.teamId}\0${channel.config.keyId}\0${channel.config.bundleId}`
            : channel.url;
  const digest = createHash("sha256")
    .update(`${channel.kind}\0${destination}`)
    .digest("hex");
  return `${channel.kind}:${digest}`;
}

function pagerDutyDedupKey(
  providerId: string,
  alertCode: string,
  incidentGeneration: number,
  auditState: string,
  scope?: string
): string {
  // Scope distinguishes otherwise-identical incidents (e.g. two projects over
  // budget on the shared project-budgets provider) so PagerDuty never
  // dedupes one project's incident into another's.
  const base = `api-usage-monitor:${providerId}:${alertCode}${scope ? `:${scope}` : ""}`;
  return auditState === "legacy_unknown"
    ? base
    : `${base}:incident-${incidentGeneration}`;
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
    readonly attempts: number,
    readonly outcome: "rejected" | "unknown"
  ) {
    super(message);
    this.name = "ChannelDeliveryFailure";
  }
}

class TriggerDeliveryClaimLostError extends Error {
  constructor() {
    super("Alert delivery claim was lost before its outcome could be persisted");
    this.name = "TriggerDeliveryClaimLostError";
  }
}

interface TriggerDeliveryClaim {
  token: string;
  generation: number;
  incidentGeneration: number;
  claimedAt: Date;
  pagerDutyDedupKey: string | null;
  operationToken: string;
  operationGeneration: number;
  configGeneration: number;
  targetEvidence: AlertEvidence;
  notificationVersion: NotificationVersion;
}

interface ResolveDeliveryClaim {
  token: string;
  generation: number;
  incidentGeneration: number;
  claimedAt: Date;
  pagerDutyDedupKey: string;
  operationToken: string;
  operationGeneration: number;
  configGeneration: number;
  targetEvidence: AlertEvidence;
  notificationVersion: NotificationVersion;
}

interface NotificationOperationClaim {
  token: string;
  generation: number;
  incidentGeneration: number;
  claimedAt: Date;
  expiresAt: Date;
  configGeneration: number;
  targetEvidence: AlertEvidence;
  notificationVersion: NotificationVersion;
}

type ActiveNotificationClaimResult =
  | {
      status: "claimed";
      notification: Prisma.ProviderAlertNotificationGetPayload<{}>;
      claim: NotificationOperationClaim;
    }
  | { status: "stale" | "busy" };

function isRetryableDeliveryError(
  channel: AlertDeliveryChannel,
  error: unknown
): boolean {
  if (channel.kind === "pagerduty") {
    // PagerDuty's stable dedup key makes ambiguous retries idempotent.
    if (!(error instanceof ChannelHttpError)) return true;
    return (
      error.status === 408 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  // Slack, Resend, and generic webhooks do not provide an idempotency key.
  // A 408/5xx or transport failure may have been accepted, so never retry it.
  return (
    error instanceof ChannelHttpError &&
    (error.status === 425 || error.status === 429)
  );
}

function deliveryFailureOutcome(error: unknown): "rejected" | "unknown" {
  if (!(error instanceof ChannelHttpError)) return "unknown";
  return error.status === 408 || error.status >= 500 ? "unknown" : "rejected";
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

async function postForm(
  label: string,
  url: string,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<void> {
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
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
  action: "trigger" | "resolve",
  exactPagerDutyDedupKey: string | null
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
        html: formatAlertEmailHtml({
          providerLabel: provider.displayName || provider.name,
          severity: alert.severity,
          message: alert.message,
          detectedAtIso: now.toISOString(),
        }),
      },
      fetchImpl,
      timeoutMs
    );
    return;
  }

  if (channel.kind === "pagerduty") {
    const pdSeverity = alert.severity === "critical" ? "critical" : "warning";
    if (!exactPagerDutyDedupKey) {
      throw new Error("PagerDuty delivery requires an incident-scoped dedup key");
    }
    await postJson(
      "PagerDuty API",
      "https://events.pagerduty.com/v2/enqueue",
      { "Content-Type": "application/json" },
      action === "resolve"
        ? {
            routing_key: channel.routingKey,
            event_action: "resolve",
            dedup_key: exactPagerDutyDedupKey,
          }
        : {
            routing_key: channel.routingKey,
            event_action: "trigger",
            dedup_key: exactPagerDutyDedupKey,
            payload: {
              summary: alertText(provider, alert),
              source: "Usage Monitor",
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

  if (channel.kind === "pushover") {
    const isAnomaly =
      alert.code === "spend_anomaly" ||
      alert.code === "request_anomaly" ||
      alert.code === "project_spend_anomaly";
    const priority = alert.severity === "critical" ? 1 : 0;
    const titlePrefix = isAnomaly
      ? alert.severity === "critical"
        ? "🚨 [CRITICAL SPIKE]"
        : "⚠️ [USAGE SPIKE]"
      : `[${alert.severity.toUpperCase()}]`;

    const params = new URLSearchParams({
      token: channel.apiToken,
      user: channel.userKey,
      title: `${titlePrefix} ${provider.displayName || provider.name}`,
      message: alert.message,
      priority: String(priority),
      url: "https://usage.jays.services/alerts",
      url_title: "View in Usage Monitor",
    });

    if (isAnomaly && alert.severity === "critical") {
      params.set("sound", "siren");
    }

    await postForm(
      "Pushover API",
      "https://api.pushover.net/1/messages.json",
      params,
      fetchImpl,
      timeoutMs
    );
    return;
  }

  if (channel.kind === "apns") {
    const devices = await prisma.apnsDeviceToken.findMany({
      where: { isActive: true },
      select: { deviceToken: true, environment: true },
    });
    if (devices.length === 0) return;
    const fanout = await fanOutApnsAlert({
      title: `[${alert.severity.toUpperCase()}] ${provider.displayName || provider.name}`,
      body: alert.message,
      collapseId: `um-${provider.id}-${alert.code}`.slice(0, 64),
      data: {
        tab: "alerts",
        alertCode: alert.code,
        providerId: provider.id,
      },
      devices,
      config: channel.config,
      transport: channel.transport,
      timeoutMs,
      retireToken: async (token) => {
        await prisma.apnsDeviceToken.updateMany({
          where: { deviceToken: token, isActive: true },
          data: { isActive: false },
        });
      },
    });
    if (fanout.delivered > 0 || (fanout.retryable === 0 && fanout.authErrors === 0)) {
      return;
    }
    if (fanout.authErrors > 0) {
      throw new Error("APNs auth/config failure");
    }
    throw new ChannelHttpError("APNs retryable failure", 429);
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
  action: "trigger" | "resolve" = "trigger",
  exactPagerDutyDedupKey: string | null = null
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
        action,
        exactPagerDutyDedupKey
      );
      return attempt;
    } catch (error) {
      lastError = error;
      if (
        attempt >= settings.maxAttempts ||
        !isRetryableDeliveryError(channel, error)
      ) {
        const message = error instanceof Error ? error.message : "Alert delivery failed";
        throw new ChannelDeliveryFailure(
          message,
          attempt,
          deliveryFailureOutcome(error)
        );
      }
      const delayMs = Math.min(
        settings.retryBaseMs * 2 ** (attempt - 1),
        MAX_RETRY_DELAY_MS
      );
      if (delayMs > 0) await sleepImpl(delayMs);
    }
  }
  const message = lastError instanceof Error ? lastError.message : "Alert delivery failed";
  throw new ChannelDeliveryFailure(
    message,
    settings.maxAttempts,
    deliveryFailureOutcome(lastError)
  );
}

function failureDetails(error: unknown): {
  attempts: number;
  message: string;
  outcome: "rejected" | "unknown";
} {
  const attempts = error instanceof ChannelDeliveryFailure ? error.attempts : 1;
  const message = error instanceof Error ? error.message : "Alert delivery failed";
  const outcome = error instanceof ChannelDeliveryFailure ? error.outcome : "unknown";
  return { attempts, message: message.slice(0, 500), outcome };
}

function isPrismaModelTimeout(
  error: unknown,
  modelName: "ProviderAlertNotification" | "ProviderAlertChannelDelivery"
): error is Error & { code: "P1008"; meta: { modelName: typeof modelName } } {
  if (!(error instanceof Error)) return false;
  const candidate = error as Error & { code?: unknown; meta?: unknown };
  if (candidate.code !== "P1008" || typeof candidate.meta !== "object" || !candidate.meta) {
    return false;
  }
  return (
    "modelName" in candidate.meta &&
    candidate.meta.modelName === modelName
  );
}

function isPrismaUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

function triggerClaimLeaseMs(settings: {
  timeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
}): number {
  let retryDelayMs = 0;
  for (let attempt = 1; attempt < settings.maxAttempts; attempt += 1) {
    retryDelayMs += Math.min(
      settings.retryBaseMs * 2 ** (attempt - 1),
      MAX_RETRY_DELAY_MS
    );
  }
  return settings.timeoutMs * settings.maxAttempts + retryDelayMs + 30_000;
}

function noteChannelPersistenceDegradation(
  result: AlertDeliveryResult,
  context: {
    providerId: string;
    alertCode: string;
    channel: AlertDeliveryChannel["kind"];
  },
  operation: AlertPersistenceOperation,
  error: Error
): void {
  result.persistenceDegraded.push({
    stage: "channel_state",
    operation,
    code: "P1008",
    model: "ProviderAlertChannelDelivery",
    ...context,
    message: error.message,
  });
}

interface NotificationOperationState {
  incidentGeneration: number;
  operationClaimToken: string | null;
  operationClaimExpiresAt: Date | null;
  operationClaimIncidentGeneration: number | null;
  operationClaimConfigGeneration: number | null;
  operationClaimEvidenceSourceAt: Date | null;
  operationClaimEvidenceAt: Date | null;
  operationClaimEvidenceState: string | null;
}

type LiveOperationTarget =
  | { status: "none" }
  | { status: "opaque" }
  | { status: "known"; evidence: AlertEvidence };

function liveOperationTarget(
  notification: NotificationOperationState,
  at: Date
): LiveOperationTarget {
  if (
    !notification.operationClaimToken ||
    !notification.operationClaimExpiresAt ||
    notification.operationClaimExpiresAt <= at ||
    notification.operationClaimIncidentGeneration !==
      notification.incidentGeneration
  ) {
    return { status: "none" };
  }
  if (
    notification.operationClaimConfigGeneration === null ||
    !notification.operationClaimEvidenceSourceAt ||
    !notification.operationClaimEvidenceAt ||
    (notification.operationClaimEvidenceState !== "active" &&
      notification.operationClaimEvidenceState !== "clear")
  ) {
    return { status: "opaque" };
  }
  return {
    status: "known",
    evidence: {
      configGeneration: notification.operationClaimConfigGeneration,
      sourceAt: notification.operationClaimEvidenceSourceAt,
      at: notification.operationClaimEvidenceAt,
      state: notification.operationClaimEvidenceState,
    },
  };
}

function compareCandidateToLiveTarget(
  target: LiveOperationTarget,
  candidate: AlertEvidence
): "available" | "busy" | "stale" | "preempt" {
  if (target.status === "none") return "available";
  if (target.status === "opaque") return "busy";
  const comparison = compareEvidence(
    {
      evidenceConfigGeneration: target.evidence.configGeneration,
      evidenceSourceAt: target.evidence.sourceAt,
      evidenceWatermarkAt: target.evidence.at,
      evidenceWatermarkState: target.evidence.state,
    },
    candidate
  );
  if (comparison > 0) return "stale";
  if (comparison === 0) return "busy";
  return "preempt";
}

async function claimNotificationOperation(
  db: PrismaLike,
  notification: NotificationVersion & {
    id: string;
    incidentGeneration: number;
    operationClaimGeneration: number;
    operationClaimToken: string | null;
    operationClaimExpiresAt: Date | null;
    operationClaimIncidentGeneration: number | null;
    operationClaimConfigGeneration: number | null;
    operationClaimEvidenceSourceAt: Date | null;
    operationClaimEvidenceAt: Date | null;
    operationClaimEvidenceState: string | null;
  },
  evidence: AlertEvidence,
  claimLeaseDurationMs: number,
  clock: () => Date
): Promise<NotificationOperationClaim | null> {
  const claimedAt = clock();
  const token = randomUUID();
  const expiresAt = new Date(claimedAt.getTime() + claimLeaseDurationMs);
  if (compareEvidence(notification, evidence) > 0) return null;

  const liveTarget = liveOperationTarget(notification, claimedAt);
  const liveDisposition = compareCandidateToLiveTarget(liveTarget, evidence);
  if (liveDisposition === "busy" || liveDisposition === "stale") return null;

  const claimed = await db.providerAlertNotification.updateMany({
    where: {
      id: notification.id,
      incidentGeneration: notification.incidentGeneration,
      resolvedAt: null,
      operationClaimGeneration: notification.operationClaimGeneration,
      provider: {
        is: { alertConfigGeneration: evidence.configGeneration },
      },
      ...exactNotificationVersionWhere(notification),
      AND: [
        ...(liveDisposition === "preempt"
          ? [
              {
                operationClaimToken: notification.operationClaimToken,
                operationClaimExpiresAt:
                  notification.operationClaimExpiresAt,
                operationClaimIncidentGeneration:
                  notification.operationClaimIncidentGeneration,
                operationClaimConfigGeneration:
                  notification.operationClaimConfigGeneration,
                operationClaimEvidenceSourceAt:
                  notification.operationClaimEvidenceSourceAt,
                operationClaimEvidenceAt:
                  notification.operationClaimEvidenceAt,
                operationClaimEvidenceState:
                  notification.operationClaimEvidenceState,
                channelDeliveries: {
                  none: {
                    OR: [
                      {
                        triggerClaimToken: { not: null },
                        triggerClaimExpiresAt: { gt: claimedAt },
                        triggerOperationClaimGeneration:
                          notification.operationClaimGeneration,
                      },
                      {
                        resolveClaimToken: { not: null },
                        resolveClaimExpiresAt: { gt: claimedAt },
                        resolveOperationClaimGeneration:
                          notification.operationClaimGeneration,
                      },
                    ],
                  },
                },
              },
            ]
          : [
              {
                OR: [
                  { operationClaimToken: null },
                  { operationClaimExpiresAt: { lte: claimedAt } },
                  {
                    operationClaimIncidentGeneration: {
                      not: notification.incidentGeneration,
                    },
                  },
                ],
              },
            ]),
      ],
    },
    data: {
      operationClaimToken: token,
      operationClaimGeneration: { increment: 1 },
      operationClaimExpiresAt: expiresAt,
      operationClaimIncidentGeneration: notification.incidentGeneration,
      operationClaimConfigGeneration: evidence.configGeneration,
      operationClaimEvidenceSourceAt: evidence.sourceAt,
      operationClaimEvidenceAt: evidence.at,
      operationClaimEvidenceState: evidence.state,
    },
  });
  if (claimed.count !== 1) return null;

  const row = await db.providerAlertNotification.findUnique({
    where: { id: notification.id },
    select: {
      resolvedAt: true,
      incidentGeneration: true,
      operationClaimToken: true,
      operationClaimGeneration: true,
      operationClaimIncidentGeneration: true,
      operationClaimConfigGeneration: true,
      operationClaimEvidenceSourceAt: true,
      operationClaimEvidenceAt: true,
      operationClaimEvidenceState: true,
      evidenceConfigGeneration: true,
      evidenceSourceAt: true,
      evidenceWatermarkAt: true,
      evidenceWatermarkState: true,
      severity: true,
      message: true,
      provider: { select: { alertConfigGeneration: true } },
    },
  });
  const stillOwnsProvisionalClaim =
    row?.resolvedAt === null &&
    row.incidentGeneration === notification.incidentGeneration &&
    row.operationClaimToken === token &&
    row.operationClaimIncidentGeneration === notification.incidentGeneration &&
    row.operationClaimConfigGeneration === evidence.configGeneration &&
    row.operationClaimEvidenceSourceAt?.getTime() ===
      evidence.sourceAt.getTime() &&
    row.operationClaimEvidenceAt?.getTime() === evidence.at.getTime() &&
    row.operationClaimEvidenceState === evidence.state;
  if (
    !row ||
    row.resolvedAt !== null ||
    row.incidentGeneration !== notification.incidentGeneration ||
    row.operationClaimToken !== token ||
    row.operationClaimIncidentGeneration !== notification.incidentGeneration ||
    row.operationClaimConfigGeneration !== evidence.configGeneration ||
    row.operationClaimEvidenceSourceAt?.getTime() !==
      evidence.sourceAt.getTime() ||
    row.operationClaimEvidenceAt?.getTime() !== evidence.at.getTime() ||
    row.operationClaimEvidenceState !== evidence.state ||
    compareEvidence(row, evidence) > 0 ||
    row.severity !== notification.severity ||
    row.message !== notification.message ||
    row.provider.alertConfigGeneration !== evidence.configGeneration
  ) {
    if (row && stillOwnsProvisionalClaim) {
      await releaseNotificationOperation(db, notification.id, {
        token,
        generation: row.operationClaimGeneration,
        incidentGeneration: row.incidentGeneration,
        claimedAt,
        expiresAt,
        configGeneration: evidence.configGeneration,
        targetEvidence: evidence,
        notificationVersion: notificationVersionOf(row),
      });
    }
    throw new TriggerDeliveryClaimLostError();
  }
  return {
    token,
    generation: row.operationClaimGeneration,
    incidentGeneration: notification.incidentGeneration,
    claimedAt,
    expiresAt,
    configGeneration: evidence.configGeneration,
    targetEvidence: evidence,
    notificationVersion: {
      evidenceConfigGeneration: row.evidenceConfigGeneration,
      evidenceSourceAt: row.evidenceSourceAt,
      evidenceWatermarkAt: row.evidenceWatermarkAt,
      evidenceWatermarkState: row.evidenceWatermarkState,
      severity: row.severity,
      message: row.message,
    },
  };
}

async function releaseNotificationOperation(
  db: PrismaLike,
  notificationId: string,
  claim: NotificationOperationClaim
): Promise<void> {
  await clearNotificationChildClaims(db, notificationId, claim);
  await db.providerAlertNotification.updateMany({
    where: {
      id: notificationId,
      incidentGeneration: claim.incidentGeneration,
      operationClaimToken: claim.token,
      operationClaimGeneration: claim.generation,
      operationClaimIncidentGeneration: claim.incidentGeneration,
      operationClaimConfigGeneration: claim.configGeneration,
      operationClaimEvidenceSourceAt: claim.targetEvidence.sourceAt,
      operationClaimEvidenceAt: claim.targetEvidence.at,
      operationClaimEvidenceState: claim.targetEvidence.state,
    },
    data: {
      operationClaimToken: null,
      operationClaimExpiresAt: null,
      operationClaimConfigGeneration: null,
      operationClaimEvidenceSourceAt: null,
      operationClaimEvidenceAt: null,
      operationClaimEvidenceState: null,
    },
  });
  // A strictly newer evidence target may intentionally preempt this parent
  // lease. Releasing an already-superseded claim is therefore a safe no-op.
  return;
}

async function clearNotificationChildClaims(
  db: PrismaLike,
  notificationId: string,
  claim: NotificationOperationClaim
): Promise<void> {
  await db.providerAlertChannelDelivery.updateMany({
    where: {
      notificationId,
      triggerClaimToken: { not: null },
      triggerOperationClaimGeneration: claim.generation,
    },
    data: {
      triggerClaimToken: null,
      triggerClaimExpiresAt: null,
    },
  });
  await db.providerAlertChannelDelivery.updateMany({
    where: {
      notificationId,
      resolveClaimToken: { not: null },
      resolveOperationClaimGeneration: claim.generation,
    },
    data: {
      resolveClaimToken: null,
      resolveClaimExpiresAt: null,
    },
  });
}

async function persistNotificationSummary(
  db: PrismaLike,
  notification: NotificationVersion & {
    id: string;
    incidentGeneration: number;
    lastSentAt: Date | null;
  },
  operationClaim: NotificationOperationClaim,
  summaryAt: Date,
  claimValidAt = summaryAt
): Promise<void> {
  const summary = await db.providerAlertNotification.updateMany({
    where: {
      id: notification.id,
      incidentGeneration: notification.incidentGeneration,
      resolvedAt: null,
      lastSentAt: notification.lastSentAt,
      operationClaimToken: operationClaim.token,
      operationClaimGeneration: operationClaim.generation,
      operationClaimIncidentGeneration: operationClaim.incidentGeneration,
      operationClaimConfigGeneration: operationClaim.configGeneration,
      operationClaimEvidenceSourceAt: operationClaim.targetEvidence.sourceAt,
      operationClaimEvidenceAt: operationClaim.targetEvidence.at,
      operationClaimEvidenceState: operationClaim.targetEvidence.state,
      operationClaimExpiresAt: { gt: claimValidAt },
      ...exactNotificationVersionWhere(operationClaim.notificationVersion),
      provider: {
        is: { alertConfigGeneration: operationClaim.configGeneration },
      },
    },
    data: {
      lastSentAt: summaryAt,
      sendCount: { increment: 1 },
    },
  });
  if (summary.count !== 1) throw new TriggerDeliveryClaimLostError();
}

async function claimTriggerDelivery(
  db: PrismaLike,
  notificationId: string,
  channel: AlertDeliveryChannel,
  incidentGeneration: number,
  expectedClaimGeneration: number,
  exactPagerDutyDedupKey: string | null,
  operationClaim: NotificationOperationClaim,
  claimLeaseDurationMs: number,
  clock: () => Date
): Promise<TriggerDeliveryClaim | null> {
  const key = channelKey(channel);
  await db.providerAlertChannelDelivery.upsert({
    where: {
      notificationId_channelKey: { notificationId, channelKey: key },
    },
    create: {
      notificationId,
      channelKey: key,
      channelKind: channel.kind,
    },
    update: {
      channelKind: channel.kind,
    },
  });

  // Compute the lease from the instant immediately before the atomic claim,
  // not from function entry. A slow upsert/lock wait must not consume it.
  const claimedAt = clock();
  const claimExpiresAt = new Date(claimedAt.getTime() + claimLeaseDurationMs);
  const claimToken = randomUUID();
  const claimed = await db.providerAlertChannelDelivery.updateMany({
    where: {
      notificationId,
      channelKey: key,
      triggerClaimGeneration: expectedClaimGeneration,
      notification: {
        is: {
          resolvedAt: null,
          incidentGeneration,
          operationClaimToken: operationClaim.token,
          operationClaimGeneration: operationClaim.generation,
          operationClaimIncidentGeneration: incidentGeneration,
          operationClaimConfigGeneration: operationClaim.configGeneration,
          operationClaimEvidenceSourceAt:
            operationClaim.targetEvidence.sourceAt,
          operationClaimEvidenceAt: operationClaim.targetEvidence.at,
          operationClaimEvidenceState: operationClaim.targetEvidence.state,
          operationClaimExpiresAt: { gt: claimedAt },
          ...exactNotificationVersionWhere(operationClaim.notificationVersion),
          provider: {
            is: {
              alertConfigGeneration: operationClaim.configGeneration,
            },
          },
        },
      },
      AND: [
        {
          OR: [
            { triggerClaimToken: null },
            { triggerClaimExpiresAt: { lte: claimedAt } },
            { triggerIncidentGeneration: { not: incidentGeneration } },
            {
              triggerOperationClaimGeneration: {
                not: operationClaim.generation,
              },
            },
          ],
        },
        {
          OR: [
            { resolveClaimToken: null },
            { resolveClaimExpiresAt: { lte: claimedAt } },
            { resolveIncidentGeneration: { not: incidentGeneration } },
            {
              resolveOperationClaimGeneration: {
                not: operationClaim.generation,
              },
            },
          ],
        },
      ],
    },
    data: {
      triggerClaimToken: claimToken,
      triggerClaimGeneration: { increment: 1 },
      triggerClaimExpiresAt: claimExpiresAt,
      triggerIncidentGeneration: incidentGeneration,
      triggerOperationClaimGeneration: operationClaim.generation,
      pagerDutyDedupKey: exactPagerDutyDedupKey,
      resolveClaimToken: null,
      resolveClaimGeneration: { increment: 1 },
      resolveClaimExpiresAt: null,
      resolveOperationClaimGeneration: null,
      lastAttemptAt: claimedAt,
      lastError: TRIGGER_OUTCOME_UNKNOWN_MARKER,
    },
  });
  if (claimed.count !== 1) return null;

  const row = await db.providerAlertChannelDelivery.findUnique({
    where: {
      notificationId_channelKey: { notificationId, channelKey: key },
    },
    select: {
      triggerClaimToken: true,
      triggerClaimGeneration: true,
      triggerIncidentGeneration: true,
      triggerOperationClaimGeneration: true,
      pagerDutyDedupKey: true,
    },
  });
  if (
    !row ||
    row.triggerClaimToken !== claimToken ||
    row.triggerIncidentGeneration !== incidentGeneration ||
    row.triggerOperationClaimGeneration !== operationClaim.generation
  ) {
    throw new TriggerDeliveryClaimLostError();
  }
  return {
    token: claimToken,
    generation: row.triggerClaimGeneration,
    incidentGeneration,
    claimedAt,
    pagerDutyDedupKey: row.pagerDutyDedupKey,
    operationToken: operationClaim.token,
    operationGeneration: operationClaim.generation,
    configGeneration: operationClaim.configGeneration,
    targetEvidence: operationClaim.targetEvidence,
    notificationVersion: operationClaim.notificationVersion,
  };
}

async function recordTriggerOutcome(
  db: PrismaLike,
  notificationId: string,
  channel: AlertDeliveryChannel,
  claim: TriggerDeliveryClaim,
  now: Date,
  attempts: number,
  error: string | null
): Promise<void> {
  const key = channelKey(channel);
  const persistedAt = noEarlierThan(now, claim.claimedAt);
  const persisted = await db.providerAlertChannelDelivery.updateMany({
    where: {
      notificationId,
      channelKey: key,
      triggerClaimToken: claim.token,
      triggerClaimGeneration: claim.generation,
      triggerIncidentGeneration: claim.incidentGeneration,
      triggerOperationClaimGeneration: claim.operationGeneration,
      notification: {
        is: {
          resolvedAt: null,
          incidentGeneration: claim.incidentGeneration,
          operationClaimToken: claim.operationToken,
          operationClaimGeneration: claim.operationGeneration,
          operationClaimIncidentGeneration: claim.incidentGeneration,
          operationClaimConfigGeneration: claim.configGeneration,
          operationClaimEvidenceSourceAt:
            claim.targetEvidence.sourceAt,
          operationClaimEvidenceAt: claim.targetEvidence.at,
          operationClaimEvidenceState: claim.targetEvidence.state,
          operationClaimExpiresAt: { gt: persistedAt },
          ...exactNotificationVersionWhere(claim.notificationVersion),
          provider: {
            is: { alertConfigGeneration: claim.configGeneration },
          },
        },
      },
    },
    data: {
      channelKind: channel.kind,
      lastAttemptAt: persistedAt,
      ...(error
        ? { triggerClaimToken: null, triggerClaimExpiresAt: null }
        : {}),
      attemptCount: { increment: attempts },
      ...(error
        ? { lastError: error }
        : {
            lastSucceededAt: persistedAt,
            lastSucceededIncidentGeneration: claim.incidentGeneration,
            successCount: { increment: 1 },
            lastResolveError: null,
            lastError: null,
          }),
    },
  });
  if (persisted.count !== 1) throw new TriggerDeliveryClaimLostError();
}

async function recordTriggerUnknownOutcome(
  db: PrismaLike,
  notificationId: string,
  channel: AlertDeliveryChannel,
  claim: TriggerDeliveryClaim,
  now: Date,
  attempts: number
): Promise<void> {
  const persistedAt = noEarlierThan(now, claim.claimedAt);
  const persisted = await db.providerAlertChannelDelivery.updateMany({
    where: {
      notificationId,
      channelKey: channelKey(channel),
      triggerClaimToken: claim.token,
      triggerClaimGeneration: claim.generation,
      triggerIncidentGeneration: claim.incidentGeneration,
      triggerOperationClaimGeneration: claim.operationGeneration,
      notification: {
        is: {
          resolvedAt: null,
          incidentGeneration: claim.incidentGeneration,
          operationClaimToken: claim.operationToken,
          operationClaimGeneration: claim.operationGeneration,
          operationClaimIncidentGeneration: claim.incidentGeneration,
          operationClaimConfigGeneration: claim.configGeneration,
          operationClaimEvidenceSourceAt:
            claim.targetEvidence.sourceAt,
          operationClaimEvidenceAt: claim.targetEvidence.at,
          operationClaimEvidenceState: claim.targetEvidence.state,
          operationClaimExpiresAt: { gt: persistedAt },
          ...exactNotificationVersionWhere(claim.notificationVersion),
          provider: {
            is: { alertConfigGeneration: claim.configGeneration },
          },
        },
      },
    },
    data: {
      channelKind: channel.kind,
      lastAttemptAt: persistedAt,
      attemptCount: { increment: attempts },
      lastError: TRIGGER_OUTCOME_UNKNOWN_MARKER,
    },
  });
  if (persisted.count !== 1) throw new TriggerDeliveryClaimLostError();
}

async function claimResolveDelivery(
  db: PrismaLike,
  notificationId: string,
  channel: Extract<AlertDeliveryChannel, { kind: "pagerduty" }>,
  incidentGeneration: number,
  expectedClaimGeneration: number,
  exactPagerDutyDedupKey: string,
  operationClaim: NotificationOperationClaim,
  claimLeaseDurationMs: number,
  clock: () => Date
): Promise<ResolveDeliveryClaim | null> {
  const key = channelKey(channel);
  await db.providerAlertChannelDelivery.upsert({
    where: {
      notificationId_channelKey: { notificationId, channelKey: key },
    },
    create: {
      notificationId,
      channelKey: key,
      channelKind: channel.kind,
    },
    update: { channelKind: channel.kind },
  });

  const claimedAt = clock();
  const claimToken = randomUUID();
  const claimed = await db.providerAlertChannelDelivery.updateMany({
    where: {
      notificationId,
      channelKey: key,
      resolveClaimGeneration: expectedClaimGeneration,
      notification: {
        is: {
          resolvedAt: null,
          incidentGeneration,
          operationClaimToken: operationClaim.token,
          operationClaimGeneration: operationClaim.generation,
          operationClaimIncidentGeneration: incidentGeneration,
          operationClaimConfigGeneration: operationClaim.configGeneration,
          operationClaimEvidenceSourceAt:
            operationClaim.targetEvidence.sourceAt,
          operationClaimEvidenceAt: operationClaim.targetEvidence.at,
          operationClaimEvidenceState: operationClaim.targetEvidence.state,
          operationClaimExpiresAt: { gt: claimedAt },
          ...exactNotificationVersionWhere(operationClaim.notificationVersion),
          provider: {
            is: {
              alertConfigGeneration: operationClaim.configGeneration,
            },
          },
        },
      },
      AND: [
        {
          OR: [
            { resolveClaimToken: null },
            { resolveClaimExpiresAt: { lte: claimedAt } },
            { resolveIncidentGeneration: { not: incidentGeneration } },
            {
              resolveOperationClaimGeneration: {
                not: operationClaim.generation,
              },
            },
          ],
        },
        {
          OR: [
            { triggerClaimToken: null },
            { triggerClaimExpiresAt: { lte: claimedAt } },
            { triggerIncidentGeneration: { not: incidentGeneration } },
            {
              triggerOperationClaimGeneration: {
                not: operationClaim.generation,
              },
            },
          ],
        },
      ],
    },
    data: {
      resolveClaimToken: claimToken,
      resolveClaimGeneration: { increment: 1 },
      resolveClaimExpiresAt: new Date(claimedAt.getTime() + claimLeaseDurationMs),
      resolveIncidentGeneration: incidentGeneration,
      resolveOperationClaimGeneration: operationClaim.generation,
      lastResolveAttemptAt: claimedAt,
      lastResolveError: RESOLVE_OUTCOME_UNKNOWN_MARKER,
      pagerDutyDedupKey: exactPagerDutyDedupKey,
      triggerClaimToken: null,
      triggerClaimGeneration: { increment: 1 },
      triggerClaimExpiresAt: null,
      triggerOperationClaimGeneration: null,
    },
  });
  if (claimed.count !== 1) return null;

  const row = await db.providerAlertChannelDelivery.findUnique({
    where: {
      notificationId_channelKey: { notificationId, channelKey: key },
    },
    select: {
      resolveClaimToken: true,
      resolveClaimGeneration: true,
      resolveIncidentGeneration: true,
      resolveOperationClaimGeneration: true,
      pagerDutyDedupKey: true,
    },
  });
  if (
    !row ||
    row.resolveClaimToken !== claimToken ||
    row.resolveIncidentGeneration !== incidentGeneration ||
    row.resolveOperationClaimGeneration !== operationClaim.generation ||
    row.pagerDutyDedupKey !== exactPagerDutyDedupKey
  ) {
    throw new TriggerDeliveryClaimLostError();
  }
  return {
    token: claimToken,
    generation: row.resolveClaimGeneration,
    incidentGeneration,
    claimedAt,
    pagerDutyDedupKey: exactPagerDutyDedupKey,
    operationToken: operationClaim.token,
    operationGeneration: operationClaim.generation,
    configGeneration: operationClaim.configGeneration,
    targetEvidence: operationClaim.targetEvidence,
    notificationVersion: operationClaim.notificationVersion,
  };
}

async function recordResolveOutcome(
  db: PrismaLike,
  notificationId: string,
  channel: Extract<AlertDeliveryChannel, { kind: "pagerduty" }>,
  claim: ResolveDeliveryClaim,
  now: Date,
  attempts: number,
  error: string | null
): Promise<void> {
  const key = channelKey(channel);
  const persistedAt = noEarlierThan(now, claim.claimedAt);
  const persisted = await db.providerAlertChannelDelivery.updateMany({
    where: {
      notificationId,
      channelKey: key,
      resolveClaimToken: claim.token,
      resolveClaimGeneration: claim.generation,
      resolveIncidentGeneration: claim.incidentGeneration,
      resolveOperationClaimGeneration: claim.operationGeneration,
      notification: {
        is: {
          resolvedAt: null,
          incidentGeneration: claim.incidentGeneration,
          operationClaimToken: claim.operationToken,
          operationClaimGeneration: claim.operationGeneration,
          operationClaimIncidentGeneration: claim.incidentGeneration,
          operationClaimConfigGeneration: claim.configGeneration,
          operationClaimEvidenceSourceAt:
            claim.targetEvidence.sourceAt,
          operationClaimEvidenceAt: claim.targetEvidence.at,
          operationClaimEvidenceState: claim.targetEvidence.state,
          operationClaimExpiresAt: { gt: persistedAt },
          ...exactNotificationVersionWhere(claim.notificationVersion),
          provider: {
            is: { alertConfigGeneration: claim.configGeneration },
          },
        },
      },
    },
    data: {
      channelKind: channel.kind,
      lastResolveAttemptAt: persistedAt,
      ...(error
        ? { resolveClaimToken: null, resolveClaimExpiresAt: null }
        : {}),
      resolveAttemptCount: { increment: attempts },
      ...(error
        ? { lastResolveError: error }
        : {
            lastResolvedAt: persistedAt,
            lastResolvedIncidentGeneration: claim.incidentGeneration,
            lastResolveError: null,
            lastError: null,
          }),
    },
  });
  if (persisted.count !== 1) throw new TriggerDeliveryClaimLostError();
}

async function claimActiveProviderAlertNotification(
  db: PrismaLike,
  provider: {
    id: string;
    name: string;
    displayName: string;
    alertConfigGeneration: number;
  },
  alert: ProviderAlert,
  now: Date,
  evidence: AlertEvidence,
  claimLeaseDurationMs: number,
  clock: () => Date
): Promise<ActiveNotificationClaimResult> {
  const key = stateKey(provider.id, alert);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const existing = await db.providerAlertNotification.findUnique({
      where: { stateKey: key },
      select: {
        id: true,
        resolvedAt: true,
        incidentGeneration: true,
        firstDetectedAt: true,
        lastDetectedAt: true,
        evidenceConfigGeneration: true,
        evidenceSourceAt: true,
        evidenceWatermarkAt: true,
        evidenceWatermarkState: true,
        severity: true,
        message: true,
        operationClaimToken: true,
        operationClaimGeneration: true,
        operationClaimExpiresAt: true,
        operationClaimIncidentGeneration: true,
        operationClaimConfigGeneration: true,
        operationClaimEvidenceSourceAt: true,
        operationClaimEvidenceAt: true,
        operationClaimEvidenceState: true,
      },
    });

    const evidenceComparison = existing
      ? compareEvidence(existing, evidence)
      : 0;
    if (existing && evidenceComparison > 0) {
      return { status: "stale" };
    }
    const claimedAt = clock();
    if (
      existing &&
      evidenceComparison === 0 &&
      latestDate(now, claimedAt) < existing.lastDetectedAt
    ) {
      return { status: "stale" };
    }
    const expiresAt = new Date(claimedAt.getTime() + claimLeaseDurationMs);
    const claimToken = randomUUID();

    if (!existing) {
      try {
        const currentProvider = await db.provider.findUnique({
          where: { id: provider.id },
          select: { alertConfigGeneration: true },
        });
        if (
          currentProvider?.alertConfigGeneration !== evidence.configGeneration
        ) {
          return { status: "stale" };
        }
        const detectedAt = latestDate(now, claimedAt, evidence.sourceAt, evidence.at);
        const created = await db.providerAlertNotification.create({
          data: {
            providerId: provider.id,
            stateKey: key,
            alertCode: alert.code,
            severity: alert.severity,
            providerName: provider.name,
            providerDisplayName: provider.displayName,
            message: alert.message,
            firstDetectedAt: detectedAt,
            lastDetectedAt: detectedAt,
            incidentGeneration: 1,
            evidenceConfigGeneration: evidence.configGeneration,
            evidenceSourceAt: evidence.sourceAt,
            evidenceWatermarkAt: evidence.at,
            evidenceWatermarkState: "active",
            pagerDutyAuditState: "generation_scoped",
            operationClaimToken: claimToken,
            operationClaimGeneration: 1,
            operationClaimExpiresAt: expiresAt,
            operationClaimIncidentGeneration: 1,
            operationClaimConfigGeneration: evidence.configGeneration,
            operationClaimEvidenceSourceAt: evidence.sourceAt,
            operationClaimEvidenceAt: evidence.at,
            operationClaimEvidenceState: evidence.state,
          },
        });
        const stillCurrent = await db.provider.findUnique({
          where: { id: provider.id },
          select: { alertConfigGeneration: true },
        });
        const claim: NotificationOperationClaim = {
          token: claimToken,
          generation: created.operationClaimGeneration,
          incidentGeneration: created.incidentGeneration,
          claimedAt,
          expiresAt,
          configGeneration: evidence.configGeneration,
          targetEvidence: evidence,
          notificationVersion: notificationVersionOf(created),
        };
        if (
          stillCurrent?.alertConfigGeneration !== evidence.configGeneration
        ) {
          await releaseNotificationOperation(db, created.id, claim);
          return { status: "stale" };
        }
        return { status: "claimed", notification: created, claim };
      } catch (error) {
        if (isPrismaUniqueConstraint(error)) continue;
        throw error;
      }
    }

    const liveTarget = liveOperationTarget(existing, claimedAt);
    const liveDisposition = compareCandidateToLiveTarget(liveTarget, evidence);
    if (liveDisposition === "stale") return { status: "stale" };
    if (liveDisposition === "busy") return { status: "busy" };

    const reopenedIncidentGeneration = existing.resolvedAt
      ? existing.incidentGeneration + 1
      : existing.incidentGeneration;
    const detectedAt = latestDate(
      now,
      claimedAt,
      evidence.sourceAt,
      evidence.at,
      existing.lastDetectedAt,
      ...(existing.resolvedAt ? [existing.resolvedAt] : [])
    );
    const claimed = await db.providerAlertNotification.updateMany({
      where: {
        id: existing.id,
        incidentGeneration: existing.incidentGeneration,
        resolvedAt: existing.resolvedAt,
        operationClaimGeneration: existing.operationClaimGeneration,
        provider: {
          is: { alertConfigGeneration: evidence.configGeneration },
        },
        ...exactNotificationVersionWhere(existing),
        AND: [
          ...(liveDisposition === "preempt"
            ? [
                {
                  operationClaimToken: existing.operationClaimToken,
                  operationClaimExpiresAt:
                    existing.operationClaimExpiresAt,
                  operationClaimIncidentGeneration:
                    existing.operationClaimIncidentGeneration,
                  operationClaimConfigGeneration:
                    existing.operationClaimConfigGeneration,
                  operationClaimEvidenceSourceAt:
                    existing.operationClaimEvidenceSourceAt,
                  operationClaimEvidenceAt:
                    existing.operationClaimEvidenceAt,
                  operationClaimEvidenceState:
                    existing.operationClaimEvidenceState,
                  channelDeliveries: {
                    none: {
                      OR: [
                        {
                          triggerClaimToken: { not: null },
                          triggerClaimExpiresAt: { gt: claimedAt },
                          triggerOperationClaimGeneration:
                            existing.operationClaimGeneration,
                        },
                        {
                          resolveClaimToken: { not: null },
                          resolveClaimExpiresAt: { gt: claimedAt },
                          resolveOperationClaimGeneration:
                            existing.operationClaimGeneration,
                        },
                      ],
                    },
                  },
                },
              ]
            : [
                {
                  OR: [
                    { operationClaimToken: null },
                    { operationClaimExpiresAt: { lte: claimedAt } },
                    {
                      operationClaimIncidentGeneration: {
                        not: existing.incidentGeneration,
                      },
                    },
                  ],
                },
              ]),
        ],
      },
      data: {
        severity: alert.severity,
        providerName: provider.name,
        providerDisplayName: provider.displayName,
        message: alert.message,
        ...(existing.resolvedAt ? { firstDetectedAt: detectedAt } : {}),
        lastDetectedAt: detectedAt,
        resolvedAt: null,
        ...(existing.resolvedAt
          ? { incidentGeneration: { increment: 1 } }
          : {}),
        evidenceConfigGeneration: evidence.configGeneration,
        evidenceSourceAt: evidence.sourceAt,
        evidenceWatermarkAt: evidence.at,
        evidenceWatermarkState: "active",
        pagerDutyAuditState: "generation_scoped",
        operationClaimToken: claimToken,
        operationClaimGeneration: { increment: 1 },
        operationClaimExpiresAt: expiresAt,
        operationClaimIncidentGeneration: reopenedIncidentGeneration,
        operationClaimConfigGeneration: evidence.configGeneration,
        operationClaimEvidenceSourceAt: evidence.sourceAt,
        operationClaimEvidenceAt: evidence.at,
        operationClaimEvidenceState: evidence.state,
      },
    });
    if (claimed.count === 0) {
      if (liveDisposition === "preempt") {
        const liveChildClaim = await db.providerAlertChannelDelivery.findFirst({
          where: {
            notificationId: existing.id,
            OR: [
              {
                triggerClaimToken: { not: null },
                triggerClaimExpiresAt: { gt: claimedAt },
                triggerOperationClaimGeneration:
                  existing.operationClaimGeneration,
              },
              {
                resolveClaimToken: { not: null },
                resolveClaimExpiresAt: { gt: claimedAt },
                resolveOperationClaimGeneration:
                  existing.operationClaimGeneration,
              },
            ],
          },
          select: { id: true },
        });
        if (liveChildClaim) return { status: "busy" };
      }
      const currentProvider = await db.provider.findUnique({
        where: { id: provider.id },
        select: { alertConfigGeneration: true },
      });
      if (
        currentProvider?.alertConfigGeneration !== evidence.configGeneration
      ) {
        return { status: "stale" };
      }
      continue;
    }

    const activated = await db.providerAlertNotification.findUniqueOrThrow({
      where: { id: existing.id },
      include: {
        provider: { select: { alertConfigGeneration: true } },
      },
    });
    const ownsClaim =
      activated.resolvedAt === null &&
      activated.incidentGeneration === reopenedIncidentGeneration &&
      activated.operationClaimToken === claimToken &&
      activated.operationClaimIncidentGeneration ===
        reopenedIncidentGeneration &&
      activated.operationClaimConfigGeneration === evidence.configGeneration &&
      activated.operationClaimEvidenceSourceAt?.getTime() ===
        evidence.sourceAt.getTime() &&
      activated.operationClaimEvidenceAt?.getTime() === evidence.at.getTime() &&
      activated.operationClaimEvidenceState === evidence.state &&
      activated.provider.alertConfigGeneration === evidence.configGeneration &&
      compareEvidence(activated, evidence) === 0 &&
      activated.severity === alert.severity &&
      activated.message === alert.message;
    const acquiredClaim: NotificationOperationClaim = {
      token: claimToken,
      generation: activated.operationClaimGeneration,
      incidentGeneration: activated.incidentGeneration,
      claimedAt,
      expiresAt,
      configGeneration: evidence.configGeneration,
      targetEvidence: evidence,
      notificationVersion: notificationVersionOf(activated),
    };
    if (ownsClaim) {
      return {
        status: "claimed",
        notification: activated,
        claim: acquiredClaim,
      };
    }
    if (
      activated.operationClaimToken === claimToken &&
      activated.operationClaimIncidentGeneration ===
        activated.incidentGeneration &&
      activated.operationClaimConfigGeneration === evidence.configGeneration
    ) {
      await releaseNotificationOperation(db, activated.id, acquiredClaim);
    }
    if (activated.provider.alertConfigGeneration !== evidence.configGeneration) {
      return { status: "stale" };
    }
    return compareEvidence(activated, evidence) > 0
      ? { status: "stale" }
      : { status: "busy" };
  }
  throw new Error(`Alert incident ${key} changed too often to activate safely`);
}

function generationMatches(
  persistedGeneration: number | null,
  incidentGeneration: number
): boolean {
  return (
    persistedGeneration === incidentGeneration ||
    (persistedGeneration === null && incidentGeneration === 1)
  );
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
  clock?: () => Date;
} = {}): Promise<AlertDeliveryResult> {
  const now = options.now ?? new Date();
  const config = options.config ?? readAlertDeliveryConfig();
  const rawDb = options.db ?? prisma;
  const db = options.db ? rawDb : withAlertPersistenceAdmission(rawDb);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  const clock =
    options.clock ??
    (options.now ? () => new Date(options.now!.getTime()) : () => new Date());
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
  const claimLeaseDurationMs = triggerClaimLeaseMs(settings);
  // The env reader emits one destination of each kind, but injected test/config
  // objects may repeat a destination. De-duplicate by the same persistent key so
  // one maintenance pass never sends it twice.
  const channels = suppressEmailWhenPushoverConfigured(
    [...new Map(config.channels.map((channel) => [channelKey(channel), channel])).values()]
  );
  const pagerDutyChannels = channels.filter(
    (channel): channel is Extract<AlertDeliveryChannel, { kind: "pagerduty" }> =>
      channel.kind === "pagerduty"
  );
  const operationClaimLeaseDurationMs =
    claimLeaseDurationMs * Math.max(1, channels.length) + 30_000;
  const result: AlertDeliveryResult = {
    evaluatedProviders: 0,
    activeAlerts: 0,
    sent: 0,
    resolved: 0,
    skipped: 0,
    errors: [],
    persistenceDegraded: [],
  };
  let deferredSummaryTimeout: Error | null = null;

  const providers = await db.provider.findMany({
    where: {
      OR: [
        { isActive: true },
        { alertNotifications: { some: { resolvedAt: null } } },
      ],
    },
    orderBy: { name: "asc" },
    select: ALERT_EVALUATION_PROVIDER_SELECT,
  });

  // --- S1: project budget/anomaly alert evaluation (production path only) ---
  // Injected test DBs skip this entirely (same precedent as computeBudgetStatus
  // above); the real-DB test suite exercises it end to end.
  let projectAlertsProvider: AlertEvaluationProvider | null = null;
  let projectAlerts: ProviderAlert[] = [];
  // False when evaluation was skipped legitimately (feature disabled or zero
  // projects — both yield an intentionally empty alert set so previously-open
  // project incidents resolve) OR when it FAILED (then the project-budgets
  // provider is excluded from targets so open incidents are preserved, not
  // falsely resolved by a transient error).
  let projectAlertsEvaluated = false;
  if (!options.db) {
    let existingProjectProvider = await db.provider.findFirst({
      where: { name: PROJECT_ALERTS_PROVIDER_NAME },
      select: ALERT_EVALUATION_PROVIDER_SELECT,
    });
    // Never an operator connection / poll target — self-heal if someone toggled it on.
    if (existingProjectProvider?.isActive) {
      existingProjectProvider = await db.provider.update({
        where: { id: existingProjectProvider.id },
        data: {
          isActive: false,
          refreshIntervalMin: Math.max(
            existingProjectProvider.refreshIntervalMin ?? 0,
            1440
          ),
          alertConfigGeneration: { increment: 1 },
        },
        select: ALERT_EVALUATION_PROVIDER_SELECT,
      });
    }
    if (!readBoolEnvValue(process.env, "ALERT_PROJECT_BUDGETS_ENABLED", true)) {
      // Disabled: evaluate as empty so any previously-open incidents resolve.
      projectAlertsProvider = existingProjectProvider;
      projectAlertsEvaluated = true;
    } else {
      const projects = await prisma.project.findMany({
        select: { id: true, name: true, monthlyBudgetUsd: true },
      });
      if (projects.length === 0) {
        // No projects configured: nothing to alert on (and unassigned spend is
        // meaningless — ALL spend is unassigned by definition). Resolve any
        // stale incidents from a since-deleted project setup.
        projectAlertsProvider = existingProjectProvider;
        projectAlertsEvaluated = true;
      } else {
        projectAlertsProvider =
          existingProjectProvider ??
          (await db.provider.create({
            data: {
              name: PROJECT_ALERTS_PROVIDER_NAME,
              displayName: PROJECT_ALERTS_PROVIDER_DISPLAY_NAME,
              type: "builtin",
              // Never a poll target; it exists only to carry project incidents.
              isActive: false,
              refreshIntervalMin: 1440,
            },
            select: ALERT_EVALUATION_PROVIDER_SELECT,
          }));
        try {
          const anomalyConfig = resolveAnomalyConfig();
          const [projectStatus, anomaliesByProjectId, openProjectAlerts] =
            await Promise.all([
              computeProjectBudgetStatus(now),
              loadSpendAnomaliesByProjectId(now, anomalyConfig, projects),
              db.providerAlertNotification.findMany({
                where: {
                  providerId: projectAlertsProvider.id,
                  resolvedAt: null,
                  alertCode: { in: ["project_budget_exceeded", "project_budget_warning"] },
                },
                select: { alertCode: true, stateKey: true },
              }),
            ]);
          // Per-project prior tier for budget hysteresis (C9 semantics).
          const previousTierByProjectId = new Map<string, BudgetAlertTier>();
          for (const row of openProjectAlerts) {
            const scope = notificationAlertScope({
              providerId: projectAlertsProvider.id,
              alertCode: row.alertCode,
              stateKey: row.stateKey,
            });
            if (!scope) continue;
            const tier: BudgetAlertTier =
              row.alertCode === "project_budget_exceeded" ? "exceeded" : "warning";
            if (previousTierByProjectId.get(scope) !== "exceeded") {
              previousTierByProjectId.set(scope, tier);
            }
          }
          projectAlerts = buildProjectBudgetAlerts({
            projects: projectStatus.projects,
            previousTierByProjectId,
            anomaliesByProjectId,
            unassignedSpentUsd: projectStatus.summary.unassignedSpentUsd,
            unassignedSpentFloorUsd: boundedNonNegativeNumber(
              appSettings.get("ALERT_UNASSIGNED_SPEND_FLOOR_USD"),
              DEFAULT_UNASSIGNED_SPEND_FLOOR_USD,
              MAX_UNASSIGNED_SPEND_FLOOR_USD
            ),
          });
          projectAlertsEvaluated = true;
        } catch (error) {
          // Transient status/anomaly failure: keep open incidents untouched by
          // excluding the project-budgets provider from this pass entirely.
          console.warn(
            "[alert-delivery] project alert evaluation failed; preserving existing project incidents this pass",
            error
          );
          projectAlerts = [];
          projectAlertsEvaluated = false;
        }
      }
    }
  }

  // --- S14: subscription & billing insight alerts (production path only) ---
  let subscriptionInsightAlerts = new Map<string, ProviderAlert[]>();
  if (
    !options.db &&
    readBoolEnvValue(process.env, "ALERT_SUBSCRIPTION_INSIGHTS_ENABLED", true)
  ) {
    try {
      subscriptionInsightAlerts = await loadSubscriptionInsightAlerts(now);
    } catch (error) {
      console.warn(
        "[alert-delivery] subscription insight evaluation failed; skipping insight alerts this pass",
        error
      );
    }
  }

  // Alert targets: the evaluated providers, plus the project-budgets system
  // provider when it has alerts to deliver. When project evaluation failed,
  // the system provider is EXCLUDED so its open incidents survive the pass.
  const alertTargets: AlertEvaluationProvider[] = [];
  for (const provider of providers) {
    if (
      projectAlertsProvider &&
      provider.id === projectAlertsProvider.id &&
      !projectAlertsEvaluated
    ) {
      continue;
    }
    alertTargets.push(provider);
  }
  if (
    projectAlertsEvaluated &&
    projectAlertsProvider &&
    projectAlerts.length > 0 &&
    !alertTargets.some((provider) => provider.id === projectAlertsProvider!.id)
  ) {
    alertTargets.push(projectAlertsProvider);
  }

  // Production delivery uses the same canonical poll+pushed+subscription
  // computation as /api/budget-status. Tests/callers that inject a partial DB
  // retain the legacy snapshot-only path because that DB may not expose the
  // external-event tables required by computeBudgetStatus.
  const canonicalByProviderId = options.db
    ? new Map<string, Awaited<ReturnType<typeof computeBudgetStatus>>["providers"][number]>()
    : new Map(
        (await computeBudgetStatus(now)).providers.map((status) => [status.id, status])
      );

  result.evaluatedProviders = alertTargets.length;

  for (const provider of alertTargets) {
    const isProjectAlertsTarget =
      projectAlertsEvaluated &&
      projectAlertsProvider != null &&
      provider.id === projectAlertsProvider.id;
    let rawAlerts: ProviderAlert[];
    if (isProjectAlertsTarget) {
      // S1: the project-budgets system provider carries the precomputed
      // per-project alerts (budget tiers with hysteresis, spend anomalies,
      // unassigned-spend info) — nothing provider-level applies to it.
      rawAlerts = projectAlerts;
    } else {
    // Budget hysteresis needs the prior open tier before we re-evaluate (C9).
    const openBudgetCodes = await db.providerAlertNotification.findMany({
      where: {
        providerId: provider.id,
        resolvedAt: null,
        alertCode: { in: ["budget_exceeded", "budget_warning"] },
      },
      select: { alertCode: true },
    });
    const previousBudgetTier =
      openBudgetCodes.some((row) => row.alertCode === "budget_exceeded")
        ? ("exceeded" as const)
        : openBudgetCodes.some((row) => row.alertCode === "budget_warning")
          ? ("warning" as const)
          : ("ok" as const);

    const alertState = buildProviderAlertState(
      {
        isActive: provider.isActive,
        refreshIntervalMin: provider.refreshIntervalMin,
        snapshotExpected: providerPollSnapshotExpected(provider),
        plan: provider.plan,
        latestSnapshot: provider.snapshots[0] ?? null,
        reconciliationDiscrepancyUsd: provider.usageReconciliations?.[0]?.status === "discrepancy" ? provider.usageReconciliations[0].deltaUsd : null,
        previousBudgetTier,
      },
      now
    );
    const canonical = canonicalByProviderId.get(provider.id);
    if (canonical && provider.isActive) {
      // Prefer canonical money alerts, but re-derive budget_exceeded/warning
      // with hysteresis against any open tier so boundary noise does not flap
      // delivery (Wave C / C9).
      const nonBudgetAlerts = alertState.alerts.filter(
        (alert) =>
          alert.code !== "budget_exceeded" &&
          alert.code !== "budget_warning" &&
          alert.code !== "usage_reconciliation_discrepancy"
      );
      const nonBudgetCanonical = canonical.alerts.filter(
        (alert) =>
          alert.code !== "budget_exceeded" && alert.code !== "budget_warning"
      );
      const hystereticBudget = buildProviderAlertState(
        {
          isActive: true,
          refreshIntervalMin: provider.refreshIntervalMin,
          snapshotExpected: false,
          plan: provider.plan
            ? {
                ...provider.plan,
                monthlyBudgetUsd: canonical.monthlyBudgetUsd,
              }
            : canonical.monthlyBudgetUsd != null
              ? {
                  billingMode: "actual",
                  fixedMonthlyCostUsd: null,
                  monthlyBudgetUsd: canonical.monthlyBudgetUsd,
                  monthlyRequestLimit: null,
                  lowBalanceUsd: null,
                  lowCredits: null,
                  renewalDate: null,
                  mustKeepFunded: false,
                }
              : null,
          latestSnapshot: null,
          trackedSpendUsd: canonical.spentUsd,
          previousBudgetTier: previousBudgetTier,
        },
        now
      ).alerts.filter(
        (alert) =>
          alert.code === "budget_exceeded" || alert.code === "budget_warning"
      );
      alertState.alerts = [
        ...nonBudgetAlerts,
        ...nonBudgetCanonical,
        ...hystereticBudget,
      ];
    }
    rawAlerts = [
      ...alertState.alerts,
      // S14: subscription & billing insights for this provider (info severity).
      ...(subscriptionInsightAlerts.get(provider.id) ?? []),
    ];
    }
    // S12: per-code severity overrides apply to BOTH the persisted incident
    // and delivery eligibility so the incident, its text, and policy agree.
    const effectiveAlerts = config.severityOverrides
      ? rawAlerts.map((alert) => {
          const override = config.severityOverrides?.[alert.code];
          return override && override !== alert.severity
            ? { ...alert, severity: override }
            : alert;
        })
      : rawAlerts;
    const deliverableAlerts = effectiveAlerts.filter((alert) =>
      shouldDeliverSeverity(alert.severity, config.minSeverity)
    );
    result.activeAlerts += effectiveAlerts.length;

    // Severity policy controls external delivery eligibility, not whether the
    // underlying condition remains active. Otherwise raising the policy would
    // falsely resolve already-open warning incidents.
    const activeKeys = new Set(effectiveAlerts.map((alert) => stateKey(provider.id, alert)));
    const openNotifications = await db.providerAlertNotification.findMany({
      where: { providerId: provider.id, resolvedAt: null },
      select: {
        id: true,
        stateKey: true,
        alertCode: true,
        severity: true,
        message: true,
        firstDetectedAt: true,
        lastDetectedAt: true,
        incidentGeneration: true,
        pagerDutyAuditState: true,
        operationClaimGeneration: true,
        operationClaimToken: true,
        operationClaimExpiresAt: true,
        operationClaimIncidentGeneration: true,
        operationClaimConfigGeneration: true,
        operationClaimEvidenceSourceAt: true,
        operationClaimEvidenceAt: true,
        operationClaimEvidenceState: true,
        evidenceConfigGeneration: true,
        evidenceSourceAt: true,
        evidenceWatermarkAt: true,
        evidenceWatermarkState: true,
      },
    });
    for (const notification of openNotifications) {
      if (activeKeys.has(notification.stateKey)) continue;

      const resolutionEvidence = alertEvidence(
        provider,
        notification.alertCode as ProviderAlert["code"],
        now,
        "clear"
      );

      const operationClaim = await claimNotificationOperation(
        db,
        notification,
        resolutionEvidence,
        operationClaimLeaseDurationMs,
        clock
      );
      if (!operationClaim) {
        result.errors.push({
          providerId: provider.id,
          alertCode: notification.alertCode,
          channel: "incident",
          error:
            compareEvidence(notification, resolutionEvidence) > 0
              ? STALE_ALERT_EVIDENCE_MESSAGE
              : NOTIFICATION_OPERATION_IN_PROGRESS_MESSAGE,
        });
        continue;
      }
      let operationClosed = false;
      try {

      const pagerDutyStates = await db.providerAlertChannelDelivery.findMany({
        where: {
          notificationId: notification.id,
          channelKind: "pagerduty",
        },
        select: {
          channelKey: true,
          lastAttemptAt: true,
          lastSucceededAt: true,
          lastSucceededIncidentGeneration: true,
          lastResolvedAt: true,
          lastResolvedIncidentGeneration: true,
          lastError: true,
          triggerClaimToken: true,
          triggerClaimExpiresAt: true,
          triggerIncidentGeneration: true,
          triggerOperationClaimGeneration: true,
          resolveClaimToken: true,
          resolveClaimGeneration: true,
          resolveClaimExpiresAt: true,
          resolveIncidentGeneration: true,
          resolveOperationClaimGeneration: true,
          pagerDutyDedupKey: true,
        },
      });
      const legacyAuditPending =
        notification.pagerDutyAuditState === "legacy_unknown";
      const resolvedForIncident = (state: (typeof pagerDutyStates)[number]) =>
        generationMatches(
          state.lastResolvedIncidentGeneration,
          notification.incidentGeneration
        ) &&
        state.lastResolvedAt !== null &&
        state.lastResolvedAt >= notification.firstDetectedAt;
      const relevantTriggerStates = pagerDutyStates.filter(
        (state) =>
          !resolvedForIncident(state) &&
          (legacyAuditPending ||
            ((generationMatches(
              state.triggerIncidentGeneration,
              notification.incidentGeneration
            ) ||
              generationMatches(
                state.lastSucceededIncidentGeneration,
                notification.incidentGeneration
              )) &&
              ((state.lastSucceededAt !== null &&
                state.lastSucceededAt >= notification.firstDetectedAt) ||
                state.lastError === TRIGGER_OUTCOME_UNKNOWN_MARKER ||
                state.triggerClaimToken !== null)))
      );
      const pagerDutyTriggerInProgress = relevantTriggerStates.some(
        (state) =>
          state.triggerClaimToken !== null &&
          state.triggerClaimExpiresAt !== null &&
          state.triggerClaimExpiresAt > now &&
          state.triggerOperationClaimGeneration === operationClaim.generation &&
          generationMatches(
            state.triggerIncidentGeneration,
            notification.incidentGeneration
          )
      );
      if (pagerDutyTriggerInProgress) {
        // Never allow an older resolve to overtake an accepted trigger whose
        // outcome has not yet crossed the durable boundary.
        result.errors.push({
          providerId: provider.id,
          alertCode: notification.alertCode,
          channel: "pagerduty",
          error: PAGERDUTY_TRIGGER_IN_PROGRESS_RESOLVE_MESSAGE,
        });
        continue;
      }

      const configuredPagerDutyKeys = new Set(
        pagerDutyChannels.map((channel) => channelKey(channel))
      );
      const originalPagerDutyDestinationMissing = relevantTriggerStates.some(
        (state) => !configuredPagerDutyKeys.has(state.channelKey)
      );
      if (originalPagerDutyDestinationMissing) {
        result.errors.push({
          providerId: provider.id,
          alertCode: notification.alertCode,
          channel: "pagerduty",
          error:
            "PagerDuty resolve pending because the original routing key is not configured",
        });
        continue;
      }
      if (legacyAuditPending && pagerDutyChannels.length === 0) {
        // Pre-generation rows could have crossed PagerDuty's boundary before a
        // channel-state write failed. Keep the local incident open until an
        // operator supplies a routing key for one idempotent legacy-key audit.
        result.errors.push({
          providerId: provider.id,
          alertCode: notification.alertCode,
          channel: "pagerduty",
          error: PAGERDUTY_LEGACY_AUDIT_PENDING_MESSAGE,
        });
        continue;
      }

      const channelsToResolve = pagerDutyChannels.filter((channel) => {
        if (legacyAuditPending) return true;
        const state = pagerDutyStates.find(
          (entry) => entry.channelKey === channelKey(channel)
        );
        return Boolean(state && relevantTriggerStates.includes(state));
      });
      const resolvedAlert: ProviderAlert = {
        code: notification.alertCode as ProviderAlert["code"],
        severity: normalizeSeverity(notification.severity) ?? "warning",
        message: notification.message,
      };
      let allPagerDutyResolvesSent = true;
      for (const channel of channelsToResolve) {
        const key = channelKey(channel);
        const state = pagerDutyStates.find((entry) => entry.channelKey === key);
        if (state && resolvedForIncident(state)) continue;
        if (
          state?.resolveClaimToken &&
          state.resolveClaimExpiresAt &&
          state.resolveClaimExpiresAt > now &&
          state.resolveOperationClaimGeneration === operationClaim.generation &&
          generationMatches(
            state.resolveIncidentGeneration,
            notification.incidentGeneration
          )
        ) {
          allPagerDutyResolvesSent = false;
          result.errors.push({
            providerId: provider.id,
            alertCode: notification.alertCode,
            channel: channel.kind,
            error: PAGERDUTY_RESOLVE_IN_PROGRESS_MESSAGE,
          });
          continue;
        }

        const exactDedupKey = legacyAuditPending
          ? pagerDutyDedupKey(
              provider.id,
              notification.alertCode,
              notification.incidentGeneration,
              "legacy_unknown",
              notificationAlertScope({
                providerId: provider.id,
                alertCode: notification.alertCode,
                stateKey: notification.stateKey,
              })
            )
          : state?.pagerDutyDedupKey ??
            pagerDutyDedupKey(
              provider.id,
              notification.alertCode,
              notification.incidentGeneration,
              notification.pagerDutyAuditState,
              notificationAlertScope({
                providerId: provider.id,
                alertCode: notification.alertCode,
                stateKey: notification.stateKey,
              })
            );
        const claim = await claimResolveDelivery(
          db,
          notification.id,
          channel,
          notification.incidentGeneration,
          state?.resolveClaimGeneration ?? 0,
          exactDedupKey,
          operationClaim,
          claimLeaseDurationMs,
          clock
        );
        if (!claim) {
          allPagerDutyResolvesSent = false;
          result.errors.push({
            providerId: provider.id,
            alertCode: notification.alertCode,
            channel: channel.kind,
            error: PAGERDUTY_RESOLVE_IN_PROGRESS_MESSAGE,
          });
          continue;
        }

        let attempts: number;
        try {
          attempts = await sendToChannel(
            channel,
            provider,
            resolvedAlert,
            now,
            fetchImpl,
            settings,
            sleepImpl,
            "resolve",
            claim.pagerDutyDedupKey
          );
        } catch (error) {
          allPagerDutyResolvesSent = false;
          const failure = failureDetails(error);
          const outcomeAt = noEarlierThan(now, clock());
          try {
            await recordResolveOutcome(
              db,
              notification.id,
              channel,
              claim,
              outcomeAt,
              failure.attempts,
              failure.message
            );
          } catch (persistenceError) {
            if (
              !isPrismaModelTimeout(
                persistenceError,
                "ProviderAlertChannelDelivery"
              )
            ) {
              throw persistenceError;
            }
            noteChannelPersistenceDegradation(
              result,
              {
                providerId: provider.id,
                alertCode: notification.alertCode,
                channel: channel.kind,
              },
              "resolve_failure_outcome",
              persistenceError
            );
          }
          result.errors.push({
            providerId: provider.id,
            alertCode: notification.alertCode,
            channel: channel.kind,
            error: failure.message,
          });
          continue;
        }

        const outcomeAt = noEarlierThan(now, clock());
        try {
          await recordResolveOutcome(
            db,
            notification.id,
            channel,
            claim,
            outcomeAt,
            attempts,
            null
          );
        } catch (persistenceError) {
          if (
            !isPrismaModelTimeout(
              persistenceError,
              "ProviderAlertChannelDelivery"
            )
          ) {
            throw persistenceError;
          }
          allPagerDutyResolvesSent = false;
          noteChannelPersistenceDegradation(
            result,
            {
              providerId: provider.id,
              alertCode: notification.alertCode,
              channel: channel.kind,
            },
            "resolve_success_outcome",
            persistenceError
          );
          result.errors.push({
            providerId: provider.id,
            alertCode: notification.alertCode,
            channel: channel.kind,
            error:
              "PagerDuty resolve was accepted but its channel state timed out; the idempotent resolve remains pending",
          });
        }
      }

      if (!allPagerDutyResolvesSent) continue;
      const closedAt = latestDate(
        now,
        operationClaim.claimedAt,
        clock(),
        notification.lastDetectedAt,
        resolutionEvidence.sourceAt,
        resolutionEvidence.at
      );
      const closed = await db.providerAlertNotification.updateMany({
        where: {
          id: notification.id,
          incidentGeneration: notification.incidentGeneration,
          resolvedAt: null,
          operationClaimToken: operationClaim.token,
          operationClaimGeneration: operationClaim.generation,
          operationClaimIncidentGeneration:
            operationClaim.incidentGeneration,
          operationClaimConfigGeneration:
            operationClaim.configGeneration,
          operationClaimEvidenceSourceAt:
            operationClaim.targetEvidence.sourceAt,
          operationClaimEvidenceAt: operationClaim.targetEvidence.at,
          operationClaimEvidenceState: operationClaim.targetEvidence.state,
          operationClaimExpiresAt: { gt: closedAt },
          ...exactNotificationVersionWhere(operationClaim.notificationVersion),
          provider: {
            is: {
              alertConfigGeneration: resolutionEvidence.configGeneration,
            },
          },
        },
        data: {
          resolvedAt: closedAt,
          evidenceConfigGeneration: resolutionEvidence.configGeneration,
          evidenceSourceAt: resolutionEvidence.sourceAt,
          evidenceWatermarkAt: resolutionEvidence.at,
          evidenceWatermarkState: "clear",
          operationClaimToken: null,
          operationClaimExpiresAt: null,
          operationClaimConfigGeneration: null,
          operationClaimEvidenceSourceAt: null,
          operationClaimEvidenceAt: null,
          operationClaimEvidenceState: null,
          ...(legacyAuditPending
            ? { pagerDutyAuditState: "legacy_audited" }
            : {}),
        },
      });
      if (closed.count !== 1) throw new TriggerDeliveryClaimLostError();
      await clearNotificationChildClaims(db, notification.id, operationClaim);
      operationClosed = true;
      result.resolved += 1;
      } finally {
        if (!operationClosed) {
          await releaseNotificationOperation(db, notification.id, operationClaim);
        }
      }
    }

    for (const alert of deliverableAlerts) {
      const activationEvidence = alertEvidence(
        provider,
        alert.code,
        now,
        "active"
      );
      const activation = await claimActiveProviderAlertNotification(
        db,
        provider,
        alert,
        now,
        activationEvidence,
        operationClaimLeaseDurationMs,
        clock
      );

      if (activation.status !== "claimed") {
        result.skipped += 1;
        result.errors.push({
          providerId: provider.id,
          alertCode: alert.code,
          channel: "incident",
          error:
            activation.status === "stale"
              ? STALE_ALERT_EVIDENCE_MESSAGE
              : NOTIFICATION_OPERATION_IN_PROGRESS_MESSAGE,
        });
        continue;
      }
      const { notification, claim: operationClaim } = activation;

      if (channels.length === 0) {
        result.skipped += 1;
        await releaseNotificationOperation(db, notification.id, operationClaim);
        continue;
      }
      // S12: per-code channel routing narrows which configured channels may
      // TRIGGER this code. The resolve path deliberately does NOT apply
      // routing: an open incident always resolves on the channel it
      // originally triggered on, so re-routing a code mid-incident can never
      // strand a PagerDuty incident.
      const channelRouting = config.channelRouting?.[alert.code];
      const routedChannels = channelRouting
        ? channels.filter((channel) => channelRouting.includes(channel.kind))
        : channels;
      if (routedChannels.length === 0) {
        result.skipped += 1;
        await releaseNotificationOperation(db, notification.id, operationClaim);
        continue;
      }
      try {

      const channelStates = await db.providerAlertChannelDelivery.findMany({
        where: { notificationId: notification.id },
        select: {
          channelKey: true,
          lastAttemptAt: true,
          lastSucceededAt: true,
          lastSucceededIncidentGeneration: true,
          lastError: true,
          triggerClaimToken: true,
          triggerClaimGeneration: true,
          triggerClaimExpiresAt: true,
          triggerIncidentGeneration: true,
          triggerOperationClaimGeneration: true,
        },
      });
      const stateByChannelKey = new Map(
        channelStates.map((state) => [state.channelKey, state])
      );
      let hasDeferredDueChannel = false;
      const dueChannels = routedChannels.filter((channel) => {
        const persisted = stateByChannelKey.get(channelKey(channel));
        if (
          persisted?.triggerClaimToken &&
          persisted.triggerClaimExpiresAt &&
          persisted.triggerClaimExpiresAt > now &&
          persisted.triggerOperationClaimGeneration ===
            operationClaim.generation &&
          generationMatches(
            persisted.triggerIncidentGeneration,
            notification.incidentGeneration
          )
        ) {
          hasDeferredDueChannel = true;
          result.errors.push({
            providerId: provider.id,
            alertCode: alert.code,
            channel: channel.kind,
            error: TRIGGER_CLAIM_IN_PROGRESS_MESSAGE,
          });
          return false;
        }
        if (
          persisted?.lastError === TRIGGER_OUTCOME_UNKNOWN_MARKER &&
          persisted.lastAttemptAt &&
          generationMatches(
            persisted.triggerIncidentGeneration,
            notification.incidentGeneration
          ) &&
          !dueForChannel(
            persisted.lastAttemptAt,
            persisted.triggerIncidentGeneration,
            notification.incidentGeneration,
            notification.firstDetectedAt,
            now,
            config.reminderHours
          )
        ) {
          hasDeferredDueChannel = true;
          result.errors.push({
            providerId: provider.id,
            alertCode: alert.code,
            channel: channel.kind,
            error: TRIGGER_OUTCOME_UNKNOWN_MESSAGE,
          });
          return false;
        }
        // lastSentAt is a migration bridge for rows written before channel
        // state existed. It prevents a one-time replay of every successful
        // legacy notification immediately after this additive table ships.
        const lastSucceededAt = persisted
          ? persisted.lastSucceededAt
          : notification.lastSentAt;
        return dueForChannel(
          lastSucceededAt,
          persisted?.lastSucceededIncidentGeneration ?? null,
          notification.incidentGeneration,
          notification.firstDetectedAt,
          now,
          config.reminderHours
        );
      });

      if (dueChannels.length === 0) {
        const successfulStates = routedChannels.map((channel) =>
          stateByChannelKey.get(channelKey(channel))
        );
        const hasCompleteDurableSuccess =
          !hasDeferredDueChannel &&
          successfulStates.every(
            (state) =>
              state?.lastSucceededAt &&
              generationMatches(
                state.lastSucceededIncidentGeneration,
                notification.incidentGeneration
              ) &&
              state.lastSucceededAt >= notification.firstDetectedAt
          );
        if (hasCompleteDurableSuccess) {
          const durableSummaryAt = latestDate(
            ...successfulStates.map((state) => state!.lastSucceededAt!)
          );
          if (
            !notification.lastSentAt ||
            notification.lastSentAt < durableSummaryAt
          ) {
            try {
              await persistNotificationSummary(
                db,
                notification,
                operationClaim,
                durableSummaryAt,
                latestDate(now, operationClaim.claimedAt, clock())
              );
            } catch (error) {
              if (!isPrismaModelTimeout(error, "ProviderAlertNotification")) {
                throw error;
              }
              deferredSummaryTimeout ??= error;
            }
          }
        }
        result.skipped += 1;
        continue;
      }

      let allDueChannelsSent = !hasDeferredDueChannel;
      let anyChannelSent = false;
      for (const channel of dueChannels) {
        // Atomically claim a durable generation before crossing the external
        // call boundary. Concurrent workers cannot both own the same channel,
        // and a crashed owner recovers only after lease expiry + reminder due.
        const claim = await claimTriggerDelivery(
          db,
          notification.id,
          channel,
          notification.incidentGeneration,
          stateByChannelKey.get(channelKey(channel))?.triggerClaimGeneration ?? 0,
          channel.kind === "pagerduty"
            ? pagerDutyDedupKey(
                provider.id,
                alert.code,
                notification.incidentGeneration,
                notification.pagerDutyAuditState,
                alert.scope
              )
            : null,
          operationClaim,
          claimLeaseDurationMs,
          clock
        );
        if (!claim) {
          allDueChannelsSent = false;
          result.errors.push({
            providerId: provider.id,
            alertCode: alert.code,
            channel: channel.kind,
            error: TRIGGER_CLAIM_IN_PROGRESS_MESSAGE,
          });
          continue;
        }

        let attempts: number;
        try {
          attempts = await sendToChannel(
            channel,
            provider,
            alert,
            now,
            fetchImpl,
            settings,
            sleepImpl,
            "trigger",
            claim.pagerDutyDedupKey
          );
        } catch (error) {
          allDueChannelsSent = false;
          const failure = failureDetails(error);
          const outcomeAt = noEarlierThan(now, clock());
          if (failure.outcome === "unknown") {
            try {
              await recordTriggerUnknownOutcome(
                db,
                notification.id,
                channel,
                claim,
                outcomeAt,
                failure.attempts
              );
            } catch (persistenceError) {
              if (
                !isPrismaModelTimeout(
                  persistenceError,
                  "ProviderAlertChannelDelivery"
                )
              ) {
                throw persistenceError;
              }
              // The durable claim already encodes unknown outcome. Its lease
              // expiry plus the reminder interval bounds recovery.
              noteChannelPersistenceDegradation(
                result,
                {
                  providerId: provider.id,
                  alertCode: alert.code,
                  channel: channel.kind,
                },
                "trigger_unknown_outcome",
                persistenceError
              );
            }
          } else {
            try {
              await recordTriggerOutcome(
                db,
                notification.id,
                channel,
                claim,
                outcomeAt,
                failure.attempts,
                failure.message
              );
            } catch (persistenceError) {
              if (
                !isPrismaModelTimeout(
                  persistenceError,
                  "ProviderAlertChannelDelivery"
                )
              ) {
                throw persistenceError;
              }
              noteChannelPersistenceDegradation(
                result,
                {
                  providerId: provider.id,
                  alertCode: alert.code,
                  channel: channel.kind,
                },
                "trigger_rejected_outcome",
                persistenceError
              );
            }
          }
          result.errors.push({
            providerId: provider.id,
            alertCode: alert.code,
            channel: channel.kind,
            error:
              failure.outcome === "unknown"
                ? TRIGGER_TRANSPORT_UNKNOWN_MESSAGE
                : failure.message,
          });
          continue;
        }

        anyChannelSent = true;
        const outcomeAt = noEarlierThan(now, clock());
        try {
          await recordTriggerOutcome(
            db,
            notification.id,
            channel,
            claim,
            outcomeAt,
            attempts,
            null
          );
        } catch (error) {
          if (!isPrismaModelTimeout(error, "ProviderAlertChannelDelivery")) throw error;

          // The external endpoint accepted the delivery. The durable intent
          // remains an explicit unknown outcome, so do not relabel this as a
          // failed send or retry it automatically on the next maintenance tick.
          allDueChannelsSent = false;
          noteChannelPersistenceDegradation(
            result,
            {
              providerId: provider.id,
              alertCode: alert.code,
              channel: channel.kind,
            },
            "trigger_success_outcome",
            error
          );
          result.errors.push({
            providerId: provider.id,
            alertCode: alert.code,
            channel: channel.kind,
            error: TRIGGER_SUCCESS_PERSISTENCE_TIMEOUT_MESSAGE,
          });
        }
      }

      if (allDueChannelsSent && anyChannelSent) {
        try {
          const summaryAt = latestDate(now, operationClaim.claimedAt, clock());
          await persistNotificationSummary(
            db,
            notification,
            operationClaim,
            summaryAt
          );
        } catch (error) {
          if (!isPrismaModelTimeout(error, "ProviderAlertNotification")) throw error;
          deferredSummaryTimeout ??= error;
          result.sent += 1;
          continue;
        }
        result.sent += 1;
      }
      } finally {
        await releaseNotificationOperation(db, notification.id, operationClaim);
      }
    }
  }

  if (deferredSummaryTimeout) {
    throw new AlertNotificationSummaryPersistenceTimeout(deferredSummaryTimeout, {
      ...result,
      errors: [...result.errors],
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Provider deletion: close outstanding PagerDuty incidents BEFORE the row goes
// ---------------------------------------------------------------------------

export interface ProviderDeletionAlertResolution {
  /** Open incidents this provider still carried when deletion was attempted. */
  openIncidents: number;
  /** PagerDuty resolve events accepted during this call. */
  pagerDutyResolvesSent: number;
  /**
   * Incidents whose PagerDuty side could NOT be closed. A non-empty list means
   * deleting the provider row right now WOULD strand a live PagerDuty incident.
   */
  unresolved: Array<{ alertCode: string; reason: string }>;
}

/**
 * `ProviderAlertNotification.providerId` cascades on delete, so hard-deleting a
 * Provider destroys every open incident row — including the dedup keys and
 * incident generations the resolve path needs. PagerDuty is then left holding a
 * triggered incident that NOTHING can ever resolve: the maintenance pass only
 * looks at providers that still exist, so no amount of waiting closes it.
 *
 * This closes the PagerDuty side first, using each incident's OWN persisted
 * dedup key so the resolve lands on the exact incident the trigger opened.
 * Resolves are idempotent at PagerDuty, so re-running after a partial failure
 * is safe.
 *
 * The caller decides what a non-empty `unresolved` means; the DELETE route
 * refuses the deletion (with an explicit force override) rather than knowingly
 * stranding an incident.
 *
 * Deliberately narrower than the maintenance resolve path: it does not take the
 * durable operation claim, and instead REFUSES to act on any incident with a
 * live claim, leaving that incident for the caller to report and the operator
 * to retry a moment later.
 */
export async function resolveProviderAlertsBeforeDeletion(options: {
  providerId: string;
  config?: AlertDeliveryConfig;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: Date;
  db?: PrismaLike;
}): Promise<ProviderDeletionAlertResolution> {
  const rawDb = options.db ?? prisma;
  const db = options.db ? rawDb : withAlertPersistenceAdmission(rawDb);
  const config = options.config ?? readAlertDeliveryConfig();
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  const now = options.now ?? new Date();
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
  const pagerDutyChannels = [
    ...new Map(
      config.channels
        .filter(
          (channel): channel is Extract<AlertDeliveryChannel, { kind: "pagerduty" }> =>
            channel.kind === "pagerduty"
        )
        .map((channel) => [channelKey(channel), channel] as const)
    ).values(),
  ];

  const result: ProviderDeletionAlertResolution = {
    openIncidents: 0,
    pagerDutyResolvesSent: 0,
    unresolved: [],
  };

  const provider = await db.provider.findUnique({
    where: { id: options.providerId },
    select: { id: true, name: true, displayName: true },
  });
  if (!provider) return result;

  const notifications = await db.providerAlertNotification.findMany({
    where: { providerId: provider.id, resolvedAt: null },
    select: {
      id: true,
      stateKey: true,
      alertCode: true,
      severity: true,
      message: true,
      firstDetectedAt: true,
      incidentGeneration: true,
      pagerDutyAuditState: true,
      operationClaimToken: true,
      operationClaimExpiresAt: true,
      channelDeliveries: {
        where: { channelKind: "pagerduty" },
        select: {
          channelKey: true,
          pagerDutyDedupKey: true,
          lastSucceededAt: true,
          lastSucceededIncidentGeneration: true,
          lastResolvedAt: true,
          lastResolvedIncidentGeneration: true,
          triggerIncidentGeneration: true,
          triggerClaimToken: true,
          triggerClaimExpiresAt: true,
          resolveClaimToken: true,
          resolveClaimExpiresAt: true,
          lastError: true,
        },
      },
    },
  });
  result.openIncidents = notifications.length;

  const configuredPagerDutyKeys = new Set(
    pagerDutyChannels.map((channel) => channelKey(channel))
  );

  for (const notification of notifications) {
    const legacyAuditPending =
      notification.pagerDutyAuditState === "legacy_unknown";
    const resolvedForIncident = (
      state: (typeof notification.channelDeliveries)[number]
    ) =>
      generationMatches(
        state.lastResolvedIncidentGeneration,
        notification.incidentGeneration
      ) &&
      state.lastResolvedAt !== null &&
      state.lastResolvedAt >= notification.firstDetectedAt;
    // Same predicate the maintenance resolve path uses: a PagerDuty
    // destination is only owed a resolve if THIS incident generation actually
    // reached it (or a legacy row makes that unknowable).
    const relevantTriggerStates = notification.channelDeliveries.filter(
      (state) =>
        !resolvedForIncident(state) &&
        (legacyAuditPending ||
          ((generationMatches(
            state.triggerIncidentGeneration,
            notification.incidentGeneration
          ) ||
            generationMatches(
              state.lastSucceededIncidentGeneration,
              notification.incidentGeneration
            )) &&
            ((state.lastSucceededAt !== null &&
              state.lastSucceededAt >= notification.firstDetectedAt) ||
              state.lastError === TRIGGER_OUTCOME_UNKNOWN_MARKER ||
              state.triggerClaimToken !== null)))
    );
    if (relevantTriggerStates.length === 0 && !legacyAuditPending) {
      // Nothing ever reached PagerDuty for this incident, so deleting the row
      // cannot strand anything there.
      continue;
    }

    const claimInFlight =
      (notification.operationClaimToken !== null &&
        notification.operationClaimExpiresAt !== null &&
        notification.operationClaimExpiresAt > now) ||
      relevantTriggerStates.some(
        (state) =>
          (state.triggerClaimToken !== null &&
            state.triggerClaimExpiresAt !== null &&
            state.triggerClaimExpiresAt > now) ||
          (state.resolveClaimToken !== null &&
            state.resolveClaimExpiresAt !== null &&
            state.resolveClaimExpiresAt > now)
      );
    if (claimInFlight) {
      // A maintenance worker is mid-delivery on this incident. Resolving under
      // it could overtake a trigger that has not yet crossed the durable
      // boundary; the lease is short, so the honest answer is "retry shortly".
      result.unresolved.push({
        alertCode: notification.alertCode,
        reason:
          "a maintenance worker is mid-delivery on this incident; retry in a moment",
      });
      continue;
    }

    if (
      relevantTriggerStates.some(
        (state) => !configuredPagerDutyKeys.has(state.channelKey)
      ) ||
      (legacyAuditPending && pagerDutyChannels.length === 0)
    ) {
      result.unresolved.push({
        alertCode: notification.alertCode,
        reason:
          "the PagerDuty routing key this incident was raised on is not configured",
      });
      continue;
    }

    const scope = notificationAlertScope({
      providerId: provider.id,
      alertCode: notification.alertCode,
      stateKey: notification.stateKey,
    });
    const resolvedAlert: ProviderAlert = {
      code: notification.alertCode as ProviderAlert["code"],
      severity: normalizeSeverity(notification.severity) ?? "warning",
      message: notification.message,
    };
    const channelsToResolve = pagerDutyChannels.filter((channel) => {
      if (legacyAuditPending) return true;
      const key = channelKey(channel);
      return relevantTriggerStates.some((state) => state.channelKey === key);
    });

    let allResolvesSent = true;
    for (const channel of channelsToResolve) {
      const key = channelKey(channel);
      const state = notification.channelDeliveries.find(
        (entry) => entry.channelKey === key
      );
      const exactDedupKey = legacyAuditPending
        ? pagerDutyDedupKey(
            provider.id,
            notification.alertCode,
            notification.incidentGeneration,
            "legacy_unknown",
            scope
          )
        : state?.pagerDutyDedupKey ??
          pagerDutyDedupKey(
            provider.id,
            notification.alertCode,
            notification.incidentGeneration,
            notification.pagerDutyAuditState,
            scope
          );
      try {
        await sendToChannel(
          channel,
          provider,
          resolvedAlert,
          now,
          fetchImpl,
          settings,
          sleepImpl,
          "resolve",
          exactDedupKey
        );
      } catch (error) {
        allResolvesSent = false;
        result.unresolved.push({
          alertCode: notification.alertCode,
          reason: failureDetails(error).message,
        });
        continue;
      }
      result.pagerDutyResolvesSent += 1;
      try {
        await db.providerAlertChannelDelivery.updateMany({
          where: { notificationId: notification.id, channelKey: key },
          data: {
            lastResolveAttemptAt: now,
            lastResolvedAt: now,
            lastResolvedIncidentGeneration: notification.incidentGeneration,
            resolveAttemptCount: { increment: 1 },
            lastResolveError: null,
          },
        });
      } catch (error) {
        // The resolve already landed at PagerDuty, which is the outcome that
        // matters here. Bookkeeping on a row that is about to be cascade-deleted
        // is best-effort; a repeat resolve is idempotent.
        if (!isPrismaModelTimeout(error, "ProviderAlertChannelDelivery")) throw error;
      }
    }

    if (!allResolvesSent) continue;
    // Close the local incident too, so an abandoned deletion leaves consistent
    // state and a concurrent maintenance pass does not re-notify.
    await db.providerAlertNotification.updateMany({
      where: { id: notification.id, resolvedAt: null },
      data: { resolvedAt: now },
    });
  }

  return result;
}
