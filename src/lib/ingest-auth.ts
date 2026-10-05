import { timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";
import { appSettings } from "@/lib/app-settings";

// Shared bearer/header parsing for ingest-style routes. Ordinary usage and
// OTLP use USAGE_INGEST_TOKEN; private-safe billing receipt imports use their
// own canonical token so a compromised telemetry producer cannot forge cash
// evidence. The server never selects alternate credentials from the request
// URL or forwarded peer identity.

export function tokenFromRequest(request: NextRequest, headerName: string): string {
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return request.headers.get(headerName)?.trim() ?? "";
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export interface IngestCredential {
  credentialId: string;
  token: string;
  allowedSourceApps: ReadonlySet<string> | null;
}

export function resolveUsageIngestCredential(request: NextRequest): IngestCredential | null {
  const actual = tokenFromRequest(request, "x-usage-ingest-token");
  if (!actual) return null;

  const rawProducerTokens = process.env.USAGE_INGEST_PRODUCER_TOKENS?.trim();
  if (rawProducerTokens) {
    const entries = rawProducerTokens
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const entry of entries) {
      const colonIndex = entry.indexOf(":");
      if (colonIndex <= 0 || colonIndex === entry.length - 1) continue;
      const producerId = entry.slice(0, colonIndex).trim();
      const token = entry.slice(colonIndex + 1).trim();
      if (!producerId || !token) continue;
      if (safeEqual(actual, token)) {
        return {
          credentialId: producerId,
          token: actual,
          allowedSourceApps: new Set([producerId]),
        };
      }
    }
  }

  const expected = process.env.USAGE_INGEST_TOKEN?.trim();
  const requireScoped = appSettings.get("USAGE_INGEST_REQUIRE_SCOPED_TOKENS") === "true";
  if (expected && !requireScoped && safeEqual(actual, expected)) {
    return {
      credentialId: "unscoped",
      token: actual,
      allowedSourceApps: null,
    };
  }

  return null;
}

export function isUsageIngestAuthorized(request: NextRequest): boolean {
  return resolveUsageIngestCredential(request) !== null;
}

export function isBillingReceiptIngestAuthorized(request: NextRequest): boolean {
  const expected = process.env.BILLING_RECEIPT_INGEST_TOKEN?.trim() ?? "";
  if (!expected) return false;
  const actual = tokenFromRequest(request, "x-billing-receipt-ingest-token");
  return Boolean(actual) && safeEqual(actual, expected);
}

/**
 * Resolve the expected read token for budget-status / subscriptions GET.
 *
 * Prefer a dedicated USAGE_READ_TOKEN. Falling back to USAGE_INGEST_TOKEN is
 * allowed outside production (and when USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK
 * is explicitly true) so local/dev stay ergonomic. In production the fallback
 * is denied by default (Wave C / C10) so a compromised read consumer cannot
 * also forge ingest events with the same secret.
 */
export function resolveUsageReadToken(
  env: NodeJS.ProcessEnv = appSettings.settingsEnv()
): string | undefined {
  const read = env.USAGE_READ_TOKEN?.trim();
  if (read) return read;

  const allowFallback =
    env.USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK?.trim().toLowerCase() === "true" ||
    env.NODE_ENV !== "production";
  if (!allowFallback) return undefined;

  return env.USAGE_INGEST_TOKEN?.trim() || undefined;
}

/**
 * Secret-free observability view of the read-token configuration for
 * /api/ready. A missing dedicated token in production means every bearer
 * consumer of GET /api/budget-status and GET /api/subscriptions 503s, but
 * before this existed the only signal was a boot-time console.warn on the
 * host. Never gates readiness `ok`; exposes booleans only, never token
 * material.
 */
export function getUsageReadTokenReadiness(
  env: NodeJS.ProcessEnv = appSettings.settingsEnv()
): {
  required: boolean;
  dedicated: boolean;
  breakGlassFallback: boolean;
  readsAuthorized: boolean;
} {
  const required = env.NODE_ENV === "production";
  const dedicated = Boolean(env.USAGE_READ_TOKEN?.trim());
  const breakGlassFallback =
    env.USAGE_READ_TOKEN_ALLOW_INGEST_FALLBACK?.trim().toLowerCase() ===
    "true";
  return {
    required,
    dedicated,
    breakGlassFallback,
    readsAuthorized: resolveUsageReadToken(env) !== undefined,
  };
}

// Read-only token check for GET /api/subscriptions (and shared by budget-status).
//
// Accepted credentials, in precedence order:
//   1. `Authorization: Bearer <token>`
//   2. `x-usage-read-token: <token>`   — canonical read header
//   3. `x-usage-ingest-token: <token>` — legacy alias, kept so existing
//      consumers that already send the ingest-style header name keep working.
// The expected secret is unchanged (USAGE_READ_TOKEN, with the documented
// non-production/break-glass fallback to USAGE_INGEST_TOKEN): only the header
// *name* gained an alias, never the credential set.
export function isUsageReadAuthorized(request: NextRequest): boolean {
  const expected = resolveUsageReadToken();
  if (!expected) return false;
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  const actual =
    bearer ||
    request.headers.get("x-usage-read-token")?.trim() ||
    request.headers.get("x-usage-ingest-token")?.trim() ||
    "";
  return Boolean(actual) && safeEqual(actual, expected);
}
