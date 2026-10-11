// Cursor team Admin API poller.
//
// Billed usage for editor, CLI, and cloud-agent runs is not on the hook
// script.  Hook turns land on AgentTurn (turn detail, never cash).  This
// poller is the billed ledger: POST /teams/filtered-usage-events, one
// ExternalUsageEvent per usage event, costUsd = chargedCents / 100.
//
// Docs (fetched 2026-10-11):
//   https://cursor.com/docs/account/teams/admin-api
//   https://cursor.com/docs/api
// Auth is Basic with the admin API key as the username and an empty
// password.  The poller is opt-in and team-plan only.  It stays off unless
// CURSOR_ADMIN_POLLER_ENABLED is set.  Enabled without CURSOR_ADMIN_API_KEY
// throws at startup so the job and its Sentry cron monitor are not
// registered.  A disabled process does not log, check in, or call the API.
//
// The docs say this endpoint is aggregated hourly and should be polled at
// most once per hour (60 requests/minute hard limit; 429 carries
// Retry-After).  Daily-usage-data has no dollar field.  /teams/spend is a
// billing-cycle total of the same chargedCents figures, so it is not
// stored again (budget math would max() it against these rows).
//
// The published event has no editor-vs-CLI field.  source is:
//   cloud-agent  when cloudAgentId is set
//   headless     when isHeadless is true (background, no cloud agent id)
//   client       otherwise (connected editor or CLI)

import "server-only";

import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";

import {
  assertCursorAdminPollerConfigured,
  CursorAdminPollerConfigError,
  isCursorAdminPollerEnabled,
} from "@/lib/cursor-admin-config";
import type { ExternalUsageEventInput } from "@/lib/external-usage-events";
import { persistExternalUsageEvents } from "@/lib/external-usage-events";
import { prisma } from "@/lib/prisma";
import { recordCursorAdminPollerCheckIn } from "@/lib/sentry-ops";
import { fanoutPersistedUsage } from "@/lib/usage-fanout";

export { assertCursorAdminPollerConfigured, isCursorAdminPollerEnabled };

export const CURSOR_ADMIN_API_BASE = "https://api.cursor.com";
export const CURSOR_ADMIN_USAGE_EVENTS_PATH = "/teams/filtered-usage-events";
export const CURSOR_ADMIN_SOURCE_APP = "cursor-admin";
export const CURSOR_ADMIN_PROVIDER = "cursor";
export const CURSOR_ADMIN_POLL_INTERVAL_MS = 60 * 60 * 1000;
export const CURSOR_ADMIN_OPEN_WINDOW_MS = 60 * 60 * 1000;
export const CURSOR_ADMIN_DEFAULT_LOOKBACK_DAYS = 7;
export const CURSOR_ADMIN_MAX_LOOKBACK_DAYS = 30;
export const CURSOR_ADMIN_PAGE_SIZE = 1000;
export const CURSOR_ADMIN_MAX_PAGES = 50;
export const CURSOR_ADMIN_MAX_RETRY_WAIT_MS = 20_000;
export const CURSOR_ADMIN_MAX_ATTEMPTS = 4;
export const CURSOR_ADMIN_REQUEST_TIMEOUT_MS = 30_000;
export const CURSOR_ADMIN_MAX_BODY_CHARS = 5_000_000;

const LAST_ATTEMPT_KEY = "cursor_admin_poller_last_attempt_ms";
const WATERMARK_KEY = "cursor_admin_poller_watermark_ms";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SLICE_MS = 7 * DAY_MS;

export type CursorUsageSource = "client" | "headless" | "cloud-agent";

export interface CursorTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalCents: number;
  discountPercentOff?: number;
}

/** Fields documented on each /teams/filtered-usage-events usageEvents item. */
export interface CursorFilteredUsageEvent {
  timestamp: string;
  userEmail: string;
  serviceAccountId?: string;
  serviceAccountName?: string;
  cloudAgentId?: string;
  automationId?: string;
  conversationId?: string;
  model: string;
  kind: string;
  maxMode: boolean;
  requestsCosts: number;
  isTokenBasedCall: boolean;
  isChargeable: boolean;
  isHeadless: boolean;
  tokenUsage?: CursorTokenUsage;
  chargedCents: number;
  cursorTokenFee?: number;
}

export interface ParsedUsageEventsPage {
  events: CursorFilteredUsageEvent[];
  hasNextPage: boolean;
}

export type CursorAdminPollResult =
  | { status: "skipped"; reason: "test_process" | "disabled" | "not_due" }
  | {
      status: "ok";
      fetched: number;
      persisted: number;
      duplicates: number;
    }
  | { status: "error"; message: string };

