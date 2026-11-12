// apns.ts — Apple Push Notification service provider client (server-side only).
//
// WHY node:http2 AND NOT fetch: APNs speaks HTTP/2 exclusively. Node's global fetch (undici) does
// not negotiate HTTP/2 to APNs, so a fetch-based provider client cannot work at all. Everything
// here goes through the built-in `node:http2` module.
//
// ENVIRONMENT: the SAME auth key works for both APNs environments; only the ENDPOINT differs.
//   sandbox    -> https://api.sandbox.push.apple.com   (Xcode / debug builds)
//   production -> https://api.push.apple.com           (TestFlight AND App Store)
// TestFlight is PRODUCTION. Device tokens are environment-specific — a sandbox token is answered
// `400 BadDeviceToken` by the production endpoint and vice versa — so the endpoint is chosen from
// the environment stored on the token row, never guessed from NODE_ENV.
//
// AUTH: a provider JWT, ES256-signed with the .p8 key, header { alg: "ES256", kid: APNS_KEY_ID },
// claims { iss: APNS_TEAM_ID, iat }. Apple REQUIRES the same token be reused for at least 20
// minutes and refreshed before 60; minting one per send earns `429 TooManyProviderTokenUpdates`.
// The token is therefore cached per (team, key) and refreshed at 50 minutes.
//
// SECRETS (Infisical/env, never logged):
//   APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID (the APNs topic),
//   plus one of APNS_P8 (raw PEM or base64), APNS_PRIVATE_KEY (raw PEM), APNS_PRIVATE_KEY_B64.
//
// FAIL SOFT: nothing in this module may take down a caller. Missing credentials return null;
// send outcomes come back as ApnsSendResult. Tests inject a transport and never open a socket.

import { createPrivateKey, sign } from "node:crypto";
import http2 from "node:http2";

export const APNS_ENDPOINTS = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
} as const;

export const APNS_TOKEN_REFRESH_MS = 50 * 60_000;
export const APNS_COLLAPSE_ID_MAX = 64;
export const DEFAULT_APNS_BUNDLE_ID = "com.simplewithus.usage.client.ios";

export type ApnsEnvSource = Record<string, string | undefined>;

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  bundleId: string;
  privateKeyPem: string;
}

export type ApnsEnvironment = keyof typeof APNS_ENDPOINTS;

export interface ApnsHttpRequest {
  origin: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface ApnsHttpResponse {
  status: number;
  body: string;
}

export type ApnsTransport = (request: ApnsHttpRequest, timeoutMs: number) => Promise<ApnsHttpResponse>;

export type ApnsDisposition =
  | "delivered"
  | "token_dead"
  | "auth_error"
  | "retryable"
  | "permanent";

export interface ApnsSendResult {
  ok: boolean;
  disposition: ApnsDisposition;
  status?: number;
  reason?: string;
  error?: string;
}

export interface ApnsAlert {
  title: string;
  body: string;
  collapseId?: string;
  data?: Record<string, unknown>;
  /** `null` omits aps.sound; undefined preserves the historical default sound. */
  sound?: string | null;
  category?: string;
  interruptionLevel?: "passive" | "active" | "time-sensitive" | "critical";
}

export interface ApnsSendInput extends ApnsAlert {
  deviceToken: string;
  environment: ApnsEnvironment;
}

export interface ApnsSendDeps {
  config: ApnsConfig;
  transport?: ApnsTransport;
  timeoutMs?: number;
  nowMs?: number;
}

export interface ApnsDeviceRecord {
  deviceToken: string;
  environment: string;
}

function looksLikePem(value: string): boolean {
  return value.includes("BEGIN") && value.includes("PRIVATE KEY");
}

/** Accept raw PEM, escaped-newline PEM, or standard base64 of the .p8. */
export function decodeApnsPrivateKeyPem(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const unescaped = trimmed.includes("\\n") ? trimmed.replace(/\\n/g, "\n") : trimmed;
  if (looksLikePem(unescaped)) return unescaped;
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (looksLikePem(decoded)) return decoded;
  } catch {
    return null;
  }
  return null;
}

