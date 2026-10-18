/**
 * Fleet alert status for the Usage Monitor ops UI (`/ops`).
 *
 * Reads the shared alert ingress (`GET /status`) rather than re-deriving
 * health from each vendor.  The ingress is the only writer of alert state and
 * posts the same truth to Zulip as a per-topic standing message, so this page
 * and the channel cannot disagree — that was the point of the split.
 *
 * Never gates product readiness.  Degrades to `configured: false` when the
 * ingress URL is unset or unreachable, exactly like fleet-backup-status.ts, so
 * an ops page never hard-fails because an alert surface is down.
 *
 * Owning repo for the ingress: AI-Fleet-Coordinator `workers/alert-ingress`.
 * Contract changes there land in `status.test.js` first.
 */

export const FLEET_ALERTS_CACHE_TTL_MS = 30_000; // 30s: this is an ops page, freshness matters more than call volume
export const FLEET_ALERTS_FAILURE_RETRY_MS = 15_000;
const FLEET_ALERTS_TIMEOUT_MS = 8_000;

/** Highest severity first; used to sort and to pick a headline state. */
const SEVERITY_RANK: Record<string, number> = { INFO: 0, MODERATE: 1, SEVERE: 2 };

export type FleetAlertPhase = "ok" | "pending" | "alerting";
export type FleetAlertSeverity = "SEVERE" | "MODERATE" | "INFO";

export interface FleetAlert {
  key: string;
  service: string;
  phase: FleetAlertPhase;
  severity: FleetAlertSeverity;
  text: string;
  link: string;
  since: number | null;
  updated: number | null;
  prodDown: boolean;
}

export interface FleetAlertTopic {
  firing: number;
  total: number;
  alerts: FleetAlert[];
}

export interface FleetAlertsPayload {
  /** False when no ingress URL is configured — renders as "Not Configured". */
  configured: boolean;
  /** Best-effort; null whenever we could not reach the ingress. */
  generatedAt: string | null;
  ok: boolean;
  summary: { topics: number; alerts: number; firing: number };
  topics: Record<string, FleetAlertTopic>;
  /** Present only on failure, so the UI can say why rather than "unknown". */
  reason: string | null;
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only these three may appear; anything else is treated as INFO. */
function normalizeSeverity(value: unknown): FleetAlertSeverity {
  const raw = readText(value)?.toUpperCase();
  if (raw === "SEVERE" || raw === "MODERATE" || raw === "INFO") return raw;
  return "INFO";
}

function normalizePhase(value: unknown): FleetAlertPhase {
  return value === "alerting" || value === "pending" ? value : "ok";
}

function parseAlert(raw: unknown): FleetAlert | null {
  if (!isRecord(raw)) return null;
  const key = readText(raw.key);
  const service = readText(raw.service);
  if (!key || !service) return null;
  const phase = normalizePhase(raw.phase);
  const severity = normalizeSeverity(raw.severity);
  return {
    key,
    service,
    phase,
    // The ingress already guarantees this, but the ops page renders severity as
    // color, so it must not take it on trust: a held or healthy signal is never
    // shown as alarming even if an older or buggy ingress says otherwise.
    severity: phase === "alerting" ? severity : "INFO",
    text: readText(raw.text) ?? "",
    link: readText(raw.link) ?? "",
    since: readNumber(raw.since),
    updated: readNumber(raw.updated),
    prodDown: raw.prodDown === true,
  };
}

/** Firing first, then by severity, then by service name. */
function sortAlerts(alerts: FleetAlert[]): FleetAlert[] {
  const phaseRank: Record<FleetAlertPhase, number> = { alerting: 0, pending: 1, ok: 2 };
  return alerts.sort(
    (a, b) =>
      phaseRank[a.phase] - phaseRank[b.phase] ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.service.localeCompare(b.service),
  );
}

/**
 * Parse the ingress payload defensively.  A malformed alert must degrade the
 * ops page, never crash it.
 */
export function parseFleetAlertsPayload(raw: unknown): FleetAlertsPayload {
  const empty: FleetAlertsPayload = {
    configured: true,
    generatedAt: null,
    ok: false,
    summary: { topics: 0, alerts: 0, firing: 0 },
    topics: {},
    reason: "malformed payload",
  };
  if (!isRecord(raw)) return empty;

  const rawTopics = isRecord(raw.topics) ? raw.topics : {};
  const collected: Array<[string, FleetAlertTopic]> = [];
  let alerts = 0;
  let firing = 0;

  for (const [topicName, value] of Object.entries(rawTopics)) {
    if (!isRecord(value)) continue;
    const list = Array.isArray(value.alerts) ? value.alerts : [];
    const parsed = list.map(parseAlert).filter((a): a is FleetAlert => a !== null);
    if (parsed.length === 0) continue;
    sortAlerts(parsed);
    const tf = parsed.filter((a) => a.phase === "alerting").length;
    firing += tf;
    alerts += parsed.length;
    collected.push([topicName, { firing: tf, total: parsed.length, alerts: parsed }]);
  }

  // Most problems first, then alphabetical.  JSON key order is incidental, so
  // the ops page must not inherit it — the card has to be stable run to run.
  collected.sort((a, b) => b[1].firing - a[1].firing || a[0].localeCompare(b[0]));
  const topics: Record<string, FleetAlertTopic> = {};
  for (const [name, topic] of collected) topics[name] = topic;

  return {
    configured: true,
    generatedAt: readText(raw.generatedAt) ?? null,
    ok: true,
    summary: { topics: Object.keys(topics).length, alerts, firing },
    topics,
    reason: null,
  };
}

function notConfigured(reason = "FLEET_ALERTS_URL is not set"): FleetAlertsPayload {
  return {
    configured: false,
    generatedAt: null,
    ok: false,
    summary: { topics: 0, alerts: 0, firing: 0 },
    topics: {},
    reason,
  };
}

interface CacheEntry {
  payload: FleetAlertsPayload;
  expiresAt: number;
}

const runtime: { cache?: CacheEntry; inFlight?: Promise<FleetAlertsPayload> } = {};

export function resetFleetAlertsCacheForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("fleet alerts cache can only be reset in tests");
  }
  runtime.cache = undefined;
  runtime.inFlight = undefined;
}

