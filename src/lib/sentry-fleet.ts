// Sparse, dependency-free Sentry envelope client for the fleet-infra project.
//
// Why a hand-rolled envelope client (no @sentry/nextjs): the runtime SDK only
// takes one DSN at init, and we want to mirror a small subset of UM's app-
// health signals into fleet-infra WITHOUT re-initialising the SDK or
// shipping a second Sentry runtime into the bundle.  The same pattern is
// used by scripts/sentry-ci-report.py for CI failure events — ported to
// TypeScript so the same code runs in the Next.js server runtime without
// a Python dependency.
//
// Configuration: SENTRY_FLEET_DSN.  Absent = complete no-op.  Never print
// the DSN value into a log line, breadcrumb, or error.  Treat the DSN like
// any other secret: read from env only, never persist, never echo.
//
// Wire contract (Sentry envelope endpoint, JSON items):
//   <envelope header JSON>\n
//   {"type":"event","content_type":"application/json"}\n
//   <event JSON>\n
// POSTed to <dsn.host>/api/<dsn.projectId>/envelope/?sentry_key=<public_key>&sentry_version=7
//
// All calls are best-effort: failures are swallowed and the caller's flow
// continues.  This module must never throw, never block, and never log the
// DSN value.  Fleet-infra is an observability channel, not a billing path.

import { hostname } from "node:os";

const SDK_NAME = "sentry.jays.services.um-fleet";
const SDK_VERSION = "1.0.0";
const HOSTNAME = hostname();
const SENTRY_VERSION = "7";

interface ParsedDsn {
  publicKey: string;
  host: string;
  projectId: string;
  envelopeBase: string;
}

function parseDsn(raw: string): ParsedDsn | null {
  // Accept the canonical Sentry DSN shape:
  //   https://<public_key>@o<org>.ingest.sentry.io/<project_id>
  //   https://<public_key>@<host>/<project_id>
  // Strip any path-prefix (e.g. /serverdsn) Sentry sometimes appends.
  const cleaned = raw.replace(/\/serverdsn$/, "");
  const match = /^https:\/\/([^@\s]+)@([^/\s]+)\/(\d+)\/?$/.exec(cleaned);
  if (!match) return null;
  const [, publicKey, host, projectId] = match;
  if (!/^[0-9a-f]+$/i.test(publicKey)) return null;
  if (!/^[A-Za-z0-9.\-:]+$/.test(host)) return null;
  if (!/^\d+$/.test(projectId)) return null;
  return {
    publicKey,
    host,
    projectId,
    envelopeBase: `https://${host}/api/${projectId}/envelope/`,
  };
}

let cachedDsn: ParsedDsn | null | undefined;

function resolveDsn(): ParsedDsn | null {
  if (cachedDsn !== undefined) return cachedDsn;
  const raw = process.env.SENTRY_FLEET_DSN?.trim();
  if (!raw) {
    cachedDsn = null;
    return null;
  }
  cachedDsn = parseDsn(raw);
  if (!cachedDsn) {
    // Misconfiguration: log a one-time warning without echoing the value.
    console.warn(
      "[sentry-fleet] SENTRY_FLEET_DSN is set but does not match the expected shape; fleet-infra emit disabled"
    );
  }
  return cachedDsn;
}

/** Test seam: clear the DSN cache between cases. */
export function __resetSentryFleetDsnForTests(): void {
  cachedDsn = undefined;
}

function isFleetConfigured(): boolean {
  return resolveDsn() !== null;
}

