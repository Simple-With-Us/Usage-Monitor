/**
 * Developer & release platform probes.
 *
 * Two cards live here:
 *  - GitHub: API rate-limit headroom plus the newest Actions run for this
 *    repo, so an operator sees both "am I about to be throttled" and "is the
 *    release pipeline red" in one glance.
 *  - App Store Connect: the newest TestFlight/App Store build and whether
 *    Apple finished processing it.
 *
 * Apple's API takes an ES256 JWT signed with the downloaded .p8 key.  The key
 * lives in env as PEM text (production is a container, so a file path is not
 * an option), and the signature must be the JOSE R||S form — a raw DER
 * signature from OpenSSL is rejected by Apple with an opaque 401, so the
 * conversion below is deliberate and covered by tests.
 *
 * Nothing derived from a credential is ever returned: no tokens, no JWTs, no
 * key material, no raw upstream payloads.
 */

import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import {
  asArray,
  asRecord,
  envValue,
  failureResult,
  finiteNumber,
  formatAge,
  formatCount,
  formatPercent,
  hasEnv,
  metric,
  requestJson,
  upstreamFailure,
} from "../probe-helpers";
import type { PlatformMetric, PlatformProbe, PlatformProbeResult } from "../types";

// ---------------------------------------------------------------------------
// Shared small helpers
// ---------------------------------------------------------------------------

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** "timed_out" -> "Timed Out".  Used for upstream enum values only. */
function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function clip(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function integers(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** "in 42m" style countdown from an ISO timestamp or epoch seconds. */
function formatCountdown(value: string | number | null): string | null {
  if (value === null) return null;
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const seconds = Math.max(0, Math.floor((ms - Date.now()) / 1000));
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3_600) return `in ${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `in ${Math.floor(seconds / 3_600)}h`;
  return `in ${Math.floor(seconds / 86_400)}d`;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/**
 * Same names the Infisical provider sync already recognises for GitHub
 * (see `SECRET_NAME_TO_PROVIDER` in infisical-provider-sync.ts).  GITHUB_TOKEN
 * is canonical; the other two are accepted so an existing deployment does not
 * have to duplicate its secret.
 */
const GITHUB_TOKEN_ENV = ["GITHUB_TOKEN", "GITHUB_API_TOKEN", "GITHUB_PAT"] as const;

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const GITHUB_USER_AGENT = "usage-monitor-platform-probe/1.0";
const GITHUB_REPO_OWNER = "Simple-With-Us";
const GITHUB_REPO_NAME = "Usage-Monitor";
/** Below this much core-API headroom the card goes degraded. */
const GITHUB_LOW_HEADROOM_PERCENT = 10;
/** Workflow names are operator-supplied; keep them from eating the headline. */
const MAX_WORKFLOW_NAME_LENGTH = 32;

const GITHUB_FAILED_CONCLUSIONS: ReadonlyMap<string, string> = new Map([
  ["failure", "failed"],
  ["timed_out", "timed out"],
  ["startup_failure", "failed to start"],
  ["action_required", "needs manual approval"],
]);

interface RateWindow {
  limit: number | null;
  remaining: number | null;
  reset: number | null;
}

function rateWindow(resources: Record<string, unknown> | undefined, name: string): RateWindow {
  const window = asRecord(resources?.[name]);
  return {
    limit: finiteNumber(window?.limit),
    remaining: finiteNumber(window?.remaining),
    reset: finiteNumber(window?.reset),
  };
}

function headroomPercent(window: RateWindow): number | null {
  if (window.limit === null || window.remaining === null || window.limit <= 0) return null;
  return Math.max(0, Math.min(100, (window.remaining / window.limit) * 100));
}

function rateWindowValue(window: RateWindow): string {
  if (window.limit === null || window.remaining === null) return "Unavailable";
  return `${integers(window.remaining)} of ${integers(window.limit)} calls left`;
}

interface LatestWorkflowRun {
  name: string;
  conclusion: string | null;
  status: string | null;
  branch: string | null;
  runNumber: number | null;
  updatedAt: string | null;
}

function latestWorkflowRun(data: unknown): LatestWorkflowRun | null {
  const runs = asArray(asRecord(data)?.workflow_runs);
  const run = asRecord(runs[0]);
  if (!run) return null;
  return {
    name: clip(textValue(run.name) ?? "Workflow", MAX_WORKFLOW_NAME_LENGTH),
    conclusion: textValue(run.conclusion),
    status: textValue(run.status),
    branch: textValue(run.head_branch),
    runNumber: finiteNumber(run.run_number),
    updatedAt: textValue(run.updated_at),
  };
}

function runConclusionValue(run: LatestWorkflowRun): string {
  if (run.conclusion) return titleCase(run.conclusion);
  if (run.status) return titleCase(run.status);
  return "Unknown";
}

async function probeGitHub(): Promise<PlatformProbeResult> {
  const token = envValue(...GITHUB_TOKEN_ENV);
  if (!token) {
    // Defensive only — the registry never calls probe() unless isConfigured().
    return { state: "unavailable", headline: "GitHub token is missing.", metrics: [], error: "unauthorized" };
  }

  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": GITHUB_USER_AGENT,
  };

  try {
    const rateLimit = await requestJson(`${GITHUB_API_ORIGIN}/rate_limit`, { headers });
    if (!rateLimit.ok) {
      return upstreamFailure(
        rateLimit.status,
        rateLimit.status === 401 || rateLimit.status === 403
          ? "GitHub rejected the token."
          : "GitHub rate-limit check failed."
      );
    }

    const resources = asRecord(asRecord(rateLimit.data)?.resources);
    const core = rateWindow(resources, "core");
    const graphql = rateWindow(resources, "graphql");
    const headroom = headroomPercent(core);

    // The Actions read is best effort: a token scoped only to billing still
    // produces a useful rate-limit card, so a 403 here must not blank it.
    const runsUrl =
      `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(GITHUB_REPO_OWNER)}` +
      `/${encodeURIComponent(GITHUB_REPO_NAME)}/actions/runs?per_page=1`;
    let run: LatestWorkflowRun | null = null;
    let runsReadable = true;
    try {
      const runs = await requestJson(runsUrl, { headers });
      if (runs.ok) run = latestWorkflowRun(runs.data);
      else runsReadable = false;
    } catch {
      runsReadable = false;
    }

    const metrics: PlatformMetric[] = [
      metric(
        "Core Rate Limit",
        rateWindowValue(core),
        formatCountdown(core.reset) ? `resets ${formatCountdown(core.reset)}` : undefined
      ),
      metric("Core Headroom", formatPercent(headroom)),
      metric("GraphQL Rate Limit", rateWindowValue(graphql)),
    ];
    if (run) {
      metrics.push(
        metric(
          "Latest Workflow",
          run.name,
          [run.branch, run.runNumber === null ? null : `run #${integers(run.runNumber)}`]
            .filter((part): part is string => part !== null)
            .join(" · ") || undefined
        ),
        metric(
          "Run Conclusion",
          runConclusionValue(run),
          run.updatedAt ? formatAge(run.updatedAt) : undefined
        )
      );
    }

    const failureWord = run?.conclusion ? GITHUB_FAILED_CONCLUSIONS.get(run.conclusion) : undefined;
    const lowHeadroom = headroom !== null && headroom < GITHUB_LOW_HEADROOM_PERCENT;
    const headroomText = headroom === null ? "unknown" : formatPercent(headroom);

    const sentences: string[] = [];
    if (failureWord) {
      sentences.push(`Latest ${run?.name} run ${failureWord}.`);
      sentences.push(
        lowHeadroom
          ? `GitHub API rate limit is nearly exhausted at ${headroomText} headroom.`
          : `GitHub API headroom is ${headroomText}.`
      );
    } else if (lowHeadroom) {
      sentences.push(`GitHub API rate limit is nearly exhausted at ${headroomText} headroom.`);
    } else {
      sentences.push(`GitHub API is responding with ${headroomText} rate-limit headroom.`);
      if (run) {
        const outcome =
          run.conclusion === "success" ? "passed" : runConclusionValue(run).toLowerCase();
        sentences.push(`Latest ${run.name} run ${outcome}.`);
      } else if (!runsReadable) {
        sentences.push("Workflow runs are not readable with this token.");
      }
    }

    return {
      state: failureWord || lowHeadroom ? "degraded" : "healthy",
      // Two spaces between sentences — fleet copy standard.
      headline: sentences.join("  "),
      metrics,
      ...(failureWord ? { error: "workflow_failed" } : {}),
    };
  } catch (error) {
    return failureResult(error, "GitHub API is unreachable.");
  }
}

