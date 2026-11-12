import {
  AdapterError,
  configurationError,
  errorResult,
  fetchJson,
  type FetchJsonOptions,
  type UsageResult,
} from "./helpers";

// Coolify Cloud's own hosted control plane. Self-hosted instances (the common
// case - Coolify is primarily a self-hosted PaaS) configure `host` to their
// own origin, e.g. https://coolify.example.com, which is treated as an
// untrusted/SSRF-checked outbound URL (see fetchOptions below).
const DEFAULT_HOST = "https://app.coolify.io";

// Bounds the number of per-server `/servers/{uuid}/resources` calls this
// adapter makes on one poll. That endpoint is supplementary detail (it adds
// database/service status beyond what /applications alone reports); capping
// it keeps one large fleet from fanning out into an unbounded number of
// requests. The core server/application health snapshot never depends on it.
const MAX_SERVERS_FOR_RESOURCE_DETAIL = 50;

interface CoolifyServerSettings {
  is_reachable?: unknown;
  is_usable?: unknown;
}

interface CoolifyServer {
  uuid?: unknown;
  name?: unknown;
  ip?: unknown;
  description?: unknown;
  is_reachable?: unknown;
  is_usable?: unknown;
  settings?: CoolifyServerSettings | null;
}

interface CoolifyApplication {
  uuid?: unknown;
  name?: unknown;
  fqdn?: unknown;
  status?: unknown;
  build_pack?: unknown;
}

interface CoolifyServerResource {
  uuid?: unknown;
  name?: unknown;
  type?: unknown;
  status?: unknown;
}

interface ParsedStatus {
  state: string;
  health: string | null;
  // "running" (Coolify's Docker-derived state string) is the sole documented
  // up signal; every other state (exited, restarting, degraded, etc.) is down.
  up: boolean;
  degraded: boolean;
}

interface ServerResourceSummary {
  uuid: string | null;
  name: string | null;
  type: string | null;
  status: string | null;
  state: string | null;
  health: string | null;
  up: boolean | null;
  degraded: boolean;
}

interface ServerSummary {
  uuid: string;
  name: string | null;
  ip: string | null;
  description: string | null;
  reachable: boolean | null;
  usable: boolean | null;
  up: boolean | null;
  resources: ServerResourceSummary[] | null;
  resourcesState: "ready" | "unavailable" | "skipped";
}

interface ApplicationSummary {
  uuid: string;
  name: string | null;
  fqdn: string | null;
  status: string | null;
  state: string | null;
  health: string | null;
  up: boolean | null;
  degraded: boolean;
  deployed: boolean;
  buildPack: string | null;
}

