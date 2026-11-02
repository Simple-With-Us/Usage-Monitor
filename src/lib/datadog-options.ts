// Shared, dependency-free Datadog env parsing for Usage Monitor.
//
// Reuses the existing fleet variable names from fleet-ops
// (`docs/DATADOG-INTEGRATION-GUIDE.md` and the host agent compose):
// DD_API_KEY, DD_SITE, DD_ENV, DD_SERVICE, DD_AGENT_HOST,
// DD_TRACE_AGENT_PORT, plus the public RUM twins NEXT_PUBLIC_DD_*.
// Never invents secret values.  A partial signal (some DD_* set, DD_SERVICE
// missing) throws instead of starting half-blind;  a fully unconfigured deploy
// stays dark unless DD_REQUIRE=1 asks for the fail-closed guard.

export type EnvMap = Record<string, string | undefined>;

export const DEFAULT_DD_SERVICE = "usage-monitor";
export const DEFAULT_DD_SITE = "us5.datadoghq.com";
export const DEFAULT_DD_ENV = "production";
export const DEFAULT_DD_AGENT_HOST = "127.0.0.1";
export const DEFAULT_DD_TRACE_AGENT_PORT = 8126;
export const PRODUCTION_TRACE_SAMPLE_RATE = 0.2;

export type DatadogSite =
  | "datadoghq.com"
  | "us3.datadoghq.com"
  | "us5.datadoghq.com"
  | "datadoghq.eu"
  | "ap1.datadoghq.com"
  | "ap2.datadoghq.com";

const SERVER_SIGNAL_KEYS = [
  "DD_SERVICE",
  "DD_ENV",
  "DD_AGENT_HOST",
  "DD_TRACE_AGENT_PORT",
  "DD_API_KEY",
  "DD_SITE",
  "DD_TRACE_ENABLED",
  "DD_TRACE_SAMPLE_RATE",
] as const;

// Only the public intake pair and the explicit RUM opt-in are keys.
// NEXT_PUBLIC_DD_SITE / SERVICE / ENV are labels.  Treating them as
// signals made a documented APM-only Infisical set (plus the .env.example
// twins) throw in register() and white-screen instrumentation-client.
const RUM_SIGNAL_KEYS = [
  "NEXT_PUBLIC_DD_APPLICATION_ID",
  "NEXT_PUBLIC_DD_CLIENT_TOKEN",
  "DD_RUM_ENABLED",
] as const;

export class DatadogConfigError extends Error {
  readonly missing: readonly string[];

  constructor(message: string, missing: readonly string[] = []) {
    super(message);
    this.name = "DatadogConfigError";
    this.missing = missing;
  }
}

export type DatadogServerConfig = {
  enabled: boolean;
  required: boolean;
  service: string;
  env: string;
  version: string;
  hostname: string;
  port: number;
  site: DatadogSite;
  sampleRate: number;
  logInjection: true;
  runtimeMetrics: true;
};

export type DatadogRumConfig = {
  enabled: boolean;
  applicationId: string;
  clientToken: string;
  site: DatadogSite;
  service: string;
  env: string;
  version: string;
  sessionSampleRate: number;
  sessionReplaySampleRate: 0;
};

export type DatadogReadiness = {
  required: boolean;
  apmConfigured: boolean;
  rumConfigured: boolean;
  service: string | null;
  env: string | null;
  site: DatadogSite | null;
  missing: readonly string[];
};

/** Trims an env var to a non-empty value, else undefined. */
export function nonEmptyEnv(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Map Coolify/handoff `prod` onto Datadog `production` so dashboards do not split. */
export function canonicalizeDatadogEnv(raw: string | undefined): string | undefined {
  const trimmed = nonEmptyEnv(raw);
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === "prod" || lower === "production") return "production";
  return trimmed;
}

export function isTruthyEnv(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function isFalsyEnv(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "no";
}

export function isNextBuildPhase(env: EnvMap = process.env): boolean {
  const phase = env.NEXT_PHASE?.trim();
  return (
    phase === "phase-production-build" || phase === "phase-development-build"
  );
}

export function isProductionRuntime(env: EnvMap = process.env): boolean {
  return env.NODE_ENV === "production" && !isNextBuildPhase(env);
}

function anySignal(env: EnvMap, keys: readonly string[]): boolean {
  return keys.some((key) => nonEmptyEnv(env[key]) !== undefined);
}

export function parseDatadogSite(
  raw: string | undefined,
  fallback: DatadogSite
): DatadogSite {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  switch (value) {
    case "datadoghq.com":
    case "us3.datadoghq.com":
    case "us5.datadoghq.com":
    case "datadoghq.eu":
    case "ap1.datadoghq.com":
    case "ap2.datadoghq.com":
      return value;
    default:
      throw new DatadogConfigError(
        `[datadog] unknown DD_SITE. Use an existing fleet site value.`
      );
  }
}

export function parseTraceAgentPort(
  raw: string | undefined,
  fallback: number
): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new DatadogConfigError(
      `[datadog] DD_TRACE_AGENT_PORT is not a valid TCP port.`
    );
  }
  return parsed;
}

