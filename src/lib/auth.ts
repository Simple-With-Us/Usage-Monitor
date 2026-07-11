import crypto, { timingSafeEqual } from "crypto";

export const SESSION_COOKIE_NAME = "dashboard_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // seconds, 30 days
const SESSION_TOKEN_FORMAT = "v1";
const MIN_SESSION_SECRET_LENGTH = 32;

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyPassword(candidate: string): boolean {
  const expected = process.env.DASHBOARD_PASSWORD?.trim();
  if (!expected) return false;
  return safeEqual(candidate, expected);
}

function validSessionSecret(value: string | undefined): string | null {
  const secret = value?.trim() ?? "";
  return secret.length >= MIN_SESSION_SECRET_LENGTH ? secret : null;
}

function validSessionVersion(): string | null {
  const version = process.env.SESSION_VERSION?.trim() || "1";
  return /^[A-Za-z0-9_-]{1,32}$/.test(version) ? version : null;
}

export function isSessionAuthConfigured(): boolean {
  return (
    validSessionSecret(process.env.SESSION_SECRET) != null &&
    validSessionVersion() != null
  );
}

function signSessionPayload(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createSessionToken(): string {
  const secret = validSessionSecret(process.env.SESSION_SECRET);
  if (!secret) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters`
    );
  }
  const version = validSessionVersion();
  if (!version) {
    throw new Error(
      "SESSION_VERSION must contain 1-32 letters, numbers, underscores, or hyphens"
    );
  }
  const expiresAt = Date.now() + SESSION_MAX_AGE * 1000;
  const nonce = crypto.randomBytes(16).toString("base64url");
  const payload = [
    SESSION_TOKEN_FORMAT,
    version,
    String(expiresAt),
    nonce,
  ].join(".");
  return `${payload}.${signSessionPayload(payload, secret)}`;
}

export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const expectedVersion = validSessionVersion();
  if (!expectedVersion) return false;
  const parts = token.split(".");
  if (parts.length !== 5) return false;
  const [format, version, expiresAtRaw, nonce, sig] = parts;
  if (
    format !== SESSION_TOKEN_FORMAT ||
    version !== expectedVersion ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) ||
    !/^[A-Za-z0-9_-]{32,64}$/.test(sig)
  ) {
    return false;
  }

  const expiresAt = Number(expiresAtRaw);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + SESSION_MAX_AGE * 1000 + 60_000
  ) {
    return false;
  }

  const secrets = [
    validSessionSecret(process.env.SESSION_SECRET),
    validSessionSecret(process.env.SESSION_SECRET_PREVIOUS),
  ].filter((secret): secret is string => secret != null);
  if (secrets.length === 0) return false;

  const payload = [format, version, expiresAtRaw, nonce].join(".");
  return secrets.some((secret) => safeEqual(sig, signSessionPayload(payload, secret)));
}
