#!/usr/bin/env node
import { constants, openSync, fstatSync, readSync, closeSync, realpathSync } from "node:fs";
import { isAbsolute, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { verifyServiceToken } from "./lib/infisical-service-token.mjs";

const PROJECT = "86e35e51-91bc-4dfd-a045-4484726b9c40";
const PROFILES = Object.freeze({
  kimi: ["kimi-usage-collector.mjs", "KIMI_CODE_INGEST_TOKEN", "KIMI_CODE_TELEMETRY_HUB_TOKEN"],
  zcode: ["zcode-usage-collector.mjs", "ZCODE_INGEST_TOKEN", "ZCODE_TELEMETRY_HUB_TOKEN"],
  "muse-code": ["muse-code-usage-collector.mjs", "MUSE_CODE_ACCESS_TOKEN", "MUSE_CODE_INGEST_TOKEN"],
});
const SETTINGS = ["HOME", "PATH", "TMPDIR", "LANG", "TZ", "USAGE_MACHINE_ID", "USAGE_MONITOR_INGEST_URL", "COLLECTOR_SENTRY_ENABLED", "COLLECTOR_TELEMETRY_HUB_ENDPOINT", "COLLECTOR_SENTRY_STATE_DIR"];
const PROFILE_SETTINGS = { kimi: ["KIMI_CODE_HOME"], zcode: ["ZCODE_DB", "ZCODE_DATA_BASE_DIR"], "muse-code": [] };

function custody(path, mode) {
  if (!isAbsolute(path)) throw new Error("invalid_custody");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o7777) !== 0o600 || s.size > 16384) throw new Error("invalid_custody");
    const buffer = Buffer.alloc(16385);
    let bytes = 0;
    while (bytes < buffer.length) {
      const n = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!n) break;
      bytes += n;
    }
    if (bytes > 16384) throw new Error("invalid_custody");
    const raw = buffer.subarray(0, bytes).toString("utf8");
    const data = JSON.parse(raw);
    const keys = mode === "service-token" ? ["token"] : ["clientId", "clientSecret"];
    if (!data || Array.isArray(data) || typeof data !== "object" || Object.keys(data).sort().join() !== keys.sort().join() || keys.some((key) => typeof data[key] !== "string" || !data[key].trim() || data[key] !== data[key].trim())) throw new Error("invalid_custody");
    // Restrict custody to a flat object with literal field names, rejecting
    // duplicate keys that JSON.parse would otherwise silently overwrite.
    const jsonString = '"(?:[^"\\\\\\x00-\\x1f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
    const field = `"(?:${keys.join("|")})"\\s*:\\s*${jsonString}`;
    if (!new RegExp(`^\\s*\\{\\s*${field}(?:\\s*,\\s*${field}){${keys.length - 1}}\\s*\\}\\s*$`).test(raw)) throw new Error("invalid_custody");
    return data;
  } finally { closeSync(fd); }
}

