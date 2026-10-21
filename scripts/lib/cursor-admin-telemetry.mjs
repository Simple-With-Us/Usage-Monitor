// Cursor Admin API -> Usage Monitor v2 usage-telemetry events.
//
// Pure logic for the Cursor Admin API producer: window normalization, response
// parsing, event building and the API client.  The CLI wrapper
// (scripts/cursor-usage-collector.mjs) owns secrets, logging and posting.
//
// API facts (probed against the live Admin API on 2026-10-20):
//
//   * The usage endpoints are POST, not GET.  GET on the same paths 404s.
//   * `POST /teams/filtered-usage-events` and `POST /teams/daily-usage-data`
//     require an explicit { startDate, endDate } window and echo the resolved
//     period back as epoch milliseconds.
//   * `POST /teams/daily-usage-data` is capped at 30 days server side and
//     answers a wider window with HTTP 400 "Date range cannot exceed 30 days".
//   * `POST /teams/spend` answers different numbers for an empty body, so an
//     explicit window is always sent.
//
// What this module deliberately does NOT send:
//
//   * No token events.  Cursor's Admin API reports no token counts for the
//     daily-usage feed, and a fabricated zero-quantity token event would
//     pollute UM's token ledger and its LiteLLM price derivation.
//   * No top-level `project`.  Cursor reports no repository, worktree or file
//     path; UM resolves `project` to a Project.id, so inventing one would
//     pollute project attribution.
//   * No personal identifiers.  email, userId, name and profilePictureUrl are
//     never put in an event or its metadata.  A stable id is used only as
//     hash INPUT for the deterministic eventId, so it never leaves this
//     process in plain text.
//
// Money: the spend event is Cursor's own reported cents for a billing cycle,
// carried as `costUsd`.  UM's server-side Cursor poller
// (src/lib/cursor-admin-poller.ts, sourceApp `cursor-admin`) is the owner of
// the per-event billed feed; it is disabled on this seat.  Only one of the two
// may be enabled for one team, otherwise the same cents land twice.

import { createHash } from "node:crypto";

export const CURSOR_ADMIN_API_BASE = "https://api.cursor.com";
export const CURSOR_ADMIN_PRODUCER_ID = "cursor-admin-api";
export const CURSOR_ADMIN_PROVIDER = "cursor";
export const CURSOR_ADMIN_SERVICE = "cursor-admin-api";

export const CURSOR_ADMIN_USAGE_EVENTS_PATH = "/teams/filtered-usage-events";
export const CURSOR_ADMIN_DAILY_USAGE_PATH = "/teams/daily-usage-data";
export const CURSOR_ADMIN_SPEND_PATH = "/teams/spend";

/** The Admin API refuses a window wider than 30 days. */
export const CURSOR_ADMIN_MAX_WINDOW_DAYS = 30;
/** The exact 400 message the API answers for a wider window. */
export const CURSOR_ADMIN_DATE_RANGE_ERROR = "Date range cannot exceed 30 days";

export const CURSOR_ADMIN_PAGE_SIZE = 100;
export const CURSOR_ADMIN_MAX_PAGES = 50;
export const CURSOR_ADMIN_MAX_ATTEMPTS = 4;
export const CURSOR_ADMIN_REQUEST_TIMEOUT_MS = 30_000;
export const CURSOR_ADMIN_RETRY_BASE_MS = 500;
export const CURSOR_ADMIN_RETRY_MAX_MS = 8_000;
export const CURSOR_ADMIN_MAX_RETRY_AFTER_MS = 20_000;

/**
 * How long a period has to be over before its numbers are published.
 *
 * Both Admin API aggregates are running totals: the row for the current day
 * grows all day, and the row for the current month grows all month.  Usage
 * Monitor stores a row under a stable event id and answers HTTP 409 when a
 * later replay of that id carries different content, so publishing a running
 * total would freeze the row at whatever the first pass saw and quarantine a
 * conflicting event on every pass after that.
 *
 * A period is therefore published only once it is closed AND has been over
 * for a full day, which is long enough for the API to stop adjusting it.  The
 * cost is that the newest published day is about two days old and the newest
 * published month is one full month old.
 */
export const CURSOR_ADMIN_SETTLE_MS = 86_400_000;

