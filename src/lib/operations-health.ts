import type { FleetBackupStatusPayload } from "@/lib/fleet-backup-status";
import type { R2FleetSummary } from "@/lib/r2-usage";
import { receiptInboxEvidenceConfigured } from "@/lib/receipt-inbox-admin";

const SOCRATIC_HEALTH_URL = "https://socratictrade.com/api/health";
const CONGRESS_HEALTH_URL = "https://congress.trade/api/health";
const RECEIPT_INBOX_SUMMARY_URL = "https://receipt-inbox.jays.services/v1/receipts/summary";
const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;
const MAX_RECEIPT_RESPONSE_BYTES = 128 * 1024;
const MAX_RECEIPT_ITEMS = 40;
const REQUEST_TIMEOUT_MS = 8_000;
const OPERATIONS_CACHE_TTL_MS = 30_000;

/**
 * CT pipeline check ids that must not paint Peer App Health.  Same rule as
 * ST FilingAPI: retired / last-resort lanes are not required for liveness.
 * CT GET /api/health is a liveness probe (readiness.ok); pipeline degraded
 * on senate-relay, executive polling, latency/Massive, or Deno must not
 * flip the card.
 */
const CONGRESS_LAST_RESORT_CHECK_IDS = new Set([
  "senate_relay",
  "latency_probes",
  "polling_executive",
]);

type UnknownRecord = Record<string, unknown>;

export type OperationalState =
  | "healthy"
  | "degraded"
  | "receiving"
  | "stale"
  | "unavailable"
  | "unreachable"
  | "unconfigured";

export interface ReceiptInboxItemSummary {
  id: string;
  receivedAt: string;
  senderDomain: string;
  senderAuthentication: "passed" | "failed" | "unknown";
  rawSizeBytes: number;
  attachmentCount: number;
  supportedAttachmentCount: number;
  bodyEvidence: boolean;
  quarantineReason: string;
  subject?: string;
  service?: string;
  kind?: string;
  calendarSort?: string;
  amountUsd?: number;
  expenseDate?: string;
  dueDate?: string;
}

export interface ReceiptInboxSummary {
  configured: boolean;
  state: OperationalState;
  evidenceActionsConfigured: boolean;
  needsReviewCount: number;
  countIsLowerBound: boolean;
  latestReceivedAt: string | null;
  fetchedAt: string;
  items: ReceiptInboxItemSummary[];
  error?: string;
}

export interface SocraticInfrastructureSummary {
  state: OperationalState;
  fetchedAt: string;
  releaseSha: string | null;
  processStartedAt: string | null;
  processUptimeSeconds: number | null;
  recentRestart: boolean;
  database: "ok" | "degraded" | "unknown";
  schedulerAgeSeconds: number | null;
  schedulerStale: boolean;
  activeTradingAccounts: number | null;
  degradedTradingAccounts: number | null;
  tradingLivenessDegraded: boolean;
  marketOpen: boolean | null;
  dataProvidersDegraded: boolean;
  dependencyCount: number | null;
  failedDependencies: string[];
  pineconeConfigured: boolean | null;
  ragEmbedProvider: string | null;
  openrouterCreditsOk: boolean | null;
  openrouterCreditsThresholdUsd: number | null;
  dbSizeBytes: number | null;
  walSizeBytes: number | null;
  freeBytes: number | null;
  totalBytes: number | null;
  litestreamState: string | null;
  litestreamAgeSeconds: number | null;
  storageDegraded: boolean;
  adminUrl: string;
  error?: string;
}

export interface CoolifyFleetResource {
  name: string | null;
  type: string | null;
  status: string | null;
  state: string | null;
  health: string | null;
  up: boolean | null;
  degraded: boolean;
  fqdn: string | null;
}

/** Coolify fleet snapshot for Operations (COOLIFY_SERVER_STATS + COOLIFY_HOST only). */
export interface CoolifyFleetSummary {
  configured: boolean;
  state: OperationalState;
  host: string | null;
  applications: CoolifyFleetResource[];
  resources: CoolifyFleetResource[];
  appsUp: number;
  appsDown: number;
  appsDegraded: number;
  appsUnknown: number;
  fetchedAt: string;
  error?: string;
}

