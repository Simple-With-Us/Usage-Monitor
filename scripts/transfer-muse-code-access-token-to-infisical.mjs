#!/usr/bin/env node
// One-time interactive transfer of Muse Code's OAuth access token into the
// explicitly scoped Usage Monitor Infisical project.  Values stay in process
// memory and request bodies only; output contains booleans and HTTP statuses.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const SERVICE_NAME = "ai.meta.dev.credentials";
const SERVICE_ACCOUNT = "meta";
const SECRET_NAME = "MUSE_CODE_ACCESS_TOKEN";
const API_TIMEOUT_MS = 20_000;
const KEYCHAIN_TIMEOUT_MS = 180_000;
const MAX_ACCESS_TOKEN_LENGTH = 16_384;

function transferError(code, status = null) {
  return Object.assign(new Error(code), { code, status });
}

function normalizeConfig(env) {
  const baseUrl = env.INFISICAL_BASE_URL || "https://app.infisical.com";
  const projectId = env.INFISICAL_UM_PROJECT_ID || env.INFISICAL_PROJECT_ID || "";
  const environment = env.INFISICAL_ENVIRONMENT || env.INFISICAL_ENV || "prod";
  const secretPath = env.INFISICAL_UM_SECRET_PATH || env.INFISICAL_SECRET_PATH || "/";
  const writeToken = env.INFISICAL_UM_WRITE_TOKEN || "";
  const readToken = env.INFISICAL_UM_READ_TOKEN || "";

  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw transferError("invalid-infisical-url");
  }
  if (
    base.protocol !== "https:" ||
    !["app.infisical.com", "us.infisical.com", "eu.infisical.com"].includes(base.hostname) ||
    base.username || base.password || base.port || base.search || base.hash ||
    !["", "/"].includes(base.pathname)
  ) throw transferError("invalid-infisical-url");
  if (!projectId || /\s/.test(projectId)) throw transferError("invalid-project-id");
  if (environment !== "prod") throw transferError("environment-must-be-prod");
  if (!secretPath.startsWith("/") || secretPath.split("/").includes("..")) {
    throw transferError("invalid-secret-path");
  }
  if (!writeToken.startsWith("st.") || !writeToken.trim()) {
    throw transferError("write-service-token-required");
  }
  if (readToken && (!readToken.startsWith("st.") || readToken === writeToken)) {
    throw transferError("separate-read-service-token-required");
  }
  return { base, projectId, environment, secretPath, writeToken, readToken };
}

