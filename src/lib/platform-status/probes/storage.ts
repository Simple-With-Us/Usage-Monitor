/**
 * Storage & backups platform probes.
 *
 * Two cards, both strictly read-only:
 *  - Backblaze B2 — the off-site backup vault for the whole fleet.  We check
 *    that the read-only monitor key still authorizes and can see the buckets,
 *    because a silently rotated or re-scoped key is how backup monitoring dies
 *    without anyone noticing.
 *  - Cloudflare R2 — four accounts, four separate free tiers.  We reuse the
 *    existing read-only fleet summary so this card and the Ops dashboard can
 *    never disagree about who is close to the limit.
 *
 * Neither probe deletes, prunes, or writes anything.  B2 stored-byte totals are
 * deliberately absent: B2 exposes no storage-summary endpoint, and the only way
 * to total bytes is to page every file version in every bucket, which is far
 * too expensive for a card that refreshes every minute.
 */

import { AdapterError } from "@/lib/adapters/helpers";
import {
  R2_THRESHOLD_PCT,
  fetchR2FleetSummary,
  loadR2FleetAccounts,
} from "@/lib/r2-usage";
import {
  asArray,
  asRecord,
  envValue,
  failureResult,
  formatBytes,
  formatBytesCompact,
  formatCount,
  hasEnv,
  httpErrorCode,
  metric,
  requestJson,
  upstreamFailure,
} from "../probe-helpers";
import type { PlatformMetric, PlatformProbe, PlatformProbeResult } from "../types";

// ---------------------------------------------------------------------------
// Backblaze B2
// ---------------------------------------------------------------------------

/**
 * Credential names, in the same precedence order `fleet-backup-status.ts`
 * resolves its read-only monitor key.  Those helpers are module-private there,
 * so the order is mirrored rather than imported; the names must stay in sync.
 */
const B2_KEY_ID_ENV: string[] = [
  "BACKBLAZE_APPLICATION_KEY_ID",
  "B2_MONITOR_KEY_ID",
  "BACKBLAZE_KEY_ID",
  "B2_KEY_ID",
];
const B2_APPLICATION_KEY_ENV: string[] = [
  "BACKBLAZE_APPLICATION_KEY",
  "B2_MONITOR_APPLICATION_KEY",
  "B2_APPLICATION_KEY",
];

