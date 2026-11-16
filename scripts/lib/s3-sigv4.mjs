/**
 * Minimal AWS SigV4 request signer for S3-compatible object stores (R2, B2).
 *
 * Why hand-rolled: this repo deliberately carries no AWS SDK dependency — the
 * runtime already signs ListObjectsV2 by hand in `src/lib/r2-usage.ts`. This
 * module is the ops-script twin of that logic, generalized to any verb so the
 * weekly R2 archive can PUT / GET / HEAD / DELETE, and kept dependency-free so
 * it runs inside the app container with nothing installed.
 *
 * Scope notes:
 *  - Path-style addressing only (`{endpoint}/{bucket}/{key}`). R2 and B2 both
 *    accept it, and it avoids DNS/vhost differences between providers.
 *  - Bodies are signed with a real payload hash (never UNSIGNED-PAYLOAD), so a
 *    truncated or corrupted upload is rejected by the server, not silently
 *    stored. That is load-bearing for the archive's verify step.
 *  - `region: "auto"` (R2's convention) is signed as `us-east-1`, matching what
 *    r2-usage.ts already does and what R2 accepts for SigV4.
 */

import { createHash, createHmac } from "node:crypto";

const UNRESERVED = /[A-Za-z0-9\-_.~]/;

/**
 * AWS-flavored percent-encoding. `encodeURIComponent` leaves `!'()*`
 * unescaped, which AWS requires escaped — a key containing any of them would
 * otherwise produce a signature mismatch that reads like a credential problem.
 */