/** How many closed months the spend read looks back. */
export const CURSOR_ADMIN_SPEND_LOOKBACK_MONTHS = 3;

/**
 * The request counters that make up the daily request count.  They are the
 * three product-surface counters Cursor reports per user per day.
 */
export const DAILY_REQUEST_COUNTERS = [
  "composerRequests",
  "chatRequests",
  "agentRequests",
];

/**
 * Further per-day counters.  They are NOT summed into the request count:
 * apiKeyReqs / usageBasedReqs / subscriptionIncludedReqs are billing
 * categories that overlap the product counters, so adding them would inflate
 * the total.  They ride in metadata instead.
 */
export const DAILY_EXTRA_COUNTERS = [
  "cmdkUsages",
  "bugbotUsages",
  "apiKeyReqs",
  "usageBasedReqs",
  "subscriptionIncludedReqs",
];

export class CursorAdminApiError extends Error {
  constructor(message, { status = null, path = null } = {}) {
    super(message);
    this.name = "CursorAdminApiError";
    this.status = status;
    this.path = path;
  }
}

export function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A non-negative counter.  Anything missing or nonsensical counts as zero. */
export function countOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

function nonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toUtcDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    // A bare YYYY-MM-DD is a UTC day, never a local midnight.
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const date = new Date(`${trimmed}T00:00:00.000Z`);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Length-prefixed SHA-256 over the given parts.  The length prefix makes the
 * basis string unambiguous: two parts that straddle a separator can never
 * hash to the same basis.  This mirrors the algorithm UM uses server side.
 */
function encodeField(value) {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

export function cursorAdminEventId(parts) {
  const basis = parts.map((part) => encodeField(String(part ?? ""))).join("");
  const digest = createHash("sha256").update(basis).digest("hex");
  return `${CURSOR_ADMIN_PRODUCER_ID}:${digest}`;
}

/**
 * Normalize a requested window to UTC calendar days and clamp it to the API's
 * 30-day cap.  The END of the window is kept and the start is pulled
 * forward, so a clamped window still covers the most recent days.
 */
export function normalizeWindow(
  { startDate, endDate, maxDays = CURSOR_ADMIN_MAX_WINDOW_DAYS } = {},
) {
  const start = toUtcDate(startDate);
  const end = toUtcDate(endDate);
  if (!start || !end) {
    throw new Error("A startDate and an endDate are required");
  }
  const startDay = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const endDay = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()),
  );
  if (startDay.getTime() > endDay.getTime()) {
    throw new Error("startDate must be on or before endDate");
  }
  const max = Number.isFinite(maxDays) && maxDays > 0 ? Math.floor(maxDays) : 1;
  const dayMs = 86_400_000;
  const totalDays = Math.round((endDay.getTime() - startDay.getTime()) / dayMs) + 1;
  let effectiveStart = startDay;
  let effectiveEnd = endDay;
  let clamped = false;
  if (totalDays > max) {
    effectiveStart = new Date(endDay.getTime() - (max - 1) * dayMs);
    clamped = true;
  }
  const days =
    Math.round((effectiveEnd.getTime() - effectiveStart.getTime()) / dayMs) + 1;
  return {
    startDate: isoDay(effectiveStart),
    endDate: isoDay(effectiveEnd),
    days,
    clamped,
    requestedDays: totalDays,
  };
}

/**
 * The window to retry with after the API answered "Date range cannot exceed
 * 30 days".  A window wider than the cap is clamped to the cap, keeping the
 * most recent days; a window already inside the cap is shortened by one day,
 * because the API counts the range its own way.  Returns null when no
 * smaller window is possible.
 */
export function narrowWindow(startDate, endDate, maxDays = CURSOR_ADMIN_MAX_WINDOW_DAYS) {
  const start = toUtcDate(startDate);
  const end = toUtcDate(endDate);
  if (!start || !end) return null;
  const dayMs = 86_400_000;
  const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  if (startDay > endDay) return null;
  const days = Math.round((endDay - startDay) / dayMs) + 1;
  if (days > maxDays) {
    return {
      startDate: isoDay(new Date(endDay - (maxDays - 1) * dayMs)),
      endDate: isoDay(new Date(endDay)),
    };
  }
  if (days > 1) {
    return {
      startDate: isoDay(new Date(startDay + dayMs)),
      endDate: isoDay(new Date(endDay)),
    };
  }
  return null;
}