export function parseSampleRate(
  raw: string | undefined,
  fallback: number
): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number.parseFloat(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new DatadogConfigError(
      `[datadog] DD_TRACE_SAMPLE_RATE must be a number between 0 and 1.`
    );
  }
  return parsed;
}

export function resolveDatadogVersion(env: EnvMap = process.env): string {
  return (
    nonEmptyEnv(env.DD_VERSION) ||
    nonEmptyEnv(env.NEXT_PUBLIC_DD_VERSION) ||
    nonEmptyEnv(env.SOURCE_COMMIT) ||
    nonEmptyEnv(env.GIT_COMMIT_SHA) ||
    nonEmptyEnv(env.NEXT_PUBLIC_GIT_COMMIT_SHA) ||
    "unknown"
  );
}

export function datadogBrowserIntakeOrigins(site: DatadogSite): string[] {
  switch (site) {
    case "datadoghq.com":
      return ["https://browser-intake-datadoghq.com"];
    case "us3.datadoghq.com":
      return ["https://browser-intake-us3-datadoghq.com"];
    case "us5.datadoghq.com":
      return ["https://browser-intake-us5-datadoghq.com"];
    case "datadoghq.eu":
      return ["https://browser-intake-datadoghq.eu"];
    case "ap1.datadoghq.com":
      return ["https://browser-intake-ap1-datadoghq.com"];
    case "ap2.datadoghq.com":
      return ["https://browser-intake-ap2-datadoghq.com"];
    default: {
      const exhaustive: never = site;
      throw new DatadogConfigError(
        `[datadog] unhandled site ${String(exhaustive)}`
      );
    }
  }
}

function missingMessage(missing: readonly string[]): string {
  return (
    `[datadog] refusing to start: missing ${missing.join(", ")}. ` +
    `Reuse the existing fleet Datadog env vars. ` +
    `Do not invent secrets. Set DD_TRACE_ENABLED=false only for throwaway containers.`
  );
}

export function resolveDatadogServerConfig(
  env: EnvMap = process.env
): DatadogServerConfig {
  const optedOut = isFalsyEnv(env.DD_TRACE_ENABLED);
  // Datadog is opt-in:  no deployment is required to run it.  DD_REQUIRE=1
  // restores the fail-closed guard for whoever wants it (fleet precedent:
  // ContactLogo's DD_REQUIRE).
  const required = isTruthyEnv(env.DD_REQUIRE) && !optedOut;
  const signaled = anySignal(env, SERVER_SIGNAL_KEYS);
  const fallbackSampleRate = isProductionRuntime(env)
    ? PRODUCTION_TRACE_SAMPLE_RATE
    : 1;

  const disabled: DatadogServerConfig = {
    enabled: false,
    required,
    service: DEFAULT_DD_SERVICE,
    env: DEFAULT_DD_ENV,
    version: resolveDatadogVersion(env),
    hostname: DEFAULT_DD_AGENT_HOST,
    port: DEFAULT_DD_TRACE_AGENT_PORT,
    site: DEFAULT_DD_SITE,
    sampleRate: fallbackSampleRate,
    logInjection: true,
    runtimeMetrics: true,
  };

  if (optedOut) {
    return { ...disabled, required: false };
  }

  const missing: string[] = [];
  if ((required || signaled) && !nonEmptyEnv(env.DD_SERVICE)) {
    missing.push("DD_SERVICE");
  }
  if (missing.length > 0) {
    throw new DatadogConfigError(missingMessage(missing), missing);
  }

  if (!required && !signaled) {
    return disabled;
  }

  return {
    enabled: true,
    required,
    service: nonEmptyEnv(env.DD_SERVICE) ?? DEFAULT_DD_SERVICE,
    env: canonicalizeDatadogEnv(env.DD_ENV) ?? DEFAULT_DD_ENV,
    version: resolveDatadogVersion(env),
    hostname: nonEmptyEnv(env.DD_AGENT_HOST) ?? DEFAULT_DD_AGENT_HOST,
    port: parseTraceAgentPort(env.DD_TRACE_AGENT_PORT, DEFAULT_DD_TRACE_AGENT_PORT),
    site: parseDatadogSite(env.DD_SITE, DEFAULT_DD_SITE),
    sampleRate: parseSampleRate(env.DD_TRACE_SAMPLE_RATE, fallbackSampleRate),
    logInjection: true,
    runtimeMetrics: true,
  };
}