export function awsUriEncode(value, encodeSlash = true) {
  let out = "";
  for (const char of String(value)) {
    if (UNRESERVED.test(char)) {
      out += char;
    } else if (char === "/") {
      out += encodeSlash ? "%2F" : "/";
    } else {
      for (const byte of Buffer.from(char, "utf8")) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  return out;
}

export function sha256Hex(data) {
  return createHash("sha256").update(data ?? "").digest("hex");
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function normalizeEndpoint(endpoint) {
  const trimmed = String(endpoint || "").replace(/\/+$/, "");
  if (!trimmed) throw new Error("s3-sigv4: endpoint is required");
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Build a signed request. Returns `{ url, headers }` ready for `fetch`.
 *
 * @param {object} options
 * @param {string} options.method      HTTP verb.
 * @param {object} options.creds       { endpoint, region, accessKeyId, secretAccessKey }
 * @param {string} options.bucket
 * @param {string} [options.key]       Object key (may contain `/`).
 * @param {Record<string,string>} [options.query]
 * @param {Buffer|string} [options.body]
 * @param {Record<string,string>} [options.headers] Extra headers to sign.
 * @param {Date} [options.now]         Injectable clock for deterministic tests.
 */
export function signS3Request({
  method,
  creds,
  bucket,
  key = "",
  query = {},
  body,
  headers = {},
  now = new Date(),
}) {
  if (!creds?.accessKeyId || !creds?.secretAccessKey) {
    throw new Error("s3-sigv4: accessKeyId and secretAccessKey are required");
  }
  if (!bucket) throw new Error("s3-sigv4: bucket is required");

  const endpoint = normalizeEndpoint(creds.endpoint);
  const host = new URL(endpoint).host;
  // R2 advertises region "auto"; SigV4 needs a concrete region and R2 accepts
  // us-east-1 for signing regardless of the bucket's actual location hint.
  const region = !creds.region || creds.region === "auto" ? "us-east-1" : creds.region;
  const service = "s3";

  const payload = body === undefined || body === null ? "" : body;
  const payloadHash = sha256Hex(payload);

  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);

  // Canonical URI: `/bucket/key`, each key segment encoded but `/` preserved.
  const encodedKey = key
    ? key.split("/").map((segment) => awsUriEncode(segment)).join("/")
    : "";
  const canonicalUri = encodedKey ? `/${bucket}/${encodedKey}` : `/${bucket}`;

  const canonicalQuery = Object.entries(query)
    .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v ?? "")])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  // Every header we sign, lowercased and sorted — host + the two x-amz-* are
  // always signed; callers can add content-type, x-amz-meta-*, etc.
  const signedHeaderMap = new Map([
    ["host", host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", amzDate],
  ]);
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    signedHeaderMap.set(name.toLowerCase(), String(value).trim());
  }
  const sortedHeaderNames = [...signedHeaderMap.keys()].sort();
  const canonicalHeaders = sortedHeaderNames
    .map((name) => `${name}:${signedHeaderMap.get(name)}\n`)
    .join("");
  const signedHeaders = sortedHeaderNames.join(";");

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const requestHeaders = {};
  for (const name of sortedHeaderNames) requestHeaders[name] = signedHeaderMap.get(name);
  requestHeaders.authorization = authorization;

  const url = `${endpoint}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  return { url, headers: requestHeaders };
}

const TRANSPORT_ERROR_CODES = new Set([
  "ABORT_ERR", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE",
  "EAI_AGAIN", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "UND_ERR_ABORTED", "UND_ERR_DESTROYED",
]);

function transportErrorCode(error) {
  // Bound traversal even for cyclic causes; never copy arbitrary error text,
  // URLs, headers, or unknown vendor codes into the operator's log.
  for (let depth = 0; depth < 4 && error && typeof error === "object"; depth++) {
    if (TRANSPORT_ERROR_CODES.has(error.code)) return error.code;
    error = error.cause;
  }
  return "unknown";
}

/**
 * Sign and execute. Throws on non-2xx with a truncated body so callers get a
 * usable message without dumping an XML wall (or a signed URL) into a log.
 */
export async function s3Request(options) {
  const { fetchImpl = fetch, expectStatuses, ...signOptions } = options;
  const { url, headers } = signS3Request(signOptions);
  const method = signOptions.method.toUpperCase();
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: signOptions.body ?? undefined,
    });
  } catch (error) {
    const phase = ["PUT", "GET", "HEAD", "DELETE", "POST"].includes(method) ? method : "REQUEST";
    // A transport rejection has no HTTP response to label below.
    // Keep the operation so archive status distinguishes upload/download/prune;
    // the original cause is deliberately excluded because it may hold secrets.
    throw new Error(`S3 ${phase} transport failed (${transportErrorCode(error)})`);
  }
  const allowed = expectStatuses ?? null;
  const ok = allowed ? allowed.includes(response.status) : response.ok;
  if (!ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      detail = "<unreadable body>";
    }
    const target = `${signOptions.bucket}/${signOptions.key ?? ""}`.replace(/\/$/, "");
    throw new Error(
      `S3 ${signOptions.method.toUpperCase()} ${target} failed: HTTP ${response.status} ${detail}`
    );
  }
  return response;
}

/** ListObjectsV2 over one prefix, following continuation tokens. */
export async function listObjects({ creds, bucket, prefix = "", fetchImpl, maxPages = 50 }) {
  const objects = [];
  let continuationToken;
  for (let page = 0; page < maxPages; page += 1) {
    const query = { "list-type": "2", "max-keys": "1000" };
    if (prefix) query.prefix = prefix;
    if (continuationToken) query["continuation-token"] = continuationToken;

    const response = await s3Request({ method: "GET", creds, bucket, query, fetchImpl });
    const xml = await response.text();

    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const entry = match[1];
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(entry)?.[1];
      if (!key) continue;
      objects.push({
        key,
        size: Number(/<Size>(\d+)<\/Size>/.exec(entry)?.[1] ?? 0),
        lastModified: /<LastModified>([\s\S]*?)<\/LastModified>/.exec(entry)?.[1] ?? null,
        etag: /<ETag>"?([^"<]+)"?<\/ETag>/.exec(entry)?.[1] ?? null,
      });
    }

    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    continuationToken = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
    if (!truncated || !continuationToken) return objects;
  }
  throw new Error(`listObjects: page cap reached for ${bucket}/${prefix}`);
}
