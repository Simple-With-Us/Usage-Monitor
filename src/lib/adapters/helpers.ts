import { lookup } from "node:dns/promises";
import https from "node:https";
import net from "node:net";

export interface UsageResult {
  balance: number | null;
  totalCost: number | null;
  totalRequests: number | null;
  credits: number | null;
  rawData: unknown;
  /**
   * Authoritative account/plan/subscription state from an official provider
   * API. This is reconciled into ProviderExternalBilling for display only; it
   * never creates local Subscription charges.
   */
  externalBilling?: AdapterExternalBillingSync;
  externalBillingSyncs?: AdapterExternalBillingSync[];
}

export interface AdapterExternalBillingRecord {
  externalId: string;
  kind: "account" | "billing_period" | "invoice" | "plan" | "subscription" | "service_plan";
  planName?: string | null;
  status?: string | null;
  amountUsd?: number | null;
  currency?: string | null;
  billingInterval?: string | null;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  nextRenewalAt?: string | null;
  requestLimit?: number | null;
  requestLimitWindow?: string | null;
  spendLimitUsd?: number | null;
  spendLimitWindow?: string | null;
}

export interface AdapterExternalBillingSync {
  /** Stable provider/API namespace, e.g. cloudflare-subscriptions. */
  source: string;
  /** True only when this response is a complete list for the source. */
  authoritative: boolean;
  records: AdapterExternalBillingRecord[];
}

export type AdapterErrorCode =
  | "CONFIGURATION_ERROR"
  | "HTTP_ERROR"
  | "INVALID_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  | "TIMEOUT"
  | "TRANSPORT_ERROR"
  | "UNSAFE_OUTBOUND_URL"
  | "UNSUPPORTED";

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      code: AdapterErrorCode;
      status?: number | null;
      retryable?: boolean;
      cause?: unknown;
    }
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AdapterError";
    this.code = options.code;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}

export function configurationError(message: string): never {
  throw new AdapterError(message, { code: "CONFIGURATION_ERROR" });
}

export function unsupportedError(message: string): never {
  throw new AdapterError(message, { code: "UNSUPPORTED" });
}

export function emptyResult(rawData: unknown = null): UsageResult {
  return {
    balance: null,
    totalCost: null,
    totalRequests: null,
    credits: null,
    rawData,
  };
}

export function blindProviderResult(provider: string, note: string): never {
  unsupportedError(`${provider}: ${note} Use pushed telemetry or a manual plan.`);
}

export function errorResult(
  status: number,
  extra: Record<string, unknown> = {}
): never {
  const upstreamMessage =
    typeof extra.note === "string" && extra.note.trim()
      ? `: ${extra.note.trim()}`
      : "";
  throw new AdapterError(`Provider API returned HTTP ${status}${upstreamMessage}`, {
    code: "HTTP_ERROR",
    status,
    retryable: status === 429 || status >= 500,
  });
}

export function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function centsToDollars(cents: unknown): number | null {
  const value = parseNumber(cents);
  return value == null ? null : value / 100;
}

export function isoDateDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export function isoDateTimeDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// --- fetchJson hardening -----------------------------------------------
//
// Every poll adapter (33 providers) eventually funnels through fetchJson.
// Historically it had no timeout, so a single hung upstream request could
// stall the whole 15-minute fetchAllDueProviders loop indefinitely (see
// usage-recorder.ts). This section adds a per-request timeout and bounded
// retry-on-transient-status behavior while preserving the exact
// { ok, status, data, headers } return contract every adapter relies on.

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RETRY_AFTER_WAIT_MS = 15_000; // never block longer than this - the next 15-min scheduler tick is the real retry
const MAX_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