function invalidResponse(message: string): never {
  throw new AdapterError(`Coolify: ${message}`, { code: "INVALID_RESPONSE" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function fetchOptions(host: string): FetchJsonOptions {
  return {
    security: host === DEFAULT_HOST ? "trusted" : "untrusted",
    maxResponseBytes: 4 * 1024 * 1024,
  };
}

// Coolify's composite Docker-derived status string is `{state}` or
// `{state}:{health}` (e.g. "running", "running:healthy", "running:unhealthy",
// "exited", "restarting:starting"). Applications that have never been
// deployed report a null/empty status.
function parseStatus(status: unknown): ParsedStatus | null {
  const raw = stringValue(status);
  if (!raw) return null;
  const [statePart, healthPart] = raw.split(":");
  const state = statePart.trim().toLowerCase() || "unknown";
  const health = healthPart?.trim().toLowerCase() || null;
  const up = state === "running";
  const degraded = up && health === "unhealthy";
  return { state, health, up, degraded };
}

async function fetchServers(
  host: string,
  headers: Record<string, string>
): Promise<CoolifyServer[]> {
  const response = await fetchJson(
    `${host}/api/v1/servers`,
    { headers },
    fetchOptions(host)
  );
  if (!response.ok) {
    return errorResult(response.status, { note: "Coolify servers request failed" });
  }
  if (!Array.isArray(response.data)) {
    invalidResponse("servers response must be an array");
  }
  for (const row of response.data) {
    if (!isRecord(row)) invalidResponse("servers response contained a non-object entry");
  }
  return response.data as CoolifyServer[];
}

async function fetchApplications(
  host: string,
  headers: Record<string, string>
): Promise<CoolifyApplication[]> {
  const response = await fetchJson(
    `${host}/api/v1/applications`,
    { headers },
    fetchOptions(host)
  );
  if (!response.ok) {
    return errorResult(response.status, { note: "Coolify applications request failed" });
  }
  if (!Array.isArray(response.data)) {
    invalidResponse("applications response must be an array");
  }
  for (const row of response.data) {
    if (!isRecord(row)) invalidResponse("applications response contained a non-object entry");
  }
  return response.data as CoolifyApplication[];
}

// Best-effort per-server resource detail (applications + databases +
// services on that server). This is supplementary: a failure here only
// downgrades that one server's `resourcesState`, it never fails the poll -
// the core server/application health snapshot already stands on its own.
async function fetchServerResources(
  host: string,
  headers: Record<string, string>,
  uuid: string
): Promise<ServerResourceSummary[] | null> {
  try {
    const response = await fetchJson(
      `${host}/api/v1/servers/${encodeURIComponent(uuid)}/resources`,
      { headers },
      fetchOptions(host)
    );
    if (!response.ok || !Array.isArray(response.data)) return null;
    const resources: ServerResourceSummary[] = [];
    for (const row of response.data) {
      if (!isRecord(row)) return null;
      const resource = row as CoolifyServerResource;
      const parsed = parseStatus(resource.status);
      resources.push({
        uuid: stringValue(resource.uuid),
        name: stringValue(resource.name),
        type: stringValue(resource.type),
        status: stringValue(resource.status),
        state: parsed?.state ?? null,
        health: parsed?.health ?? null,
        up: parsed?.up ?? null,
        degraded: parsed?.degraded ?? false,
      });
    }
    return resources;
  } catch {
    return null;
  }
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  if (!apiKey || !apiKey.trim()) {
    configurationError("Coolify API token is required");
  }
  const configuredHost = config?.host;
  if (configuredHost != null && typeof configuredHost !== "string") {
    configurationError("host must be a string");
  }
  const host = (configuredHost?.trim() || DEFAULT_HOST).replace(/\/+$/, "");

  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  // Both calls read the same team-scoped `read` ability, so there is no
  // realistic scenario where one succeeds and the other fails on
  // authorization alone; fetching them together keeps the adapter simple
  // while still failing with a typed, gracefully-handled AdapterError (never
  // an unhandled crash) when the token is invalid or lacks access.
  const [rawServers, rawApplications] = await Promise.all([
    fetchServers(host, headers),
    fetchApplications(host, headers),
  ]);

  const servers: ServerSummary[] = [];
  for (const server of rawServers) {
    const uuid = stringValue(server.uuid);
    if (!uuid) invalidResponse("a server was returned without a uuid");
    // is_reachable/is_usable are injected at the top level by GET /servers,
    // with the same values also nested under settings; accept either shape
    // defensively without weakening the requirement that at least one is
    // present as a real boolean.
    const reachable =
      optionalBoolean(server.is_reachable) ?? optionalBoolean(server.settings?.is_reachable);
    const usable =
      optionalBoolean(server.is_usable) ?? optionalBoolean(server.settings?.is_usable);
    servers.push({
      uuid,
      name: stringValue(server.name),
      ip: stringValue(server.ip),
      description: stringValue(server.description),
      reachable,
      usable,
      up: reachable == null || usable == null ? null : reachable && usable,
      resources: null,
      resourcesState: "skipped",
    });
  }

  const applications: ApplicationSummary[] = [];
  for (const application of rawApplications) {
    const uuid = stringValue(application.uuid);
    if (!uuid) invalidResponse("an application was returned without a uuid");
    const parsed = parseStatus(application.status);
    applications.push({
      uuid,
      name: stringValue(application.name),
      fqdn: stringValue(application.fqdn),
      status: stringValue(application.status),
      state: parsed?.state ?? null,
      health: parsed?.health ?? null,
      up: parsed?.up ?? null,
      degraded: parsed?.degraded ?? false,
      // A null/empty status means the application has never been deployed,
      // not that its (nonexistent) container is down.
      deployed: parsed != null,
      buildPack: stringValue(application.build_pack),
    });
  }

  // Enrich each server with its defined resources (apps + databases +
  // services), bounded and best-effort. Any server past the bound, or whose
  // individual call fails, is simply left at its default "skipped"/
  // "unavailable" state rather than affecting the rest of the snapshot.
  const truncatedResourceDetail = servers.length > MAX_SERVERS_FOR_RESOURCE_DETAIL;
  const serversForResourceDetail = servers.slice(0, MAX_SERVERS_FOR_RESOURCE_DETAIL);
  const resourceResults = await Promise.all(
    serversForResourceDetail.map((server) => fetchServerResources(host, headers, server.uuid))
  );
  serversForResourceDetail.forEach((server, index) => {
    const resources = resourceResults[index];
    server.resources = resources;
    server.resourcesState = resources == null ? "unavailable" : "ready";
  });

  const serversUp = servers.filter((server) => server.up === true).length;
  const serversDown = servers.filter((server) => server.up === false).length;
  const applicationsDeployed = applications.filter((app) => app.deployed);
  const applicationsUp = applicationsDeployed.filter((app) => app.up === true).length;
  const applicationsDown = applicationsDeployed.filter((app) => app.up === false).length;
  const applicationsDegraded = applications.filter((app) => app.degraded).length;

  return {
    balance: null,
    // Coolify (self-hosted or Cloud) exposes no billing/invoice API to this
    // connector - it is infrastructure control plane, not a metered vendor.
    // This is intentionally left null/omitted rather than reporting $0, which
    // would falsely claim a verified zero cost.
    totalCost: null,
    // There is no natural "requests" or billable-unit concept for a
    // self-hosted control plane; left null rather than repurposing this
    // field for a count that could be misread as a request volume.
    totalRequests: null,
    credits: null,
    rawData: {
      host,
      servers: servers.map((server) => ({
        uuid: server.uuid,
        name: server.name,
        ip: server.ip,
        description: server.description,
        reachable: server.reachable,
        usable: server.usable,
        up: server.up,
        resources: server.resources,
        resourcesState: server.resourcesState,
      })),
      applications: applications.map((app) => ({
        uuid: app.uuid,
        name: app.name,
        fqdn: app.fqdn,
        status: app.status,
        state: app.state,
        health: app.health,
        up: app.up,
        degraded: app.degraded,
        deployed: app.deployed,
        buildPack: app.buildPack,
      })),
      resourceCounts: {
        servers: servers.length,
        serversUp,
        serversDown,
        applications: applications.length,
        applicationsDeployed: applicationsDeployed.length,
        applicationsUp,
        applicationsDown,
        applicationsDegraded,
      },
      capabilities: {
        serverReachability: true,
        applicationHealth: true,
        // CPU/memory/disk utilization is pushed by Coolify's optional
        // Sentinel agent into the instance's own database; it is not exposed
        // through any documented GET endpoint of the public REST API this
        // connector reads, so it is never fabricated here.
        resourceUsageMetrics: false,
        perServerResourceInventory: truncatedResourceDetail ? "partial" : "ready",
        billing: false,
      },
    },
  };
}