export interface CongressInfrastructureSummary {
  state: OperationalState;
  fetchedAt: string;
  ok: boolean | null;
  database: "ok" | "degraded" | "unknown";
  schemaOk: boolean | null;
  pipelineStatus: string | null;
  releaseSha: string | null;
  failedChecks: string[];
  adminUrl: string;
  error?: string;
}

export interface OperationsHealthSummary {
  receiptInbox: ReceiptInboxSummary;
  socraticInfrastructure: SocraticInfrastructureSummary;
  congressInfrastructure: CongressInfrastructureSummary;
  coolifyFleet: CoolifyFleetSummary;
  r2Fleet: R2FleetSummary | null;
  /** Per-app / per-location off-site backup status (B2 dumps, Litestream, local). */
  fleetBackups: FleetBackupStatusPayload | null;
  fetchedAt: string;
}

const RECENT_RESTART_SECONDS = 600;

let lastReceiptSuccess: ReceiptInboxSummary | undefined;
let lastSocraticSuccess: SocraticInfrastructureSummary | undefined;
let lastCongressSuccess: CongressInfrastructureSummary | undefined;
let lastCoolifySuccess: CoolifyFleetSummary | undefined;
let operationsCache: { expiresAt: number; value: OperationsHealthSummary } | undefined;
let operationsInFlight: Promise<OperationsHealthSummary> | undefined;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** ST now reports L0 age on the continuous tier, not storage.litestreamAgeSeconds. */
function continuousLitestreamTierAgeSeconds(
  storage: UnknownRecord | undefined
): number | null {
  const tiers = Array.isArray(storage?.litestreamTiers)
    ? storage.litestreamTiers
    : [];
  for (const raw of tiers) {
    const row = asRecord(raw);
    if (!row) continue;
    const isContinuous =
      row.tier === "0" || row.tier === 0 || row.label === "Continuous Sync";
    if (!isContinuous) continue;
    const age = finiteNonNegative(row.ageSeconds);
    if (age != null) return age;
    const at = canonicalTimestamp(row.newestActivityAt);
    if (at) return Math.max(0, (Date.now() - Date.parse(at)) / 1000);
  }
  return null;
}

function boundedInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max
    ? (value as number)
    : null;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("response_too_large");
  }
  if (!response.body) throw new Error("empty_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function receiptConfiguration(): { url: string; token: string } | undefined {
  const token = process.env.RECEIPT_INBOX_READ_TOKEN?.trim();
  return token && token.length >= 32 ? { url: RECEIPT_INBOX_SUMMARY_URL, token } : undefined;
}

