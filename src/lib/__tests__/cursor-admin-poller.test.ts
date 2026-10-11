import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CURSOR_ADMIN_RATE_LIMIT_BODY,
  CURSOR_FILTERED_USAGE_EVENTS_FIXTURE,
  CURSOR_SERVICE_ACCOUNT_USAGE_EVENT_FIXTURE,
} from "@/lib/cursor-admin-fixtures";
import {
  CURSOR_ADMIN_API_BASE,
  CURSOR_ADMIN_MAX_PAGES,
  CURSOR_ADMIN_MAX_RETRY_WAIT_MS,
  CURSOR_ADMIN_PAGE_SIZE,
  CURSOR_ADMIN_USAGE_EVENTS_PATH,
  cursorAdminPollWindow,
  cursorUsageEventIdempotencyKey,
  mapCursorUsageEvent,
  parseCursorFilteredUsageEvent,
  parseFilteredUsageEventsPage,
  pollCursorAdminUsage,
  resetCursorAdminPollerForTests,
  resolveCursorAdminLookbackMs,
  type CursorAdminPollState,
  type CursorFilteredUsageEvent,
} from "@/lib/cursor-admin-poller";
import type { ExternalUsageEventInput } from "@/lib/external-usage-events";

const API_KEY = "crsr_admin_test_key_do_not_log";

function env(values: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}
const LAST_ATTEMPT_KEY = "cursor_admin_poller_last_attempt_ms";
const WATERMARK_KEY = "cursor_admin_poller_watermark_ms";
const NOW = new Date("2026-10-11T22:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function pageOf(events: readonly unknown[], hasNextPage: boolean, currentPage = 1) {
  return {
    totalUsageEventsCount: 113,
    pagination: {
      numPages: hasNextPage ? currentPage + 1 : currentPage,
      currentPage,
      pageSize: 25,
      hasNextPage,
      hasPreviousPage: currentPage > 1,
    },
    usageEvents: events,
    period: CURSOR_FILTERED_USAGE_EVENTS_FIXTURE.period,
  };
}

function memoryState(): CursorAdminPollState & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    async get(key) {
      return rows.get(key) ?? null;
    },
    async set(key, value) {
      rows.set(key, value);
    },
  };
}

function memoryPersist(store: Map<string, ExternalUsageEventInput>) {
  return async (events: ExternalUsageEventInput[]) => {
    const fresh: ExternalUsageEventInput[] = [];
    for (const event of events) {
      if (!store.has(event.idempotencyKey)) {
        store.set(event.idempotencyKey, event);
        fresh.push(event);
      }
    }
    return {
      attempted: events.length,
      persisted: fresh.length,
      skippedPrunedDuplicates: 0,
      newEvents: fresh,
    };
  };
}

function authHeader(): string {
  return `Basic ${Buffer.from(`${API_KEY}:`).toString("base64")}`;
}

describe("Cursor filtered usage fixtures", () => {
  it("parses the documented page, including hasNextPage", () => {
    const page = parseFilteredUsageEventsPage(CURSOR_FILTERED_USAGE_EVENTS_FIXTURE);
    expect(page).not.toBeNull();
    expect(page?.hasNextPage).toBe(true);
    expect(page?.events).toHaveLength(3);
    expect(page?.events[0]).toMatchObject({
      timestamp: "1750979225854",
      userEmail: "developer@company.com",
      model: "claude-4.5-sonnet",
      kind: "Usage-based",
      chargedCents: 21.36232,
      cursorTokenFee: 1.18,
    });
    expect(page?.events[0]?.tokenUsage).toMatchObject({
      inputTokens: 126,
      outputTokens: 450,
      cacheWriteTokens: 6112,
      cacheReadTokens: 11964,
    });
  });

  it("parses the documented service-account event as headless", () => {
    const event = parseCursorFilteredUsageEvent(CURSOR_SERVICE_ACCOUNT_USAGE_EVENT_FIXTURE);
    expect(event).not.toBeNull();
    const mapped = mapCursorUsageEvent(event!);
    expect(mapped.service).toBe("cursor-headless");
    expect(mapped.metadata).toMatchObject({
      source: "headless",
      serviceAccountId: "sa_abc123",
      userEmail: "agent-runner@company.com",
    });
  });

  it("rejects a page whose pagination flag is missing", () => {
    expect(
      parseFilteredUsageEventsPage({
        usageEvents: CURSOR_FILTERED_USAGE_EVENTS_FIXTURE.usageEvents,
        pagination: { numPages: 1, currentPage: 1, pageSize: 25 },
      })
    ).toBeNull();
  });

  it("rejects an empty page that still claims another page", () => {
    expect(parseFilteredUsageEventsPage(pageOf([], true))).toBeNull();
  });
});

