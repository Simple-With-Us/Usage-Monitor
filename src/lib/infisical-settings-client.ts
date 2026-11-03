import "server-only";
import { InfisicalWriteError, type InfisicalSettings } from "@jaywedgeworth22/congress-trading-shared";
import type { InfisicalConnection } from "./infisical-connections";
import { authorizeInfisical, infisicalJson, infisicalSecretApi, infisicalSecretParams, InfisicalAuthError, requireConcreteInfisicalValue, requireInfisicalSecretIdentity } from "./infisical-auth";

export function createRoutedInfisicalSettings(connection: InfisicalConnection, options: { baseUrl?: string; fetchImpl?: typeof fetch; refreshIntervalMs?: number } = {}): InfisicalSettings {
  let cache = new Map<string, string>();
  let locations = new Map<string, string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  async function refresh() {
    const next = new Map<string, string>();
    const paths = new Map<string, string>();
    for (const path of connection.readPaths) {
      const token = await authorizeInfisical(connection, path, "read", options);
      const body = await infisicalJson(`${infisicalSecretApi(connection)}?${infisicalSecretParams(connection, path, true)}`, { headers: { authorization: `Bearer ${token}` } }, options);
      if (!Array.isArray(body.secrets)) throw new InfisicalAuthError("invalid_response");
      for (const record of body.secrets) {
        if (!record || typeof record !== "object") throw new InfisicalAuthError("invalid_response");
        const entry = record as Record<string, unknown>;
        if (typeof entry.secretKey !== "string" || typeof entry.secretValue !== "string") throw new InfisicalAuthError("invalid_response");
        if (connection.mode === "service-tokens") requireInfisicalSecretIdentity(connection, path, entry);
        if (next.has(entry.secretKey)) throw new InfisicalAuthError("ambiguous_secret_folder");
        next.set(entry.secretKey, connection.mode === "service-tokens" ? requireConcreteInfisicalValue(entry.secretValue) : entry.secretValue);
        paths.set(entry.secretKey, path);
      }
    }
    cache = next;
    locations = paths;
  }
  return {
    async init() {
      await refresh();
      const interval = options.refreshIntervalMs ?? 300_000;
      if (interval > 0) {
        timer = setInterval(() => { void refresh().catch(() => console.error("[app-settings] Infisical refresh failed; keeping cached settings")); }, interval);
        timer.unref?.();
      }
    },
    get: (key) => cache.get(key),
    has: (key) => cache.has(key),
    getAll: () => Object.fromEntries(cache),
    getRequired(key) { const value = cache.get(key); if (value === undefined) throw new Error("Required Infisical setting is absent"); return value; },
    refresh,
    stop() { if (timer) clearInterval(timer); timer = undefined; },
    async set(key, value) {
      try {
        const path = locations.get(key) ?? connection.secretPath;
        const token = await authorizeInfisical(connection, path, "write", options);
        const api = `${infisicalSecretApi(connection)}/${encodeURIComponent(key)}`;
        const body = JSON.stringify({ [connection.mode === "service-tokens" ? "workspaceId" : "projectId"]: connection.projectId, environment: "prod", secretPath: path, type: "shared", secretValue: value });
        const init = { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body };
        try { await infisicalJson(api, { ...init, method: "PATCH" }, options); }
        catch (error) {
          if (!(error instanceof InfisicalAuthError) || error.code !== "http_404") throw error;
          await infisicalJson(api, { ...init, method: "POST" }, options);
        }
        cache.set(key, value);
        locations.set(key, path);
      } catch { throw new InfisicalWriteError(key, "save rejected"); }
    },
  };
}