export interface CursorAdminPollState {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface CursorAdminPollOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  persist?: (events: ExternalUsageEventInput[]) => Promise<{
    attempted: number;
    persisted: number;
    skippedPrunedDuplicates: number;
    newEvents: ExternalUsageEventInput[];
  }>;
  fanout?: (
    events: readonly { provider: string; sourceApp: string; model?: string | null; costUsd?: number | null }[],
    route: "poll"
  ) => Promise<void>;
  checkIn?: (status: "ok" | "error") => Promise<void>;
  ensureProvider?: () => Promise<void>;
  state?: CursorAdminPollState;
  /** Bypass the hourly gate.  Tests only. */
  force?: boolean;
  /** Vitest sets VITEST and the scheduler must not call Cursor.  Tests opt in. */
  runInTests?: boolean;
}

interface PollWindow {
  startMs: number;
  endMs: number;
  watermarkMs: number | null;
}

let inFlight: Promise<CursorAdminPollResult> | null = null;

export function resetCursorAdminPollerForTests(): void {
  inFlight = null;
}

function encodeField(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function canonicalNumber(value: number): string {
  return JSON.stringify(value);
}

// Zod schemas are the trust boundary for the untrusted Admin API response.
// The hand-written parsers they replaced used bespoke type guards that
// could not be reasoned about centrally; schema parsing gives one place to
// see the documented shape and lets Zod return every validation issue.

const TimestampEpochMillisSchema = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    const raw =
      typeof value === "string"
        ? value.trim()
        : Number.isFinite(value)
          ? String(Math.trunc(value))
          : "";
    if (!/^\d{12,16}$/.test(raw)) {
      ctx.addIssue({
        code: "custom",
        message: "timestamp must be a 12-16 digit epoch milliseconds string",
      });
      return z.NEVER;
    }
    const ms = Number(raw);
    if (!Number.isSafeInteger(ms)) {
      ctx.addIssue({
        code: "custom",
        message: "timestamp must be a safe integer",
      });
      return z.NEVER;
    }
    const year = new Date(ms).getUTCFullYear();
    if (year < 2000 || year > 2100) {
      ctx.addIssue({
        code: "custom",
        message: "timestamp year must be between 2000 and 2100",
      });
      return z.NEVER;
    }
    return raw;
  });

function optionalNonEmptyTrimmedString(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value === undefined || value === "" ? undefined : value));
}

const CursorTokenUsageSchema = z
  .object({
    inputTokens: z.number().finite(),
    outputTokens: z.number().finite(),
    cacheWriteTokens: z.number().finite(),
    cacheReadTokens: z.number().finite(),
    totalCents: z.number().finite(),
    discountPercentOff: z.number().finite().optional(),
  })
  .strict();

const CursorFilteredUsageEventSchema = z
  .object({
    timestamp: TimestampEpochMillisSchema,
    userEmail: z
      .string()
      .trim()
      .min(1)
      .max(320)
      .refine((value) => value.includes("@"), {
        message: "userEmail must contain @",
      }),
    model: z.string().trim().min(1).max(200),
    kind: z.string().trim().min(1).max(200),
    maxMode: z.boolean(),
    requestsCosts: z.number().finite(),
    isTokenBasedCall: z.boolean(),
    isChargeable: z.boolean(),
    isHeadless: z.boolean(),
    chargedCents: z.number().finite(),
    serviceAccountId: optionalNonEmptyTrimmedString(200),
    serviceAccountName: optionalNonEmptyTrimmedString(200),
    cloudAgentId: optionalNonEmptyTrimmedString(200),
    automationId: optionalNonEmptyTrimmedString(200),
    conversationId: optionalNonEmptyTrimmedString(200),
    tokenUsage: CursorTokenUsageSchema.nullish().transform((value) => value ?? undefined),
    cursorTokenFee: z.number().finite().optional(),
  })
  .strict()
  .refine((data) => !(data.isTokenBasedCall && data.tokenUsage === undefined), {
    message: "isTokenBasedCall=true requires a tokenUsage object",
  });

const CursorFilteredUsageEventsPageSchema = z
  .object({
    totalUsageEventsCount: z.number().finite(),
    pagination: z
      .object({
        numPages: z.number().finite(),
        currentPage: z.number().finite(),
        pageSize: z.number().finite(),
        hasNextPage: z.boolean(),
        hasPreviousPage: z.boolean(),
      })
      .strict(),
    usageEvents: z.array(CursorFilteredUsageEventSchema),
    period: z
      .object({
        startDate: z.number().finite(),
        endDate: z.number().finite(),
      })
      .strict(),
  })
  .strict();

