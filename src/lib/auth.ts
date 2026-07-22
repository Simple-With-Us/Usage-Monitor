import crypto, { hkdfSync, timingSafeEqual } from "crypto";

export const SESSION_COOKIE_NAME = "dashboard_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // seconds, 30 days

// Fixed, non-secret domain-separation strings for HKDF - they don't need to
// be random (that's what the DASHBOARD_PASSWORD/DASHBOARD_SESSION_SECRET
// input key material provides); they just need to be unique to this app and
// this derived key's purpose so the same input material never accidentally
// produces the same key elsewhere.
const SESSION_HKDF_SALT = "api-usage-monitor.session-token.v2";
const SESSION_HKDF_INFO = "dashboard-session-hmac";

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

// Derives the session-signing key via HKDF-SHA256 instead of keying the HMAC
// directly on the plaintext password. That way a leaked session cookie's
// signature can't be used as an offline oracle to verify password guesses,
// and setting/rotating the SESSION_SECRET can invalidate
// sessions without changing the login password.
function deriveSessionSigningKey(): Buffer | null {
  const inputKeyMaterial = process.env.SESSION_SECRET?.trim();
  if (!inputKeyMaterial) return null;
  return Buffer.from(
    hkdfSync("sha256", inputKeyMaterial, SESSION_HKDF_SALT, SESSION_HKDF_INFO, 32)
  );
}

export function createSessionToken(): string {
  const signingKey = deriveSessionSigningKey();
  if (!signingKey) {
    throw new Error("SESSION_SECRET environment variable is not set");
  }
  const expiresAt = Date.now() + SESSION_MAX_AGE * 1000;
  const sig = crypto.createHmac("sha256", signingKey).update(String(expiresAt)).digest("hex");
  return `${expiresAt}.${sig}`;
}

export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [expiresAtRaw, sig] = parts;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

  const signingKey = deriveSessionSigningKey();
  if (!signingKey) return false;

  const expectedSig = crypto.createHmac("sha256", signingKey).update(String(expiresAt)).digest("hex");
  return safeEqual(sig, expectedSig);
}

/**
 * Wave G / E18: route-level session re-check for mutators. Middleware already
 * gates most dashboard routes; handlers that are excluded (e.g. subscriptions
 * collection) or that want defense-in-depth should call this before writes.
 */
export function hasValidDashboardSession(request: {
  cookies: { get: (name: string) => { value: string } | undefined };
}): boolean {
  return verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
}

/**
 * True when mutators should enforce a dashboard session cookie.
 * Middleware still gates production routes. Direct unit tests (vitest) call
 * handlers without cookies, so enforcement is skipped under VITEST / NODE_ENV
 * test. Production always enforces when SESSION_SECRET is configured.
 */
export function shouldEnforceDashboardSession(): boolean {
  // Vitest sets VITEST=true. Do not key off NODE_ENV alone — CI uses
  // NODE_ENV=test while a few tests deliberately clear VITEST to assert
  // production-shaped session enforcement.
  if (process.env.VITEST === "true") {
    return false;
  }
  return Boolean(process.env.SESSION_SECRET?.trim());
}