/** The default window: the last `days` UTC days ending today. */
export function defaultWindow({ days = CURSOR_ADMIN_MAX_WINDOW_DAYS, now = new Date() } = {}) {
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const span = Number.isFinite(days) && days > 0 ? Math.floor(days) : 1;
  const start = new Date(end.getTime() - (span - 1) * 86_400_000);
  return normalizeWindow({ startDate: start, endDate: end });
}

/** The first instant of the UTC day named by "YYYY-MM-DD". */
export function utcDayStartMs(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(nonEmptyString(day) ?? "");
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? ms : null;
}

/** The first instant of the UTC month that contains `ms`. */
export function monthStartUtcMs(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** The first instant of the UTC month after the one that contains `ms`. */
export function nextMonthStartUtcMs(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/**
 * True once the period that ended at `endMs` has been over long enough for
 * its numbers to be final.  A day ends at the next midnight, a month ends at
 * the first of the next month.
 */
export function isSettledPeriod(endMs, now) {
  if (!Number.isFinite(endMs) || !Number.isFinite(now)) return false;
  return now - endMs >= CURSOR_ADMIN_SETTLE_MS;
}

/**
 * The month-aligned windows for the closed, settled months before `now`.
 *
 * The spend endpoint answers HTTP 400 unless startDate is the first of a
 * month -- its own message is "startDate must align with the start of a
 * month" -- and it reports the cycle-to-date total of the month that
 * startDate names, ignoring endDate for the amount.  A month's total is only
 * final once the month is over, so the running month is never read and never
 * published.
 */
export function closedSpendWindows(
  now = Date.now(),
  lookback = CURSOR_ADMIN_SPEND_LOOKBACK_MONTHS,
) {
  const anchor = new Date(now);
  if (Number.isNaN(anchor.getTime())) return [];
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  const windows = [];
  for (let back = 1; back <= lookback; back += 1) {
    const startMs = Date.UTC(year, month - back, 1);
    const nextStartMs = Date.UTC(year, month - back + 1, 1);
    if (!isSettledPeriod(nextStartMs, now)) continue;
    windows.push({
      startDate: isoDay(new Date(startMs)),
      endDate: isoDay(new Date(nextStartMs - 86_400_000)),
      cycleStartMs: startMs,
    });
  }
  return windows;
}

// --------------------------------------------------------------- parsing ---

export function parseDailyUsageRows(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  return payload.data.filter((row) => isRecord(row));
}

export function parseUsageEvents(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.usageEvents)) return [];
  return payload.usageEvents.filter((row) => isRecord(row));
}

export function parseSpendMembers(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.teamMemberSpend)) return [];
  return payload.teamMemberSpend.filter((row) => isRecord(row));
}

export function hasNextPage(payload) {
  const pagination = isRecord(payload) ? payload.pagination : null;
  return isRecord(pagination) && pagination.hasNextPage === true;
}

export function spendCycleStartMs(payload) {
  const value = isRecord(payload) ? payload.subscriptionCycleStart : null;
  const n = numberOrNull(value);
  return n != null && n > 0 ? n : null;
}

// ---------------------------------------------------------- event building ---

/**
 * A stable per-user key.  It is used ONLY as hash input for the eventId, so
 * no personal identifier is ever transmitted.
 */
function userKeyOf(row) {
  return (
    nonEmptyString(row?.userId) ??
    nonEmptyString(row?.email) ??
    nonEmptyString(row?.name) ??
    ""
  );
}

function dayOf(row) {
  const day = nonEmptyString(row?.day);
  const epoch = numberOrNull(row?.date);
  let occurredAt = null;
  if (epoch != null && epoch > 0) {
    occurredAt = new Date(epoch).toISOString();
  } else if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    occurredAt = `${day}T00:00:00.000Z`;
  }
  if (!occurredAt) return null;
  return { date: day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : occurredAt.slice(0, 10), occurredAt };
}

/**
 * One event per day per user.
 *
 * metricType `usage` with unit `request` is the shared contract's generic
 * request-count shape; the v2 metricType vocabulary has nothing more
 * specific for a request counter, and UM's LiteLLM price derivation ignores
 * unit `request`, so no bogus API-equivalent cost is derived from it.
 */