function resolveDefaultTimeoutMs(): number {
  const raw = process.env.ADAPTER_HTTP_TIMEOUT_MS;
  if (raw == null || raw.trim() === "") return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

// Strips query strings from a URL before it can end up in an Error message.
// Several adapters pass API keys as query params (e.g. google-ai.ts's
// ?key=...) - those must never leak into persisted fetch-all error arrays
// or logs.
export function redactUrlForError(url: string): string {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return url;
  return `${url.slice(0, queryIndex)}?[REDACTED]`;
}

// Parses a Retry-After header value, which per RFC 9110 is either an
// integer number of seconds or an HTTP-date. Returns milliseconds to wait,
// or null if the header is absent/unparseable.
function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return dateMs - Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchJsonOptions {
  /** Per-request timeout in ms. Defaults to ADAPTER_HTTP_TIMEOUT_MS or 30s. */
  timeoutMs?: number;
  /** Maximum decoded response body size. Defaults to 2 MiB. */
  maxResponseBytes?: number;
  /**
   * Use for operator-configurable/dynamically discovered endpoints. It pins a
   * prevalidated public DNS address into the TLS request, preventing private,
   * link-local, metadata-service, DNS-rebinding, and redirect pivots.
   */
  security?: "trusted" | "untrusted";
}

export async function fetchJson(
  url: string,
  init?: RequestInit,
  options?: FetchJsonOptions
): Promise<{ ok: boolean; status: number; data: unknown; headers: Headers }> {
  const parsedUrl = parseHttpsUrl(url);
  const timeoutMs = options?.timeoutMs ?? resolveDefaultTimeoutMs();
  const maxResponseBytes =
    options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new AdapterError("maxResponseBytes must be a positive integer", {
      code: "CONFIGURATION_ERROR",
    });
  }
  // Only retry GET-like (idempotent) requests - every adapter call today is
  // a GET, but gate on method explicitly rather than assuming.
  const method = (init?.method ?? "GET").toUpperCase();
  const isRetryable = method === "GET";

  let attempt = 0;
   
  while (true) {
    let res: Response;
    try {
      res = options?.security === "untrusted"
        ? await fetchUntrustedWithPinnedDns(
            parsedUrl,
            init,
            timeoutMs,
            maxResponseBytes
          )
        : await fetchWithTimeout(parsedUrl.toString(), init, timeoutMs);
    } catch (err) {
      if (err instanceof AdapterError) throw err;
      const redactedUrl = redactUrlForError(url);
      const isAbort = err instanceof Error && err.name === "AbortError";
      const message = isAbort
        ? `Request to ${redactedUrl} timed out after ${timeoutMs}ms`
        : `Request to ${redactedUrl} failed: ${
            err instanceof Error ? err.message : "network error"
          }`;
      throw new AdapterError(message, {
        code: "TRANSPORT_ERROR",
        retryable: true,
        cause: err,
      });
    }

    if (
      isRetryable &&
      RETRYABLE_STATUSES.has(res.status) &&
      attempt < MAX_RETRIES
    ) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      if (retryAfterMs != null) {
        if (retryAfterMs > MAX_RETRY_AFTER_WAIT_MS) {
          // Server asked us to wait longer than we're willing to block for -
          // give up now and let the next scheduler tick retry instead.
          return await toResult(res, maxResponseBytes);
        }
        if (retryAfterMs > 0) {
          await sleep(retryAfterMs);
        }
      } else {
        // Exponential backoff when the server didn't tell us how long to wait.
        await sleep(2 ** attempt * 1000);
      }
      // This response is being discarded in favor of a retry. Cancel its
      // unread body so undici returns the connection to the pool instead of
      // leaking it across the polling loop. Body may be null (e.g. no content)
      // and cancel() can reject if already closed - ignore both.
      await res.body?.cancel().catch(() => {});
      attempt++;
      continue;
    }

    return await toResult(res, maxResponseBytes);
  }
}

function parseHttpsUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AdapterError("Provider endpoint must be a valid HTTPS URL", {
      code: "UNSAFE_OUTBOUND_URL",
    });
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new AdapterError(
      "Provider endpoint must use HTTPS and must not contain URL credentials",
      { code: "UNSAFE_OUTBOUND_URL" }
    );
  }
  return url;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<Response> {
  // Compose caller-provided signal (if any) with the timeout signal so an
  // adapter can still cancel a request itself in the future.
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (init?.signal) signals.push(init.signal);
  const signal =
    signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  // Credentials must never be replayed to a redirect target. Provider API
  // endpoints are canonical and do not require redirects, so fail closed.
  return fetch(url, { ...init, redirect: "error", signal });
}

interface ResolvedAddress {
  address: string;
  family: number;
}

type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

async function defaultAddressResolver(hostname: string): Promise<ResolvedAddress[]> {
  if (net.isIP(hostname)) {
    return [{ address: hostname, family: net.isIP(hostname) }];
  }
  return lookup(hostname, { all: true, verbatim: true });
}

function ipv4Octets(address: string): number[] | null {
  if (net.isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => part >= 0 && part <= 255)
    ? parts
    : null;
}

