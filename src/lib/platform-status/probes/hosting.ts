/**
 * Hosting & compute probes — "where does the fleet actually run".
 *
 * Hetzner and Coolify are the live pair: the Hetzner box is the host, Coolify
 * is what runs the apps on it.  Both reuse the exact env vars `server-metrics.ts`
 * already reads, so wiring one surface wires the other.  Render and Vercel reuse
 * the credential names their existing adapters use.  The remaining four have no
 * integration in this repo yet; they are implemented against each vendor's
 * documented list endpoint so that the day a token is set the card just works,
 * and until then the card's whole job is to name the env var to set.
 *
 * House rules honoured here: no global `fetch`, no secrets in output, probes
 * never throw, and every headline/label is written for a human to read.
 */

import {
  asArray,
  asRecord,
  envValue,
  failureResult,
  finiteNumber,
  formatCount,
  hasEnv,
  metric,
  requestJson,
  upstreamFailure,
} from "../probe-helpers";
import type { PlatformMetric, PlatformProbe, PlatformProbeResult } from "../types";

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** Defensive ceiling so a large account cannot turn a card into a loop. */
const MAX_ROWS = 200;

/** Hetzner Cloud server id for fleet host.  Overridable via HETZNER_SERVER_ID. */
const DEFAULT_HETZNER_SERVER_ID = process.env.HETZNER_SERVER_ID || "";
/** Same default the host metrics surface uses.  Overridable via COOLIFY_HOST. */
const DEFAULT_COOLIFY_HOST = "https://host.jays.services";

const HETZNER_TOKEN_ENV = ["HCLOUD_TOKEN", "HETZNER_API_TOKEN", "HETZNER_API_KEY"] as const;
/** Read-only stats token first.  COOLIFY_AGENTS is a write token and is never read here. */
const COOLIFY_TOKEN_ENV = ["COOLIFY_SERVER_STATS", "COOLIFY_API_TOKEN"] as const;
const RENDER_TOKEN_ENV = ["RENDER_API_KEY", "RENDER_API_TOKEN"] as const;
const VERCEL_TOKEN_ENV = ["VERCEL_API_TOKEN", "VERCEL_TOKEN"] as const;

