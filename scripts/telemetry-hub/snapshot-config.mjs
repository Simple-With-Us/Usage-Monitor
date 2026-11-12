import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseReceiverSources } from "./otlp-receiver.mjs";

const KEYS = ["SENTRY_OTLP_ENDPOINT", "SENTRY_PUBLIC_KEY", "TELEMETRY_HUB_SOURCES_JSON"];
const MAX_BYTES = 1024 * 1024;

/** Read the explicitly mounted deployment snapshot; never search for credentials. */
export async function loadHubSnapshot(path) {
  let handle;
  try {
    if (typeof path !== "string" || !isAbsolute(path) || typeof constants.O_NOFOLLOW !== "number") throw new Error();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0));
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o7777) !== 0o600 || metadata.uid !== process.getuid() || metadata.size > MAX_BYTES) throw new Error();
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error();
    const config = JSON.parse(text);
    if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).length !== KEYS.length || KEYS.some((key) => typeof config[key] !== "string" || !config[key].trim())) throw new Error();
    const destination = new URL(config.SENTRY_OTLP_ENDPOINT);
    if (destination.protocol !== "https:" || !(destination.hostname === "sentry.io" || destination.hostname.endsWith(".sentry.io")) || !/^\/api\/\d+\/integration\/otlp\/?$/.test(destination.pathname) || destination.username || destination.password || destination.search || destination.hash || !/^[a-f0-9]+$/i.test(config.SENTRY_PUBLIC_KEY)) throw new Error();
    parseReceiverSources(config.TELEMETRY_HUB_SOURCES_JSON);
    return Object.fromEntries(KEYS.map((key) => [key, config[key]]));
  } catch { throw new Error("Hub snapshot is missing, insecure or invalid"); }
  finally { await handle?.close(); }
}

export async function hubBootstrapPlan(env = process.env) {
  const environment = { ...env };
  const bootstrapKeys = new Set(["INFISICAL_TOKEN", "INFISICAL_PROJECT_ID", "INFISICAL_API_URL"]);
  for (const key of Object.keys(environment)) if (key.startsWith("INFISICAL_") && !bootstrapKeys.has(key)) delete environment[key];
  if (env.TELEMETRY_HUB_CONFIG_FILE) {
    if (env.INFISICAL_TOKEN) throw new Error("Hub bootstrap modes are mutually exclusive");
    const snapshot = await loadHubSnapshot(env.TELEMETRY_HUB_CONFIG_FILE);
    delete environment.INFISICAL_TOKEN;
    return { command: process.execPath, args: ["scripts/telemetry-hub/launch-server.mjs"], env: { ...environment, ...snapshot } };
  }
  if (!env.INFISICAL_TOKEN || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(env.INFISICAL_PROJECT_ID || "")) throw new Error("Hub requires its existing scoped Infisical service token and project address");
  return { command: "infisical", args: [
    "run", "--silent", "--telemetry=false", "--env", "prod", "--path", "/telemetry",
    "--include-imports=false", "--recursive=false", "--expand=false", "--projectId", env.INFISICAL_PROJECT_ID,
    "--", "node", "scripts/telemetry-hub/launch-server.mjs",
  ], env: environment };
}