// ---------------------------------------------------------------------------
// App Store Connect
// ---------------------------------------------------------------------------

const ASC_ISSUER_ENV = "ASC_ISSUER_ID";
const ASC_KEY_ID_ENV = "ASC_KEY_ID";
const ASC_PRIVATE_KEY_ENV = "ASC_PRIVATE_KEY";

/**
 * `limit` alone would hand back an arbitrary partial page on an account with
 * more than five builds, so a newest build that failed processing — the exact
 * thing this card exists to surface — could fall outside the window entirely.
 * `sort=-uploadedDate` makes the server pick the newest five; the spelling
 * matches this repo's other App Store Connect caller, `scripts/asc-push-listing.rb`.
 */
const ASC_BUILDS_URL =
  "https://api.appstoreconnect.apple.com/v1/builds?sort=-uploadedDate&limit=5";
const ASC_AUDIENCE = "appstoreconnect-v1";
/** Apple rejects anything over 20 minutes; a probe needs far less. */
const ASC_TOKEN_LIFETIME_SECONDS = 600;
/** P-256 — each of R and S is exactly 32 bytes in the JOSE form. */
const ES256_COMPONENT_BYTES = 32;

const ASC_FAILED_STATES = new Set(["FAILED", "INVALID"]);

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Accept the PEM either with real newlines or with the `\n`-escaped form that
 * survives a single-line env var, and tolerate a bare base64 body.
 */
