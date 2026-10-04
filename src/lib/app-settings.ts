// =============================================================================
// app-settings — Infisical sole-source-of-truth for app-level tunable knobs
// =============================================================================
//
// "Truth" per INFISICAL.md: secrets AND env config AND tunable settings knobs
// live in the Infisical `usage-monitor` project.  This module owns the
// *tunable knobs* an admin changes without a code deploy: adapter timeouts,
// ingest emergency switches, alert routing knobs, readiness thresholds, and
// the settings refresh interval itself.
//
// Secrets (tokens, keys, DSNs, DATABASE_URL, ENCRYPTION_KEY, DASHBOARD_PASSWORD)
// and other service config stay in process.env, populated from the SAME
// Infisical project by the existing Infisical→Coolify env sync (the deployment
// path).  See INFISICAL.md for the full inventory and the boundary.
//
// Runtime contract (fleet-wide canonical pattern):
//   - init()        loads every secret for the project+environment into an
//                   in-memory cache at startup.  When universal-auth
//                   credentials are absent (local dev, CI, build) it stays in
//                   env-fallback mode and reads process.env live — no network.
//                   When credentials ARE present but the Infisical load fails,
//                   it logs LOUDLY and stays in env-fallback mode: the
//                   deploy-time env sync already carries Infisical values, so
//                   staleness is safer than a failed boot.
//   - get()/getBool()/getInt()/getFloat()  read memory ONLY in Infisical
//                   mode.  They never touch the network, so they are safe in
//                   hot request/tick paths.
//   - refresh()     re-reads Infisical and swaps the cache on success.  On
//                   failure it logs loudly and keeps the last-known-good
//                   cache.  Runs automatically every INFISICAL_SETTINGS_REFRESH_MS
//                   (default 5 min) and on SIGHUP (wired in instrumentation.ts).
//   - set()         write-through: validates against the schema below, writes
//                   to Infisical FIRST, then updates the cache.  If the
//                   Infisical write fails the save fails — cache and Infisical
//                   never diverge silently.  In env-fallback mode (no creds)
//                   it writes process.env, matching the pre-SOT local-dev
//                   behavior of the settings PUT route.
//   - settingsEnv() a process.env overlay for legacy default-parameter seams
//                   (readAlertDeliveryConfig, resolveUsageReadToken, ...):
//                   knob keys resolve through this service, everything else
//                   passes through to process.env unchanged.
//
// Edge-safety: this module has no import-time side effects and no node:
// imports, so importing it from edge-runtime code (middleware) is safe.
// init() is only ever called from instrumentation.ts on the nodejs runtime.

import {
  createInfisicalSettings,
  type InfisicalSettings,
} from "@jaywedgeworth22/congress-trading-shared";

/** Infisical project for this app (jays-services org).  See INFISICAL.md. */
export const APP_INFISICAL_PROJECT_ID = "86e35e51-91bc-4dfd-a045-4484726b9c40";

const DEFAULT_REFRESH_MS = 300_000; // 5 minutes, per the canonical pattern.

export type AppSettingType = "string" | "int" | "float" | "bool";

export interface AppSettingDef {
  /** The Infisical secret key (and env var name in env-fallback mode). */
  key: string;
  type: AppSettingType;
  /** Compiled default, used when the key is absent everywhere. */
  defaultValue: string;
  /** Inclusive numeric bounds (int/float). */
  min?: number;
  /** Inclusive numeric bounds (int/float). */
  max?: number;
  /** When true, `min` is exclusive (value must be > min). */
  minExclusive?: boolean;
  /** Allowed values for string settings (compared case-insensitively). */
  allowed?: string[];
  description: string;
}

/**
 * The full inventory of app-level tunable knobs owned by this module.
 * Every key here is writable through the admin PUT /api/settings/runtime
 * route (dashboard session only) with write-through to Infisical.
 * Non-sensitive defaults may exist in the Infisical project; secret keys
 * NEVER appear here — they ride the env-sync deployment path.
 */