/** Hard-coded vendor endpoint, so this one stays on the trusted path. */
const B2_AUTHORIZE_URL = "https://api.backblazeb2.com/b2api/v2/b2_authorize_account";

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function probeBackblaze(): Promise<PlatformProbeResult> {
  const keyId = envValue(...B2_KEY_ID_ENV);
  const applicationKey = envValue(...B2_APPLICATION_KEY_ENV);
  if (!keyId || !applicationKey) {
    return {
      state: "unavailable",
      headline: "Only half of the Backblaze monitor key is set.",
      metrics: [],
      error: "missing_credentials",
    };
  }

  try {
    const basic = Buffer.from(`${keyId}:${applicationKey}`, "utf8").toString("base64");
    const auth = await requestJson(B2_AUTHORIZE_URL, {
      headers: { Authorization: `Basic ${basic}` },
    });

    if (!auth.ok) {
      return upstreamFailure(
        auth.status,
        auth.status === 401 || auth.status === 403
          ? "Backblaze rejected the monitor key."
          : "Backblaze could not authorize the monitor key."
      );
    }

    const authData = asRecord(auth.data);
    const apiUrl = trimmed(authData?.apiUrl);
    const token = trimmed(authData?.authorizationToken);
    const accountId = trimmed(authData?.accountId);
    if (!apiUrl || !token || !accountId) {
      return {
        state: "degraded",
        headline: "Backblaze authorized the key but returned a response this probe cannot read.",
        metrics: [],
        error: "invalid_response",
      };
    }

    const allowed = asRecord(authData?.allowed);
    const capabilities = asArray(allowed?.capabilities).filter(
      (entry): entry is string => typeof entry === "string"
    );
    // An unscoped key reports no capability list at all; treat that as full read.
    const may = (capability: string): boolean =>
      capabilities.length === 0 || capabilities.includes(capability);
    const scopedBucketName = trimmed(allowed?.bucketName);

    let bucketCount: number | null = null;
    let listFailureStatus: number | null = null;

    if (may("listBuckets")) {
      // `apiUrl` is discovered from the authorize response rather than compiled
      // in, so it goes out over the pinned-DNS untrusted path.
      const listed = await requestJson(
        `${apiUrl.replace(/\/$/, "")}/b2api/v2/b2_list_buckets`,
        {
          method: "POST",
          headers: { Authorization: token, "Content-Type": "application/json" },
          body: JSON.stringify({ accountId }),
        },
        { security: "untrusted" }
      );
      if (listed.ok) {
        bucketCount = asArray(asRecord(listed.data)?.buckets).filter(
          (row) => asRecord(row) !== undefined
        ).length;
      } else if (!scopedBucketName) {
        return upstreamFailure(
          listed.status,
          "Backblaze accepted the monitor key but refused to list buckets."
        );
      } else {
        listFailureStatus = listed.status;
      }
    }
    if (bucketCount === null && scopedBucketName) bucketCount = 1;

    const canListFiles = may("listFiles");
    const metrics: PlatformMetric[] = [
      metric(
        "Buckets",
        bucketCount === null ? "Unavailable" : formatCount(bucketCount, "bucket")
      ),
      metric(
        "Key Scope",
        scopedBucketName ?? "All buckets",
        scopedBucketName ? "single-bucket key" : undefined
      ),
      metric("File Listing", canListFiles ? "Allowed" : "Denied", "monitor key"),
      metric("Account", `…${accountId.slice(-8)}`),
    ];

    if (!canListFiles) {
      return {
        state: "degraded",
        headline:
          "Backblaze B2 is reachable.  The monitor key cannot list files, so backup inventory will not work.",
        metrics,
        error: "insufficient_scope",
      };
    }

    if (listFailureStatus !== null) {
      return {
        state: "degraded",
        headline:
          "Backblaze B2 is reachable.  The key only covers one bucket, so fleet-wide inventory is unavailable.",
        metrics,
        error: httpErrorCode(listFailureStatus),
      };
    }

    return {
      state: "healthy",
      headline: "Backblaze B2 accepted the read-only monitor key.",
      metrics,
    };
  } catch (error) {
    return failureResult(error, "Could not reach Backblaze B2.");
  }
}

// ---------------------------------------------------------------------------
// Cloudflare R2
// ---------------------------------------------------------------------------

/** Per-request ceiling for the fleet sweep; four accounts run in parallel. */
const R2_REQUEST_TIMEOUT_MS = 6_000;
/** Whole-sweep ceiling, so one hung account cannot stall the platforms page. */
const R2_SWEEP_DEADLINE_MS = 14_000;
/**
 * Trusted Cloudflare GraphQL only.  The default probe cap is 256 KiB so a
 * status check cannot pull an unbounded dump; this query is compile-time
 * pinned.  A 24h latest-per-bucket window stays small; a second month-long
 * group-by-bucketName field covers idle orphans.  1 MiB leaves headroom if
 * an account grows more buckets without failing the card.
 */
export const R2_GRAPHQL_MAX_RESPONSE_BYTES = 1024 * 1024;

const R2_CONSOLE_URL = "https://dash.cloudflare.com/?to=/:account/r2/overview";

function isCloudflareApiUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === "api.cloudflare.com";
  } catch {
    return false;
  }
}

function toResponse(status: number, data: unknown): Response {
  const safeStatus =
    Number.isInteger(status) && status >= 200 && status <= 599 ? status : 502;
  const isText = typeof data === "string";
  const body =
    data === null || data === undefined ? "" : isText ? (data as string) : JSON.stringify(data);
  const bodyless = safeStatus === 204 || safeStatus === 205 || safeStatus === 304;
  return new Response(bodyless ? null : body, {
    status: safeStatus,
    headers: { "content-type": isText ? "text/plain" : "application/json" },
  });
}