async function readTokenMetadata({ token, fetchImpl, base }) {
  let response;
  try {
    response = await fetchImpl(new URL("/api/v2/service-token", base), {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    throw transferError("service-token-metadata-request-failed");
  }
  if (!response.ok) throw transferError("service-token-metadata-rejected", response.status);
  let metadata;
  try {
    metadata = await response.json();
  } catch {
    throw transferError("service-token-metadata-invalid", response.status);
  }
  return { metadata, status: response.status };
}

function metadataMatches(metadata, { projectId, environment, secretPath, permission }) {
  return Boolean(
    metadata &&
    metadata.workspace === projectId &&
    Array.isArray(metadata.permissions) &&
    (permission === "write"
      ? ["write", "read,write"].includes([...metadata.permissions].sort().join(","))
      : metadata.permissions.length === 1 && metadata.permissions[0] === "read") &&
    Array.isArray(metadata.scopes) &&
    metadata.scopes.length === 1 &&
    metadata.scopes[0]?.environment === environment &&
    metadata.scopes[0]?.secretPath === secretPath &&
    (metadata.expiresAt == null ||
      (Number.isFinite(Date.parse(metadata.expiresAt)) && Date.parse(metadata.expiresAt) > Date.now()))
  );
}

async function validateTokenScope(config, token, permission, fetchImpl) {
  const { metadata, status } = await readTokenMetadata({ token, fetchImpl, base: config.base });
  if (!metadataMatches(metadata, { ...config, permission })) {
    throw transferError(`${permission}-token-scope-mismatch`, status);
  }
  return status;
}

async function readMuseAccessToken({ execFileImpl, platform }) {
  if (platform !== "darwin") throw transferError("interactive-transfer-requires-macos");
  let result;
  try {
    result = await execFileImpl(
      "/usr/bin/security",
      ["find-generic-password", "-s", SERVICE_NAME, "-a", SERVICE_ACCOUNT, "-w"],
      { encoding: "utf8", timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 1_048_576 },
    );
  } catch {
    throw transferError("keychain-read-failed");
  }
  let credential;
  try {
    credential = JSON.parse(String(result?.stdout ?? "").trim());
  } catch {
    throw transferError("keychain-payload-invalid");
  }
  const rawAccessToken = credential?.access_token;
  if (typeof rawAccessToken !== "string" || !rawAccessToken.trim()) {
    throw transferError("keychain-access-token-missing");
  }
  if (/[\r\n]/.test(rawAccessToken)) throw transferError("keychain-access-token-invalid");
  const accessToken = rawAccessToken.trim();
  if (accessToken.length > MAX_ACCESS_TOKEN_LENGTH) throw transferError("keychain-access-token-too-long");
  return accessToken;
}

async function writeSecret(config, accessToken, fetchImpl) {
  const url = new URL(`/api/v4/secrets/${SECRET_NAME}`, config.base);
  const request = {
    headers: {
      authorization: `Bearer ${config.writeToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      projectId: config.projectId,
      environment: config.environment,
      secretPath: config.secretPath,
      secretValue: accessToken,
      type: "shared",
    }),
    redirect: "error",
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  };
  let response;
  try {
    response = await fetchImpl(url, { ...request, method: "PATCH" });
    if (response.status === 404) {
      response = await fetchImpl(url, { ...request, method: "POST" });
    }
  } catch {
    throw transferError("secret-write-request-failed");
  }
  if (!response.ok) throw transferError("secret-write-rejected", response.status);
  return response.status;
}

async function verifySecret(config, accessToken, fetchImpl) {
  const url = new URL(`/api/v4/secrets/${SECRET_NAME}`, config.base);
  url.searchParams.set("projectId", config.projectId);
  url.searchParams.set("environment", config.environment);
  url.searchParams.set("secretPath", config.secretPath);
  url.searchParams.set("type", "shared");
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${config.readToken}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    throw transferError("readback-request-failed");
  }
  if (!response.ok) throw transferError("readback-rejected", response.status);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw transferError("readback-response-invalid", response.status);
  }
  const returnedValue = payload?.secret?.secretValue ?? payload?.secretValue;
  return { status: response.status, matches: returnedValue === accessToken };
}

export async function transferMuseCodeAccessToken({
  env = process.env,
  fetchImpl = fetch,
  execFileImpl = execFileAsync,
  platform = process.platform,
} = {}) {
  // Validate destination and both supplied credentials before touching Keychain.
  const config = normalizeConfig(env);
  if (platform !== "darwin") throw transferError("interactive-transfer-requires-macos");
  const writeScopeStatus = await validateTokenScope(config, config.writeToken, "write", fetchImpl);
  let readScopeStatus = null;
  if (config.readToken) {
    readScopeStatus = await validateTokenScope(config, config.readToken, "read", fetchImpl);
  }

  // This explicit invocation may show a macOS approval prompt.  It never edits ACLs.
  const accessToken = await readMuseAccessToken({ execFileImpl, platform });
  const writeStatus = await writeSecret(config, accessToken, fetchImpl);
  let readback = null;
  if (config.readToken) readback = await verifySecret(config, accessToken, fetchImpl);
  return {
    keychainRead: true,
    writeScopeStatus,
    writeStatus,
    readbackScopeStatus: readScopeStatus,
    readbackStatus: readback?.status ?? null,
    readbackMatches: readback?.matches ?? null,
  };
}

async function main() {
  if (!process.argv.includes("--confirm-transfer")) {
    console.error(JSON.stringify({ ok: false, code: "confirmation-required", status: null }));
    process.exitCode = 2;
    return;
  }
  try {
    const result = await transferMuseCodeAccessToken();
    console.log(JSON.stringify(result));
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "transfer-failed";
    const status = Number.isInteger(error?.status) ? error.status : null;
    console.error(JSON.stringify({ ok: false, code, status }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