export const APP_SETTING_DEFS: AppSettingDef[] = [
  {
    key: "ADAPTER_HTTP_TIMEOUT_MS",
    type: "int",
    defaultValue: "30000",
    min: 1,
    max: 600_000,
    description:
      "Per-request timeout (ms) for provider poll fetches in src/lib/adapters/helpers.ts.",
  },
  {
    key: "ADAPTER_PROVIDER_TIMEOUT_MS",
    type: "int",
    defaultValue: "90000",
    min: 1,
    max: 1_800_000,
    description:
      "Outer per-provider time budget (ms) in fetchAllDueProviders (src/lib/usage-recorder.ts).",
  },
  {
    key: "READY_DISK_WARN_FREE_BYTES",
    type: "int",
    defaultValue: String(5 * 1024 * 1024 * 1024),
    min: 0,
    description:
      "Free-bytes warn threshold reported by /api/ready checks.disk (observability only).",
  },
  {
    key: "OTLP_METRICS_INGEST_ENABLED",
    type: "bool",
    defaultValue: "true",
    description:
      "Emergency switch for the database-writing POST /api/otlp/v1/metrics route (explicit false → 503).",
  },
  {
    key: "OTLP_SYSTEM_METRICS_INGEST_ENABLED",
    type: "bool",
    defaultValue: "false",
    description:
      "Opt-in persistence of host system.* OTLP metrics (default-off: they flood ExternalUsageEvent).",
  },
  {
    key: "INGEST_COST_DERIVATION_ENABLED",
    type: "bool",
    defaultValue: "false",
    description:
      "Derive cost estimates for unpriced usage/token ingest events (metadata only; never cash).",
  },
  {
    key: "USAGE_INGEST_REQUIRE_SCOPED_TOKENS",
    type: "bool",
    defaultValue: "false",
    description:
      "When true, unscoped USAGE_INGEST_TOKEN ingest is denied; only per-producer scoped tokens work.",
  },
  {
    key: "USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK",
    type: "bool",
    defaultValue: "false",
    description:
      "Break-glass: allow USAGE_INGEST_TOKEN on read routes in production. Keep false.",
  },
  {
    key: "USAGE_SCHEDULER_ENABLED",
    type: "bool",
    defaultValue: "true",
    description:
      "Emergency switch for the in-process 15-minute poll scheduler (explicit false disables).",
  },
  {
    key: "ALERT_MIN_SEVERITY",
    type: "string",
    defaultValue: "warning",
    allowed: ["info", "warning", "critical"],
    description: "Minimum alert severity that gets delivered (alert-delivery).",
  },
  {
    key: "ALERT_EMAIL_ENABLED",
    type: "bool",
    defaultValue: "true",
    description: "Master enable for the email alert channel (Resend).",
  },
  {
    key: "ALERT_DISABLE_EMAIL",
    type: "bool",
    defaultValue: "false",
    description: "Hard-disable email alert delivery.",
  },
  {
    key: "ALERT_REMINDER_HOURS",
    type: "float",
    defaultValue: "24",
    min: 0,
    minExclusive: true,
    max: 24 * 30,
    description: "Cadence (hours) for re-reminding on still-open alert incidents.",
  },
  {
    key: "ALERT_DELIVERY_TIMEOUT_MS",
    type: "float",
    defaultValue: "10000",
    min: 1,
    max: 60_000,
    description: "Per-channel delivery timeout (ms) for alert webhooks/email.",
  },
  {
    key: "ALERT_DELIVERY_MAX_ATTEMPTS",
    type: "int",
    defaultValue: "3",
    min: 1,
    max: 5,
    description: "Max delivery attempts per alert channel.",
  },
  {
    key: "ALERT_UNASSIGNED_SPEND_FLOOR_USD",
    type: "float",
    defaultValue: "25",
    min: 0,
    max: 1_000_000,
    description:
      "Unassigned-spend floor (USD) below which project-budget alerts are suppressed.",
  },
  {
    key: "INFISICAL_SETTINGS_REFRESH_MS",
    type: "int",
    defaultValue: String(DEFAULT_REFRESH_MS),
    min: 60_000,
    max: 3_600_000,
    description:
      "Background cache refresh interval (ms). Restart-applied: it seeds the refresh timer at boot.",
  },
];

const SETTING_DEF_BY_KEY = new Map(APP_SETTING_DEFS.map((d) => [d.key, d]));
export const APP_SETTING_KEYS = new Set(SETTING_DEF_BY_KEY.keys());