function parseReceiptItem(value: unknown): ReceiptInboxItemSummary | null {
  const item = asRecord(value);
  const id = typeof item?.id === "string" && /^[0-9a-f]{64}$/.test(item.id) ? item.id : null;
  const receivedAt = canonicalTimestamp(item?.receivedAt);
  const domain =
    typeof item?.senderDomain === "string" && /^[a-z0-9.-]{1,253}$/i.test(item.senderDomain)
      ? item.senderDomain.toLowerCase()
      : "unknown";
  const senderAuthentication = ["passed", "failed", "unknown"].includes(
    String(item?.senderAuthentication)
  )
    ? (item?.senderAuthentication as "passed" | "failed" | "unknown")
    : "unknown";
  const rawSizeBytes = boundedInteger(item?.rawSizeBytes, 25 * 1024 * 1024);
  const attachmentCount = boundedInteger(item?.attachmentCount, 100);
  const supportedAttachmentCount = boundedInteger(item?.supportedAttachmentCount, 100);
  if (
    !id ||
    !receivedAt ||
    rawSizeBytes === null ||
    attachmentCount === null ||
    supportedAttachmentCount === null
  ) {
    return null;
  }
  const parsed: ReceiptInboxItemSummary = {
    id,
    receivedAt,
    senderDomain: domain,
    senderAuthentication,
    rawSizeBytes,
    attachmentCount,
    supportedAttachmentCount,
    bodyEvidence: item?.bodyEvidence === true,
    quarantineReason:
      typeof item?.quarantineReason === "string" && item.quarantineReason.length <= 80
        ? item.quarantineReason
        : "awaiting_review",
  };
  const subject = sanitizeReceiptText(item?.subject, 180);
  const service = sanitizeReceiptText(item?.service, 80);
  const kind = sanitizeReceiptEnum(item?.kind, ["subscription", "prepaid", "usage", "one_time"]);
  const calendarSort = sanitizeReceiptEnum(
    item?.calendarSort,
    ["subscription", "prepaid", "usage", "dev-expense"],
  );
  const amountUsd = finiteAmount(item?.amountUsd);
  const expenseDate = receiptIsoDay(item?.expenseDate);
  const dueDate = receiptIsoDay(item?.dueDate);
  if (subject) parsed.subject = subject;
  if (service) parsed.service = service;
  if (kind) parsed.kind = kind;
  if (calendarSort) parsed.calendarSort = calendarSort;
  if (amountUsd != null) parsed.amountUsd = amountUsd;
  if (expenseDate) parsed.expenseDate = expenseDate;
  if (dueDate) parsed.dueDate = dueDate;
  return parsed;
}

function sanitizeReceiptText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\b\S+@\S+\b/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > max) return cleaned ? cleaned.slice(0, max) : undefined;
  return cleaned;
}

function sanitizeReceiptEnum(value: unknown, allowed: string[]): string | undefined {
  return typeof value === "string" && allowed.includes(value) ? value : undefined;
}

function finiteAmount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 5000
    ? value
    : undefined;
}

