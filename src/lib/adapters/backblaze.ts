import {
  AdapterError,
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingRecord,
  type UsageResult,
} from "./helpers";

/**
 * Backblaze B2 inventory + catalog storage-cost estimate.
 *
 * B2 has no public invoice/billing-history API. This adapter:
 * 1. Authorizes with applicationKeyId + applicationKey (Class C / free).
 * 2. Lists buckets the key can see (listBuckets).
 * 3. Pages b2_list_file_versions per bucket (Class C) to sum stored bytes
 *    including hidden versions that still bill until permanently deleted.
 * 4. Estimates monthly storage run-rate from public B2 pricing
 *    (default $0.006/GB-month after a free allowance), pro-rates by UTC month
 *    elapsed, and labels totalCost with costCoverageCaveat (not an invoice).
 *
 * Download / Class A/B transaction spend is not available from inventory APIs;
 * set soft caps via ProviderPlan.monthlyBudgetUsd and requestLimit (storage MB).
 * Console Caps & Alerts remain the hard protection layer.
 *
 * Credentials:
 * - Preferred: API key field = applicationKey, config.applicationKeyId = key id.
 * - Also accepted: API key field = "keyId:applicationKey" (B2 CLI style).
 * - Optional config: storagePricePerGbMonth, freeStorageGb, storageCapGb,
 *   maxFilesPerBucket (safety bound for huge buckets).
 */

const AUTH_URL = "https://api.backblazeb2.com/b2api/v2/b2_authorize_account";
const DEFAULT_STORAGE_PRICE_PER_GB = 0.006;
const DEFAULT_FREE_STORAGE_GB = 10;
const DEFAULT_MAX_FILES_PER_BUCKET = 50_000;
const LIST_PAGE_SIZE = 1_000;
const MAX_PAGES_PER_BUCKET = 100;
/** Litestream replica bucket for this app — exclude from inventory by default. */
const USAGE_MONITOR_BACKUP_BUCKET = "api-usage-monitor";

function shouldInventoryBucket(bucketName: string, config?: Record<string, unknown>): boolean {
  if (config?.includeUsageMonitorBackupBucket === true) return true;
  return bucketName.toLowerCase() !== USAGE_MONITOR_BACKUP_BUCKET;
}