export function getAppSettingDef(key: string): AppSettingDef | undefined {
  return SETTING_DEF_BY_KEY.get(key);
}

/** Infisical environment slug: UM_INFISICAL_ENV wins, else NODE_ENV mapping. */
export function resolveInfisicalEnvironment(
  env: NodeJS.ProcessEnv = process.env
): string {
  const explicit = env.UM_INFISICAL_ENV?.trim();
  if (explicit) return explicit;
  return env.NODE_ENV === "production" ? "prod" : "dev";
}

export interface AppSettingsCredentials {
  clientId?: string;
  clientSecret?: string;
}

function resolveCredentials(
  env: NodeJS.ProcessEnv = process.env
): AppSettingsCredentials {
  // Prefer dedicated runtime credentials; fall back to the shared fleet
  // automation machine identity (Admin on this project's usage-monitor
  // project — see INFISICAL.md).  Values are never logged.
  const clientId =
    env.INFISICAL_CLIENT_ID?.trim() ||
    env.INFISICAL_AUTOMATION_CLIENT_ID?.trim();
  const clientSecret =
    env.INFISICAL_CLIENT_SECRET?.trim() ||
    env.INFISICAL_AUTOMATION_CLIENT_SECRET?.trim();
  return {
    clientId: clientId || undefined,
    clientSecret: clientSecret || undefined,
  };
}

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw == null) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