function usageSource(event: Pick<CursorFilteredUsageEvent, "cloudAgentId" | "isHeadless">): CursorUsageSource {
  if (event.cloudAgentId) return "cloud-agent";
  if (event.isHeadless) return "headless";
  return "client";
}

export function cursorUsageEventIdempotencyKey(event: CursorFilteredUsageEvent): string {
  const tokens = event.tokenUsage;
  const fields = [
    event.timestamp,
    event.userEmail.trim().toLowerCase(),
    event.serviceAccountId ?? "",
    event.cloudAgentId ?? "",
    event.automationId ?? "",
    event.conversationId ?? "",
    event.model,
    event.kind,
    event.maxMode ? "1" : "0",
    canonicalNumber(event.requestsCosts),
    event.isTokenBasedCall ? "1" : "0",
    event.isChargeable ? "1" : "0",
    event.isHeadless ? "1" : "0",
    tokens ? canonicalNumber(tokens.inputTokens) : "",
    tokens ? canonicalNumber(tokens.outputTokens) : "",
    tokens ? canonicalNumber(tokens.cacheWriteTokens) : "",
    tokens ? canonicalNumber(tokens.cacheReadTokens) : "",
    canonicalNumber(event.chargedCents),
    event.cursorTokenFee == null ? "" : canonicalNumber(event.cursorTokenFee),
    tokens?.discountPercentOff == null ? "" : canonicalNumber(tokens.discountPercentOff),
  ];
  const digest = createHash("sha256")
    .update(fields.map(encodeField).join(""))
    .digest("hex");
  return `cursor-admin:${digest}`;
}

export function parseCursorFilteredUsageEvent(value: unknown): CursorFilteredUsageEvent | null {
  const result = CursorFilteredUsageEventSchema.safeParse(value);
  if (!result.success) return null;
  return result.data;
}

export function parseFilteredUsageEventsPage(data: unknown): ParsedUsageEventsPage | null {
  const result = CursorFilteredUsageEventsPageSchema.safeParse(data);
  if (!result.success) return null;
  if (result.data.usageEvents.length === 0 && result.data.pagination.hasNextPage) return null;
  return { events: result.data.usageEvents, hasNextPage: result.data.pagination.hasNextPage };
}

export function mapCursorUsageEvent(event: CursorFilteredUsageEvent): ExternalUsageEventInput {
  const source = usageSource(event);
  const tokens = event.tokenUsage;
  const quantity = tokens
    ? tokens.inputTokens + tokens.outputTokens + tokens.cacheWriteTokens + tokens.cacheReadTokens
    : event.requestsCosts;
  const metadata: Record<string, string | number | boolean> = {
    userEmail: event.userEmail,
    kind: event.kind,
    source,
    chargedCents: event.chargedCents,
    requestsCosts: event.requestsCosts,
    isChargeable: event.isChargeable,
    isTokenBasedCall: event.isTokenBasedCall,
    isHeadless: event.isHeadless,
    maxMode: event.maxMode,
  };
  if (tokens) {
    metadata.inputTokens = tokens.inputTokens;
    metadata.outputTokens = tokens.outputTokens;
    metadata.cacheWriteTokens = tokens.cacheWriteTokens;
    metadata.cacheReadTokens = tokens.cacheReadTokens;
    metadata.cacheTokens = tokens.cacheWriteTokens + tokens.cacheReadTokens;
    metadata.modelCostCents = tokens.totalCents;
    if (tokens.discountPercentOff != null) metadata.discountPercentOff = tokens.discountPercentOff;
  }
  if (event.cursorTokenFee != null) metadata.cursorTokenFeeCents = event.cursorTokenFee;
  if (event.conversationId) metadata.conversationId = event.conversationId;
  if (event.cloudAgentId) metadata.cloudAgentId = event.cloudAgentId;
  if (event.automationId) metadata.automationId = event.automationId;
  if (event.serviceAccountId) metadata.serviceAccountId = event.serviceAccountId;
  if (event.serviceAccountName) metadata.serviceAccountName = event.serviceAccountName;

  return {
    idempotencyKey: cursorUsageEventIdempotencyKey(event),
    sourceApp: CURSOR_ADMIN_SOURCE_APP,
    provider: CURSOR_ADMIN_PROVIDER,
    service: `cursor-${source}`,
    label: event.kind,
    keyRef: event.model,
    billingMode: "actual",
    metricType: "cost",
    quantity,
    unit: tokens ? "token" : "request",
    costUsd: event.chargedCents / 100,
    requests: 1,
    confidence: "actual",
    occurredAt: new Date(Number(event.timestamp)),
    metadata: metadata as Prisma.InputJsonObject,
  };
}