export function isForbiddenOutboundAddress(address: string): boolean {
  const v4 = ipv4Octets(address);
  if (v4) {
    const [a, b] = v4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && v4[2] === 2) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0 && v4[2] === 113) ||
      a >= 224
    );
  }

  const normalized = address.toLowerCase().split("%")[0];
  if (net.isIP(normalized) !== 6) return true;

  // IPv4-mapped IPv6 can be written with dotted or hexadecimal tails.
  if (normalized.startsWith("::ffff:")) {
    const tail = normalized.slice(7);
    if (net.isIP(tail) === 4) return isForbiddenOutboundAddress(tail);
    const groups = tail.split(":");
    if (groups.length === 2) {
      const high = Number.parseInt(groups[0], 16);
      const low = Number.parseInt(groups[1], 16);
      if (Number.isFinite(high) && Number.isFinite(low)) {
        return isForbiddenOutboundAddress(
          `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
        );
      }
    }
    return true;
  }

  return (
    normalized === "::" ||
    normalized === "::1" ||
    /^f[cd]/.test(normalized) ||
    /^fe[89ab]/.test(normalized) ||
    /^ff/.test(normalized) ||
    normalized.startsWith("2001:db8:")
  );
}

export async function resolveSafeOutboundAddress(
  url: URL,
  resolver: AddressResolver = defaultAddressResolver
): Promise<ResolvedAddress[]> {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "metadata.google.internal"
  ) {
    throw new AdapterError("Provider endpoint resolves to a local hostname", {
      code: "UNSAFE_OUTBOUND_URL",
    });
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(hostname);
  } catch (error) {
    throw new AdapterError("Provider endpoint DNS lookup failed", {
      code: "TRANSPORT_ERROR",
      retryable: true,
      cause: error,
    });
  }

  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isForbiddenOutboundAddress(address))
  ) {
    throw new AdapterError(
      "Provider endpoint resolved to a private, reserved, or link-local address",
      { code: "UNSAFE_OUTBOUND_URL" }
    );
  }
  return addresses;
}

async function fetchUntrustedWithPinnedDns(
  url: URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  maxResponseBytes: number
): Promise<Response> {
  const addresses = await resolveSafeOutboundAddress(url);
  const requestedFamily = addresses[0].family;
  const pinned = addresses.find((entry) => entry.family === requestedFamily)!;
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (init?.signal) signals.push(init.signal);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  return new Promise<Response>((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: init?.method ?? "GET",
        headers: init?.headers as https.RequestOptions["headers"],
        signal,
        lookup: ((_hostname, options, callback) => {
          const all = typeof options === "object" && options?.all;
          if (all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        }) as net.LookupFunction,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          reject(
            new AdapterError("Provider endpoint redirects are not allowed", {
              code: "UNSAFE_OUTBOUND_URL",
              status,
            })
          );
          return;
        }

        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxResponseBytes) {
            response.destroy(
              new AdapterError("Provider response exceeded the configured size limit", {
                code: "RESPONSE_TOO_LARGE",
              })
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
            else if (value != null) headers.set(name, String(value));
          }
          const body = Buffer.concat(chunks);
          resolve(
            new Response(status === 204 || status === 304 ? null : body, {
              status,
              headers,
            })
          );
        });
      }
    );

    request.on("error", reject);
    const body = init?.body;
    if (body != null) {
      if (typeof body === "string" || body instanceof Uint8Array) request.write(body);
      else {
        request.destroy(
          new AdapterError("Untrusted provider request body type is unsupported", {
            code: "CONFIGURATION_ERROR",
          })
        );
        return;
      }
    }
    request.end();
  });
}

async function toResult(
  res: Response,
  maxResponseBytes: number
): Promise<{ ok: boolean; status: number; data: unknown; headers: Headers }> {
  const contentType = res.headers.get("content-type") || "";
  let data: unknown = null;

  const declaredLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    await res.body?.cancel().catch(() => {});
    throw new AdapterError("Provider response exceeded the configured size limit", {
      code: "RESPONSE_TOO_LARGE",
    });
  }

  const bytes = await readResponseBytes(res, maxResponseBytes);
  const text = new TextDecoder().decode(bytes);

  if (contentType.includes("application/json")) {
    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      if (res.ok) {
        throw new AdapterError("Provider returned malformed JSON", {
          code: "INVALID_RESPONSE",
          cause: error,
        });
      }
      data = null;
    }
  } else {
    data = text || null;
  }

  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

async function readResponseBytes(
  res: Response,
  maxResponseBytes: number
): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel().catch(() => {});
        throw new AdapterError(
          "Provider response exceeded the configured size limit",
          { code: "RESPONSE_TOO_LARGE" }
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function headerNumber(
  headers: Headers,
  names: string[]
): number | null {
  for (const name of names) {
    const value = parseNumber(headers.get(name));
    if (value != null) return value;
  }
  return null;
}

export function sumDailyCosts(
  buckets: Array<{ results?: Array<{ amount?: string | number }> }>
): number | null {
  let totalCents = 0;
  let found = false;

  for (const bucket of buckets) {
    for (const result of bucket.results || []) {
      const amount = parseNumber(result.amount);
      if (amount != null) {
        totalCents += amount;
        found = true;
      }
    }
  }

  return found ? totalCents / 100 : null;
}