function normalizeForWrite(def: AppSettingDef, value: string): string {
  const trimmed = value.trim();
  switch (def.type) {
    case "bool": {
      const parsed = parseBool(trimmed);
      if (parsed === undefined) {
        throw new Error(
          `Invalid boolean for "${def.key}": expected one of true/false/1/0/yes/no/on/off`
        );
      }
      return parsed ? "true" : "false";
    }
    case "int": {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new Error(`Invalid integer for "${def.key}"`);
      }
      assertBounds(def, parsed);
      return String(parsed);
    }
    case "float": {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid number for "${def.key}"`);
      }
      assertBounds(def, parsed);
      return String(parsed);
    }
    case "string": {
      if (def.allowed) {
        const lowered = trimmed.toLowerCase();
        const match = def.allowed.find((a) => a.toLowerCase() === lowered);
        if (!match) {
          throw new Error(
            `Invalid value for "${def.key}": expected one of ${def.allowed.join(", ")}`
          );
        }
        return match;
      }
      if (!trimmed) throw new Error(`Empty value for "${def.key}"`);
      return trimmed;
    }
  }
}

function assertBounds(def: AppSettingDef, value: number): void {
  if (def.min !== undefined) {
    const violates = def.minExclusive ? value <= def.min : value < def.min;
    if (violates) {
      throw new Error(
        `Value for "${def.key}" must be ${def.minExclusive ? ">" : ">="} ${def.min}`
      );
    }
  }
  if (def.max !== undefined && value > def.max) {
    throw new Error(`Value for "${def.key}" must be <= ${def.max}`);
  }
}

/** Read a raw string: Infisical cache when in Infisical mode, else process.env live. */
export type SettingsSource = "infisical" | "env" | "default";

export interface AppSettingMeta {
  key: string;
  type: AppSettingType;
  description: string;
  defaultValue: string;
  /** The effective value an admin would see (non-secret knobs only). */
  value: string;
  source: SettingsSource;
}

export class AppSettingsService {
  private client: InfisicalSettings | null = null;
  private infisicalMode = false;
  private initPromise: Promise<void> | null = null;
  private proxy: NodeJS.ProcessEnv | null = null;

  /**
   * Load settings at startup.  Safe to call multiple times (one flight).
   * Never throws for missing credentials or a failed Infisical load —
   * those degrade LOUDLY to env-fallback mode, because the deploy-time
   * env sync already carries Infisical values.
   */
  init(options?: {
    clientId?: string;
    clientSecret?: string;
    environment?: string;
    refreshIntervalMs?: number;
    infisicalUrl?: string;
    fetchImpl?: typeof fetch;
  }): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit(options ?? {});
    }
    return this.initPromise;
  }

  private async doInit(options: {
    clientId?: string;
    clientSecret?: string;
    environment?: string;
    refreshIntervalMs?: number;
    infisicalUrl?: string;
    fetchImpl?: typeof fetch;
  }): Promise<void> {
    const envCreds = resolveCredentials();
    const clientId = options.clientId ?? envCreds.clientId;
    const clientSecret = options.clientSecret ?? envCreds.clientSecret;
    if (!clientId || !clientSecret) {
      console.warn(
        "[app-settings] No Infisical universal-auth credentials " +
          "(INFISICAL_CLIENT_ID/INFISICAL_CLIENT_SECRET or " +
          "INFISICAL_AUTOMATION_CLIENT_ID/INFISICAL_AUTOMATION_CLIENT_SECRET); " +
          "running in env-fallback mode. Tunable knobs read process.env. See INFISICAL.md."
      );
      return;
    }
    const environment = options.environment ?? resolveInfisicalEnvironment();
    const refreshIntervalMs =
      options.refreshIntervalMs ??
      this.readRefreshIntervalMsFromEnv() ??
      DEFAULT_REFRESH_MS;
    const client = createInfisicalSettings({
      projectId: APP_INFISICAL_PROJECT_ID,
      environment,
      refreshIntervalMs,
      infisicalUrl: options.infisicalUrl,
      clientId,
      clientSecret,
      fetchImpl: options.fetchImpl,
      onRefreshError: (error) => {
        // The client already logs loudly; this hook is the seam for
        // alerting without ever receiving secret values.
        console.error(`[app-settings] background refresh hook: ${error.message}`);
      },
    });
    try {
      await client.init();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[app-settings] Infisical load failed for project ${APP_INFISICAL_PROJECT_ID} ` +
          `environment "${environment}": ${message}. Continuing in env-fallback mode; ` +
          `the deploy-time env sync already carries Infisical values. See INFISICAL.md.`
      );
      try {
        client.stop();
      } catch {
        // best effort
      }
      return;
    }
    this.client = client;
    this.infisicalMode = true;
    console.info(
      `[app-settings] Loaded settings from Infisical (project ${APP_INFISICAL_PROJECT_ID}, ` +
        `environment "${environment}", refresh every ${refreshIntervalMs} ms).`
    );
  }

  /** True once init() has completed (in either mode). */
  get initialized(): boolean {
    return this.initPromise !== null;
  }

  /** True when reads come from the live Infisical cache. */
  get isInfisicalMode(): boolean {
    return this.infisicalMode;
  }

  /** Raw string read.  Memory-only in Infisical mode; process.env in env mode. */
  get(key: string): string | undefined {
    if (this.infisicalMode && this.client) {
      return this.client.get(key);
    }
    const raw = process.env[key];
    return raw == null || raw === "" ? undefined : raw;
  }

  /** True when the key has a value (Infisical cache or env). Never hits the network. */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Snapshot of all knob values. Memory-only in Infisical mode. */
  getAll(): Record<string, string> {
    if (this.infisicalMode && this.client) {
      return this.client.getAll();
    }
    const out: Record<string, string> = {};
    for (const key of APP_SETTING_KEYS) {
      const value = process.env[key];
      if (value != null && value !== "") out[key] = value;
    }
    return out;
  }

  /**
   * Read a value, throwing a clear error (naming the key, pointing at
   * INFISICAL.md) if absent.  Never hits the network.
   */
  getRequired(key: string): string {
    const value = this.get(key);
    if (value === undefined) {
      const def = getAppSettingDef(key);
      throw new Error(
        `Missing required setting "${key}". Add it to the Infisical ` +
          `usage-monitor project (see INFISICAL.md)` +
          (def ? ` — compiled default is "${def.defaultValue}"` : "") +
          "."
      );
    }
    return value;
  }

  /** Raw read plus where it came from (for the admin surface). */
  getWithSource(key: string): { value: string | undefined; source: SettingsSource } {
    if (this.infisicalMode && this.client) {
      const value = this.client.get(key);
      if (value !== undefined) return { value, source: "infisical" };
    }
    const raw = process.env[key];
    if (raw != null && raw !== "") return { value: raw, source: "env" };
    return { value: undefined, source: "default" };
  }

  getBool(key: string, fallback: boolean): boolean {
    const parsed = parseBool(this.get(key));
    return parsed ?? fallback;
  }

  getInt(
    key: string,
    fallback: number,
    bounds?: { min?: number; max?: number; minExclusive?: boolean }
  ): number {
    const raw = this.get(key);
    if (raw == null) return fallback;
    const parsed = Number(raw.trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
    if (bounds?.min !== undefined) {
      const violates = bounds.minExclusive ? parsed <= bounds.min : parsed < bounds.min;
      if (violates) return fallback;
    }
    if (bounds?.max !== undefined && parsed > bounds.max) return fallback;
    return parsed;
  }

  getFloat(
    key: string,
    fallback: number,
    bounds?: { min?: number; max?: number; minExclusive?: boolean }
  ): number {
    const raw = this.get(key);
    if (raw == null) return fallback;
    const parsed = Number(raw.trim());
    if (!Number.isFinite(parsed)) return fallback;
    if (bounds?.min !== undefined) {
      const violates = bounds.minExclusive ? parsed <= bounds.min : parsed < bounds.min;
      if (violates) return fallback;
    }
    if (bounds?.max !== undefined && parsed > bounds.max) return fallback;
    return parsed;
  }

  /**
   * Write-through save for admin changes.  Validates against the schema,
   * writes to Infisical FIRST (when in Infisical mode), then updates the
   * cache.  A failed Infisical write rejects and the cache is untouched.
   * In env-fallback mode it writes process.env (local-dev parity with the
   * pre-SOT settings PUT behavior).
   */
  async set(key: string, value: string): Promise<string> {
    const def = getAppSettingDef(key);
    if (!def) {
      throw new Error(`"${key}" is not a writable app setting (see INFISICAL.md)`);
    }
    const normalized = normalizeForWrite(def, value);
    if (this.infisicalMode && this.client) {
      await this.client.set(key, normalized); // throws InfisicalWriteError on failure; cache untouched
    } else {
      process.env[key] = normalized;
    }
    return normalized;
  }

  /** On-demand refresh ("Reload settings" admin action, SIGHUP). */
  async refresh(): Promise<void> {
    if (this.infisicalMode && this.client) {
      await this.client.refresh();
    }
  }

  /** Admin-observable snapshot of every knob (values are non-secret). */
  getAllMeta(): AppSettingMeta[] {
    return APP_SETTING_DEFS.map((def) => {
      const { value, source } = this.getWithSource(def.key);
      return {
        key: def.key,
        type: def.type,
        description: def.description,
        defaultValue: def.defaultValue,
        value: value ?? def.defaultValue,
        source: value === undefined ? "default" : source,
      };
    });
  }

  /**
   * process.env overlay for legacy default-parameter seams: knob keys resolve
   * through this service; every other key passes through to process.env.
   * Only named property reads are intercepted (no enumeration traps), which
   * matches how the call sites use it.
   */
  settingsEnv(): NodeJS.ProcessEnv {
    if (!this.proxy) {
      const self = this;
      this.proxy = new Proxy(process.env, {
        get(target, prop, receiver) {
          if (typeof prop === "string" && APP_SETTING_KEYS.has(prop)) {
            return self.get(prop) ?? Reflect.get(target, prop, receiver);
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    }
    return this.proxy;
  }

  /** Stop the background refresh timer (shutdown / tests). */
  stop(): void {
    this.client?.stop();
  }

  /** Test-only: reset to a pristine uninitialized service. */
  _resetForTests(): void {
    this.stop();
    this.client = null;
    this.infisicalMode = false;
    this.initPromise = null;
    this.proxy = null;
  }

  private readRefreshIntervalMsFromEnv(): number | undefined {
    const raw = process.env.INFISICAL_SETTINGS_REFRESH_MS;
    if (raw == null || raw.trim() === "") return undefined;
    const parsed = Number(raw.trim());
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return undefined;
    if (parsed < 60_000 || parsed > 3_600_000) return undefined;
    return parsed;
  }
}

/** Process-wide singleton.  Call `await appSettings.init()` once at startup. */
export const appSettings = new AppSettingsService();