export function loadApnsConfig(env: ApnsEnvSource = process.env): ApnsConfig | null {
  // The apns-topic is the iOS Client app's bundle ID,
  // `com.simplewithus.usage.client.ios` (owner ruling 2026-10-11). Prod sets
  // APNS_BUNDLE_ID in Infisical; the DEFAULT_APNS_BUNDLE_ID fallback mirrors
  // the iOS target so an un-overridden load picks up the same topic.
  const keyId = (env.APNS_KEY_ID ?? "").trim();
  const teamId = (env.APNS_TEAM_ID ?? "").trim();
  const bundleId = (env.APNS_BUNDLE_ID ?? DEFAULT_APNS_BUNDLE_ID).trim();
  const rawKey = (env.APNS_P8 ?? env.APNS_PRIVATE_KEY ?? env.APNS_PRIVATE_KEY_B64 ?? "").trim();
  if (!keyId || !teamId || !bundleId || !rawKey) return null;
  const privateKeyPem = decodeApnsPrivateKeyPem(rawKey);
  if (!privateKeyPem) return null;
  return { keyId, teamId, bundleId, privateKeyPem };
}

export function apnsConfigured(config: ApnsConfig | null | undefined): config is ApnsConfig {
  return !!config && !!config.keyId && !!config.teamId && !!config.bundleId && !!config.privateKeyPem;
}

export function resolveApnsEnvironment(value: string | null | undefined): ApnsEnvironment {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "sandbox" || normalized === "development" || normalized === "debug") {
    return "sandbox";
  }
  return "production";
}

type CachedProviderToken = { jwt: string; issuedAtMs: number };
const providerTokenCache = new Map<string, CachedProviderToken>();

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function providerTokenCacheKey(config: ApnsConfig): string {
  return `${config.teamId}:${config.keyId}`;
}

export function getApnsProviderToken(config: ApnsConfig, nowMs: number = Date.now()): string {
  const cacheKey = providerTokenCacheKey(config);
  const cached = providerTokenCache.get(cacheKey);
  if (cached && nowMs - cached.issuedAtMs < APNS_TOKEN_REFRESH_MS) return cached.jwt;

  const iat = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64Url(JSON.stringify({ iss: config.teamId, iat }));
  const signingInput = `${header}.${claims}`;
  const key = createPrivateKey({ key: config.privateKeyPem, format: "pem" });
  const signature = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  const jwt = `${signingInput}.${base64Url(signature)}`;
  providerTokenCache.set(cacheKey, { jwt, issuedAtMs: nowMs });
  return jwt;
}

export function invalidateApnsProviderToken(config?: ApnsConfig): void {
  if (config) providerTokenCache.delete(providerTokenCacheKey(config));
  else providerTokenCache.clear();
}

export const httpTwoApnsTransport: ApnsTransport = (request, timeoutMs) =>
  new Promise<ApnsHttpResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const session = http2.connect(request.origin);
    const cleanup = () => {
      try {
        session.close();
      } catch {
        /* already closing */
      }
    };
    session.on("error", (error) =>
      finish(() => {
        cleanup();
        reject(error);
      })
    );

    const stream = session.request({
      ":method": "POST",
      ":path": request.path,
      ...request.headers,
    });
    stream.setEncoding("utf8");
    stream.setTimeout(timeoutMs, () => {
      finish(() => {
        try {
          stream.close(http2.constants.NGHTTP2_CANCEL);
        } catch {
          /* already closed */
        }
        cleanup();
        reject(new Error(`APNs request timed out after ${timeoutMs}ms`));
      });
    });

    let status = 0;
    let body = "";
    stream.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    stream.on("data", (chunk: string) => {
      body += chunk;
    });
    stream.on("error", (error) =>
      finish(() => {
        cleanup();
        reject(error);
      })
    );
    stream.on("end", () =>
      finish(() => {
        cleanup();
        resolve({ status, body });
      })
    );
    stream.end(request.body);
  });

