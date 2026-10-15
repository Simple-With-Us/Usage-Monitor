/**
 * Backblaze B2 fleet app usage breakdown (storage + daily download / Class C).
 *
 * Storage comes from the latest `backblaze-b2-bucket-storage` external-billing
 * rows (Backblaze provider poll).  Download bandwidth and API transaction counts
 * come from Backblaze's daily Usage Report CSV in the auto-created
 * `b2-reports-$ACCOUNTID` bucket when the monitor key can read it.
 */

import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { resolveBackblazeMonitorCredentials } from "@/lib/b2-monitor-credentials";
import { sendPushoverNotification } from "@/lib/r2-usage";

import type {
  B2AppId,
  B2AppUsageBreakdownPayload,
  B2AppUsageDailyPoint,
  B2AppUsageSlice,
} from "@/lib/b2-app-usage-types";

export type {
  B2AppId,
  B2AppUsageBreakdownPayload,
  B2AppUsageDailyPoint,
  B2AppUsageSlice,
} from "@/lib/b2-app-usage-types";

export const B2_APP_USAGE_CACHE_TTL_MS = 180_000;
export const B2_CLASS_C_DAILY_FREE_DEFAULT = 2500;
export const B2_DOWNLOAD_GB_DAILY_FREE_DEFAULT = 1;
export const B2_CLASS_C_NEAR_CAP_RATIO = 0.8;
export const B2_DOWNLOAD_NEAR_CAP_RATIO = 0.8;
export const B2_CLASS_C_SPIKE_MULTIPLIER = 3;
export const B2_USAGE_REPORT_DAYS = 7;
export const B2_DAILY_PUSHOVER_FILENAME = "b2-last-daily-pushover.json";

export interface B2UsageCheckResult {
  assessment: B2AppUsageBreakdownPayload;
  pushoverSent: boolean;
}

const APP_LABELS: Record<B2AppId, string> = {
  "usage-monitor": "Usage Monitor",
  "socratic-trade": "Socratic.Trade",
  "congress-trade": "Congress.Trade",
  "fleet-infra": "Fleet Infra",
  other: "Other",
};

interface CacheEntry {
  payload: B2AppUsageBreakdownPayload;
  expiresAt: number;
}

const runtime: { cache?: CacheEntry; inFlight?: Promise<B2AppUsageBreakdownPayload> } =
  {};

export function resetB2AppUsageCacheForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("B2 app usage cache can only be reset in tests");
  }
  runtime.cache = undefined;
  runtime.inFlight = undefined;
}

export function resolveBucketAppId(bucketName: string): B2AppId {
  const raw = bucketName.toLowerCase();
  if (raw.includes("socratic")) return "socratic-trade";
  if (raw.includes("congress")) return "congress-trade";
  if (raw.includes("usage-monitor") || raw.includes("usagemonitor")) {
    return "usage-monitor";
  }
  if (raw.includes("fleet")) return "fleet-infra";
  return "other";
}

export function resolveBucketAppLabel(bucketName: string): string {
  return APP_LABELS[resolveBucketAppId(bucketName)];
}

function parseNumber(value: string | undefined): number {
  if (!value?.trim()) return 0;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : 0;
}

/** Minimal RFC-style CSV parse (quoted fields, commas). */
export function parseUsageReportCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    if (cells.length === 0) continue;
    const row: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]] = cells[c] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