async function requestJson(url, init, fetchImpl) {
  const response = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("request_failed"); }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 128 * 1024) { await reader.cancel(); throw new Error("response_too_large"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function prepareCollector({ profile, mode, path, env = process.env, fetchImpl = fetch, origin = "https://app.infisical.com" }) {
  if (!Object.hasOwn(PROFILES, profile) || !["service-token", "machine-identity"].includes(mode) || typeof path !== "string") throw new Error("invalid_arguments");
  if (env.USAGE_MONITOR_INGEST_URL !== undefined && env.USAGE_MONITOR_INGEST_URL !== "https://usage.jays.services/api/ingest/usage") throw new Error("invalid_ingest_url");
  if (Object.keys(env).some((key) => key.startsWith("INFISICAL_") && env[key])) throw new Error("ambiguous_auth");
  const url = new URL(origin);
  if (url.protocol !== "https:" || !["app.infisical.com", "us.infisical.com", "eu.infisical.com"].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("invalid_origin");
  const auth = custody(path, mode);
  let token;
  if (mode === "service-token") {
    token = auth.token;
    if (!token.startsWith("st.")) throw new Error("invalid_service_token");
    await verifyServiceToken({ token, projectId: PROJECT, paths: ["/telemetry"], permissions: ["read"], baseUrl: url.origin, fetchImpl });
  } else {
    const login = await requestJson(`${url.origin}/api/v1/auth/universal-auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(auth) }, fetchImpl);
    if (!login || typeof login.accessToken !== "string" || !login.accessToken.trim() || login.accessToken !== login.accessToken.trim() || login.accessToken.startsWith("st.")) throw new Error("invalid_login");
    token = login.accessToken;
  }
  const query = new URLSearchParams({ workspaceId: PROJECT, environment: "prod", secretPath: "/telemetry", viewSecretValue: "true", expandSecretReferences: "false", include_imports: "false", recursive: "false" });
  const body = await requestJson(`${url.origin}/api/v3/secrets/raw?${query}`, { headers: { authorization: `Bearer ${token}` } }, fetchImpl);
  if (!body || !Array.isArray(body.secrets)) throw new Error("invalid_secrets");
  const required = PROFILES[profile].slice(1);
  const values = {};
  const seen = new Set();
  for (const row of body.secrets) {
    if (!row || typeof row !== "object" || typeof row.secretKey !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(row.secretKey) || typeof row.secretValue !== "string" || seen.has(row.secretKey)) throw new Error("invalid_secrets");
    seen.add(row.secretKey);
    if (required.includes(row.secretKey)) {
      if (!row.secretValue.trim() || row.secretValue !== row.secretValue.trim() || /\$\{/.test(row.secretValue) || /[\x00-\x1f\x7f]/.test(row.secretValue)) throw new Error("invalid_secrets");
      values[row.secretKey] = row.secretValue;
    }
  }
  if (required.some((name) => !Object.hasOwn(values, name))) throw new Error("missing_secrets");
  const childEnv = { COLLECTOR_STRICT_INJECTED_SECRETS: "1" };
  for (const key of [...SETTINGS, ...PROFILE_SETTINGS[profile]]) if (typeof env[key] === "string") childEnv[key] = env[key];
  Object.assign(childEnv, values);
  return { script: join(dirname(fileURLToPath(import.meta.url)), PROFILES[profile][0]), env: childEnv };
}

export async function launchChild(plan, { spawnImpl = spawn, processImpl = process } = {}) {
  const args = plan.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => !["--dry-run", "--debug"].includes(arg)) || new Set(args).size !== args.length) throw new Error("invalid_arguments");
  const child = spawnImpl(processImpl.execPath, [plan.script, ...args], { env: plan.env, stdio: "inherit" });
  const forwardInt = () => child.kill("SIGINT");
  const forwardTerm = () => child.kill("SIGTERM");
  processImpl.on("SIGINT", forwardInt); processImpl.on("SIGTERM", forwardTerm);
  const result = await new Promise((resolve) => { child.once("error", () => resolve({ code: 127 })); child.once("exit", (code, signal) => resolve({ code, signal })); });
  processImpl.off("SIGINT", forwardInt); processImpl.off("SIGTERM", forwardTerm);
  if (result.signal) processImpl.kill(processImpl.pid, result.signal);
  return result.code ?? 1;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length < 3 || argv.slice(3).some((arg) => !["--dry-run", "--debug"].includes(arg)) || new Set(argv.slice(3)).size !== argv.length - 3) throw new Error("invalid_arguments");
  const plan = await prepareCollector({ profile: argv[0], mode: argv[1], path: argv[2] });
  return launchChild({ ...plan, args: argv.slice(3) });
}

function isEntrypoint() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isEntrypoint()) {
  main().then((code) => { process.exitCode = code; }).catch(() => { console.error("Collector credential injection failed."); process.exitCode = 1; });
}