function classify(status: number, reason: string | undefined): ApnsDisposition {
  if (status === 200) return "delivered";
  if (status === 410) return "token_dead";
  if (status === 400 && reason === "BadDeviceToken") return "token_dead";
  if (status === 403 || status === 401) return "auth_error";
  if (status === 429 || status >= 500) return "retryable";
  return "permanent";
}

function parseReason(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

export function buildApnsPayload(alert: ApnsAlert): Record<string, unknown> {
  const aps: Record<string, unknown> = {
    alert: { title: alert.title, body: alert.body },
    "interruption-level": alert.interruptionLevel ?? "active",
    category: alert.category ?? "USAGE_ALERT",
  };
  if (alert.sound !== null) aps.sound = alert.sound ?? "default";
  return {
    aps,
    ...(alert.data ?? {}),
  };
}

export async function sendApnsPush(input: ApnsSendInput, deps: ApnsSendDeps): Promise<ApnsSendResult> {
  const transport = deps.transport ?? httpTwoApnsTransport;
  const timeoutMs = deps.timeoutMs ?? 5000;
  const origin = APNS_ENDPOINTS[input.environment];

  let jwt: string;
  try {
    jwt = getApnsProviderToken(deps.config, deps.nowMs ?? Date.now());
  } catch (error) {
    return {
      ok: false,
      disposition: "auth_error",
      error: `APNs provider token could not be signed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const headers: Record<string, string> = {
    authorization: `bearer ${jwt}`,
    "apns-topic": deps.config.bundleId,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "content-type": "application/json",
  };
  if (input.collapseId) {
    headers["apns-collapse-id"] = input.collapseId.slice(0, APNS_COLLAPSE_ID_MAX);
  }

  let response: ApnsHttpResponse;
  try {
    response = await transport(
      {
        origin,
        path: `/3/device/${input.deviceToken}`,
        headers,
        body: JSON.stringify(buildApnsPayload(input)),
      },
      timeoutMs
    );
  } catch (error) {
    return {
      ok: false,
      disposition: "retryable",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const reason = parseReason(response.body);
  const disposition = classify(response.status, reason);
  if (disposition === "auth_error" && reason === "ExpiredProviderToken") {
    invalidateApnsProviderToken(deps.config);
  }
  return {
    ok: disposition === "delivered",
    disposition,
    status: response.status,
    ...(reason ? { reason } : {}),
    ...(disposition === "delivered" ? {} : { error: `APNs HTTP ${response.status}${reason ? `: ${reason}` : ""}` }),
  };
}

export interface ApnsFanOutResult {
  delivered: number;
  retired: number;
  retryable: number;
  authErrors: number;
  permanent: number;
}

export async function fanOutApnsAlert(input: {
  title: string;
  body: string;
  collapseId?: string;
  data?: Record<string, unknown>;
  devices: ApnsDeviceRecord[];
  config: ApnsConfig;
  transport?: ApnsTransport;
  timeoutMs?: number;
  nowMs?: number;
  retireToken?: (token: string, reason: string) => Promise<void>;
}): Promise<ApnsFanOutResult> {
  const result: ApnsFanOutResult = {
    delivered: 0,
    retired: 0,
    retryable: 0,
    authErrors: 0,
    permanent: 0,
  };
  for (const device of input.devices) {
    const send = await sendApnsPush(
      {
        deviceToken: device.deviceToken,
        environment: resolveApnsEnvironment(device.environment),
        title: input.title,
        body: input.body,
        ...(input.collapseId ? { collapseId: input.collapseId } : {}),
        data: input.data,
      },
      {
        config: input.config,
        transport: input.transport,
        timeoutMs: input.timeoutMs,
        nowMs: input.nowMs,
      }
    );
    if (send.ok) {
      result.delivered += 1;
      continue;
    }
    if (send.disposition === "token_dead") {
      result.retired += 1;
      if (input.retireToken) {
        await input.retireToken(device.deviceToken, send.error ?? send.reason ?? "token_dead");
      }
      continue;
    }
    if (send.disposition === "auth_error") result.authErrors += 1;
    else if (send.disposition === "retryable") result.retryable += 1;
    else result.permanent += 1;
  }
  return result;
}