export function buildDailyUsageEvent(row, { now = Date.now() } = {}) {
  if (!isRecord(row)) return null;
  const day = dayOf(row);
  if (!day) return null;
  const dayStartMs = utcDayStartMs(day.date);
  if (dayStartMs == null) return null;
  // The row for a day that is not over yet keeps growing, and the row for a
  // day that ended less than a day ago can still be adjusted.  Publishing
  // either would freeze the stored row at its first value and quarantine a
  // conflicting event on every pass after that.
  if (!isSettledPeriod(dayStartMs + 86_400_000, now)) return null;
  const model = nonEmptyString(row.mostUsedModel);
  const requestCount = DAILY_REQUEST_COUNTERS.reduce(
    (sum, key) => sum + countOf(row[key]),
    0,
  );
  const metadata = {
    day: day.date,
    source: CURSOR_ADMIN_SERVICE,
  };
  for (const key of [...DAILY_REQUEST_COUNTERS, ...DAILY_EXTRA_COUNTERS]) {
    metadata[key] = countOf(row[key]);
  }
  if (model) metadata.model = model;
  return {
    eventId: cursorAdminEventId([
      CURSOR_ADMIN_DAILY_USAGE_PATH,
      day.date,
      userKeyOf(row),
      "requests",
    ]),
    provider: CURSOR_ADMIN_PROVIDER,
    service: CURSOR_ADMIN_SERVICE,
    label: "daily-usage",
    ...(model ? { producerKeyRef: model } : {}),
    metricType: "usage",
    unit: "request",
    quantity: requestCount,
    requests: requestCount,
    billingMode: "actual",
    confidence: "actual",
    occurredAt: day.occurredAt,
    metadata,
  };
}

export function buildDailyUsageEvents(rows, { now = Date.now() } = {}) {
  if (!Array.isArray(rows)) return [];
  const events = [];
  const seen = new Set();
  for (const row of rows) {
    const event = buildDailyUsageEvent(row, { now });
    // The API returns one row per day per user.  A repeated (day, user) row
    // (a pagination overlap) would carry the same eventId with the same
    // content, so the first one wins and the batch cannot 409 on itself.
    if (!event || seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    events.push(event);
  }
  return events;
}

/**
 * One event per team member per closed billing cycle.
 *
 * `costUsd` is the money Cursor actually charged (spendCents / 100).
 * `includedSpendUsd` is the amount the subscription included; it is a
 * different number and stays in metadata so it can never be mistaken for
 * cash.  Both carry the fractional cents Cursor reports.
 *
 * The cycle has to be closed and settled before it is published: the API
 * reports a cycle-to-date total, so a cycle that is still running changes
 * every time Cursor is used.  A published row whose content changes under a
 * stable event id is the HTTP 409 the ingest answers with, and it would
 * freeze the stored amount at its first value.  A closed cycle's total is
 * final, so the event replays byte-identically and dedupes.
 */
export function buildSpendEvent(member, { cycleStartMs = null, now = Date.now() } = {}) {
  if (!isRecord(member)) return null;
  const cycleStart = numberOrNull(cycleStartMs);
  if (cycleStart == null || cycleStart <= 0) return null;
  const cycleEnd = nextMonthStartUtcMs(cycleStart);
  if (!isSettledPeriod(cycleEnd, now)) return null;
  const spendCents = countOf(member.spendCents);
  const includedCents = numberOrNull(member.includedSpendCents);
  const includedUsd = includedCents != null ? includedCents / 100 : 0;
  // Nothing was charged and nothing was covered by the subscription, so the
  // cycle has no money in it at all and needs no row.
  if (spendCents <= 0 && includedUsd <= 0) return null;
  const metadata = {
    kind: "spend",
    source: CURSOR_ADMIN_SERVICE,
    fastPremiumRequests: countOf(member.fastPremiumRequests),
    finalCycleTotal: true,
    cycleEnd: new Date(cycleEnd).toISOString(),
  };
  if (includedCents != null) metadata.includedSpendUsd = includedUsd;
  return {
    eventId: cursorAdminEventId([
      CURSOR_ADMIN_SPEND_PATH,
      String(cycleStart),
      userKeyOf(member),
      "spend",
    ]),
    provider: CURSOR_ADMIN_PROVIDER,
    service: CURSOR_ADMIN_SERVICE,
    label: "team-member-spend",
    metricType: "cost",
    unit: "usd",
    costUsd: spendCents / 100,
    billingMode: "actual",
    confidence: "actual",
    occurredAt: new Date(cycleStart).toISOString(),
    metadata,
  };
}

export function buildSpendEvents(members, { cycleStartMs = null, now = Date.now() } = {}) {
  if (!Array.isArray(members)) return [];
  const events = [];
  const seen = new Set();
  for (const member of members) {
    const event = buildSpendEvent(member, { cycleStartMs, now });
    // Same (cycle, member) twice would be the same eventId with the same
    // content, so the first row wins.
    if (!event || seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    events.push(event);
  }
  return events;
}

// ------------------------------------------------------------ api client ---

function retryAfterMs(response) {
  const header = response?.headers?.get?.("retry-after");
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(CURSOR_ADMIN_MAX_RETRY_AFTER_MS, seconds * 1000);
}

async function postJson({ url, body, apiKey, fetchImpl }) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CURSOR_ADMIN_REQUEST_TIMEOUT_MS),
  });
  const text = typeof response.text === "function" ? await response.text() : "";
  return { response, text };
}

function parseJsonBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * POST one Admin API call.
 *
 * A transient 5xx / 429 / network error is retried with backoff.  A 4xx is
 * reported and never looped.  The 30-day window rejection is handled by
 * clamping the window and retrying once instead of failing the run.
 *
 * Response bodies are never logged: they can carry account ids.
 */
export async function cursorAdminRequest({
  path,
  body,
  apiKey,
  baseUrl = CURSOR_ADMIN_API_BASE,
  fetchImpl = fetch,
  sleep = defaultSleep,
  maxAttempts = CURSOR_ADMIN_MAX_ATTEMPTS,
  log = () => {},
}) {
  if (!apiKey) {
    throw new CursorAdminApiError("CURSOR_ADMIN_API_KEY is required", { path });
  }
  const url = `${baseUrl}${path}`;
  let requestBody = { ...body };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response = null;
    let text = "";
    try {
      const result = await postJson({ url, body: requestBody, apiKey, fetchImpl });
      response = result.response;
      text = result.text;
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      if (attempt >= maxAttempts) {
        throw new CursorAdminApiError(
          `Cursor Admin API ${path} failed after ${maxAttempts} attempts (${name})`,
          { path },
        );
      }
      const waitMs = Math.min(CURSOR_ADMIN_RETRY_MAX_MS, CURSOR_ADMIN_RETRY_BASE_MS * 2 ** (attempt - 1));
      log(`Cursor Admin API ${path} network error (${name}); retry in ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }
    if (response.ok) {
      const parsed = parseJsonBody(text);
      if (!parsed) {
        throw new CursorAdminApiError(
          `Cursor Admin API ${path} answered with a non-JSON body`,
          { status: response.status, path },
        );
      }
      return parsed;
    }
    if (
      response.status === 400 &&
      requestBody.startDate &&
      requestBody.endDate &&
      text.includes(CURSOR_ADMIN_DATE_RANGE_ERROR)
    ) {
      const narrowed = narrowWindow(requestBody.startDate, requestBody.endDate);
      if (
        narrowed &&
        (narrowed.startDate !== requestBody.startDate || narrowed.endDate !== requestBody.endDate)
      ) {
        requestBody = {
          ...requestBody,
          startDate: narrowed.startDate,
          endDate: narrowed.endDate,
        };
        log(
          `Cursor Admin API ${path} rejected the window (${CURSOR_ADMIN_DATE_RANGE_ERROR}); retrying with ${narrowed.startDate}..${narrowed.endDate}`,
        );
        continue;
      }
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt >= maxAttempts) {
        throw new CursorAdminApiError(
          `Cursor Admin API ${path} failed with HTTP ${response.status} after ${maxAttempts} attempts`,
          { status: response.status, path },
        );
      }
      const hinted = retryAfterMs(response);
      const waitMs = Math.min(
        CURSOR_ADMIN_RETRY_MAX_MS,
        hinted ?? CURSOR_ADMIN_RETRY_BASE_MS * 2 ** (attempt - 1),
      );
      log(`Cursor Admin API ${path} HTTP ${response.status}; retry in ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }
    throw new CursorAdminApiError(
      `Cursor Admin API ${path} failed with HTTP ${response.status}`,
      { status: response.status, path },
    );
  }
  throw new CursorAdminApiError(
    `Cursor Admin API ${path} failed after ${maxAttempts} attempts`,
    { path },
  );
}