export function resolveCursorAdminLookbackMs(env: NodeJS.ProcessEnv): number {
  const raw = env.CURSOR_ADMIN_LOOKBACK_DAYS?.trim();
  if (!raw) return CURSOR_ADMIN_DEFAULT_LOOKBACK_DAYS * DAY_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return CURSOR_ADMIN_DEFAULT_LOOKBACK_DAYS * DAY_MS;
  const days = Math.min(CURSOR_ADMIN_MAX_LOOKBACK_DAYS, Math.max(1, Math.floor(parsed)));
  return days * DAY_MS;
}

export function cursorAdminPollWindow(nowMs: number, watermarkMs: number | null, lookbackMs: number): PollWindow | null {
  const earliest = nowMs - lookbackMs;
  const startMs = watermarkMs == null ? earliest : Math.max(earliest, watermarkMs + 1);
  if (startMs > nowMs) return null;
  const endMs = Math.min(nowMs, startMs + MAX_SLICE_MS - 1);
  if (endMs < startMs) return null;
  return { startMs, endMs, watermarkMs };
}

function nextWatermark(window: PollWindow, nowMs: number): number | null {
  const stableEnd = nowMs - CURSOR_ADMIN_OPEN_WINDOW_MS;
  const advancedTo = Math.min(window.endMs, stableEnd);
  if (advancedTo < window.startMs) return window.watermarkMs;
  return advancedTo;
}

function basicAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function retryWaitMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const trimmed = retryAfterHeader.trim();
    if (/^\d+$/.test(trimmed)) {
      const seconds = Number(trimmed);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, CURSOR_ADMIN_MAX_RETRY_WAIT_MS);
      }
    }
  }
  return Math.min(1000 * 2 ** attempt, CURSOR_ADMIN_MAX_RETRY_WAIT_MS);
}

interface FetchedPage {
  ok: true;
  page: ParsedUsageEventsPage;
}

interface FailedFetch {
  ok: false;
  message: string;
}

async function postUsageEventsPage(
  apiKey: string,
  body: { startDate: number; endDate: number; page: number; pageSize: number },
  deps: Required<Pick<CursorAdminPollOptions, "fetchImpl" | "sleep">>
): Promise<FetchedPage | FailedFetch> {
  const url = `${CURSOR_ADMIN_API_BASE}${CURSOR_ADMIN_USAGE_EVENTS_PATH}`;
  for (let attempt = 0; attempt < CURSOR_ADMIN_MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await deps.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: basicAuthHeader(apiKey),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CURSOR_ADMIN_REQUEST_TIMEOUT_MS),
      });
    } catch {
      if (attempt + 1 >= CURSOR_ADMIN_MAX_ATTEMPTS) {
        return { ok: false, message: "Cursor Admin API request failed" };
      }
      await deps.sleep(retryWaitMs(attempt, null));
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt + 1 >= CURSOR_ADMIN_MAX_ATTEMPTS) {
        return { ok: false, message: `Cursor Admin API returned HTTP ${response.status}` };
      }
      await deps.sleep(retryWaitMs(attempt, response.headers.get("retry-after")));
      continue;
    }

    if (response.status !== 200) {
      return { ok: false, message: `Cursor Admin API returned HTTP ${response.status}` };
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      return { ok: false, message: "Cursor Admin API response could not be read" };
    }
    if (text.length > CURSOR_ADMIN_MAX_BODY_CHARS) {
      return { ok: false, message: "Cursor Admin API response exceeded the size cap" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, message: "Cursor Admin API response was not JSON" };
    }
    const page = parseFilteredUsageEventsPage(parsed);
    if (!page) {
      return { ok: false, message: "Cursor Admin API response did not match filtered usage events" };
    }
    return { ok: true, page };
  }
  return { ok: false, message: "Cursor Admin API request failed" };
}

function prismaState(): CursorAdminPollState {
  return {
    async get(key) {
      const row = await prisma.appSetting.findUnique({ where: { key } });
      return row?.value ?? null;
    },
    async set(key, value) {
      await prisma.appSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    },
  };
}