function newEventId(): string {
  // RFC 4122 v4.  Avoid pulling a uuid library — envelopes are 16 random
  // bytes + 4-bit version + 2-bit variant.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex: string[] = [];
  for (const b of bytes) hex.push(b.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("");
}

function nowIso(): string {
  return new Date().toISOString();
}

function releaseTag(): string {
  // Pulled lazily so test stubs can override process.env before first call.
  const version = process.env.SENTRY_FLEET_RELEASE ?? "usage-monitor@dev";
  return version;
}

function environmentTag(): string {
  return (
    process.env.SENTRY_ENVIRONMENT?.trim() ||
    process.env.NODE_ENV?.trim() ||
    "production"
  );
}

export interface FleetInfraTags {
  app: string;
  agent: string;
  [key: string]: string;
}

export interface FleetInfraEmitOptions {
  /** "info" is the default for healthy periodic signals. */
  level?: "info" | "warning" | "error" | "debug";
  /** Stable fingerprint so fleet-infra dedupes repeats of the same signal. */
  fingerprint?: string[];
  /** Free-form structured data attached to the event. */
  extra?: Record<string, string | number | boolean>;
}

/**
 * Emit a single Sentry event to the fleet-infra project.  No-op when
 * SENTRY_FLEET_DSN is absent or malformed.  Never throws.  Never logs
 * the DSN value or any secret.
 */
export async function recordFleetInfraEvent(
  message: string,
  tags: FleetInfraTags,
  options: FleetInfraEmitOptions = {}
): Promise<void> {
  const dsn = resolveDsn();
  if (!dsn) return;
  const level = options.level ?? "info";
  const fingerprint = options.fingerprint ?? ["um-fleet", message];
  try {
    const event = {
      event_id: newEventId(),
      timestamp: nowIso(),
      platform: "node",
      level,
      logger: "um.fleet",
      transaction: `um.fleet.${tags["metric.name"] ?? "signal"}`,
      server_name: HOSTNAME,
      release: releaseTag(),
      environment: environmentTag(),
      tags: { ...tags },
      extra: options.extra ?? {},
      fingerprint,
      message,
    };
    // Serialize the event once so the envelope item header can carry the
    // real payload byte length.  Per the Sentry envelope protocol, a
    // non-zero `length` is the UTF-8 byte count of the JSON body that
    // follows; `scripts/sentry-ci-report.py` computes it the same way.
    // A zero length on a non-empty payload makes the receiver treat the
    // item as truncated and reject or misparse the envelope.
    const eventJson = JSON.stringify(event);
    const eventByteLength = Buffer.byteLength(eventJson, "utf8");
    const envelope = [
      JSON.stringify({
        event_id: event.event_id,
        sent_at: nowIso(),
        sdk: { name: SDK_NAME, version: SDK_VERSION },
        trace: {
          environment: event.environment,
          release: event.release,
          public_key: dsn.publicKey,
        },
      }),
      JSON.stringify({
        type: "event",
        length: eventByteLength,
        content_type: "application/json",
      }),
      eventJson,
      "",
    ].join("\n");
    const url =
      dsn.envelopeBase +
      `?sentry_key=${encodeURIComponent(dsn.publicKey)}` +
      `&sentry_version=${SENTRY_VERSION}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "User-Agent": `${SDK_NAME}/${SDK_VERSION}`,
      },
      body: envelope,
    });
    if (!res.ok && process.env.SENTRY_FLEET_DEBUG === "true") {
      // Diagnostic only — debug-mode leaks the HTTP status, not the DSN.
      console.warn(
        `[sentry-fleet] event "${message}" returned HTTP ${res.status}`
      );
    }
  } catch {
    // Best-effort: the next call is a fresh attempt.
  }
}

/**
 * Emit a Sentry event that represents one point of a metric (counter
 * increment, gauge reading, duration sample).  This is the fleet-infra
 * mirror of the Sentry Application Metrics that the SDK emits into the
 * usage-monitor project.
 *
 * The `value` rides in `extra.metric.value`; `attributes` are stamped
 * into tags.  The `fingerprint` is `[app, name, kind]` so fleet-infra
 * dedupes a stream of `scheduler.tick = 1` events into a single issue
 * that increments per occurrence.
 */
export async function recordFleetInfraMetric(
  name: string,
  value: number,
  attributes: Record<string, string | number | boolean> = {}
): Promise<void> {
  // Metric kind is decided by the NAME, not the value.  Sentry Application
  // Metrics classify `gauge` vs `counter` by semantics (a measurement vs
  // a count), and `scheduler.duration_ms` is always a gauge even though
  // `Date.now() - tickStartedAt` is an integer.  Anything ending in
  // `_ms`, `duration_*`, or `*_ratio` is a gauge; everything else is a
  // counter (the typical Sentry Application Metrics shape).
  const isGauge = /(?:^|[._])(?:duration_ms|ttft_ms|duration|ratio|latency)\b/.test(name);
  const kind = isGauge ? "gauge" : "counter";
  const tags: FleetInfraTags = {
    app: "usage-monitor",
    agent: process.env.AGENT_TAG?.trim() || "MM",
    "metric.name": name,
    "metric.kind": kind,
  };
  for (const [k, v] of Object.entries(attributes)) {
    if (v === undefined || v === null) continue;
    tags[`metric.${k}`] = String(v);
  }
  // Failure-class metrics are warnings, healthy counters/info events stay info.
  // Match `failed|rejected|error` after a `.` or `_` segment boundary so
  // "ingest.admission_rejected", "scheduler.tick.failed", and
  // "circuit_error" all trip the warning classification while healthy
  // metric names like "scheduler.duration_ms" do not.
  const isFailureMetric = /(?:^|[._])(?:failed|rejected|error)\b/.test(name);
  await recordFleetInfraEvent(
    `${name} = ${value}`,
    tags,
    {
      level: isFailureMetric ? "warning" : "info",
      fingerprint: ["um-fleet", "metric", name],
      extra: { "metric.value": value },
    }
  );
}

/** Test seam + ops probe: true when the fleet-infra DSN is configured. */
export function isSentryFleetConfigured(): boolean {
  return isFleetConfigured();
}
