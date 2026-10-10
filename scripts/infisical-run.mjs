#!/usr/bin/env node
// Launches a command with secrets injected from Infisical for Usage-Monitor,
// then propagates the child's exit code. Sets SECRETS_SOURCE=infisical.
//
// Auth: Universal Auth Client ID + Client Secret (preferred), falling back to
// INFISICAL_AUTOMATION_CLIENT_ID / INFISICAL_SHARED_CLIENT_ID or INFISICAL_TOKEN.
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
    `[infisical] Refusing INFISICAL_ENV="${requestedEnv}": Usage-Monitor reads Infisical prod only (dev and staging are retired).`
  );
  process.exit(2);
}
const envName = "prod";
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

const clientId =
  process.env.INFISICAL_CLIENT_ID ||
  process.env.INFISICAL_UM_CLIENT_ID ||
  process.env.INFISICAL_AUTOMATION_CLIENT_ID ||
  process.env.INFISICAL_SHARED_CLIENT_ID;

const clientSecret =
  process.env.INFISICAL_CLIENT_SECRET ||
  process.env.INFISICAL_UM_CLIENT_SECRET ||
  process.env.INFISICAL_AUTOMATION_CLIENT_SECRET ||
  process.env.INFISICAL_SHARED_CLIENT_SECRET;

let token = process.env.INFISICAL_TOKEN || process.env.INFISICAL_SHARED_TOKEN;

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
    console.error(`[infisical] Universal-auth login failed (exit ${r.status}): ${r.stderr.trim()}`);
    process.exit(r.status ?? 1);
  }
  token = r.stdout.trim();
}

if (!token) {
  console.error(
    "[infisical] Missing credentials: set INFISICAL_AUTOMATION_CLIENT_ID + INFISICAL_AUTOMATION_CLIENT_SECRET (or INFISICAL_TOKEN)."
  );
  process.exit(2);
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
    console.error(`[infisical] Check failed (exit ${r.status}): ${r.stderr.trim()}`);
    process.exit(r.status ?? 1);
  }
  try {
    const secrets = JSON.parse(r.stdout);
    const count = Array.isArray(secrets) ? secrets.length : Object.keys(secrets).length;
    console.log(`[infisical] Verified usage-monitor project secret store (${envName}): ${count} keys accessible.`);
    process.exit(0);
  } catch (err) {
    console.error(`[infisical] Check parse error: ${err.message}`);
    process.exit(1);
  }
}

const execArgs = ["run", "--env", envName, "--path", secretsPath, "--projectId", projectId];
if (process.env.INFISICAL_BASE_URL) {
  execArgs.push(`--domain=${process.env.INFISICAL_BASE_URL}`);
}
execArgs.push("--", ...command);

const child = spawn("infisical", execArgs, {
  stdio: "inherit",
  env: runEnv,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