/** Headline state for the card: the worst thing currently firing. */
export function worstFiringSeverity(payload: FleetAlertsPayload): FleetAlertSeverity {
  let worst: FleetAlertSeverity = "INFO";
  for (const topic of Object.values(payload.topics)) {
    for (const alert of topic.alerts) {
      if (alert.phase !== "alerting") continue;
      if (SEVERITY_RANK[alert.severity] > SEVERITY_RANK[worst]) worst = alert.severity;
    }
  }
  return worst;
}

async function fetchOnce(): Promise<FleetAlertsPayload> {
  const base = readText(process.env.FLEET_ALERTS_URL);
  if (!base) return notConfigured();
  const url = `${base.replace(/\/$/, "")}/status`;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FLEET_ALERTS_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) {
      return { ...notConfigured(`ingress HTTP ${response.status}`), configured: true };
    }
    return parseFleetAlertsPayload(await response.json());
  } catch (error) {
    return {
      ...notConfigured(error instanceof Error ? error.message : "ingress unreachable"),
      configured: true,
    };
  }
}

/**
 * Cached read.  A failure is cached briefly too, so an ingress outage does not
 * turn into one outbound request per ops-page render.
 */
export async function getFleetAlerts(): Promise<FleetAlertsPayload> {
  const now = Date.now();
  if (runtime.cache && runtime.cache.expiresAt > now) return runtime.cache.payload;
  if (runtime.inFlight) return runtime.inFlight;

  const ttl = runtime.cache?.payload.ok === false ? FLEET_ALERTS_FAILURE_RETRY_MS : FLEET_ALERTS_CACHE_TTL_MS;
  const inflight = fetchOnce()
    .then((payload) => {
      runtime.cache = { payload, expiresAt: Date.now() + ttl };
      return payload;
    })
    .finally(() => {
      runtime.inFlight = undefined;
    });
  runtime.inFlight = inflight;
  return inflight;
}