export function resolveDatadogRumConfig(
  env: EnvMap = process.env
): DatadogRumConfig {
  const optedOut = isFalsyEnv(env.DD_RUM_ENABLED);
  const signaled = anySignal(env, RUM_SIGNAL_KEYS);
  const applicationId = nonEmptyEnv(env.NEXT_PUBLIC_DD_APPLICATION_ID);
  const clientToken = nonEmptyEnv(env.NEXT_PUBLIC_DD_CLIENT_TOKEN);
  const version = resolveDatadogVersion(env);

  const disabled: DatadogRumConfig = {
    enabled: false,
    applicationId: "",
    clientToken: "",
    site: DEFAULT_DD_SITE,
    service: DEFAULT_DD_SERVICE,
    env: DEFAULT_DD_ENV,
    version,
    sessionSampleRate: 100,
    sessionReplaySampleRate: 0,
  };

  if (optedOut) {
    return disabled;
  }

  if (!signaled && !applicationId && !clientToken) {
    return disabled;
  }

  const missing: string[] = [];
  if (!applicationId) missing.push("NEXT_PUBLIC_DD_APPLICATION_ID");
  if (!clientToken) missing.push("NEXT_PUBLIC_DD_CLIENT_TOKEN");
  if (missing.length > 0) {
    throw new DatadogConfigError(missingMessage(missing), missing);
  }

  return {
    enabled: true,
    applicationId: applicationId as string,
    clientToken: clientToken as string,
    site: parseDatadogSite(
      env.NEXT_PUBLIC_DD_SITE ?? env.DD_SITE,
      DEFAULT_DD_SITE
    ),
    service:
      nonEmptyEnv(env.NEXT_PUBLIC_DD_SERVICE) ??
      nonEmptyEnv(env.DD_SERVICE) ??
      DEFAULT_DD_SERVICE,
    env:
      canonicalizeDatadogEnv(env.NEXT_PUBLIC_DD_ENV) ??
      canonicalizeDatadogEnv(env.DD_ENV) ??
      DEFAULT_DD_ENV,
    version,
    sessionSampleRate: 100,
    sessionReplaySampleRate: 0,
  };
}

export function assertDatadogRuntimeConfig(env: EnvMap = process.env): {
  server: DatadogServerConfig;
  rum: DatadogRumConfig;
} {
  const server = resolveDatadogServerConfig(env);
  // RUM is optional and stays dark until both public intake vars exist.
  // A partial RUM pair must not abort APM / process boot — that path is
  // GET /api/datadog-public-config (503) and the client init (log, no UI).
  let rum: DatadogRumConfig;
  try {
    rum = resolveDatadogRumConfig(env);
  } catch (error) {
    if (error instanceof DatadogConfigError) {
      rum = {
        enabled: false,
        applicationId: "",
        clientToken: "",
        site: DEFAULT_DD_SITE,
        service: DEFAULT_DD_SERVICE,
        env: DEFAULT_DD_ENV,
        version: resolveDatadogVersion(env),
        sessionSampleRate: 100,
        sessionReplaySampleRate: 0,
      };
    } else {
      throw error;
    }
  }
  return { server, rum };
}

/**
 * Secret-free readiness view.  Never throws: incomplete config is reported
 * as missing key NAMES only.  Never includes token or API-key values.
 */
export function getDatadogReadiness(env: EnvMap = process.env): DatadogReadiness {
  const required =
    isTruthyEnv(env.DD_REQUIRE) && !isFalsyEnv(env.DD_TRACE_ENABLED);
  try {
    const server = resolveDatadogServerConfig(env);
    const rum = resolveDatadogRumConfig(env);
    return {
      required: server.required,
      apmConfigured: server.enabled,
      rumConfigured: rum.enabled,
      service: server.enabled ? server.service : null,
      env: server.enabled ? server.env : rum.enabled ? rum.env : null,
      site: server.enabled ? server.site : rum.enabled ? rum.site : null,
      missing: [],
    };
  } catch (error) {
    if (error instanceof DatadogConfigError) {
      return {
        required,
        apmConfigured: false,
        rumConfigured: false,
        service: null,
        env: null,
        site: null,
        missing: error.missing,
      };
    }
    throw error;
  }
}

export function datadogConnectSrcOrigins(env: EnvMap = process.env): string[] {
  try {
    const rum = resolveDatadogRumConfig(env);
    if (!rum.enabled) return [];
    return datadogBrowserIntakeOrigins(rum.site);
  } catch {
    return [];
  }
}