async function fetchPaginated({
  path,
  window,
  apiKey,
  fetchImpl,
  sleep,
  log,
  limit = CURSOR_ADMIN_PAGE_SIZE,
  pick,
}) {
  const rows = [];
  let pages = 0;
  let page = 1;
  while (page <= CURSOR_ADMIN_MAX_PAGES) {
    const payload = await cursorAdminRequest({
      path,
      body: {
        startDate: window.startDate,
        endDate: window.endDate,
        page,
        limit,
      },
      apiKey,
      fetchImpl,
      sleep,
      log,
    });
    pages += 1;
    rows.push(...pick(payload));
    if (!hasNextPage(payload)) break;
    page += 1;
  }
  return { rows, pages };
}

export function fetchDailyUsageRows(options) {
  return fetchPaginated({ ...options, path: CURSOR_ADMIN_DAILY_USAGE_PATH, pick: parseDailyUsageRows });
}

export function fetchUsageEvents(options) {
  return fetchPaginated({ ...options, path: CURSOR_ADMIN_USAGE_EVENTS_PATH, pick: parseUsageEvents });
}

export async function fetchSpend(options) {
  const members = [];
  let payload = null;
  let cycleStartMs = null;
  let pages = 0;
  let page = 1;
  let totalPages = 1;
  while (page <= CURSOR_ADMIN_MAX_PAGES) {
    payload = await cursorAdminRequest({
      path: CURSOR_ADMIN_SPEND_PATH,
      body: {
        startDate: options.window.startDate,
        endDate: options.window.endDate,
        page,
        limit: CURSOR_ADMIN_PAGE_SIZE,
      },
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
      log: options.log,
    });
    pages += 1;
    members.push(...parseSpendMembers(payload));
    cycleStartMs = spendCycleStartMs(payload) ?? cycleStartMs;
    const reported = numberOrNull(payload?.totalPages);
    totalPages = reported != null && reported > 0 ? reported : 1;
    if (page >= totalPages) break;
    page += 1;
  }
  return { payload, members, cycleStartMs, pages, totalPages };
}

// ------------------------------------------------------------- collector ---

/**
 * Read the three Admin API endpoints and build the v2 events.
 *
 * The per-event feed (/teams/filtered-usage-events) is read for coverage
 * only: it is empty on this account, its rows carry billed cents and token
 * counts that UM's server-side Cursor poller owns, and mapping them here
 * would double count cash in UM.
 */
export async function collectCursorEvents({
  window,
  spendWindows = null,
  now = Date.now(),
  apiKey,
  fetchImpl = fetch,
  sleep = defaultSleep,
  log = () => {},
} = {}) {
  const daily = await fetchDailyUsageRows({ window, apiKey, fetchImpl, sleep, log });
  let usageFeed = { rows: [], pages: 0 };
  let usageFeedError = null;
  try {
    usageFeed = await fetchUsageEvents({ window, apiKey, fetchImpl, sleep, log });
  } catch (error) {
    usageFeedError = error instanceof Error ? error.message : String(error);
    log(`per-event feed unavailable (${usageFeedError}); continuing with the daily feed`);
  }
  // The spend endpoint needs a month-aligned window and answers with the
  // cycle-to-date total of the month that window names, so the closed
  // settled months are read one at a time and the running month is never
  // read.  A month that cannot be read is skipped, not fatal: the other
  // months still publish.
  const months = spendWindows ?? closedSpendWindows(now);
  const spendReads = [];
  const spendErrors = [];
  for (const month of months) {
    try {
      const spend = await fetchSpend({ window: month, apiKey, fetchImpl, sleep, log });
      spendReads.push({ ...spend, window: month });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      spendErrors.push({ month: month.startDate, message });
      log(`spend for ${month.startDate} unavailable (${message}); continuing`);
    }
  }
  const usageEvents = buildDailyUsageEvents(daily.rows, { now });
  const spendEvents = [];
  const seenSpendIds = new Set();
  for (const read of spendReads) {
    for (const event of buildSpendEvents(read.members, { cycleStartMs: read.cycleStartMs, now })) {
      // Two months can answer with the same cycle, so the same event id can
      // arrive twice.  One row per event id is enough.
      if (seenSpendIds.has(event.eventId)) continue;
      seenSpendIds.add(event.eventId);
      spendEvents.push(event);
    }
  }
  return {
    usageEvents,
    spendEvents,
    stats: {
      dailyRows: daily.rows.length,
      dailyPages: daily.pages,
      usageFeedRows: usageFeed.rows.length,
      usageFeedPages: usageFeed.pages,
      usageFeedError,
      spendMembers: spendReads.reduce((sum, read) => sum + read.members.length, 0),
      spendPages: spendReads.reduce((sum, read) => sum + read.pages, 0),
      spendMonths: spendReads.map((read) => read.window.startDate),
      spendErrors,
      cycleStartMs: spendReads[0]?.cycleStartMs ?? null,
    },
  };
}