describe("mapCursorUsageEvent", () => {
  const events = CURSOR_FILTERED_USAGE_EVENTS_FIXTURE.usageEvents;

  it("records billed dollars, tokens, kind, and client source from the first doc event", () => {
    const mapped = mapCursorUsageEvent(parseCursorFilteredUsageEvent(events[0])!);
    expect(mapped.costUsd).toBeCloseTo(21.36232 / 100);
    expect(mapped).toMatchObject({
      sourceApp: "cursor-admin",
      provider: "cursor",
      service: "cursor-client",
      label: "Usage-based",
      keyRef: "claude-4.5-sonnet",
      billingMode: "actual",
      metricType: "cost",
      unit: "token",
      quantity: 126 + 450 + 6112 + 11964,
      requests: 1,
      confidence: "actual",
    });
    expect(mapped.occurredAt.toISOString()).toBe("2025-06-26T23:07:05.854Z");
    expect(mapped.windowStart).toBeUndefined();
    expect(mapped.metadata).toMatchObject({
      userEmail: "developer@company.com",
      kind: "Usage-based",
      source: "client",
      inputTokens: 126,
      outputTokens: 450,
      cacheWriteTokens: 6112,
      cacheReadTokens: 11964,
      chargedCents: 21.36232,
      cursorTokenFeeCents: 1.18,
    });
  });

  it("keeps included-plan charged cents as dollars without inventing a token unit", () => {
    const mapped = mapCursorUsageEvent(parseCursorFilteredUsageEvent(events[2])!);
    expect(mapped).toMatchObject({
      label: "Included in Business",
      unit: "request",
      quantity: 1.4,
      costUsd: 0.08,
      service: "cursor-client",
    });
    expect(mapped.metadata).toMatchObject({
      kind: "Included in Business",
      isChargeable: false,
      chargedCents: 8,
    });
  });

  it("classifies a cloud agent id ahead of the headless flag", () => {
    const mapped = mapCursorUsageEvent(
      parseCursorFilteredUsageEvent({
        ...CURSOR_SERVICE_ACCOUNT_USAGE_EVENT_FIXTURE,
        cloudAgentId: "ca_123",
      })!
    );
    expect(mapped.service).toBe("cursor-cloud-agent");
    expect(mapped.metadata).toMatchObject({ source: "cloud-agent", cloudAgentId: "ca_123" });
  });

  it("dedupes on the event identity and changes the key when the timestamp changes", () => {
    const event = parseCursorFilteredUsageEvent(events[0])!;
    expect(cursorUsageEventIdempotencyKey(event)).toBe(cursorUsageEventIdempotencyKey(event));
    const shifted: CursorFilteredUsageEvent = { ...event, timestamp: "1750979225855" };
    expect(cursorUsageEventIdempotencyKey(shifted)).not.toBe(cursorUsageEventIdempotencyKey(event));
  });
});