function readMillis(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function ensureCursorProviderSeeded(): Promise<void> {
  const providers = await prisma.provider.findMany({
    select: { id: true, name: true },
  });
  const existing = providers.find((provider) => provider.name.toLowerCase() === "cursor");
  if (existing) return;
  await prisma.provider.create({
    data: {
      name: "cursor",
      displayName: "Cursor",
      type: "generic",
      category: "LLM/AI",
      isActive: true,
      refreshIntervalMin: 60,
    },
  });
}

async function executePoll(options: CursorAdminPollOptions): Promise<CursorAdminPollResult> {
  const env = options.env ?? process.env;
  if (process.env.VITEST === "true" && options.runInTests !== true) {
    return { status: "skipped", reason: "test_process" };
  }

  if (!isCursorAdminPollerEnabled(env)) {
    return { status: "skipped", reason: "disabled" };
  }

  const apiKey = env.CURSOR_ADMIN_API_KEY?.trim() ?? "";
  const now = options.now ?? (() => new Date());
  const checkIn = options.checkIn ?? recordCursorAdminPollerCheckIn;
  if (!apiKey) {
    throw new CursorAdminPollerConfigError();
  }

  const state = options.state ?? prismaState();
  const nowMs = now().getTime();
  const lastAttempt = readMillis(await state.get(LAST_ATTEMPT_KEY));
  if (
    !options.force &&
    lastAttempt != null &&
    nowMs - lastAttempt < CURSOR_ADMIN_POLL_INTERVAL_MS
  ) {
    return { status: "skipped", reason: "not_due" };
  }

  const watermark = readMillis(await state.get(WATERMARK_KEY));
  const window = cursorAdminPollWindow(nowMs, watermark, resolveCursorAdminLookbackMs(env));
  if (!window) {
    await state.set(LAST_ATTEMPT_KEY, String(nowMs));
    await checkIn("ok");
    return { status: "ok", fetched: 0, persisted: 0, duplicates: 0 };
  }

  await state.set(LAST_ATTEMPT_KEY, String(nowMs));
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const collected: CursorFilteredUsageEvent[] = [];

  return Sentry.startSpan({ name: "cursor-admin.poll", op: "task" }, async () => {
    for (let page = 1; page <= CURSOR_ADMIN_MAX_PAGES; page += 1) {
      const result = await postUsageEventsPage(
        apiKey,
        {
          startDate: window.startMs,
          endDate: window.endMs,
          page,
          pageSize: CURSOR_ADMIN_PAGE_SIZE,
        },
        { fetchImpl, sleep }
      );
      if (!result.ok) {
        console.error(`[cursor-admin] ${result.message}`);
        await checkIn("error");
        return { status: "error", message: result.message };
      }
      collected.push(...result.page.events);
      if (!result.page.hasNextPage) break;
      if (page === CURSOR_ADMIN_MAX_PAGES) {
        const message = "Cursor Admin API pagination exceeded the page cap";
        console.error(`[cursor-admin] ${message}`);
        await checkIn("error");
        return { status: "error", message };
      }
    }

    const mapped = collected.map(mapCursorUsageEvent);
    const persist = options.persist ?? persistExternalUsageEvents;
    let persisted = 0;
    let duplicates = 0;
    const fresh: ExternalUsageEventInput[] = [];
    try {
      for (let index = 0; index < mapped.length; index += 200) {
        const chunk = mapped.slice(index, index + 200);
        const result = await persist(chunk);
        persisted += result.persisted;
        duplicates += Math.max(0, result.attempted - result.persisted - result.skippedPrunedDuplicates);
        fresh.push(...result.newEvents);
      }
    } catch (error) {
      console.error(
        "[cursor-admin] failed to persist usage events",
        error instanceof Error ? error.name : "unknown"
      );
      await checkIn("error");
      return { status: "error", message: "Cursor Admin API events could not be persisted" };
    }

    const advanced = nextWatermark(window, nowMs);
    if (advanced != null) {
      await state.set(WATERMARK_KEY, String(advanced));
    }

    try {
      await (options.ensureProvider ?? ensureCursorProviderSeeded)();
    } catch (error) {
      console.warn(
        "[cursor-admin] could not ensure the Cursor provider row",
        error instanceof Error ? error.name : "unknown"
      );
    }

    if (fresh.length > 0) {
      const fanout = options.fanout ?? fanoutPersistedUsage;
      await fanout(
        fresh.map((event) => ({
          provider: event.provider,
          sourceApp: event.sourceApp,
          model: event.keyRef,
          costUsd: event.costUsd,
        })),
        "poll"
      );
    }

    console.info(
      `[cursor-admin] persisted ${persisted} of ${collected.length} usage events (${duplicates} duplicates)`
    );
    await checkIn("ok");
    return {
      status: "ok",
      fetched: collected.length,
      persisted,
      duplicates,
    };
  });
}

export function pollCursorAdminUsage(
  options: CursorAdminPollOptions = {}
): Promise<CursorAdminPollResult> {
  if (inFlight) return inFlight;
  const run = executePoll(options).finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}