function normalizePrivateKeyPem(raw: string): string {
  const unescaped = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  const normalized = unescaped.replace(/\r\n/g, "\n").trim();
  if (normalized.includes("-----BEGIN")) return normalized;
  const body = normalized.replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

function readDerInteger(der: Buffer, offset: number): { value: Buffer; next: number } {
  if (der[offset] !== 0x02) throw new Error("ECDSA signature component is not a DER integer");
  const length = der[offset + 1];
  if (!Number.isInteger(length) || length === 0 || length > 0x7f) {
    throw new Error("ECDSA signature component has an unsupported length");
  }
  const start = offset + 2;
  const end = start + length;
  if (end > der.length) throw new Error("ECDSA signature component is truncated");
  return { value: der.subarray(start, end), next: end };
}

/** Strip DER's sign padding and left-pad to the fixed JOSE component width. */
function fixedWidthComponent(value: Buffer, size: number): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0x00) start += 1;
  const trimmed = value.subarray(start);
  if (trimmed.length > size) throw new Error("ECDSA signature component overflows P-256");
  const padded = Buffer.alloc(size);
  trimmed.copy(padded, size - trimmed.length);
  return padded;
}

/**
 * Convert OpenSSL's DER `SEQUENCE { INTEGER r, INTEGER s }` into the JOSE
 * fixed-width `R || S` form JWS requires.  DER components are variable length
 * (they drop leading zeros and add a 0x00 sign byte when the high bit is set),
 * so passing DER straight through produces a token Apple silently rejects.
 */
function derToJoseSignature(der: Buffer, componentBytes = ES256_COMPONENT_BYTES): Buffer {
  let offset = 0;
  if (der[offset] !== 0x30) throw new Error("ECDSA signature is not a DER sequence");
  offset += 1;
  let sequenceLength = der[offset];
  offset += 1;
  if (sequenceLength === undefined) throw new Error("ECDSA signature is truncated");
  if ((sequenceLength & 0x80) !== 0) {
    const lengthBytes = sequenceLength & 0x7f;
    if (lengthBytes < 1 || lengthBytes > 2) {
      throw new Error("ECDSA signature has an unsupported DER length");
    }
    sequenceLength = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      sequenceLength = (sequenceLength << 8) | (der[offset] ?? 0);
      offset += 1;
    }
  }
  if (offset + sequenceLength !== der.length) {
    throw new Error("ECDSA signature length does not match its contents");
  }
  const r = readDerInteger(der, offset);
  const s = readDerInteger(der, r.next);
  if (s.next !== der.length) throw new Error("ECDSA signature has trailing bytes");
  return Buffer.concat([
    fixedWidthComponent(r.value, componentBytes),
    fixedWidthComponent(s.value, componentBytes),
  ]);
}

/**
 * Build the ES256 bearer token Apple expects.  Throws a fixed, sanitized
 * message on any key problem so nothing derived from the .p8 can reach a card.
 */