function receiptIsoDay(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

export async function fetchReceiptInboxSummary(): Promise<ReceiptInboxSummary> {
  const hasPartialConfiguration = Boolean(
    process.env.RECEIPT_INBOX_READ_TOKEN?.trim()
  );
  const config = receiptConfiguration();
  const fetchedAt = new Date().toISOString();
  if (!config) {
    return {
      configured: hasPartialConfiguration,
      state: hasPartialConfiguration ? "unavailable" : "unconfigured",
      evidenceActionsConfigured: receiptInboxEvidenceConfigured(),
      needsReviewCount: 0,
      countIsLowerBound: false,
      latestReceivedAt: null,
      fetchedAt,
      items: [],
      ...(hasPartialConfiguration ? { error: "invalid_configuration" } : {}),
    };
  }
  try {
    const response = await fetch(config.url, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = asRecord(await readBoundedJson(response, MAX_RECEIPT_RESPONSE_BYTES));
    if (body?.configured !== true || body.status !== "receiving" || !Array.isArray(body.items)) {
      throw new Error("invalid_response");
    }
    const items = body.items
      .map(parseReceiptItem)
      .filter((item): item is ReceiptInboxItemSummary => item !== null)
      .slice(0, MAX_RECEIPT_ITEMS);
    const needsReviewCount = boundedInteger(body.needsReviewCount, 1_000_000);
    if (needsReviewCount === null) throw new Error("invalid_response");
    const result: ReceiptInboxSummary = {
      configured: true,
      state: "receiving",
      evidenceActionsConfigured: receiptInboxEvidenceConfigured(),
      needsReviewCount,
      countIsLowerBound: body.countIsLowerBound === true,
      latestReceivedAt: canonicalTimestamp(body.latestReceivedAt),
      fetchedAt,
      items,
    };
    lastReceiptSuccess = result;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unavailable";
    if (lastReceiptSuccess) {
      return { ...lastReceiptSuccess, state: "stale", error: message };
    }
    return {
      configured: true,
      state: "unavailable",
      evidenceActionsConfigured: receiptInboxEvidenceConfigured(),
      needsReviewCount: 0,
      countIsLowerBound: false,
      latestReceivedAt: null,
      fetchedAt,
      items: [],
      error: message,
    };
  }
}

export function isCongressLastResortCheck(id: string): boolean {
  const n = id.toLowerCase();
  if (CONGRESS_LAST_RESORT_CHECK_IDS.has(n)) return true;
  if (n.includes("massive")) return true;
  if (n.includes("deno")) return true;
  if (n.includes("filingapi")) return true;
  return false;
}

export function congressFailedChecks(pipeline: unknown): string[] {
  const record = asRecord(pipeline);
  const checks = Array.isArray(record?.checks) ? record.checks : [];
  const failed: string[] = [];
  for (const raw of checks) {
    const row = asRecord(raw);
    const id = typeof row?.id === "string" ? row.id : "";
    if (!id || !/^[a-z0-9._:-]{1,80}$/i.test(id)) continue;
    if (isCongressLastResortCheck(id)) continue;
    const status = typeof row?.status === "string" ? row.status.toLowerCase() : "";
    if (status === "stalled" || status === "degraded") failed.push(id);
  }
  return failed.slice(0, 20);
}

function dependencyFailures(value: unknown): string[] {
  const dependencies = asRecord(value);
  if (!dependencies) return [];
  return Object.entries(dependencies)
    .filter(([, raw]) => asRecord(raw)?.ok === false)
    .map(([name]) => name)
    // Overnight VIX/Cboe misses are expected (market closed) and already
    // surface as dataProvidersDegraded.  Counting them as hard dependency
    // failures made Peer App Health stay Degraded all night on a healthy
    // ST process (release 08fcc353).
    .filter((name) => !/^vix[-:]/i.test(name))
    // Last-resort scarce FilingAPI is env-keyed and currently 401s.  It is
    // not required for ST to trade or stay up, so it must not paint Peer App
    // Health Degraded the same way a dead DB or Litestream would.
    .filter((name) => name !== "filingapi")
    .filter((name) => /^[a-z0-9._:-]{1,80}$/i.test(name))
    .slice(0, 20);
}

function dependencyCount(value: unknown): number | null {
  const dependencies = asRecord(value);
  if (!dependencies) return null;
  return Object.keys(dependencies).length;
}

function unreachableSocratic(fetchedAt: string, error?: string): SocraticInfrastructureSummary {
  return {
    state: "unreachable",
    fetchedAt,
    releaseSha: null,
    processStartedAt: null,
    processUptimeSeconds: null,
    recentRestart: false,
    database: "unknown",
    schedulerAgeSeconds: null,
    schedulerStale: false,
    activeTradingAccounts: null,
    degradedTradingAccounts: null,
    tradingLivenessDegraded: false,
    marketOpen: null,
    dataProvidersDegraded: false,
    dependencyCount: null,
    failedDependencies: [],
    pineconeConfigured: null,
    ragEmbedProvider: null,
    openrouterCreditsOk: null,
    openrouterCreditsThresholdUsd: null,
    dbSizeBytes: null,
    walSizeBytes: null,
    freeBytes: null,
    totalBytes: null,
    litestreamState: null,
    litestreamAgeSeconds: null,
    storageDegraded: false,
    adminUrl: "https://admin.socratictrade.com/admin/server",
    ...(error ? { error } : {}),
  };
}

/**
 * Playwright visual/e2e kill switch for server-side operations-health egress
 * (Kody threads 2026-10-21: offline flag needs one shared definition, a prod
 * marker, and coverage of every probe).  BOTH variables are required:
 * OPERATIONS_HEALTH_OFFLINE opts in, and E2E_TEST_PASSWORD exists only in the
 * Playwright webServer env (playwright.config.ts), so a stray prod flag can
 * never mark the fleet unreachable.
 */
export function operationsHealthEgressDisabled(): boolean {
  return (
    process.env.OPERATIONS_HEALTH_OFFLINE === "true" &&
    Boolean(process.env.E2E_TEST_PASSWORD)
  );
}

export async function fetchSocraticInfrastructureSummary(): Promise<SocraticInfrastructureSummary> {
  const fetchedAt = new Date().toISOString();
  // Playwright visual/e2e runs must render fully offline (suite invariant):
  // short-circuit the external health probe so /ops never depends on egress.
  if (operationsHealthEgressDisabled()) return unreachableSocratic(fetchedAt);
  try {
    const response = await fetch(SOCRATIC_HEALTH_URL, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = asRecord(await readBoundedJson(response, MAX_HEALTH_RESPONSE_BYTES));
    const checks = asRecord(body?.checks);
    if (typeof body?.ok !== "boolean" || !checks) throw new Error("invalid_response");
    const release = asRecord(checks.release);
    const trading = asRecord(checks.tradingLiveness);
    const storage = asRecord(checks.storage);
    const openrouter = asRecord(checks.openrouterCredits);
    const failedDependencies = dependencyFailures(checks.dependencies);
    const database = checks.db === "ok" ? "ok" : checks.db ? "degraded" : "unknown";
    const litestreamState =
      typeof storage?.litestreamStatus === "string"
        ? storage.litestreamStatus
        : typeof storage?.litestreamState === "string"
          ? storage.litestreamState
          : null;
    const processUptimeSeconds = finiteNonNegative(release?.processUptimeSeconds);
    const processStartedAt = canonicalTimestamp(release?.processStartedAt);
    const recentRestart =
      processUptimeSeconds !== null && processUptimeSeconds < RECENT_RESTART_SECONDS;
    const tradingLivenessDegraded = checks.tradingLivenessDegraded === true;
    const dataProvidersDegraded = checks.dataProvidersDegraded === true;
    const storageDegraded =
      checks.storageDegraded === true ||
      storage?.litestreamTiersDegraded === true;
    const schedulerStale = checks.schedulerStale === true;
    const openrouterCreditsOk =
      openrouter == null ? null : openrouter.ok === true ? true : openrouter.ok === false ? false : null;
    const hardDegraded =
      body.ok !== true ||
      database !== "ok" ||
      failedDependencies.length > 0 ||
      storageDegraded ||
      schedulerStale ||
      openrouterCreditsOk === false ||
      (litestreamState !== null &&
        litestreamState !== "replicating" &&
        litestreamState !== "known") ||
      recentRestart;
    const marketOpen = typeof trading?.marketOpen === "boolean" ? trading.marketOpen : null;
    // When the cash session is closed, ST marks quote/VIX providers degraded
    // without that meaning the app is sick.  Keep the flag for the detail
    // payload, but do not paint Peer App Health Degraded overnight.
    const softDegraded =
      tradingLivenessDegraded || (dataProvidersDegraded && marketOpen !== false);
    const degraded = hardDegraded || softDegraded;
    const result: SocraticInfrastructureSummary = {
      state: degraded ? "degraded" : "healthy",
      fetchedAt,
      releaseSha:
        typeof release?.sha === "string" && /^[0-9a-f]{7,64}$/i.test(release.sha)
          ? release.sha.toLowerCase()
          : null,
      processStartedAt,
      processUptimeSeconds,
      recentRestart,
      database,
      schedulerAgeSeconds: finiteNonNegative(checks.schedulerAgeSeconds),
      schedulerStale,
      activeTradingAccounts: boundedInteger(trading?.activeAccounts, 10_000),
      degradedTradingAccounts: boundedInteger(trading?.degraded, 10_000),
      tradingLivenessDegraded,
      marketOpen,
      dataProvidersDegraded,
      dependencyCount: dependencyCount(checks.dependencies),
      failedDependencies,
      pineconeConfigured:
        typeof checks.pineconeConfigured === "boolean" ? checks.pineconeConfigured : null,
      ragEmbedProvider:
        typeof checks.ragEmbedProvider === "string" &&
        /^[a-z0-9._:-]{1,40}$/i.test(checks.ragEmbedProvider)
          ? checks.ragEmbedProvider
          : null,
      openrouterCreditsOk,
      openrouterCreditsThresholdUsd: finiteNonNegative(openrouter?.thresholdUsd),
      dbSizeBytes: finiteNonNegative(storage?.dbSizeBytes),
      walSizeBytes: finiteNonNegative(storage?.walSizeBytes),
      freeBytes: finiteNonNegative(storage?.freeBytes),
      totalBytes: finiteNonNegative(storage?.totalBytes),
      litestreamState,
      litestreamAgeSeconds:
        finiteNonNegative(storage?.litestreamAgeSeconds) ??
        continuousLitestreamTierAgeSeconds(storage),
      storageDegraded,
      adminUrl: "https://admin.socratictrade.com/admin/server",
    };
    lastSocraticSuccess = result;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreachable";
    if (lastSocraticSuccess) {
      return { ...lastSocraticSuccess, state: "stale", error: message };
    }
    return unreachableSocratic(fetchedAt, message);
  }
}

function unreachableCongress(fetchedAt: string, error?: string): CongressInfrastructureSummary {
  return {
    state: "unreachable",
    fetchedAt,
    ok: null,
    database: "unknown",
    schemaOk: null,
    pipelineStatus: null,
    releaseSha: null,
    failedChecks: [],
    adminUrl: "https://congress.trade/api/health",
    ...(error ? { error } : {}),
  };
}

/**
 * Bounded liveness probe of Congress.Trade GET /api/health.
 * Process answering with ok:true is healthy.  Pipeline degraded on
 * retired / last-resort lanes (senate-relay, executive polling, Massive
 * latency, Deno, FilingAPI) must not paint the card.
 */
export async function fetchCongressInfrastructureSummary(): Promise<CongressInfrastructureSummary> {
  const fetchedAt = new Date().toISOString();
  // See fetchSocraticInfrastructureSummary: offline short-circuit for e2e.
  if (operationsHealthEgressDisabled()) return unreachableCongress(fetchedAt);
  try {
    const response = await fetch(CONGRESS_HEALTH_URL, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = asRecord(await readBoundedJson(response, MAX_HEALTH_RESPONSE_BYTES).catch(() => null));
    if (!body || typeof body.ok !== "boolean") {
      throw new Error(response.ok ? "invalid_response" : `HTTP ${response.status}`);
    }
    const pipeline = asRecord(body.pipeline);
    const build = asRecord(body.build);
    const pipelineStatus =
      typeof body.status === "string"
        ? body.status
        : typeof pipeline?.status === "string"
          ? pipeline.status
          : null;
    const failedChecks = congressFailedChecks(pipeline ?? body.pipeline);
    const database = body.db === true ? "ok" : body.db === false ? "degraded" : "unknown";
    const schemaOk = typeof body.schema === "boolean" ? body.schema : null;
    const releaseSha =
      typeof build?.sha === "string" && /^[0-9a-f]{7,64}$/i.test(build.sha)
        ? build.sha.toLowerCase()
        : null;
    // Liveness: readiness.ok is the process-up signal.  Do not paint
    // degraded from pipeline.status (last-resort / retired lanes live there).
    const result: CongressInfrastructureSummary = {
      state: body.ok === true ? "healthy" : "degraded",
      fetchedAt,
      ok: body.ok,
      database,
      schemaOk,
      pipelineStatus,
      releaseSha,
      failedChecks,
      adminUrl: "https://congress.trade/api/health",
    };
    lastCongressSuccess = result;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unreachable";
    if (lastCongressSuccess) {
      return { ...lastCongressSuccess, state: "stale", error: message };
    }
    return unreachableCongress(fetchedAt, message);
  }
}

function coolifyConfiguration(): { host: string; token: string } | undefined {
  const token =
    process.env.COOLIFY_SERVER_STATS?.trim() || process.env.COOLIFY_API_TOKEN?.trim() || "";
  // Never fall through to COOLIFY_AGENTS — full admin must stay out of app code paths.
  if (!token || token.length < 16) return undefined;
  const host = (process.env.COOLIFY_HOST?.trim() || "https://host.jays.services").replace(
    /\/+$/,
    ""
  );
  try {
    const parsed = new URL(host);
    if (parsed.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return { host, token };
}

function parseCoolifyStatus(status: unknown): {
  state: string | null;
  health: string | null;
  up: boolean | null;
  degraded: boolean;
} {
  if (typeof status !== "string" || !status.trim()) {
    return { state: null, health: null, up: null, degraded: false };
  }
  const [statePart, healthPart] = status.split(":");
  const state = statePart.trim().toLowerCase() || "unknown";
  const health = healthPart?.trim().toLowerCase() || null;
  const up = state === "running";
  // "running:unknown" is common for compose apps without a healthcheck — not degraded.
  const degraded = up && health === "unhealthy";
  return { state, health, up, degraded };
}

function mapCoolifyResource(
  row: UnknownRecord,
  typeFallback: string | null
): CoolifyFleetResource | null {
  const name =
    typeof row.name === "string" && row.name.trim() && row.name.length <= 120
      ? row.name.trim()
      : null;
  const typeRaw =
    typeof row.type === "string" && row.type.trim()
      ? row.type.trim().toLowerCase()
      : typeFallback;
  const type =
    typeRaw && /^[a-z0-9._:-]{1,40}$/i.test(typeRaw) ? typeRaw : typeFallback;
  const status =
    typeof row.status === "string" && row.status.trim() && row.status.length <= 80
      ? row.status.trim()
      : null;
  const parsed = parseCoolifyStatus(status);
  const fqdnRaw = typeof row.fqdn === "string" ? row.fqdn.trim() : null;
  let fqdn: string | null = null;
  if (fqdnRaw && fqdnRaw.length <= 300 && !/[<>\s]/.test(fqdnRaw)) {
    fqdn = fqdnRaw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(", ");
  }
  if (!name && !status && !fqdn) return null;
  return {
    name,
    type,
    status,
    state: parsed.state,
    health: parsed.health,
    up: parsed.up,
    degraded: parsed.degraded,
    fqdn,
  };
}

export async function fetchCoolifyFleetSummary(): Promise<CoolifyFleetSummary> {
  const fetchedAt = new Date().toISOString();
  const config = coolifyConfiguration();
  if (!config) {
    return {
      configured: false,
      state: "unconfigured",
      host: null,
      applications: [],
      resources: [],
      appsUp: 0,
      appsDown: 0,
      appsDegraded: 0,
      appsUnknown: 0,
      fetchedAt,
    };
  }
  try {
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${config.token}`,
    };
    const appsRes = await fetch(`${config.host}/api/v1/applications`, {
      headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!appsRes.ok) throw new Error(`applications HTTP ${appsRes.status}`);
    const appsBody = await readBoundedJson(appsRes, MAX_HEALTH_RESPONSE_BYTES);
    if (!Array.isArray(appsBody)) throw new Error("invalid_applications");
    const applications: CoolifyFleetResource[] = [];
    for (const row of appsBody.slice(0, 40)) {
      const rec = asRecord(row);
      if (!rec) continue;
      const mapped = mapCoolifyResource(rec, "application");
      if (mapped) applications.push(mapped);
    }

    let resources: CoolifyFleetResource[] = [];
    try {
      const serversRes = await fetch(`${config.host}/api/v1/servers`, {
        headers,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (serversRes.ok) {
        const serversBody = await readBoundedJson(serversRes, MAX_HEALTH_RESPONSE_BYTES);
        const servers = Array.isArray(serversBody) ? serversBody : [];
        const resourceLists = await Promise.all(
          servers.slice(0, 5).map(async (server) => {
            const uuid =
              typeof asRecord(server)?.uuid === "string"
                ? (asRecord(server)!.uuid as string)
                : null;
            if (!uuid || !/^[a-z0-9]{8,64}$/i.test(uuid)) return [];
            const resRes = await fetch(
              `${config.host}/api/v1/servers/${encodeURIComponent(uuid)}/resources`,
              {
                headers,
                cache: "no-store",
                redirect: "error",
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              }
            );
            if (!resRes.ok) return [];
            const resBody = await readBoundedJson(resRes, MAX_HEALTH_RESPONSE_BYTES);
            if (!Array.isArray(resBody)) return [];
            const mappedRows: CoolifyFleetResource[] = [];
            for (const row of resBody.slice(0, 40)) {
              const rec = asRecord(row);
              if (!rec) continue;
              const mapped = mapCoolifyResource(rec, null);
              if (mapped) mappedRows.push(mapped);
            }
            return mappedRows;
          })
        );
        resources = resourceLists.flat();
      }
    } catch {
      // resources are supplementary
    }

    const appsUp = applications.filter((a) => a.up === true).length;
    const appsDown = applications.filter((a) => a.up === false).length;
    const appsDegraded = applications.filter((a) => a.degraded).length;
    const appsUnknown = applications.filter((a) => a.up == null).length;
    const state: OperationalState =
      appsDown > 0
        ? "degraded"
        : appsDegraded > 0
          ? "degraded"
          : applications.length === 0
            ? "unavailable"
            : "healthy";
    const result: CoolifyFleetSummary = {
      configured: true,
      state,
      host: config.host,
      applications,
      resources,
      appsUp,
      appsDown,
      appsDegraded,
      appsUnknown,
      fetchedAt,
    };
    lastCoolifySuccess = result;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unavailable";
    if (lastCoolifySuccess) {
      return { ...lastCoolifySuccess, state: "stale", error: message };
    }
    return {
      configured: true,
      state: "unavailable",
      host: config.host,
      applications: [],
      resources: [],
      appsUp: 0,
      appsDown: 0,
      appsDegraded: 0,
      appsUnknown: 0,
      fetchedAt,
      error: message,
    };
  }
}

export async function fetchOperationsHealth(): Promise<OperationsHealthSummary> {
  const now = Date.now();
  if (operationsCache && operationsCache.expiresAt > now) return operationsCache.value;

  const stale = operationsCache?.value;
  if (!operationsInFlight) {
    operationsInFlight = (async () => {
      const { fetchR2FleetSummary } = await import("@/lib/r2-usage");
      const { fetchFleetBackupStatus } = await import("@/lib/fleet-backup-status");
      const [
        receiptInbox,
        socraticInfrastructure,
        congressInfrastructure,
        coolifyFleet,
        r2Fleet,
        fleetBackups,
      ] = await Promise.all([
          fetchReceiptInboxSummary(),
          fetchSocraticInfrastructureSummary(),
          fetchCongressInfrastructureSummary(),
          fetchCoolifyFleetSummary(),
          fetchR2FleetSummary().catch((error) => {
            console.error("[operations] R2 fleet summary failed:", error);
            return null;
          }),
          fetchFleetBackupStatus().catch((error) => {
            console.error("[operations] fleet backup status failed:", error);
            return null;
          }),
        ]);
      const value: OperationsHealthSummary = {
        receiptInbox,
        socraticInfrastructure,
        congressInfrastructure,
        coolifyFleet,
        r2Fleet,
        fleetBackups,
        fetchedAt: new Date().toISOString(),
      };
      operationsCache = { expiresAt: Date.now() + OPERATIONS_CACHE_TTL_MS, value };
      return value;
    })().finally(() => {
      operationsInFlight = undefined;
    });
  }

  // Serve a just-expired snapshot immediately so the iOS 20–60s request
  // timeout never waits on a cold Coolify+R2+B2 fan-out after the first load.
  if (stale) return stale;
  return operationsInFlight;
}

export function resetOperationsHealthCacheForTests(): void {
  lastReceiptSuccess = undefined;
  lastSocraticSuccess = undefined;
  lastCongressSuccess = undefined;
  lastCoolifySuccess = undefined;
  operationsCache = undefined;
  operationsInFlight = undefined;
}
