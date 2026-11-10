import crypto, { createHash, hkdfSync, scryptSync, timingSafeEqual } from "crypto";

export const SESSION_COOKIE_NAME = "dashboard_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // seconds, 30 days

// Fixed, non-secret domain-separation strings for HKDF - they don't need to
// be random (that's what the DASHBOARD_PASSWORD/DASHBOARD_SESSION_SECRET
// input key material provides); they just need to be unique to this app and
// this derived key's purpose so the same input material never accidentally
// produces the same key elsewhere.
const SESSION_HKDF_SALT = "api-usage-monitor.session-token.v2";
const SESSION_HKDF_INFO = "dashboard-session-hmac";

// Hashing both sides first fixes the compared length to the digest size, so
// timingSafeEqual never throws on mismatched lengths and no length/mismatch
// signal leaks via response timing - a plain `!==` (or a naive length-checked
// timingSafeEqual, which short-circuits before the constant-time compare ever
// runs) does leak it. Same pattern as isAuthorizedCronSecret in
// src/app/api/cron/fetch-all/route.ts.
function safeEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest()
  );
}

// Password comparison goes through scrypt, not the cheap sha256 in safeEqual:
// a memory-hard KDF makes each brute-force guess cost real work (and satisfies
// CodeQL js/insufficient-password-hash, which rightly rejects bare SHA-256 on
// password material). The fixed app salt is fine for this compare-only use —
// nothing is stored; it just fixes both digests to equal length so
// timingSafeEqual stays constant-time with no length signal. Login is the only
// caller, so the ~100ms scrypt cost is a feature, not a hazard.
const PASSWORD_COMPARE_SALT = "api-usage-monitor.password-compare.v1";

export function verifyPassword(candidate: string): boolean {
  const expected = process.env.DASHBOARD_PASSWORD?.trim();
  if (!expected) return false;
  return timingSafeEqual(
    scryptSync(candidate, PASSWORD_COMPARE_SALT, 32),
    scryptSync(expected, PASSWORD_COMPARE_SALT, 32)
  );
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

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF guard for cookie-authenticated mutators. `dashboard_session` is
 * SameSite=Lax, but SameSite is scoped per-SITE (the registrable domain
 * jays.services), not per-origin — a sibling *.jays.services page counts as
 * "same-site", so the browser DOES attach the cookie to its cross-origin
 * POSTs. Switching the cookie to "strict" would not close that; the origin
 * has to be checked explicitly.
 *
 * Header-absent requests are allowed deliberately: browsers always send
 * Origin on unsafe methods, while the iOS client (URLSession, cookie-authed
 * via ios/.../Networking/APIClient.swift) sends neither Origin nor
 * Sec-Fetch-Site. Origin is compared against the request's own Host rather
 * than an env var so localhost/dev keeps working and nothing depends on
 * X-Forwarded-Host from Caddy/Cloudflare.
 */
export function isCsrfSafeRequest(request: {
  method: string;
  headers: { get: (name: string) => string | null };
}): boolean {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return true;

  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
    // Catches "same-site" (the sibling-subdomain case) and "cross-site".
    return false;
  }

  const origin = request.headers.get("origin");
  if (!origin) return true; // native client; browsers cannot omit this on unsafe methods
  if (origin === "null") return false; // sandboxed iframe / opaque origin

  const host = request.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
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