interface B2Auth {
  apiUrl: string;
  token: string;
  accountId: string;
  downloadUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function b2Authorize(
  keyId: string,
  applicationKey: string,
  fetchImpl: typeof fetch
): Promise<B2Auth> {
  const basic = Buffer.from(`${keyId}:${applicationKey}`, "utf8").toString("base64");
  const response = await fetchImpl(
    "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
    {
      headers: { Authorization: `Basic ${basic}` },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    }
  );
  if (!response.ok) {
    throw new Error(`b2_authorize_account HTTP ${response.status}`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  const apiUrl = typeof data.apiUrl === "string" ? data.apiUrl.replace(/\/$/, "") : "";
  const token = typeof data.authorizationToken === "string" ? data.authorizationToken : "";
  const accountId = typeof data.accountId === "string" ? data.accountId : "";
  const downloadUrl =
    typeof data.downloadUrl === "string" ? data.downloadUrl.replace(/\/$/, "") : "";
  if (!apiUrl || !token || !accountId || !downloadUrl) {
    throw new Error("b2_authorize_account missing fields");
  }
  return { apiUrl, token, accountId, downloadUrl };
}

async function b2Post(
  auth: B2Auth,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${auth.apiUrl}/b2api/v2/${path}`, {
    method: "POST",
    headers: {
      Authorization: auth.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`${path} HTTP ${response.status}`);
  }
  const data = (await response.json()) as unknown;
  if (!isRecord(data)) throw new Error(`${path} non-object body`);
  return data;
}

function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function recentUtcDates(count: number, now: Date): string[] {
  const dates: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(utcDateString(d));
  }
  return dates;
}

async function downloadReportCsvForDate(
  auth: B2Auth,
  reportsBucketId: string,
  date: string,
  fetchImpl: typeof fetch
): Promise<string | null> {
  const list = await b2Post(
    auth,
    "b2_list_file_names",
    {
      bucketId: reportsBucketId,
      prefix: `${date}/usage.account`,
      maxFileCount: 5,
    },
    fetchImpl
  );
  const files = Array.isArray(list.files) ? list.files : [];
  let fileId: string | null = null;
  let fileName: string | null = null;
  for (const entry of files) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.fileName === "string" ? entry.fileName : "";
    if (!name.includes("usage.account") || name.includes("audit")) continue;
    fileId = typeof entry.fileId === "string" ? entry.fileId : null;
    fileName = name;
    break;
  }
  if (!fileId || !fileName) return null;

  const downloadAuth = await b2Post(
    auth,
    "b2_get_download_authorization",
    {
      bucketId: reportsBucketId,
      fileNamePrefix: fileName,
      validDurationInSeconds: 300,
    },
    fetchImpl
  );
  const downloadToken =
    typeof downloadAuth.authorizationToken === "string"
      ? downloadAuth.authorizationToken
      : auth.token;

  const url = `${auth.downloadUrl}/file/${reportsBucketId}/${fileName}`;
  const response = await fetchImpl(url, {
    headers: { Authorization: downloadToken },
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (!response.ok) return null;
  return await response.text();
}

interface DayBucketUsage {
  date: string;
  bucketName: string;
  storedGb: number;
  downloadedGb: number;
  classCTransactions: number;
  classBTransactions: number;
}

export function aggregateReportRows(rows: Array<Record<string, string>>, date: string): {
  buckets: DayBucketUsage[];
  accountDownloadedGb: number;
  accountClassCTotal: number;
} {
  const buckets: DayBucketUsage[] = [];
  let accountDownloadedGb = 0;
  let accountClassCTotal = 0;

  for (const row of rows) {
    const rowDate = row.date?.trim() || date;
    if (rowDate !== date) continue;
    const bucketName = row.bucket_name?.trim();
    if (!bucketName) {
      accountDownloadedGb = Math.max(
        accountDownloadedGb,
        parseNumber(row.downloaded_gb)
      );
      accountClassCTotal = Math.max(
        accountClassCTotal,
        parseNumber(row.api_txn_class_c)
      );
      continue;
    }
    buckets.push({
      date: rowDate,
      bucketName,
      storedGb: parseNumber(row.stored_gb),
      downloadedGb: parseNumber(row.downloaded_gb),
      classCTransactions: parseNumber(row.api_txn_class_c),
      classBTransactions: parseNumber(row.api_txn_class_b),
    });
  }

  if (accountDownloadedGb === 0 && buckets.length > 0) {
    accountDownloadedGb = buckets.reduce((s, b) => s + b.downloadedGb, 0);
  }
  if (accountClassCTotal === 0 && buckets.length > 0) {
    accountClassCTotal = buckets.reduce((s, b) => s + b.classCTransactions, 0);
  }

  return { buckets, accountDownloadedGb, accountClassCTotal };
}

async function loadStorageByApp(): Promise<
  Map<B2AppId, { storageGb: number; bucketNames: string[] }>
> {
  const providers = await prisma.provider.findMany({
    select: { id: true, name: true },
  });
  const providerId = providers.find(
    (p) => p.name.toLowerCase() === "backblaze"
  )?.id;
  const map = new Map<B2AppId, { storageGb: number; bucketNames: string[] }>();
  if (!providerId) return map;

  const rows = await prisma.providerExternalBilling.findMany({
    where: {
      providerId,
      source: "backblaze-b2-bucket-storage",
    },
    select: {
      serviceName: true,
      usageQuantity: true,
    },
  });

  for (const row of rows) {
    const bucket = row.serviceName?.trim();
    if (!bucket) continue;
    const appId = resolveBucketAppId(bucket);
    const qty = row.usageQuantity ?? 0;
    const existing = map.get(appId) ?? { storageGb: 0, bucketNames: [] };
    existing.storageGb += Math.max(0, qty);
    if (!existing.bucketNames.includes(bucket)) {
      existing.bucketNames.push(bucket);
    }
    map.set(appId, existing);
  }
  return map;
}

function buildDailySeries(
  dayBuckets: Map<string, DayBucketUsage[]>,
  accountTotals: Map<string, { downloadedGb: number; classCTotal: number }>
): B2AppUsageDailyPoint[] {
  const dates = [...dayBuckets.keys()].sort();
  return dates.map((date) => {
    const buckets = dayBuckets.get(date) ?? [];
    const byApp: Partial<
      Record<B2AppId, { downloadedGb: number; classCTransactions: number }>
    > = {};
    for (const bucket of buckets) {
      const appId = resolveBucketAppId(bucket.bucketName);
      const cur = byApp[appId] ?? { downloadedGb: 0, classCTransactions: 0 };
      cur.downloadedGb += bucket.downloadedGb;
      cur.classCTransactions += bucket.classCTransactions;
      byApp[appId] = cur;
    }
    const totals = accountTotals.get(date);
    return {
      date,
      accountDownloadedGb: totals?.downloadedGb ?? 0,
      accountClassCTotal: totals?.classCTotal ?? 0,
      byApp,
    };
  });
}

function evaluateAlerts(
  dailySeries: B2AppUsageDailyPoint[],
  caps: { classCDailyFree: number; downloadGbDailyFree: number }
): B2AppUsageBreakdownPayload["alerts"] {
  const latest = dailySeries[dailySeries.length - 1];
  if (!latest) {
    return { classCNearCap: false, downloadNearCap: false, classCSpike: false };
  }
  const classCNearCap =
    latest.accountClassCTotal >= caps.classCDailyFree * B2_CLASS_C_NEAR_CAP_RATIO;
  const downloadNearCap =
    latest.accountDownloadedGb >=
    caps.downloadGbDailyFree * B2_DOWNLOAD_NEAR_CAP_RATIO;

  const prior = dailySeries.slice(0, -1).map((d) => d.accountClassCTotal);
  const median =
    prior.length > 0
      ? prior.slice().sort((a, b) => a - b)[Math.floor(prior.length / 2)]
      : 0;
  const classCSpike =
    prior.length >= 2 &&
    latest.accountClassCTotal >=
      Math.max(caps.classCDailyFree * 0.5, median * B2_CLASS_C_SPIKE_MULTIPLIER);

  return { classCNearCap, downloadNearCap, classCSpike };
}

function mergeApps(
  storageByApp: Map<B2AppId, { storageGb: number; bucketNames: string[] }>,
  latestBuckets: DayBucketUsage[]
): B2AppUsageSlice[] {
  const latestByApp = new Map<B2AppId, DayBucketUsage>();
  for (const bucket of latestBuckets) {
    const appId = resolveBucketAppId(bucket.bucketName);
    const existing = latestByApp.get(appId);
    if (!existing) {
      latestByApp.set(appId, { ...bucket });
    } else {
      existing.storedGb += bucket.storedGb;
      existing.downloadedGb += bucket.downloadedGb;
      existing.classCTransactions += bucket.classCTransactions;
      existing.classBTransactions += bucket.classBTransactions;
    }
  }

  const appIds = new Set<B2AppId>([
    ...storageByApp.keys(),
    ...latestByApp.keys(),
  ]);
  const ordered: B2AppId[] = [
    "socratic-trade",
    "congress-trade",
    "usage-monitor",
    "fleet-infra",
    "other",
  ];
  const slices: B2AppUsageSlice[] = [];
  for (const id of ordered) {
    if (!appIds.has(id)) continue;
    const storage = storageByApp.get(id);
    const latest = latestByApp.get(id);
    slices.push({
      id,
      label: APP_LABELS[id],
      bucketNames: storage?.bucketNames ?? [],
      storageGb: storage?.storageGb ?? latest?.storedGb ?? 0,
      latestDay: latest
        ? {
            date: latest.date,
            storedGb: latest.storedGb,
            downloadedGb: latest.downloadedGb,
            classCTransactions: latest.classCTransactions,
            classBTransactions: latest.classBTransactions,
          }
        : null,
    });
  }
  return slices;
}

export async function fetchB2AppUsageBreakdown(
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<B2AppUsageBreakdownPayload> {
  const caps = {
    classCDailyFree: Math.max(
      1,
      Number(process.env.B2_CLASS_C_DAILY_FREE) || B2_CLASS_C_DAILY_FREE_DEFAULT
    ),
    downloadGbDailyFree: Math.max(
      0.001,
      Number(process.env.B2_DOWNLOAD_GB_DAILY_FREE) ||
        B2_DOWNLOAD_GB_DAILY_FREE_DEFAULT
    ),
  };

  const credentials = resolveBackblazeMonitorCredentials();
  const warnings: string[] = [];
  const storageByApp = await loadStorageByApp();
  const storageSource =
    storageByApp.size > 0 ? "external_billing" : "unavailable";
  if (storageSource === "unavailable") {
    warnings.push("No Backblaze storage inventory in external billing yet.");
  }

  let reportSource: "usage_csv" | "unavailable" = "unavailable";
  const dayBuckets = new Map<string, DayBucketUsage[]>();
  const accountTotals = new Map<
    string,
    { downloadedGb: number; classCTotal: number }
  >();

  if (!credentials) {
    warnings.push("Backblaze monitor key not configured.");
  } else {
    try {
      const auth = await b2Authorize(
        credentials.keyId,
        credentials.applicationKey,
        fetchImpl
      );
      const reportsBucketName = `b2-reports-${auth.accountId}`;
      const buckets = await b2Post(
        auth,
        "b2_list_buckets",
        { accountId: auth.accountId },
        fetchImpl
      );
      let reportsBucketId: string | null = null;
      if (Array.isArray(buckets.buckets)) {
        for (const row of buckets.buckets) {
          if (!isRecord(row)) continue;
          if (row.bucketName === reportsBucketName && typeof row.bucketId === "string") {
            reportsBucketId = row.bucketId;
            break;
          }
        }
      }
      if (!reportsBucketId) {
        warnings.push(
          "Daily usage report bucket not visible (enable Usage Reports for the admin account)."
        );
      } else {
        const dates = recentUtcDates(B2_USAGE_REPORT_DAYS, now);
        for (const date of dates) {
          const csv = await downloadReportCsvForDate(
            auth,
            reportsBucketId,
            date,
            fetchImpl
          );
          if (!csv) continue;
          const rows = parseUsageReportCsv(csv);
          const { buckets: parsed, accountDownloadedGb, accountClassCTotal } =
            aggregateReportRows(rows, date);
          if (parsed.length === 0 && accountClassCTotal === 0) continue;
          dayBuckets.set(date, parsed);
          accountTotals.set(date, {
            downloadedGb: accountDownloadedGb,
            classCTotal: accountClassCTotal,
          });
        }
        if (dayBuckets.size > 0) {
          reportSource = "usage_csv";
        } else {
          warnings.push("No recent B2 usage report CSV found.");
        }
      }
    } catch (error) {
      warnings.push(
        error instanceof Error ? error.message : "B2 usage report fetch failed"
      );
    }
  }

  const dailySeries = buildDailySeries(dayBuckets, accountTotals);
  const latestDate = dailySeries[dailySeries.length - 1]?.date ?? null;
  const latestBuckets =
    latestDate != null ? dayBuckets.get(latestDate) ?? [] : [];

  const apps = mergeApps(storageByApp, latestBuckets);
  const alerts = evaluateAlerts(dailySeries, caps);

  return {
    configured: Boolean(credentials),
    asOf: now.toISOString(),
    cacheAgeSeconds: 0,
    reportDate: latestDate,
    storageSource,
    reportSource,
    warnings,
    caps,
    alerts,
    apps,
    dailySeries,
  };
}

export async function getB2AppUsageBreakdown(
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<B2AppUsageBreakdownPayload> {
  const cached = runtime.cache;
  if (cached && cached.expiresAt > now.getTime()) {
    const ageMs = now.getTime() - (cached.expiresAt - B2_APP_USAGE_CACHE_TTL_MS);
    return {
      ...cached.payload,
      cacheAgeSeconds: Math.max(0, Math.round(ageMs / 1000)),
    };
  }
  if (runtime.inFlight) return runtime.inFlight;

  const run = (async () => {
    const payload = await fetchB2AppUsageBreakdown(fetchImpl, now);
    runtime.cache = {
      payload,
      expiresAt: now.getTime() + B2_APP_USAGE_CACHE_TTL_MS,
    };
    return payload;
  })();

  runtime.inFlight = run;
  try {
    return await run;
  } finally {
    if (runtime.inFlight === run) runtime.inFlight = undefined;
  }
}

function formatB2PushoverMessage(payload: B2AppUsageBreakdownPayload): {
  title: string;
  body: string;
} {
  const latest = payload.dailySeries[payload.dailySeries.length - 1];
  const classC = latest?.accountClassCTotal ?? 0;
  const dl = latest?.accountDownloadedGb ?? 0;
  const title = "📦 Backblaze B2 Fleet Usage";
  const lines = [
    `Account Class C (latest day): ${classC.toLocaleString()} / ${payload.caps.classCDailyFree.toLocaleString()} free`,
    `Account download (latest day): ${dl.toFixed(2)} GB / ${payload.caps.downloadGbDailyFree} GB free`,
    payload.alerts.classCSpike ? "⚠️ Class C spike vs prior week" : null,
    payload.alerts.classCNearCap ? "⚠️ Class C near daily cap" : null,
    payload.alerts.downloadNearCap ? "⚠️ Download near daily cap" : null,
    ...payload.apps
      .filter((a) => a.storageGb > 0 || a.latestDay)
      .slice(0, 4)
      .map((a) => {
        const dlPart = a.latestDay
          ? ` · ${a.latestDay.downloadedGb.toFixed(2)} GB dl`
          : "";
        return `  ${a.label}: ${a.storageGb.toFixed(1)} GB stored${dlPart}`;
      }),
    payload.reportDate ? `Report date: ${payload.reportDate}` : "Report: unavailable",
  ].filter(Boolean);
  return { title, body: lines.join("\n") };
}

export async function runB2UsageCheck(
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<B2UsageCheckResult> {
  const assessment = await getB2AppUsageBreakdown(fetchImpl, now);
  let pushoverSent = false;

  const shouldAlert =
    assessment.reportSource === "usage_csv" &&
    (assessment.alerts.classCNearCap ||
      assessment.alerts.downloadNearCap ||
      assessment.alerts.classCSpike);

  if (shouldAlert) {
    const today = utcDateString(now);
    const last = getLastDailyPushoverDateForB2();
    if (last !== today) {
      const { title, body } = formatB2PushoverMessage(assessment);
      const result = await sendPushoverNotification(title, body, 0, fetchImpl, {
        subject: "um",
      });
      if (result.ok) {
        recordDailyPushoverSentForB2(today);
        pushoverSent = true;
      }
    }
  }

  return { assessment, pushoverSent };
}

let inMemoryB2PushoverDate = "";

function b2PushoverFlagPath(): string {
  const base =
    process.env.USAGE_MONITOR_DATA_DIR?.trim() ||
    process.env.DATABASE_URL?.replace(/^file:/, "").replace(/\/[^/]+$/, "") ||
    process.cwd();
  return path.join(base, B2_DAILY_PUSHOVER_FILENAME);
}

function getLastDailyPushoverDateForB2(): string {
  if (inMemoryB2PushoverDate) return inMemoryB2PushoverDate;
  try {
    const raw = fs.readFileSync(b2PushoverFlagPath(), "utf8");
    const parsed = JSON.parse(raw) as { date?: string };
    if (typeof parsed.date === "string") {
      inMemoryB2PushoverDate = parsed.date;
      return parsed.date;
    }
  } catch {
    // absent file is normal
  }
  return "";
}

function recordDailyPushoverSentForB2(dateStr: string): void {
  inMemoryB2PushoverDate = dateStr;
  try {
    fs.writeFileSync(
      b2PushoverFlagPath(),
      JSON.stringify({ date: dateStr, sentAt: new Date().toISOString() }),
      { encoding: "utf8", mode: 0o600 }
    );
  } catch (error) {
    console.error("[b2-app-usage] Failed saving last daily pushover file:", error);
  }
}
