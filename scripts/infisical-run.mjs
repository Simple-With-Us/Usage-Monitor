#!/usr/bin/env node
// Launches a command with secrets injected from Infisical for Usage-Monitor,
// then propagates the child's exit code. Sets SECRETS_SOURCE=infisical.
//
// Auth: explicitly supplied app machine identity or project service token.
// Fleet Automation and other projects' credentials are never borrowed.
//
// Usage: node scripts/infisical-run.mjs -- npm run start
//        node scripts/infisical-run.mjs --check

import { spawn, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const separatorIndex = args.indexOf("--");
const command = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : checkOnly ? [] : args;

if (command.length === 0 && !checkOnly) {
  console.error("Usage: node scripts/infisical-run.mjs -- <command...>");
  console.error("       node scripts/infisical-run.mjs --check");
  process.exit(2);
}

const probe = spawnSync("infisical", ["--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (probe.error?.code === "ENOENT") {
  console.error("Infisical CLI is not installed or is not on PATH.");
  process.exit(127);
}

// Owner directive 2026-10-10: Infisical prod is the only environment (dev and
// staging are being retired).  The old NODE_ENV fallback produced slugs that
// are not Infisical environments ("production", "development"), so it is gone.
const requestedEnv = (process.env.INFISICAL_ENV || "").trim();
if (requestedEnv && requestedEnv !== "prod") {
  console.error(
    "[infisical] Refusing non-prod INFISICAL_ENV: Usage-Monitor reads Infisical prod only."
  );
  process.exit(2);
}
const envName = "prod";
if (process.env.INFISICAL_BASE_URL) {
  try {
    const url = new URL(process.env.INFISICAL_BASE_URL);
    if (url.protocol !== "https:" || !["app.infisical.com", "us.infisical.com", "eu.infisical.com"].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error();
  } catch { console.error("[infisical] Refusing an unsupported Infisical base URL."); process.exit(2); }
}
const secretsPath = process.env.INFISICAL_PATH || "/";
const projectId =
  process.env.INFISICAL_PROJECT_ID ||
  process.env.INFISICAL_UM_PROJECT_ID ||
  process.env.INFISICAL_APP_PROJECT_ID;

if (!projectId) {
  console.error(
    "[infisical] Missing project id: set INFISICAL_UM_PROJECT_ID (or INFISICAL_PROJECT_ID)."
  );
  process.exit(2);
}

const genericPair = Boolean(process.env.INFISICAL_CLIENT_ID || process.env.INFISICAL_CLIENT_SECRET);
const clientId = genericPair ? process.env.INFISICAL_CLIENT_ID : process.env.INFISICAL_UM_CLIENT_ID;
const clientSecret = genericPair ? process.env.INFISICAL_CLIENT_SECRET : process.env.INFISICAL_UM_CLIENT_SECRET;
let token = process.env.INFISICAL_UM_READ_TOKEN || process.env.INFISICAL_TOKEN;

if (Boolean(clientId) !== Boolean(clientSecret)) {
  console.error(
    "[infisical] Partial universal-auth credentials: set BOTH client ID and client secret (or neither)."
  );
  process.exit(2);
}

if (clientId && clientSecret && !token) {
  const mintEnv = {
    ...process.env,
    INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: clientId,
    INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: clientSecret,
  };
  const loginArgs = ["login", "--method=universal-auth", "--silent", "--plain"];
  if (process.env.INFISICAL_BASE_URL) {
    loginArgs.push(`--domain=${process.env.INFISICAL_BASE_URL}`);
  }
  const r = spawnSync("infisical", loginArgs, {
    encoding: "utf8",
    env: mintEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    console.error(`[infisical] Universal-auth login failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
  token = r.stdout.trim();
}

if (!token) {
  console.error(
    "[infisical] Missing app credentials: set an app-specific client pair or INFISICAL_UM_READ_TOKEN."
  );
  process.exit(2);
}

if (token.startsWith("st.")) {
  // A service token can return its own folder for arbitrary path queries.
  // Verify its own project/environment/folder/permission metadata instead.
  try {
    const base = new URL(process.env.INFISICAL_BASE_URL || "https://app.infisical.com");
    if (base.protocol !== "https:" || !["app.infisical.com", "us.infisical.com", "eu.infisical.com"].includes(base.hostname) || base.username || base.password || base.port || base.search || base.hash || !["", "/"].includes(base.pathname)) throw new Error();
    const response = await fetch(`${base.origin}/api/v2/service-token`, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok || Number(response.headers.get("content-length")) > 128 * 1024) throw new Error();
    const reader = response.body?.getReader();
    if (!reader) throw new Error();
    let bytes = 0;
    const chunks = [];
    try {
      while (true) { const item = await reader.read(); if (item.done) break; bytes += item.value.length; if (bytes > 128 * 1024) { await reader.cancel(); throw new Error(); } chunks.push(item.value); }
    } finally { reader.releaseLock(); }
    const metadata = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (metadata.workspace !== projectId || !Array.isArray(metadata.permissions) || metadata.permissions.length !== 1 || metadata.permissions[0] !== "read" || !Array.isArray(metadata.scopes) || metadata.scopes.length !== 1 || metadata.scopes[0].environment !== "prod" || metadata.scopes[0].secretPath !== secretsPath || metadata.expiresAt != null && (!Number.isFinite(Date.parse(metadata.expiresAt)) || Date.parse(metadata.expiresAt) <= Date.now())) throw new Error();
  } catch {
    console.error("[infisical] Service token metadata does not verify the exact app read scope.");
    process.exit(2);
  }
}

const runEnv = {
  ...process.env,
  INFISICAL_TOKEN: token,
  SECRETS_SOURCE: "infisical",
};

if (checkOnly) {
  const exportArgs = ["export", "--env", envName, "--path", secretsPath, "--projectId", projectId, "--format", "json"];
  if (process.env.INFISICAL_BASE_URL) {
    exportArgs.push(`--domain=${process.env.INFISICAL_BASE_URL}`);
  }
  const r = spawnSync("infisical", exportArgs, {
    encoding: "utf8",
    env: runEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    console.error(`[infisical] Check failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
  try {
    const secrets = JSON.parse(r.stdout);
    const count = Array.isArray(secrets) ? secrets.length : Object.keys(secrets).length;
    console.log(`[infisical] Verified usage-monitor project secret store (${envName}): ${count} keys accessible.`);
    process.exit(0);
  } catch (err) {
    console.error("[infisical] Check returned an invalid response.");
    process.exit(1);
  }
}

const execArgs = ["run", "--env", envName, "--path", secretsPath, "--projectId", projectId];
if (process.env.INFISICAL_BASE_URL) {
  execArgs.push(`--domain=${process.env.INFISICAL_BASE_URL}`);
}
execArgs.push("--", ...command);

const forwardSigint = () => child.kill("SIGINT");
const forwardSigterm = () => child.kill("SIGTERM");
let childSettled = false;
let child;

const removeSignalForwarders = () => {
  process.off("SIGINT", forwardSigint);
  process.off("SIGTERM", forwardSigterm);
};

process.on("SIGINT", forwardSigint);
process.on("SIGTERM", forwardSigterm);

child = spawn("infisical", execArgs, {
  stdio: "inherit",
  env: runEnv,
});

child.once("error", (error) => {
  if (childSettled) return;
  childSettled = true;
  removeSignalForwarders();
  console.error(`[infisical] Failed to start Infisical CLI (${error.code ?? "unknown"}).`);
  process.exit(127);
});

child.once("exit", (code, signal) => {
  if (childSettled) return;
  childSettled = true;
  removeSignalForwarders();

  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