function signAppStoreConnectToken(issuerId: string, keyId: string, privateKeyPem: string): string {
  let key: KeyObject;
  try {
    key = createPrivateKey(normalizePrivateKeyPem(privateKeyPem));
  } catch {
    throw new Error("App Store Connect private key could not be parsed");
  }
  if (key.asymmetricKeyType !== "ec") {
    throw new Error("App Store Connect private key must be an EC P-256 key");
  }
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (curve !== undefined && curve !== "prime256v1") {
    throw new Error("App Store Connect private key must be an EC P-256 key");
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = {
    iss: issuerId,
    iat: issuedAt,
    exp: issuedAt + ASC_TOKEN_LIFETIME_SECONDS,
    aud: ASC_AUDIENCE,
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;

  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const derSignature = signer.sign(key);
  return `${signingInput}.${derToJoseSignature(derSignature).toString("base64url")}`;
}

interface AscBuild {
  version: string | null;
  processingState: string | null;
  uploadedDate: string | null;
  expirationDate: string | null;
  expired: boolean | null;
}

function ascBuilds(data: unknown): AscBuild[] {
  return asArray(asRecord(data)?.data)
    .map((row) => asRecord(asRecord(row)?.attributes))
    .filter((attributes): attributes is Record<string, unknown> => attributes !== undefined)
    .map((attributes) => ({
      version: textValue(attributes.version),
      processingState: textValue(attributes.processingState),
      uploadedDate: textValue(attributes.uploadedDate),
      expirationDate: textValue(attributes.expirationDate),
      expired: typeof attributes.expired === "boolean" ? attributes.expired : null,
    }));
}

/**
 * The request already asks Apple for newest-first, so this is the belt to that
 * suspenders: a page that came back in another order still yields the newest
 * upload rather than whichever row happened to land first.
 */
function newestBuild(builds: AscBuild[]): AscBuild | null {
  let newest: AscBuild | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const build of builds) {
    const ms = build.uploadedDate ? Date.parse(build.uploadedDate) : Number.NaN;
    const score = Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
    if (newest === null || score > newestMs) {
      newest = build;
      newestMs = score;
    }
  }
  return newest;
}

async function probeAppStoreConnect(): Promise<PlatformProbeResult> {
  const issuerId = envValue(ASC_ISSUER_ENV);
  const keyId = envValue(ASC_KEY_ID_ENV);
  const privateKey = envValue(ASC_PRIVATE_KEY_ENV);
  if (!issuerId || !keyId || !privateKey) {
    return {
      state: "unavailable",
      headline: "App Store Connect credentials are incomplete.",
      metrics: [],
      error: "invalid_credentials",
    };
  }

  let token: string;
  try {
    token = signAppStoreConnectToken(issuerId, keyId, privateKey);
  } catch {
    // A key that cannot sign is a credential problem, not a network one, so
    // this deliberately reports "unavailable" rather than "unreachable".  The
    // message is fixed text: nothing derived from the key is ever echoed.
    return {
      state: "unavailable",
      headline: "App Store Connect key could not sign a request.  Check ASC_PRIVATE_KEY and ASC_KEY_ID.",
      metrics: [],
      error: "invalid_credentials",
    };
  }

  try {
    const response = await requestJson(ASC_BUILDS_URL, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      return upstreamFailure(
        response.status,
        response.status === 401 || response.status === 403
          ? "App Store Connect rejected the API key."
          : "App Store Connect build lookup failed."
      );
    }

    const builds = ascBuilds(response.data);
    const latest = newestBuild(builds);
    if (!latest) {
      return {
        state: "healthy",
        headline: "App Store Connect is reachable.  No builds have been uploaded yet.",
        metrics: [metric("Recent Builds", formatCount(0, "build"))],
      };
    }

    const processingState = latest.processingState?.toUpperCase() ?? null;
    const failed = processingState !== null && ASC_FAILED_STATES.has(processingState);
    const processingCount = builds.filter(
      (build) => build.processingState?.toUpperCase() === "PROCESSING"
    ).length;
    const version = latest.version ?? "Unknown";

    const metrics: PlatformMetric[] = [
      metric(
        "Latest Build",
        version,
        latest.uploadedDate ? `uploaded ${formatAge(latest.uploadedDate)}` : undefined
      ),
      metric("Processing State", processingState ? titleCase(processingState) : "Unknown"),
      metric("Builds In Processing", formatCount(processingCount, "build")),
      metric("Recent Builds", formatCount(builds.length, "build"), "latest 5"),
    ];
    const expiry = latest.expired === true ? "Expired" : formatCountdown(latest.expirationDate);
    if (expiry) metrics.push(metric("Build Expiry", expiry));

    const headline = failed
      ? `Latest build ${version} failed processing in App Store Connect.`
      : processingState === "PROCESSING"
        ? `Latest build ${version} is still processing in App Store Connect.`
        : `Latest build ${version} is processed and ready in App Store Connect.`;

    return {
      state: failed ? "degraded" : "healthy",
      headline,
      metrics,
      ...(failed ? { error: "build_processing_failed" } : {}),
    };
  } catch (error) {
    return failureResult(error, "App Store Connect is unreachable.");
  }
}

// ---------------------------------------------------------------------------

export const DEVELOPER_PROBES: readonly PlatformProbe[] = [
  {
    id: "github",
    name: "GitHub",
    category: "developer",
    requiredEnv: [GITHUB_TOKEN_ENV[0]],
    consoleUrl: `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/actions`,
    isConfigured: () => hasEnv(...GITHUB_TOKEN_ENV),
    probe: probeGitHub,
  },
  {
    id: "app-store-connect",
    name: "App Store Connect",
    category: "developer",
    requiredEnv: [ASC_ISSUER_ENV, ASC_KEY_ID_ENV, ASC_PRIVATE_KEY_ENV],
    consoleUrl: "https://appstoreconnect.apple.com/apps",
    isConfigured: () =>
      hasEnv(ASC_ISSUER_ENV) && hasEnv(ASC_KEY_ID_ENV) && hasEnv(ASC_PRIVATE_KEY_ENV),
    probe: probeAppStoreConnect,
  },
];