function readText(value: unknown, maxLength = 60): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 1)}…`;
}

function displayName(value: unknown, fallback: string): string {
  return readText(value, 40) ?? fallback;
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "api-worker" or "api-worker and 2 more" — never a wall of names. */
function nameList(names: string[], fallback: string): string {
  const first = names[0];
  if (!first) return fallback;
  return names.length === 1 ? first : `${first} and ${count(names.length - 1)} more`;
}

/** "api-worker is suspended." / "api-worker and 2 more are suspended." */
function problemSentence(names: string[], singular: string, plural: string, fallback: string): string {
  return `${nameList(names, fallback)} ${names.length === 1 ? singular : plural}.`;
}

/** A plain-language headline for a well-formed response that reported a failure. */
function upstreamHeadline(platform: string, status: number): string {
  if (status === 401 || status === 403) return `${platform} rejected the configured credentials.`;
  if (status === 404) return `${platform} could not find the configured resource.`;
  if (status === 429) return `${platform} is rate limiting status checks.`;
  if (status >= 500) return `${platform} returned a server error.`;
  return `${platform} returned HTTP ${status}.`;
}

/** Unreachable in practice — the registry only calls probe() when configured. */
function missingCredentials(platform: string): PlatformProbeResult {
  return {
    state: "unavailable",
    headline: `${platform} credentials could not be read.`,
    metrics: [],
    error: "missing_credentials",
  };
}

function malformed(platform: string): PlatformProbeResult {
  return {
    state: "degraded",
    headline: `${platform} returned a response this monitor does not recognize.`,
    metrics: [],
    error: "invalid_response",
  };
}

// ---------------------------------------------------------------------------
// Hetzner Cloud
// ---------------------------------------------------------------------------

async function probeHetzner(): Promise<PlatformProbeResult> {
  const token = envValue(...HETZNER_TOKEN_ENV);
  if (!token) return missingCredentials("Hetzner Cloud");
  const serverId = envValue("HETZNER_SERVER_ID") ?? DEFAULT_HETZNER_SERVER_ID;

  try {
    const response = await requestJson(
      `https://api.hetzner.cloud/v1/servers/${encodeURIComponent(serverId)}`,
      { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) {
      return upstreamFailure(response.status, upstreamHeadline("Hetzner Cloud", response.status));
    }

    const server = asRecord(asRecord(response.data)?.server);
    if (!server) return malformed("Hetzner Cloud");

    const name = displayName(server.name, `Server ${serverId}`);
    const status = readText(server.status, 24) ?? "unknown";
    const running = status.toLowerCase() === "running";
    const serverType = asRecord(server.server_type);
    const typeName = readText(serverType?.name, 24) ?? "Unknown";
    const cores = finiteNumber(serverType?.cores);
    const memoryGb = finiteNumber(serverType?.memory);
    const location =
      readText(asRecord(server.location)?.name, 32) ??
      readText(asRecord(asRecord(server.datacenter)?.location)?.name, 32) ??
      readText(asRecord(server.datacenter)?.name, 32) ??
      "Unknown";
    // Hetzner reports an enabled backup schedule as a window string ("14-18")
    // and a disabled one as null, so presence is the enabled/disabled signal.
    const backupWindow = readText(server.backup_window, 24);

    const metrics: PlatformMetric[] = [
      metric("Server", name),
      metric("Status", sentenceCase(status)),
      metric(
        "Server Type",
        cores !== null && memoryGb !== null
          ? `${typeName} · ${count(cores)} vCPU · ${count(memoryGb)} GB`
          : typeName
      ),
      metric("Location", location),
      metric(
        "Automatic Backups",
        backupWindow ? "Enabled" : "Disabled",
        backupWindow ? `window ${backupWindow}` : undefined
      ),
    ];

    // Backups being off is a standing configuration choice, not an incident, so
    // it is called out in the headline without dragging the card to degraded.
    const headline = running
      ? backupWindow
        ? `Hetzner server ${name} is running.`
        : `Hetzner server ${name} is running.  Automatic backups are off.`
      : `Hetzner server ${name} reports status ${status}.`;

    return { state: running ? "healthy" : "degraded", headline, metrics };
  } catch (error) {
    return failureResult(error, "Hetzner Cloud could not be reached.");
  }
}

// ---------------------------------------------------------------------------
// Coolify
// ---------------------------------------------------------------------------

type CoolifyBucket = "running" | "unhealthy" | "unknown" | "stopped";

/**
 * Coolify reports "<state>:<health>", e.g. "running:healthy".  A running app
 * whose health is anything other than "healthy" — including the literal
 * "running:unknown" that compose apps without a healthcheck report — is counted
 * as unknown, because this monitor cannot claim the app is serving traffic.
 */
function classifyCoolifyStatus(status: string | null): CoolifyBucket {
  if (!status) return "unknown";
  const [statePart, healthPart] = status.split(":");
  const state = statePart.trim().toLowerCase();
  const health = (healthPart ?? "").trim().toLowerCase();
  if (state !== "running") return "stopped";
  if (health === "unhealthy") return "unhealthy";
  if (health === "healthy") return "running";
  return "unknown";
}