describe("pollCursorAdminUsage", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetCursorAdminPollerForTests();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
    info = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
    info.mockRestore();
  });

  function harness(
    fetchImpl: typeof fetch,
    extras: {
      sleep?: (ms: number) => Promise<void>;
      now?: () => Date;
      force?: boolean;
      env?: NodeJS.ProcessEnv;
    } = {}
  ) {
    const state = memoryState();
    const store = new Map<string, ExternalUsageEventInput>();
    const fanout = vi.fn(
      async (
        events: readonly {
          provider: string;
          sourceApp: string;
          model?: string | null;
          costUsd?: number | null;
        }[],
        route: "poll"
      ) => {
        void events;
        void route;
      }
    );
    const checkIn = vi.fn(async () => undefined);
    const ensureProvider = vi.fn(async () => undefined);
    const run = (force = extras.force) =>
      pollCursorAdminUsage({
        env: env({ CURSOR_ADMIN_API_KEY: API_KEY, ...extras.env }),
        fetchImpl,
        sleep: extras.sleep ?? (async () => undefined),
        now: extras.now ?? (() => NOW),
        persist: memoryPersist(store),
        fanout,
        checkIn,
        ensureProvider,
        state,
        force,
        runInTests: true,
      });
    return { state, store, fanout, checkIn, ensureProvider, run };
  }

  it("skips inside Vitest unless the test opts in", async () => {
    const fetchImpl = vi.fn();
    const result = await pollCursorAdminUsage({
      env: env({ CURSOR_ADMIN_API_KEY: API_KEY }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      runInTests: false,
    });
    expect(result).toEqual({ status: "skipped", reason: "test_process" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("warns and skips when the admin key is missing", async () => {
    const fetchImpl = vi.fn();
    const checkIn = vi.fn(async () => undefined);
    const first = await pollCursorAdminUsage({
      env: env(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
      checkIn,
      runInTests: true,
    });
    const second = await pollCursorAdminUsage({
      env: env({ CURSOR_ADMIN_API_KEY: "   " }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date(NOW.getTime() + 15 * 60 * 1000),
      checkIn,
      runInTests: true,
    });
    expect(first).toEqual({ status: "skipped", reason: "missing_key" });
    expect(second).toEqual({ status: "skipped", reason: "missing_key" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(checkIn).toHaveBeenCalledTimes(1);
    expect(checkIn).toHaveBeenCalledWith("ok");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("CURSOR_ADMIN_API_KEY");
  });

  it("pages the documented events and sends Basic auth with an empty password", async () => {
    const docEvents = CURSOR_FILTERED_USAGE_EVENTS_FIXTURE.usageEvents;
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      const body = JSON.parse(String(init?.body)) as { page: number };
      if (body.page === 1) return jsonResponse(pageOf(docEvents.slice(0, 2), true, 1));
      return jsonResponse(pageOf(docEvents.slice(2), false, 2));
    });
    const { store, fanout, checkIn, ensureProvider, run, state } = harness(
      fetchImpl as unknown as typeof fetch
    );

    const result = await run(true);
    expect(result).toEqual({ status: "ok", fetched: 3, persisted: 3, duplicates: 0 });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(`${CURSOR_ADMIN_API_BASE}${CURSOR_ADMIN_USAGE_EVENTS_PATH}`);
    expect(requests[0]?.url).not.toContain(API_KEY);
    const headers = new Headers(requests[0]?.init.headers);
    expect(headers.get("authorization")).toBe(authHeader());
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({
      page: 1,
      pageSize: CURSOR_ADMIN_PAGE_SIZE,
      startDate: NOW.getTime() - 7 * DAY_MS,
      endDate: NOW.getTime() - 1,
    });
    expect(JSON.parse(String(requests[1]?.init.body)).page).toBe(2);
    expect(store.size).toBe(3);
    const first = [...store.values()].find((event) => event.keyRef === "claude-4.5-sonnet");
    expect(first?.costUsd).toBeCloseTo(21.36232 / 100);
    expect(fanout).toHaveBeenCalledTimes(1);
    const forwarded = fanout.mock.calls[0]?.[0];
    const route = fanout.mock.calls[0]?.[1];
    expect(route).toBe("poll");
    expect(forwarded).toHaveLength(3);
    expect(JSON.stringify(forwarded)).not.toContain("developer@company.com");
    expect(JSON.stringify(forwarded)).not.toContain(API_KEY);
    expect(checkIn).toHaveBeenCalledWith("ok");
    expect(ensureProvider).toHaveBeenCalledOnce();
    expect(state.rows.get(WATERMARK_KEY)).toBe(String(NOW.getTime() - HOUR_MS));
    expect(state.rows.get(LAST_ATTEMPT_KEY)).toBe(String(NOW.getTime()));
  });

  it("does not double count a rerun and does not fan out duplicates", async () => {
    const docEvents = CURSOR_FILTERED_USAGE_EVENTS_FIXTURE.usageEvents;
    const fetchImpl = vi.fn(async () => jsonResponse(pageOf(docEvents, false)));
    const { store, fanout, run } = harness(fetchImpl as unknown as typeof fetch);

    const first = await run(true);
    const second = await run(true);
    expect(first).toMatchObject({ status: "ok", persisted: 3, duplicates: 0 });
    expect(second).toMatchObject({ status: "ok", fetched: 3, persisted: 0, duplicates: 3 });
    expect(store.size).toBe(3);
    expect(fanout).toHaveBeenCalledTimes(1);
  });

  it("waits out the open hour and skips until the hourly gate elapses", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse(pageOf([CURSOR_FILTERED_USAGE_EVENTS_FIXTURE.usageEvents[2]], false))
    );
    const { state, run } = harness(fetchImpl as unknown as typeof fetch);

    await run(false);
    const again = await run(false);
    expect(again).toEqual({ status: "skipped", reason: "not_due" });
    expect(fetchImpl).toHaveBeenCalledOnce();

    const later = new Date(NOW.getTime() + HOUR_MS);
    const continued = await pollCursorAdminUsage({
      env: env({ CURSOR_ADMIN_API_KEY: API_KEY }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
      now: () => later,
      persist: async (events) => ({
        attempted: events.length,
        persisted: 0,
        skippedPrunedDuplicates: 0,
        newEvents: [],
      }),
      fanout: async () => undefined,
      checkIn: async () => undefined,
      ensureProvider: async () => undefined,
      state,
      runInTests: true,
    });
    expect(continued.status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const replayBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body ?? ""));
    expect(replayBody.startDate).toBe(NOW.getTime() - HOUR_MS + 1);
    expect(state.rows.get(WATERMARK_KEY)).toBe(String(later.getTime() - HOUR_MS));
  });

  it("backs off on 429 using Retry-After and then persists", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(CURSOR_ADMIN_RATE_LIMIT_BODY, 429, { "retry-after": "1" });
      }
      return jsonResponse(pageOf([CURSOR_FILTERED_USAGE_EVENTS_FIXTURE.usageEvents[0]], false));
    });
    const { checkIn, run } = harness(fetchImpl as unknown as typeof fetch, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await run(true);
    expect(result).toMatchObject({ status: "ok", fetched: 1, persisted: 1 });
    expect(sleeps).toEqual([1000]);
    expect(checkIn).toHaveBeenCalledWith("ok");
    expect(JSON.stringify(error.mock.calls)).not.toContain(API_KEY);
  });

  it("caps a 60 second Retry-After and does not advance the watermark after repeated 429s", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () =>
      jsonResponse(CURSOR_ADMIN_RATE_LIMIT_BODY, 429, { "retry-after": "60" })
    );
    const { state, checkIn, store, run } = harness(fetchImpl as unknown as typeof fetch, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await run(true);
    expect(result).toEqual({
      status: "error",
      message: "Cursor Admin API returned HTTP 429",
    });
    expect(sleeps).toEqual([
      CURSOR_ADMIN_MAX_RETRY_WAIT_MS,
      CURSOR_ADMIN_MAX_RETRY_WAIT_MS,
      CURSOR_ADMIN_MAX_RETRY_WAIT_MS,
    ]);
    expect(store.size).toBe(0);
    expect(state.rows.has(WATERMARK_KEY)).toBe(false);
    expect(state.rows.get(LAST_ATTEMPT_KEY)).toBe(String(NOW.getTime()));
    expect(checkIn).toHaveBeenCalledWith("error");
    expect(result.status === "error" ? result.message : "").not.toContain(API_KEY);

    const followUp = await run(false);
    expect(followUp).toEqual({ status: "skipped", reason: "not_due" });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("does not persist a malformed page or move the watermark", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        usageEvents: [{ timestamp: "1750979225854" }],
        pagination: { hasNextPage: false },
      })
    );
    const { state, checkIn, store, run } = harness(fetchImpl as unknown as typeof fetch);
    const result = await run(true);
    expect(result).toEqual({
      status: "error",
      message: "Cursor Admin API response did not match filtered usage events",
    });
    expect(store.size).toBe(0);
    expect(state.rows.has(WATERMARK_KEY)).toBe(false);
    expect(checkIn).toHaveBeenCalledWith("error");
  });

  it("fails closed when pagination exceeds the page cap", async () => {
    const event = CURSOR_FILTERED_USAGE_EVENTS_FIXTURE.usageEvents[2];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { page: number };
      return jsonResponse(pageOf([event], true, body.page));
    });
    const { store, checkIn, run } = harness(fetchImpl as unknown as typeof fetch);
    const result = await run(true);
    expect(result).toEqual({
      status: "error",
      message: "Cursor Admin API pagination exceeded the page cap",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(CURSOR_ADMIN_MAX_PAGES);
    expect(store.size).toBe(0);
    expect(checkIn).toHaveBeenCalledWith("error");
  });

  it("does not retry a non-rate-limit client error", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => jsonResponse({ code: "error", message: "nope" }, 401));
    const { run } = harness(fetchImpl as unknown as typeof fetch, { sleep });
    const result = await run(true);
    expect(result).toEqual({ status: "error", message: "Cursor Admin API returned HTTP 401" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain(API_KEY);
  });
});

describe("cursor admin poll window", () => {
  it("clamps lookback to the documented 30 day maximum", () => {
    expect(resolveCursorAdminLookbackMs(env())).toBe(7 * DAY_MS);
    expect(resolveCursorAdminLookbackMs(env({ CURSOR_ADMIN_LOOKBACK_DAYS: "nope" }))).toBe(7 * DAY_MS);
    expect(resolveCursorAdminLookbackMs(env({ CURSOR_ADMIN_LOOKBACK_DAYS: "0" }))).toBe(DAY_MS);
    expect(resolveCursorAdminLookbackMs(env({ CURSOR_ADMIN_LOOKBACK_DAYS: "99" }))).toBe(30 * DAY_MS);
  });

  it("starts at the lookback and leaves the current hour open", () => {
    const nowMs = NOW.getTime();
    const window = cursorAdminPollWindow(nowMs, null, 7 * DAY_MS);
    expect(window).toEqual({
      startMs: nowMs - 7 * DAY_MS,
      endMs: nowMs - 1,
      watermarkMs: null,
    });
  });
});