/**
 * The dry-run summary.  It reports counts, kinds and dates only: no key, no
 * email, no amount and no model leaves the process.
 */
export function summarizeDryRun({ usageEvents = [], spendEvents = [], window, stats = {} } = {}) {
  const metricTypes = [...new Set(usageEvents.map((event) => event.metricType))].sort();
  const spendMetricTypes = [...new Set(spendEvents.map((event) => event.metricType))].sort();
  const days = [...new Set(usageEvents.map((event) => event.metadata?.day).filter(Boolean))].sort();
  const months = [...new Set(stats.spendMonths ?? [])].sort();
  const lines = [
    `window: ${window.startDate}..${window.endDate} (${window.days} day(s)${window.clamped ? `, clamped from ${window.requestedDays} requested day(s)` : ""})`,
    `daily usage rows: ${stats.dailyRows ?? 0}`,
    `daily usage events: ${usageEvents.length} (metricType=${metricTypes.join(",") || "none"}, unit=request)`,
    `days covered: ${days.length ? `${days[0]}..${days[days.length - 1]}` : "none"}`,
    `spend members: ${stats.spendMembers ?? 0}`,
    `spend months read: ${months.length ? months.join(",") : "none"}`,
    `spend events: ${spendEvents.length} (metricType=${spendMetricTypes.join(",") || "none"}, unit=usd)`,
    `per-event feed rows: ${stats.usageFeedRows ?? 0} (read for coverage; not mapped)`,
  ];
  if (stats.usageFeedError) lines.push(`per-event feed error: ${stats.usageFeedError}`);
  for (const failure of stats.spendErrors ?? []) {
    lines.push(`spend error for ${failure.month}: ${failure.message}`);
  }
  return lines.join("\n");
}

/**
 * Run one collector pass.
 *
 * `post` is injected by the CLI (it owns the ingest token and the house
 * posting helper).  Usage events and spend events are posted as SEPARATE
 * batches: UM answers a whole batch with 409 when one event collides with a
 * stored row that has different content, and a spend change must not poison
 * the daily usage batch.
 */
export async function runCursorCollector({
  dryRun = false,
  window,
  spendWindows = null,
  now = Date.now(),
  apiKey,
  fetchImpl = fetch,
  sleep = defaultSleep,
  post = null,
  log = () => {},
} = {}) {
  const result = await collectCursorEvents({
    window,
    spendWindows,
    now,
    apiKey,
    fetchImpl,
    sleep,
    log,
  });
  if (dryRun) {
    log(summarizeDryRun({ ...result, window }));
    return { ...result, dryRun: true, usageAck: null, spendAck: null };
  }
  let usageAck = null;
  let spendAck = null;
  if (post) {
    if (result.usageEvents.length > 0) {
      usageAck = await post({ events: result.usageEvents, kind: "usage" });
    }
    if (result.spendEvents.length > 0) {
      spendAck = await post({ events: result.spendEvents, kind: "spend" });
    }
  }
  return { ...result, dryRun: false, usageAck, spendAck };
}