interface RecordingFetch {
  fetch: typeof fetch;
  /** First non-ok HTTP status the sweep saw, so we can map it to a card state. */
  firstErrorStatus: () => number | null;
  /** First transport-level failure, kept so a size/timeout cap stays legible. */
  firstThrown: () => unknown;
}

/**
 * A `fetch`-shaped shim over {@link requestJson}.
 *
 * `fetchR2FleetSummary` takes an injectable transport, so the fleet sweep runs
 * through the bounded, SSRF-safe adapter stack instead of global fetch.  It
 * also lets the probe recover the upstream status that the summary itself
 * flattens into a per-account error string we must never render.
 */
function createRecordingFetch(): RecordingFetch {
  let firstErrorStatus: number | null = null;
  let firstThrown: unknown = null;

  const impl: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    try {
      const isGraphql = /\/client\/v4\/graphql(?:\?|$)/i.test(url);
      const response = await requestJson(url, init, {
        security: isCloudflareApiUrl(url) ? "trusted" : "untrusted",
        timeoutMs: R2_REQUEST_TIMEOUT_MS,
        maxResponseBytes: isGraphql ? R2_GRAPHQL_MAX_RESPONSE_BYTES : undefined,
      });
      if (!response.ok && firstErrorStatus === null) firstErrorStatus = response.status;
      return toResponse(response.status, response.data);
    } catch (error) {
      if (firstThrown === null) firstThrown = error;
      throw error;
    }
  };

  return {
    fetch: impl,
    firstErrorStatus: () => firstErrorStatus,
    firstThrown: () => firstThrown,
  };
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`R2 sweep timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isResponseTooLarge(error: unknown): boolean {
  return error instanceof AdapterError && error.code === "RESPONSE_TOO_LARGE";
}

function usageReadHint(error?: string): string {
  if (error && /too large|RESPONSE_TOO_LARGE|size limit/i.test(error)) {
    return "analytics payload too large";
  }
  return "usage read failed";
}

async function probeCloudflareR2(): Promise<PlatformProbeResult> {
  const transport = createRecordingFetch();

  let summary: Awaited<ReturnType<typeof fetchR2FleetSummary>>;
  try {
    summary = await withDeadline(fetchR2FleetSummary(transport.fetch), R2_SWEEP_DEADLINE_MS);
  } catch (error) {
    return failureResult(error, "Could not reach the Cloudflare analytics API.");
  }

  const accounts = summary.accounts.filter((account) => account.configured);
  const failed = accounts.filter((account) => account.status === "error");
  const status = transport.firstErrorStatus();

  if (accounts.length > 0 && failed.length === accounts.length) {
    if (status !== null) {
      return upstreamFailure(
        status,
        status === 401 || status === 403
          ? "Cloudflare rejected the R2 analytics token."
          : "Cloudflare returned no R2 usage for any account."
      );
    }
    const thrown = transport.firstThrown();
    if (isResponseTooLarge(thrown)) {
      return {
        state: "degraded",
        headline: "Cloudflare returned more R2 analytics data than this probe accepts.",
        metrics: [],
        error: "response_too_large",
      };
    }
    return failureResult(thrown, "Could not reach the Cloudflare analytics API.");
  }

  const freeTierBytes = summary.freeTier.storageBytes;
  const metrics: PlatformMetric[] = [];
  const notEnabled = accounts.filter((account) => account.metricsSource === "r2_not_enabled");
  for (const account of accounts) {
    if (account.metricsSource === "r2_not_enabled") {
      metrics.push(metric(account.label, "R2 not enabled"));
      continue;
    }
    if (account.status === "error" || !account.storage) {
      metrics.push(
        metric(account.label, "Unavailable", usageReadHint(account.error))
      );
      continue;
    }
    const peakHint =
      account.monthPeakBytes != null &&
      account.monthPeakBytes > account.storage.actual + 1024 * 1024
        ? `month peak ${formatBytes(account.monthPeakBytes)}${
            account.monthPeakDate ? ` ${account.monthPeakDate}` : ""
          }`
        : account.currentBytes != null &&
            Math.abs(account.currentBytes - account.storage.actual) > 1024 * 1024
          ? `now ${formatBytes(account.currentBytes)}`
          : undefined;
    metrics.push(
      metric(
        account.label,
        `${formatBytes(account.storage.actual)} / ${formatBytesCompact(freeTierBytes)} Free Tier`,
        peakHint,
        account.storage.mtdPct
      )
    );
  }
  metrics.push(
    metric("Accounts Reporting", `${accounts.length - failed.length} of ${accounts.length}`)
  );
  if (summary.localBackup.autoDisabled) {
    metrics.push(metric("R2 Writes", "Paused by free-tier guard", "this host"));
  }

  if (summary.localBackup.autoDisabled) {
    return {
      state: "degraded",
      headline:
        "R2 writes are paused by the free-tier guard.  Litestream stays stopped until it clears.",
      metrics,
      error: "free_tier_guard",
    };
  }

  const pressured = accounts.find((account) => account.overallOnTrackToExceed70Pct);
  if (pressured) {
    return {
      state: "degraded",
      headline: `${pressured.label} is past the ${R2_THRESHOLD_PCT}% R2 free-tier guard.  Cut storage or operations now.`,
      metrics,
      error: "free_tier_pressure",
    };
  }

  if (failed.length > 0) {
    return {
      state: "degraded",
      headline: `Cloudflare returned no R2 usage for ${failed.length} of ${accounts.length} accounts.`,
      metrics,
      error: status !== null ? httpErrorCode(status) : "upstream_error",
    };
  }

  if (notEnabled.length > 0 && notEnabled.length === accounts.length) {
    return {
      state: "healthy",
      headline: "No Cloudflare account in this fleet has R2 enabled.",
      metrics,
    };
  }

  return {
    state: "healthy",
    headline:
      notEnabled.length > 0
        ? `Every live R2 account is under the ${R2_THRESHOLD_PCT}% free-tier guard.`
        : `Every R2 account is under the ${R2_THRESHOLD_PCT}% free-tier guard.`,
    metrics,
  };
}

// ---------------------------------------------------------------------------

export const STORAGE_PROBES: readonly PlatformProbe[] = [
  {
    id: "backblaze-b2",
    name: "Backblaze B2",
    category: "storage",
    requiredEnv: ["BACKBLAZE_APPLICATION_KEY_ID", "BACKBLAZE_APPLICATION_KEY"],
    consoleUrl: "https://secure.backblaze.com/b2_buckets.htm",
    isConfigured: () =>
      hasEnv(...B2_KEY_ID_ENV) && hasEnv(...B2_APPLICATION_KEY_ENV),
    probe: probeBackblaze,
  },
  {
    id: "cloudflare-r2",
    name: "Cloudflare R2",
    category: "storage",
    requiredEnv: [
      "R2_USAGE_ACCOUNT_ID",
      "CLOUDFLARE_FLEET_API_TOKEN",
      "R2_USAGE_API_TOKEN",
      "CLOUDFLARE_ST_ACCOUNT_ID",
      "CLOUDFLARE_ST_API_TOKEN",
      "CLOUDFLARE_CT_ACCOUNT_ID",
      "CLOUDFLARE_CT_API_TOKEN",
      "CLOUDFLARE_OLD_ACCOUNT_ID",
      "CLOUDFLARE_OLD_API_TOKEN",
    ],
    consoleUrl: R2_CONSOLE_URL,
    isConfigured: () => loadR2FleetAccounts(process.env).length > 0,
    probe: probeCloudflareR2,
  },
];