function invalidResponse(message: string): never {
  throw new AdapterError(`Backblaze B2: ${message}`, { code: "INVALID_RESPONSE" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function roundMoney(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function roundGb(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function resolveBackblazeCredentials(
  apiKey: string,
  config?: Record<string, unknown>
): { applicationKeyId: string; applicationKey: string } {
  const rawKey = apiKey.trim();
  const configKeyId =
    stringValue(config?.applicationKeyId) ??
    stringValue(config?.keyId) ??
    stringValue(config?.applicationKeyID);

  // Combined "keyId:applicationKey" (B2 authorize format). Key ids look like
  // 00… and application keys never contain colons in practice.
  if (rawKey.includes(":")) {
    const colon = rawKey.indexOf(":");
    const idPart = rawKey.slice(0, colon).trim();
    const secretPart = rawKey.slice(colon + 1).trim();
    if (idPart && secretPart) {
      return { applicationKeyId: idPart, applicationKey: secretPart };
    }
  }

  if (!configKeyId) {
    configurationError(
      "Backblaze B2 requires applicationKeyId (config) plus applicationKey (API key), or a combined keyId:applicationKey value"
    );
  }
  if (!rawKey) {
    configurationError("Backblaze B2 applicationKey is empty");
  }
  return { applicationKeyId: configKeyId, applicationKey: rawKey };
}

interface B2Authorize {
  accountId: string;
  apiUrl: string;
  downloadUrl?: string;
  authorizationToken: string;
  allowed?: {
    capabilities?: string[];
    bucketId?: string | null;
    bucketName?: string | null;
  };
}

interface B2Bucket {
  bucketId: string;
  bucketName: string;
  bucketType?: string;
  revision?: number;
  lifecycleRules?: unknown[];
}

interface B2FileVersion {
  fileId?: string;
  fileName?: string;
  contentLength?: number;
  contentType?: string;
  action?: string;
  uploadTimestamp?: number;
}

interface BucketInventory {
  bucketId: string;
  bucketName: string;
  bucketType: string | null;
  fileVersions: number;
  storageBytes: number;
  storageGb: number;
  incomplete: boolean;
  truncated: boolean;
}

function utcMonthFraction(now: Date): {
  monthStart: Date;
  nextMonth: Date;
  fraction: number;
} {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const monthMs = Math.max(1, nextMonth.getTime() - monthStart.getTime());
  const elapsedMs = Math.min(monthMs, Math.max(0, now.getTime() - monthStart.getTime()));
  return { monthStart, nextMonth, fraction: elapsedMs / monthMs };
}

async function authorizeAccount(
  applicationKeyId: string,
  applicationKey: string
): Promise<B2Authorize> {
  const basic = Buffer.from(`${applicationKeyId}:${applicationKey}`, "utf8").toString(
    "base64"
  );
  const response = await fetchJson(AUTH_URL, {
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!response.ok) {
    return errorResult(response.status, { note: "Backblaze b2_authorize_account failed" });
  }
  if (!isRecord(response.data)) {
    invalidResponse("authorize response must be an object");
  }
  const accountId = stringValue(response.data.accountId);
  const apiUrl = stringValue(response.data.apiUrl);
  const authorizationToken = stringValue(response.data.authorizationToken);
  if (!accountId || !apiUrl || !authorizationToken) {
    invalidResponse("authorize response missing accountId, apiUrl, or authorizationToken");
  }
  const allowed = isRecord(response.data.allowed) ? response.data.allowed : undefined;
  return {
    accountId,
    apiUrl: apiUrl.replace(/\/$/, ""),
    downloadUrl: stringValue(response.data.downloadUrl) ?? undefined,
    authorizationToken,
    allowed: allowed
      ? {
          capabilities: Array.isArray(allowed.capabilities)
            ? allowed.capabilities.filter((c): c is string => typeof c === "string")
            : undefined,
          bucketId: stringValue(allowed.bucketId),
          bucketName: stringValue(allowed.bucketName),
        }
      : undefined,
  };
}

async function b2Post<T>(
  apiUrl: string,
  token: string,
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  const response = await fetchJson(`${apiUrl}/b2api/v2/${path}`, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    return errorResult(response.status, { note: `Backblaze ${path} failed` });
  }
  if (!isRecord(response.data) && !Array.isArray(response.data)) {
    invalidResponse(`${path} returned a non-object body`);
  }
  return response.data as T;
}

async function listBuckets(
  apiUrl: string,
  token: string,
  accountId: string
): Promise<B2Bucket[]> {
  const data = await b2Post<{ buckets?: unknown }>(apiUrl, token, "b2_list_buckets", {
    accountId,
  });
  if (!Array.isArray(data.buckets)) {
    invalidResponse("list_buckets missing buckets array");
  }
  const out: B2Bucket[] = [];
  for (const row of data.buckets) {
    if (!isRecord(row)) invalidResponse("list_buckets entry is not an object");
    const bucketId = stringValue(row.bucketId);
    const bucketName = stringValue(row.bucketName);
    if (!bucketId || !bucketName) {
      invalidResponse("list_buckets entry missing bucketId or bucketName");
    }
    out.push({
      bucketId,
      bucketName,
      bucketType: stringValue(row.bucketType) ?? undefined,
      revision: typeof row.revision === "number" ? row.revision : undefined,
      lifecycleRules: Array.isArray(row.lifecycleRules) ? row.lifecycleRules : undefined,
    });
  }
  return out;
}

async function inventoryBucket(
  apiUrl: string,
  token: string,
  bucket: B2Bucket,
  maxFiles: number
): Promise<BucketInventory> {
  let startFileName: string | undefined;
  let startFileId: string | undefined;
  let fileVersions = 0;
  let storageBytes = 0;
  let truncated = false;
  let pages = 0;

  while (pages < MAX_PAGES_PER_BUCKET && fileVersions < maxFiles) {
    pages += 1;
    const remaining = maxFiles - fileVersions;
    const maxFileCount = Math.min(LIST_PAGE_SIZE, remaining);
    const body: Record<string, unknown> = {
      bucketId: bucket.bucketId,
      maxFileCount,
    };
    if (startFileName) body.startFileName = startFileName;
    if (startFileId) body.startFileId = startFileId;

    const data = await b2Post<{
      files?: unknown;
      nextFileName?: unknown;
      nextFileId?: unknown;
    }>(apiUrl, token, "b2_list_file_versions", body);

    const files = data.files;
    if (!Array.isArray(files)) {
      invalidResponse(`list_file_versions for ${bucket.bucketName} missing files array`);
    }

    for (const row of files) {
      if (!isRecord(row)) {
        invalidResponse(`list_file_versions for ${bucket.bucketName} has a non-object file`);
      }
      const file = row as B2FileVersion;
      // upload / hide both occupy storage for contentLength; start actions
      // are unfinished large files and may have contentLength 0.
      const len = typeof file.contentLength === "number" ? file.contentLength : 0;
      if (Number.isFinite(len) && len > 0) storageBytes += len;
      fileVersions += 1;
    }

    const nextName = stringValue(data.nextFileName);
    const nextId = stringValue(data.nextFileId);
    if (!nextName) break;
    startFileName = nextName;
    startFileId = nextId ?? undefined;
    if (fileVersions >= maxFiles) {
      truncated = true;
      break;
    }
  }

  if (pages >= MAX_PAGES_PER_BUCKET) truncated = true;

  return {
    bucketId: bucket.bucketId,
    bucketName: bucket.bucketName,
    bucketType: bucket.bucketType ?? null,
    fileVersions,
    storageBytes,
    storageGb: roundGb(storageBytes / (1024 * 1024 * 1024)),
    incomplete: truncated,
    truncated,
  };
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const { applicationKeyId, applicationKey } = resolveBackblazeCredentials(apiKey, config);

  const pricePerGb =
    parseNumber(config?.storagePricePerGbMonth) ?? DEFAULT_STORAGE_PRICE_PER_GB;
  const freeStorageGb =
    parseNumber(config?.freeStorageGb) ?? DEFAULT_FREE_STORAGE_GB;
  const storageCapGb = parseNumber(config?.storageCapGb);
  const maxFilesPerBucket = Math.max(
    1,
    Math.floor(parseNumber(config?.maxFilesPerBucket) ?? DEFAULT_MAX_FILES_PER_BUCKET)
  );

  if (!(pricePerGb >= 0) || !Number.isFinite(pricePerGb)) {
    configurationError("storagePricePerGbMonth must be a non-negative number");
  }
  if (!(freeStorageGb >= 0) || !Number.isFinite(freeStorageGb)) {
    configurationError("freeStorageGb must be a non-negative number");
  }

  const auth = await authorizeAccount(applicationKeyId, applicationKey);
  const caps = auth.allowed?.capabilities ?? [];
  if (caps.length > 0 && !caps.includes("listBuckets") && !auth.allowed?.bucketId) {
    // Bucket-scoped keys often omit listBuckets but still list the one bucket
    // via allowed.bucketId. Fail only when we cannot discover any bucket.
  }

  let buckets: B2Bucket[] = [];
  if (caps.includes("listBuckets") || caps.length === 0) {
    try {
      buckets = await listBuckets(auth.apiUrl, auth.authorizationToken, auth.accountId);
    } catch (err) {
      // Fall through to single-bucket scope when listBuckets is denied.
      if (auth.allowed?.bucketId && auth.allowed?.bucketName) {
        buckets = [
          {
            bucketId: auth.allowed.bucketId,
            bucketName: auth.allowed.bucketName,
            bucketType: undefined,
          },
        ];
      } else {
        throw err;
      }
    }
  } else if (auth.allowed?.bucketId && auth.allowed?.bucketName) {
    buckets = [
      {
        bucketId: auth.allowed.bucketId,
        bucketName: auth.allowed.bucketName,
      },
    ];
  } else {
    configurationError(
      "Backblaze key cannot listBuckets and has no allowed bucket scope"
    );
  }

  const inventories: BucketInventory[] = [];
  for (const bucket of buckets) {
    if (!shouldInventoryBucket(bucket.bucketName, config)) continue;
    inventories.push(
      await inventoryBucket(
        auth.apiUrl,
        auth.authorizationToken,
        bucket,
        maxFilesPerBucket
      )
    );
  }

  const totalBytes = inventories.reduce((s, b) => s + b.storageBytes, 0);
  const totalVersions = inventories.reduce((s, b) => s + b.fileVersions, 0);
  const totalGb = roundGb(totalBytes / (1024 * 1024 * 1024));
  const billableGb = Math.max(0, totalGb - freeStorageGb);
  const monthlyRunRate = roundMoney(billableGb * pricePerGb);
  const anyTruncated = inventories.some((b) => b.truncated);

  const now = new Date();
  const { monthStart, fraction } = utcMonthFraction(now);
  const estimatedMtd = roundMoney(monthlyRunRate * fraction);

  // totalRequests stores whole megabytes of storage so ProviderPlan.requestLimit
  // can act as a soft storage cap in MB (Render bandwidth pattern).
  const storageMb = Math.round(totalBytes / (1024 * 1024));

  const softCap = storageCapGb != null && Number.isFinite(storageCapGb) ? storageCapGb : null;
  const overSoftCap = softCap != null && totalGb > softCap;

  const records: AdapterExternalBillingRecord[] = inventories.map((b) => ({
    externalId: b.bucketId,
    kind: "service_plan" as const,
    serviceName: b.bucketName,
    planName: b.bucketType ?? "B2 bucket",
    status: b.truncated ? "partial" : "active",
    amountUsd: roundMoney(
      Math.max(0, b.storageGb - freeStorageGb / Math.max(1, inventories.length)) *
        pricePerGb
    ),
    currency: "USD",
    usageQuantity: b.storageGb,
    usageUnit: "GB",
    rollupRole: "metadata" as const,
  }));

  const caveatParts = [
    "Estimated storage MTD from public B2 price × inventoried file versions, pro-rated by UTC month elapsed. Not an invoice.",
    "Download bandwidth and Class A/B API transactions are not included (console Caps & Alerts cover hard limits).",
  ];
  if (anyTruncated) {
    caveatParts.push(
      `Inventory truncated at ${maxFilesPerBucket} file versions per bucket; storage may be understated.`
    );
  }
  if (overSoftCap && softCap != null) {
    caveatParts.push(
      `Soft storage cap ${softCap} GB exceeded (current ${totalGb} GB).`
    );
  }

  return {
    balance: null,
    totalCost: estimatedMtd,
    costWindowStart: monthStart,
    costWindowEnd: now,
    costScope: "calendar_month_to_date",
    costCoverageCaveat: {
      code: anyTruncated
        ? "backblaze_storage_estimate_partial"
        : "backblaze_storage_catalog_prorated",
      message: caveatParts.join(" "),
    },
    totalRequests: storageMb,
    credits: freeStorageGb > 0 ? Math.max(0, freeStorageGb - totalGb) : null,
    rawData: {
      accountIdSuffix: auth.accountId.slice(-8),
      apiUrl: auth.apiUrl,
      capabilities: caps,
      scopedBucketName: auth.allowed?.bucketName ?? null,
      buckets: inventories,
      resourceCounts: {
        buckets: inventories.length,
        fileVersions: totalVersions,
      },
      storage: {
        totalBytes,
        totalGb,
        totalMb: storageMb,
        freeStorageGb,
        billableGb,
        pricePerGbMonthUsd: pricePerGb,
        softCapGb: softCap,
        overSoftCap,
      },
      monthlyRunRate: {
        amount: monthlyRunRate,
        currency: "USD",
        basis: "storage_gb_after_free_allowance_times_public_price",
        estimatedMtdUsd: estimatedMtd,
        monthFraction: fraction,
      },
      capabilities_flags: {
        completeInventory: !anyTruncated,
        actualInvoiceCost: false,
        downloadUsageTracked: false,
        classABTransactionsTracked: false,
      },
    },
    externalBilling: {
      source: "backblaze-b2-bucket-storage",
      authoritative: !anyTruncated,
      records,
    },
  };
}