/** COOLIFY_HOST is operator-configurable, so it is validated and treated as untrusted. */
function coolifyHost(): string | null {
  const raw = (envValue("COOLIFY_HOST") ?? DEFAULT_COOLIFY_HOST).replace(/\/+$/, "");
  try {
    if (new URL(raw).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return raw;
}

async function probeCoolify(): Promise<PlatformProbeResult> {
  const token = envValue(...COOLIFY_TOKEN_ENV);
  if (!token) return missingCredentials("Coolify");
  const host = coolifyHost();
  if (!host) {
    return {
      state: "unavailable",
      headline: "COOLIFY_HOST is not a valid HTTPS URL.",
      metrics: [],
      error: "invalid_host",
    };
  }

  try {
    const response = await requestJson(
      `${host}/api/v1/applications`,
      { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } },
      { security: "untrusted" }
    );
    if (!response.ok) {
      return upstreamFailure(response.status, upstreamHeadline("Coolify", response.status));
    }
    if (!Array.isArray(response.data)) return malformed("Coolify");

    const rows = asArray(response.data).slice(0, MAX_ROWS);
    const names: Record<CoolifyBucket, string[]> = {
      running: [],
      unhealthy: [],
      unknown: [],
      stopped: [],
    };
    for (const row of rows) {
      const record = asRecord(row);
      if (!record) continue;
      const bucket = classifyCoolifyStatus(readText(record.status, 80));
      names[bucket].push(displayName(record.name, "an application"));
    }

    const total =
      names.running.length + names.unhealthy.length + names.unknown.length + names.stopped.length;
    const metrics: PlatformMetric[] = [
      metric("Applications", count(total)),
      metric("Running", count(names.running.length)),
      metric("Unhealthy", count(names.unhealthy.length)),
      metric("Unknown Health", count(names.unknown.length)),
      metric("Stopped", count(names.stopped.length)),
    ];

    if (total === 0) {
      return {
        state: "degraded",
        headline: "Coolify reported no applications.",
        metrics,
        error: "no_applications",
      };
    }

    // Worst state wins the second sentence, so the headline always names the
    // thing the owner should look at first.
    let problem: string | null = null;
    if (names.stopped.length > 0) {
      problem = problemSentence(names.stopped, "is not running", "are not running", "An application");
    } else if (names.unhealthy.length > 0) {
      problem = problemSentence(names.unhealthy, "is unhealthy", "are unhealthy", "An application");
    } else if (names.unknown.length > 0) {
      problem = problemSentence(
        names.unknown,
        "reports unknown health",
        "report unknown health",
        "An application"
      );
    }

    if (!problem) {
      return {
        state: "healthy",
        headline: `All ${count(total)} Coolify applications are running and healthy.`,
        metrics,
      };
    }

    return {
      state: "degraded",
      headline: `${count(names.running.length)} of ${count(total)} Coolify applications are healthy.  ${problem}`,
      metrics,
    };
  } catch (error) {
    return failureResult(error, "Coolify could not be reached.");
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function isRenderSuspended(value: unknown): boolean {
  return value === true || (typeof value === "string" && value.trim().toLowerCase() === "suspended");
}

async function probeRender(): Promise<PlatformProbeResult> {
  const token = envValue(...RENDER_TOKEN_ENV);
  if (!token) return missingCredentials("Render");

  try {
    const response = await requestJson("https://api.render.com/v1/services?limit=100", {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      return upstreamFailure(response.status, upstreamHeadline("Render", response.status));
    }
    if (!Array.isArray(response.data)) return malformed("Render");

    const suspended: string[] = [];
    let total = 0;
    for (const row of asArray(response.data).slice(0, MAX_ROWS)) {
      const record = asRecord(row);
      if (!record) continue;
      // Render's list endpoint wraps each service in { service, cursor }.
      const service = asRecord(record.service) ?? record;
      total += 1;
      if (isRenderSuspended(service.suspended)) {
        suspended.push(displayName(service.name, "a service"));
      }
    }

    const live = total - suspended.length;
    const metrics: PlatformMetric[] = [
      metric("Services", count(total)),
      metric("Live", count(live)),
      metric("Suspended", count(suspended.length)),
    ];

    if (suspended.length > 0) {
      return {
        state: "degraded",
        headline: `${count(live)} of ${count(total)} Render services are live.  ${problemSentence(suspended, "is suspended", "are suspended", "A service")}`,
        metrics,
      };
    }

    return {
      state: "healthy",
      headline:
        total === 0
          ? "Render has no services in this account."
          : `All ${count(total)} Render services are live.`,
      metrics,
    };
  } catch (error) {
    return failureResult(error, "Render could not be reached.");
  }
}

// ---------------------------------------------------------------------------
// Vercel
// ---------------------------------------------------------------------------

/**
 * `unknown` is deliberately distinct from `building`.  Folding every
 * unrecognised readyState into "building" reports a deploy in progress that
 * may not exist, and a card should not invent a reason it does not have.
 */
type VercelDeployState = "ready" | "failed" | "building" | "unknown" | "none";

function vercelProductionState(project: Record<string, unknown>): VercelDeployState {
  const production = asRecord(asRecord(project.targets)?.production);
  const latest = asRecord(asArray(project.latestDeployments)[0]);
  const raw = readText(production?.readyState, 24) ?? readText(latest?.readyState, 24);
  if (!raw) return "none";
  const state = raw.toUpperCase();
  if (state === "READY") return "ready";
  if (state === "ERROR" || state === "CANCELED" || state === "CANCELLED") return "failed";
  if (
    state === "BUILDING" ||
    state === "QUEUED" ||
    state === "INITIALIZING" ||
    state === "UPLOADING"
  ) {
    return "building";
  }
  return "unknown";
}

async function probeVercel(): Promise<PlatformProbeResult> {
  const token = envValue(...VERCEL_TOKEN_ENV);
  if (!token) return missingCredentials("Vercel");
  const teamId = envValue("VERCEL_TEAM_ID");

  try {
    const params = new URLSearchParams({ limit: "100" });
    if (teamId) params.set("teamId", teamId);
    const response = await requestJson(`https://api.vercel.com/v9/projects?${params}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      return upstreamFailure(response.status, upstreamHeadline("Vercel", response.status));
    }

    const projects = asRecord(response.data)?.projects;
    if (!Array.isArray(projects)) return malformed("Vercel");

    const failed: string[] = [];
    let total = 0;
    let ready = 0;
    let building = 0;
    for (const row of projects.slice(0, MAX_ROWS)) {
      const project = asRecord(row);
      if (!project) continue;
      total += 1;
      const state = vercelProductionState(project);
      if (state === "ready") ready += 1;
      else if (state === "building") building += 1;
      else if (state === "failed") failed.push(displayName(project.name, "a project"));
    }

    const metrics: PlatformMetric[] = [
      metric("Projects", count(total)),
      metric("Production Ready", count(ready)),
      metric("Failed", count(failed.length)),
      metric("Building", count(building)),
    ];

    if (failed.length > 0) {
      return {
        state: "degraded",
        headline: `${count(ready)} of ${count(total)} Vercel projects have a ready production deployment.  ${problemSentence(failed, "failed to deploy", "failed to deploy", "A project")}`,
        metrics,
      };
    }

    // A project with no ready production deployment is not healthy just
    // because nothing reported an outright failure: it is either mid-build or
    // in a state we could not classify, and both mean production is not
    // confirmed live.  Returning healthy here produced a green card whose own
    // headline read "0 of 1 projects have a ready production deployment".
    if (total > 0 && ready < total) {
      const unclassified = total - ready - building;
      return {
        state: "degraded",
        headline:
          building > 0 && unclassified === 0
            ? `${count(ready)} of ${count(total)} Vercel projects have a ready production deployment.  ${count(building)} still building.`
            : `${count(ready)} of ${count(total)} Vercel projects have a ready production deployment.`,
        metrics,
        error: building > 0 && unclassified === 0 ? "deploy_in_progress" : "not_ready",
      };
    }

    return {
      state: "healthy",
      headline:
        total === 0
          ? "Vercel has no projects in this scope."
          : `All ${count(total)} Vercel projects have a ready production deployment.`,
      metrics,
    };
  } catch (error) {
    return failureResult(error, "Vercel could not be reached.");
  }
}

// ---------------------------------------------------------------------------
// Netlify
// ---------------------------------------------------------------------------

type NetlifyBucket = "published" | "failed" | "unpublished";

/**
 * Netlify exposes the deploy currently serving a site as `published_deploy`.
 * Only a "ready" one is actually live: a site with no such record has never
 * published, and any other state ("building", "enqueued", "canceled", …) means
 * the site is not serving that deploy.  Both land in `unpublished` rather than
 * in no bucket at all, so the three counts always add up to the site total and
 * a site this monitor cannot vouch for keeps the card off "healthy".
 */
function classifyNetlifySite(site: Record<string, unknown>): NetlifyBucket {
  const state = (readText(asRecord(site.published_deploy)?.state, 24) ?? "").toLowerCase();
  if (state === "ready") return "published";
  if (state === "error" || state === "failed") return "failed";
  return "unpublished";
}

async function probeNetlify(): Promise<PlatformProbeResult> {
  const token = envValue("NETLIFY_API_TOKEN");
  if (!token) return missingCredentials("Netlify");

  try {
    const response = await requestJson("https://api.netlify.com/api/v1/sites?per_page=100", {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      return upstreamFailure(response.status, upstreamHeadline("Netlify", response.status));
    }
    if (!Array.isArray(response.data)) return malformed("Netlify");

    const names: Record<NetlifyBucket, string[]> = {
      published: [],
      failed: [],
      unpublished: [],
    };
    for (const row of asArray(response.data).slice(0, MAX_ROWS)) {
      const site = asRecord(row);
      if (!site) continue;
      names[classifyNetlifySite(site)].push(displayName(site.name, "a site"));
    }

    const published = names.published.length;
    const total = published + names.failed.length + names.unpublished.length;
    const metrics: PlatformMetric[] = [
      metric("Sites", count(total)),
      metric("Published", count(published)),
      metric("Failed Builds", count(names.failed.length)),
      metric("Not Published", count(names.unpublished.length)),
    ];

    // Worst state wins the second sentence, so the headline names the site the
    // owner should look at first.
    let problem: string | null = null;
    if (names.failed.length > 0) {
      problem = problemSentence(names.failed, "failed to build", "failed to build", "A site");
    } else if (names.unpublished.length > 0) {
      problem = problemSentence(
        names.unpublished,
        "has no published deploy",
        "have no published deploy",
        "A site"
      );
    }

    if (problem) {
      return {
        state: "degraded",
        headline: `${count(published)} of ${count(total)} Netlify sites have a published deploy.  ${problem}`,
        metrics,
      };
    }

    return {
      state: "healthy",
      headline:
        total === 0
          ? "Netlify has no sites in this account."
          : `All ${count(total)} Netlify sites have a published deploy.`,
      metrics,
    };
  } catch (error) {
    return failureResult(error, "Netlify could not be reached.");
  }
}

// ---------------------------------------------------------------------------
// Fly.io
// ---------------------------------------------------------------------------

async function probeFly(): Promise<PlatformProbeResult> {
  const token = envValue("FLY_API_TOKEN");
  if (!token) return missingCredentials("Fly.io");
  const org = envValue("FLY_ORG_SLUG") ?? "personal";

  try {
    const response = await requestJson(
      `https://api.machines.dev/v1/apps?org_slug=${encodeURIComponent(org)}`,
      { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) {
      return upstreamFailure(response.status, upstreamHeadline("Fly.io", response.status));
    }

    const body = asRecord(response.data);
    if (!body || !Array.isArray(body.apps)) return malformed("Fly.io");

    const idle: string[] = [];
    let total = 0;
    let machines = 0;
    for (const row of asArray(body.apps).slice(0, MAX_ROWS)) {
      const app = asRecord(row);
      if (!app) continue;
      total += 1;
      const machineCount = finiteNumber(app.machine_count) ?? 0;
      machines += machineCount;
      if (machineCount <= 0) idle.push(displayName(app.name, "an app"));
    }

    const metrics: PlatformMetric[] = [
      metric("Apps", count(total)),
      metric("Machines", count(machines)),
      metric("Organization", displayName(org, "personal")),
    ];

    if (idle.length > 0) {
      return {
        state: "degraded",
        headline: `Fly.io reports ${count(total)} apps on ${count(machines)} machines.  ${problemSentence(idle, "has no machines", "have no machines", "An app")}`,
        metrics,
      };
    }

    return {
      state: "healthy",
      headline:
        total === 0
          ? "Fly.io has no apps in this organization."
          : `Fly.io reports ${count(total)} apps on ${count(machines)} machines.`,
      metrics,
    };
  } catch (error) {
    return failureResult(error, "Fly.io could not be reached.");
  }
}

// ---------------------------------------------------------------------------
// Railway
// ---------------------------------------------------------------------------

/**
 * Inventory only, on purpose.
 *
 * A Railway service does not have one runtime state: it has one deployment per
 * environment (production, staging, every PR environment), so "is this service
 * running" has no single answer that one bounded query can return — and a
 * nested per-service deployment connection across every project is exactly the
 * kind of query Railway rejects for cost on a larger account.  Rather than
 * guess, this probe reports what it can actually see — how many projects and
 * services exist — and says plainly that deployment status is not part of it.
 * A stopped or crashed service must never be summarized as running here.
 */
const RAILWAY_QUERY =
  "query { me { projects { edges { node { id name services { edges { node { id } } } } } } } }";

async function probeRailway(): Promise<PlatformProbeResult> {
  const token = envValue("RAILWAY_API_TOKEN");
  if (!token) return missingCredentials("Railway");

  try {
    const response = await requestJson("https://backboard.railway.com/graphql/v2", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: RAILWAY_QUERY }),
    });
    if (!response.ok) {
      return upstreamFailure(response.status, upstreamHeadline("Railway", response.status));
    }

    const body = asRecord(response.data);
    if (!body) return malformed("Railway");
    // GraphQL reports auth and permission problems in a 200 body, so the
    // errors array has to be checked even on an ok response.
    if (asArray(body.errors).length > 0) {
      return {
        state: "degraded",
        headline: "Railway returned a GraphQL error for the projects query.",
        metrics: [],
        error: "graphql_error",
      };
    }

    const edges = asRecord(asRecord(asRecord(body.data)?.me)?.projects)?.edges;
    if (!Array.isArray(edges)) return malformed("Railway");

    let projects = 0;
    let services = 0;
    for (const edge of edges.slice(0, MAX_ROWS)) {
      const node = asRecord(asRecord(edge)?.node);
      if (!node) continue;
      projects += 1;
      services += asArray(asRecord(node.services)?.edges).length;
    }

    const metrics: PlatformMetric[] = [
      metric("Projects", count(projects)),
      metric("Services", count(services)),
      metric("Deployment Status", "Not checked", "inventory only"),
    ];

    return {
      state: "healthy",
      headline:
        projects === 0
          ? "Railway has no projects on this account."
          : `Railway lists ${formatCount(projects, "project")} with ${formatCount(services, "service")}.  Deployment status is not checked.`,
      metrics,
    };
  } catch (error) {
    return failureResult(error, "Railway could not be reached.");
  }
}

// ---------------------------------------------------------------------------
// DigitalOcean
// ---------------------------------------------------------------------------

async function probeDigitalOcean(): Promise<PlatformProbeResult> {
  const token = envValue("DIGITALOCEAN_API_TOKEN");
  if (!token) return missingCredentials("DigitalOcean");

  try {
    const response = await requestJson(
      "https://api.digitalocean.com/v2/droplets?per_page=100",
      { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) {
      return upstreamFailure(response.status, upstreamHeadline("DigitalOcean", response.status));
    }

    const body = asRecord(response.data);
    if (!body || !Array.isArray(body.droplets)) return malformed("DigitalOcean");

    const stopped: string[] = [];
    let total = 0;
    let active = 0;
    for (const row of asArray(body.droplets).slice(0, MAX_ROWS)) {
      const droplet = asRecord(row);
      if (!droplet) continue;
      total += 1;
      const status = (readText(droplet.status, 24) ?? "unknown").toLowerCase();
      if (status === "active") active += 1;
      else stopped.push(displayName(droplet.name, "a droplet"));
    }

    const metrics: PlatformMetric[] = [
      metric("Droplets", count(total)),
      metric("Active", count(active)),
      metric("Not Active", count(stopped.length)),
    ];

    if (stopped.length > 0) {
      return {
        state: "degraded",
        headline: `${count(active)} of ${count(total)} DigitalOcean droplets are active.  ${problemSentence(stopped, "is not active", "are not active", "A droplet")}`,
        metrics,
      };
    }

    return {
      state: "healthy",
      headline:
        total === 0
          ? "DigitalOcean has no droplets in this account."
          : `All ${count(total)} DigitalOcean droplets are active.`,
      metrics,
    };
  } catch (error) {
    return failureResult(error, "DigitalOcean could not be reached.");
  }
}

// ---------------------------------------------------------------------------
// Registry entries — display order is this order.
// ---------------------------------------------------------------------------

export const HOSTING_PROBES: readonly PlatformProbe[] = [
  {
    id: "hetzner",
    name: "Hetzner Cloud",
    category: "hosting",
    requiredEnv: ["HCLOUD_TOKEN", "HETZNER_SERVER_ID"],
    consoleUrl: "https://console.hetzner.cloud/",
    isConfigured: () => hasEnv(...HETZNER_TOKEN_ENV),
    probe: probeHetzner,
  },
  {
    id: "coolify",
    name: "Coolify",
    category: "hosting",
    requiredEnv: ["COOLIFY_SERVER_STATS", "COOLIFY_HOST"],
    consoleUrl: DEFAULT_COOLIFY_HOST,
    isConfigured: () => hasEnv(...COOLIFY_TOKEN_ENV),
    probe: probeCoolify,
  },
  {
    id: "render",
    name: "Render",
    category: "hosting",
    requiredEnv: ["RENDER_API_KEY"],
    consoleUrl: "https://dashboard.render.com",
    isConfigured: () => hasEnv(...RENDER_TOKEN_ENV),
    probe: probeRender,
  },
  {
    id: "vercel",
    name: "Vercel",
    category: "hosting",
    requiredEnv: ["VERCEL_API_TOKEN"],
    consoleUrl: "https://vercel.com/dashboard",
    isConfigured: () => hasEnv(...VERCEL_TOKEN_ENV),
    probe: probeVercel,
  },
  {
    id: "netlify",
    name: "Netlify",
    category: "hosting",
    requiredEnv: ["NETLIFY_API_TOKEN"],
    consoleUrl: "https://app.netlify.com",
    isConfigured: () => hasEnv("NETLIFY_API_TOKEN"),
    probe: probeNetlify,
  },
  {
    id: "fly-io",
    name: "Fly.io",
    category: "hosting",
    requiredEnv: ["FLY_API_TOKEN"],
    consoleUrl: "https://fly.io/dashboard",
    isConfigured: () => hasEnv("FLY_API_TOKEN"),
    probe: probeFly,
  },
  {
    id: "railway",
    name: "Railway",
    category: "hosting",
    requiredEnv: ["RAILWAY_API_TOKEN"],
    consoleUrl: "https://railway.com/dashboard",
    isConfigured: () => hasEnv("RAILWAY_API_TOKEN"),
    probe: probeRailway,
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    category: "hosting",
    requiredEnv: ["DIGITALOCEAN_API_TOKEN"],
    consoleUrl: "https://cloud.digitalocean.com/droplets",
    isConfigured: () => hasEnv("DIGITALOCEAN_API_TOKEN"),
    probe: probeDigitalOcean,
  },
];
