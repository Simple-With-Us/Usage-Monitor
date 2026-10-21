// Tests for the Cursor Admin API producer.
//
// The suite never touches the live Cursor API and never talks to Usage
// Monitor: every HTTP call goes through an injected fetch stub, and the
// fixtures are the response shapes documented for the Admin API.
//
// This suite runs under Vitest, not node:test.  The repository's Vitest
// include is the default (`**/*.test.mjs`), so it collects every file in
// this directory.  A node:test suite collected this way is imported by
// Vitest, registers zero tests there, and fails the run with "No test suite
// found in file".  Vitest is a dev dependency only -- the collector itself
// runs on Node builtins alone, with no third-party package.

import assert from "node:assert/strict";

import { describe, it } from "vitest";

import {
  CURSOR_ADMIN_DATE_RANGE_ERROR,
  CURSOR_ADMIN_MAX_WINDOW_DAYS,
  buildDailyUsageEvents,
  buildSpendEvent,
  buildSpendEvents,
  closedSpendWindows,
  collectCursorEvents,
  normalizeWindow,
  runCursorCollector,
} from "../lib/cursor-admin-telemetry.mjs";

const USER_ID = "user_9f2c41de";
const USER_EMAIL = "jay.owner@example.com";
const USER_NAME = "Jay Owner";
const PROFILE_PICTURE = "https://cursor.example/avatars/9f2c41de.png";
// The closed September cycle, 2026-09-01T00:00:00Z.  A cycle is published
// only once it has been over for a full day, so the fixtures use a cycle
// that is settled at NOW.
const CYCLE_START = 1788220800000;
// 2026-10-25T12:00:00Z.  Every fixture period is closed and settled at this
// instant, and the running October cycle is deliberately not.
const NOW = Date.parse("2026-10-25T12:00:00.000Z");
// The running cycle, 2026-10-01T00:00:00Z.
const RUNNING_CYCLE_START = 1790812800000;

const DAILY_ROW = {
  date: 1790812800000,
  day: "2026-10-01",
  userId: USER_ID,
  email: USER_EMAIL,
  isActive: true,
  totalLinesAdded: 12,
  totalLinesDeleted: 3,
  acceptedLinesAdded: 10,
  acceptedLinesDeleted: 2,
  totalApplies: 4,
  totalAccepts: 3,
  totalRejects: 1,
  totalTabsShown: 7,
  totalTabsAccepted: 5,
  composerRequests: 2,
  chatRequests: 1,
  agentRequests: 5,
  cmdkUsages: 4,
  subscriptionIncludedReqs: 3,
  apiKeyReqs: 1,
  usageBasedReqs: 2,
  bugbotUsages: 0,
  mostUsedModel: "claude-sonnet-4-5",
  applyMostUsedExtension: "",
  tabMostUsedExtension: "",
};

const DAILY_RESPONSE = {
  period: { startDate: 1790812800000, endDate: 1792540799999 },
  data: [DAILY_ROW],
  pagination: {
    page: 1,
    pageSize: 1000,
    totalUsers: 1,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  },
};

const EMPTY_DAILY_RESPONSE = {
  period: { startDate: 1790812800000, endDate: 1792540799999 },
  data: [],
  pagination: {
    page: 1,
    pageSize: 1000,
    totalUsers: 0,
    totalPages: 0,
    hasNextPage: false,
    hasPreviousPage: false,
  },
};

const EMPTY_USAGE_EVENTS_RESPONSE = {
  totalUsageEventsCount: 0,
  pagination: {
    numPages: 0,
    currentPage: 1,
    pageSize: 100,
    hasNextPage: false,
    hasPreviousPage: false,
  },
  usageEvents: [],
  period: { startDate: 1790812800000, endDate: 1792454400000 },
};

const SPEND_MEMBER = {
  userId: USER_ID,
  spendCents: 2133.62178,
  includedSpendCents: 55397.17694726,
  fastPremiumRequests: 0,
  name: USER_NAME,
  email: USER_EMAIL,
  profilePictureUrl: PROFILE_PICTURE,
  role: "owner",
  monthlyLimitDollars: null,
  hardLimitOverrideDollars: 1,
  effectivePerUserLimitDollars: 1,
};

const SPEND_RESPONSE = {
  teamMemberSpend: [SPEND_MEMBER],
  subscriptionCycleStart: CYCLE_START,
  totalMembers: 1,
  totalPages: 1,
  limitedUsersCount: 1,
  maxUserSpendCents: 2133.62178,
};

const WINDOW = normalizeWindow({ startDate: "2026-10-01", endDate: "2026-10-30" });

function jsonResponse(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => {
        const key = String(name).toLowerCase();
        return headers[key] ?? headers[Object.keys(headers).find((k) => k.toLowerCase() === key)] ?? null;
      },
    },
    text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
  };
}

/** A fetch stub that routes by path and records every call. */
function routeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ url, path, body: init?.body ? JSON.parse(init.body) : null });
    const handler = routes[path];
    if (!handler) throw new Error(`unexpected request to ${path}`);
    return handler(calls.length, calls[calls.length - 1]);
  };
  impl.calls = calls;
  return impl;
}

function defaultRoutes(overrides = {}) {
  return {
    "/teams/daily-usage-data": overrides.daily ?? (() => jsonResponse(200, DAILY_RESPONSE)),
    "/teams/filtered-usage-events":
      overrides.usageEvents ?? (() => jsonResponse(200, EMPTY_USAGE_EVENTS_RESPONSE)),
    "/teams/spend": overrides.spend ?? (() => jsonResponse(200, SPEND_RESPONSE)),
  };
}

describe("cursor daily usage events", () => {
  it("builds the expected event shape and carries the model through", () => {
    const events = buildDailyUsageEvents([DAILY_ROW], { now: NOW });
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.metricType, "usage");
    assert.equal(event.unit, "request");
    assert.equal(event.provider, "cursor");
    assert.equal(event.billingMode, "actual");
    assert.equal(event.confidence, "actual");
    // composerRequests 2 + chatRequests 1 + agentRequests 5
    assert.equal(event.quantity, 8);
    assert.equal(event.requests, 8);
    assert.equal(event.producerKeyRef, "claude-sonnet-4-5");
    assert.equal(event.metadata.model, "claude-sonnet-4-5");
    assert.equal(event.metadata.agentRequests, 5);
    assert.equal(event.metadata.day, "2026-10-01");
    assert.equal(event.occurredAt, "2026-10-01T00:00:00.000Z");
  });

  it("still emits one valid event per day per user when every counter is zero", () => {
    const zeroRow = {
      date: 1790899200000,
      day: "2026-10-02",
      userId: USER_ID,
      email: USER_EMAIL,
      isActive: false,
      totalLinesAdded: 0,
      totalLinesDeleted: 0,
      acceptedLinesAdded: 0,
      acceptedLinesDeleted: 0,
      totalApplies: 0,
      totalAccepts: 0,
      totalRejects: 0,
      totalTabsShown: 0,
      totalTabsAccepted: 0,
      composerRequests: 0,
      chatRequests: 0,
      agentRequests: 0,
      cmdkUsages: 0,
      subscriptionIncludedReqs: 0,
      apiKeyReqs: 0,
      usageBasedReqs: 0,
      bugbotUsages: 0,
      mostUsedModel: "",
      applyMostUsedExtension: "",
      tabMostUsedExtension: "",
    };
    const events = buildDailyUsageEvents([zeroRow, { ...zeroRow, day: "2026-10-03", date: 1790985600000 }], { now: NOW });
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.metricType, "usage");
      assert.equal(event.unit, "request");
      assert.equal(event.quantity, 0);
      assert.equal(event.requests, 0);
      assert.equal(event.producerKeyRef, undefined);
      assert.equal(event.metadata.model, undefined);
    }
  });

  it("produces no events for an empty data array", () => {
    const events = buildDailyUsageEvents([], { now: NOW });
    assert.deepEqual(events, []);
  });
});

describe("cursor spend events", () => {
  it("converts fractional cents to dollars without losing precision", () => {
    const [event] = buildSpendEvents([SPEND_MEMBER], { cycleStartMs: CYCLE_START, now: NOW });
    assert.equal(event.costUsd, 21.3362178);
    assert.equal(event.metricType, "cost");
    assert.equal(event.unit, "usd");
    assert.equal(event.billingMode, "actual");
  });

  it("carries the included spend in metadata and keeps it apart from the spend amount", () => {
    const [event] = buildSpendEvents([SPEND_MEMBER], { cycleStartMs: CYCLE_START, now: NOW });
    assert.equal(event.metadata.includedSpendUsd, 553.9717694726);
    assert.notEqual(event.metadata.includedSpendUsd, event.costUsd);
    assert.equal(event.costUsd, 21.3362178);
  });

  it("drops a member row without a cycle start", () => {
    assert.equal(buildSpendEvent(SPEND_MEMBER, { cycleStartMs: null, now: NOW }), null);
  });
});

describe("privacy of the emitted events", () => {
  it("never carries a personal identifier", () => {
    const [usage] = buildDailyUsageEvents([DAILY_ROW], { now: NOW });
    const [spend] = buildSpendEvents([SPEND_MEMBER], { cycleStartMs: CYCLE_START, now: NOW });
    for (const event of [usage, spend]) {
      const serialized = JSON.stringify(event);
      assert.equal(serialized.includes(USER_EMAIL), false);
      assert.equal(serialized.includes(USER_ID), false);
      assert.equal(serialized.includes(USER_NAME), false);
      assert.equal(serialized.includes(PROFILE_PICTURE), false);
    }
  });

  it("leaves the top-level project field unset", () => {
    const [usage] = buildDailyUsageEvents([DAILY_ROW], { now: NOW });
    const [spend] = buildSpendEvents([SPEND_MEMBER], { cycleStartMs: CYCLE_START, now: NOW });
    for (const event of [usage, spend]) {
      assert.equal("project" in event, false);
      assert.equal(event.project, undefined);
    }
  });

  it("never emits a token event, not even a zero-quantity one", () => {
    const zeroRow = {
      ...DAILY_ROW,
      day: "2026-10-02",
      date: 1790899200000,
      composerRequests: 0,
      chatRequests: 0,
      agentRequests: 0,
    };
    const events = [...buildDailyUsageEvents([DAILY_ROW, zeroRow], { now: NOW })];
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.notEqual(event.unit, "token");
      assert.equal(event.metadata?.tokenType, undefined);
      assert.equal(event.metadata?.inputTokens, undefined);
      assert.equal(event.metadata?.outputTokens, undefined);
    }
  });
});

describe("settled periods only", () => {
  it("publishes a day that has been over for a full day", () => {
    const row = { ...DAILY_ROW, day: "2026-10-23", date: 1792540800000 };
    const events = buildDailyUsageEvents([row], { now: NOW });
    assert.equal(events.length, 1);
    assert.equal(events[0].metadata.day, "2026-10-23");
  });

  it("does not publish the day that is still running", () => {
    const row = { ...DAILY_ROW, day: "2026-10-25", date: 1792800000000 };
    assert.deepEqual(buildDailyUsageEvents([row], { now: NOW }), []);
  });

  it("does not publish a day that ended less than a full day ago", () => {
    const row = { ...DAILY_ROW, day: "2026-10-24", date: 1792713600000 };
    assert.deepEqual(buildDailyUsageEvents([row], { now: NOW }), []);
  });

  it("publishes a closed cycle and refuses the running one", () => {
    assert.equal(buildSpendEvents([SPEND_MEMBER], { cycleStartMs: CYCLE_START, now: NOW }).length, 1);
    assert.deepEqual(
      buildSpendEvents([SPEND_MEMBER], { cycleStartMs: RUNNING_CYCLE_START, now: NOW }),
      [],
    );
  });

  it("marks a published cycle as a final total", () => {
    const [event] = buildSpendEvents([SPEND_MEMBER], { cycleStartMs: CYCLE_START, now: NOW });
    assert.equal(event.metadata.finalCycleTotal, true);
    assert.equal(event.metadata.cycleEnd, "2026-10-01T00:00:00.000Z");
    assert.equal(event.occurredAt, "2026-09-01T00:00:00.000Z");
  });

  it("skips a cycle in which nothing was charged and nothing was covered", () => {
    const empty = { ...SPEND_MEMBER, spendCents: 0, includedSpendCents: 0 };
    assert.deepEqual(buildSpendEvents([empty], { cycleStartMs: CYCLE_START, now: NOW }), []);
  });

  it("spend windows are month aligned and never include the running month", () => {
    const windows = closedSpendWindows(NOW);
    assert.equal(windows.length, 3);
    for (const window of windows) {
      assert.match(window.startDate, /^\d{4}-\d{2}-01$/);
      assert.equal(window.startDate.slice(0, 7), new Date(window.cycleStartMs).toISOString().slice(0, 7));
    }
    // The running month is never read.
    assert.equal(windows.some((window) => window.startDate === "2026-10-01"), false);
    assert.equal(windows[0].startDate, "2026-09-01");
  });

  it("asks the spend endpoint for a month-aligned window", async () => {
    const fetchImpl = routeFetch(defaultRoutes());
    await collectCursorEvents({ window: WINDOW, apiKey: "test-key", fetchImpl, now: NOW });
    const spendCalls = fetchImpl.calls.filter((call) => call.path === "/teams/spend");
    assert.equal(spendCalls.length, 3);
    for (const call of spendCalls) {
      // The endpoint answers HTTP 400 unless startDate is the first of a
      // month: "startDate must align with the start of a month".
      assert.match(call.body.startDate, /^\d{4}-\d{2}-01$/);
    }
  });
});

describe("determinism", () => {
  it("produces a byte-identical event and event id on two separate runs", async () => {
    const fetchImpl = routeFetch(defaultRoutes());
    const first = await collectCursorEvents({ window: WINDOW, apiKey: "test-key", fetchImpl, now: NOW });
    const second = await collectCursorEvents({ window: WINDOW, apiKey: "test-key", fetchImpl, now: NOW });
    assert.equal(first.usageEvents.length, 1);
    assert.equal(
      JSON.stringify(first.usageEvents),
      JSON.stringify(second.usageEvents),
    );
    assert.equal(first.usageEvents[0].eventId, second.usageEvents[0].eventId);
    assert.equal(first.spendEvents[0].eventId, second.spendEvents[0].eventId);
    assert.equal(
      JSON.stringify(first.spendEvents),
      JSON.stringify(second.spendEvents),
    );
  });
});

describe("window handling", () => {
  it("clamps a window wider than 30 days before the request is made", async () => {
    const fetchImpl = routeFetch(defaultRoutes());
    const wide = normalizeWindow({ startDate: "2026-01-01", endDate: "2026-10-20" });
    assert.equal(wide.days, CURSOR_ADMIN_MAX_WINDOW_DAYS);
    assert.equal(wide.clamped, true);
    await collectCursorEvents({ window: wide, apiKey: "test-key", fetchImpl, now: NOW });
    const daily = fetchImpl.calls.find((call) => call.path === "/teams/daily-usage-data");
    const requested = new Date(`${daily.body.endDate}T00:00:00.000Z`).getTime() -
      new Date(`${daily.body.startDate}T00:00:00.000Z`).getTime();
    assert.equal(Math.round(requested / 86_400_000) + 1, CURSOR_ADMIN_MAX_WINDOW_DAYS);
  });

  it("clamps and retries a 400 that says the date range exceeds 30 days", async () => {
    let attempts = 0;
    const fetchImpl = routeFetch(
      defaultRoutes({
        daily: () => {
          attempts += 1;
          if (attempts === 1) {
            return jsonResponse(400, { error: CURSOR_ADMIN_DATE_RANGE_ERROR });
          }
          return jsonResponse(200, DAILY_RESPONSE);
        },
      }),
    );
    const result = await collectCursorEvents({ window: WINDOW, apiKey: "test-key", fetchImpl, now: NOW });
    assert.equal(attempts, 2);
    assert.equal(result.usageEvents.length, 1);
    const dailyCalls = fetchImpl.calls.filter((call) => call.path === "/teams/daily-usage-data");
    assert.equal(dailyCalls.length, 2);
    const span = new Date(`${dailyCalls[1].body.endDate}T00:00:00.000Z`).getTime() -
      new Date(`${dailyCalls[1].body.startDate}T00:00:00.000Z`).getTime();
    assert.ok(Math.round(span / 86_400_000) + 1 <= CURSOR_ADMIN_MAX_WINDOW_DAYS);
  });
});

describe("pagination", () => {
  it("follows hasNextPage and stops", async () => {
    const fetchImpl = routeFetch(
      defaultRoutes({
        daily: (call) => {
          if (call === 1) {
            return jsonResponse(200, {
              ...DAILY_RESPONSE,
              data: [DAILY_ROW],
              pagination: { ...DAILY_RESPONSE.pagination, hasNextPage: true, totalPages: 2 },
            });
          }
          return jsonResponse(200, {
            ...DAILY_RESPONSE,
            data: [{ ...DAILY_ROW, day: "2026-10-02", date: 1790899200000 }],
            pagination: { ...DAILY_RESPONSE.pagination, hasNextPage: false, totalPages: 2 },
          });
        },
      }),
    );
    const result = await collectCursorEvents({ window: WINDOW, apiKey: "test-key", fetchImpl, now: NOW });
    const dailyCalls = fetchImpl.calls.filter((call) => call.path === "/teams/daily-usage-data");
    assert.equal(dailyCalls.length, 2);
    assert.equal(dailyCalls[0].body.page, 1);
    assert.equal(dailyCalls[1].body.page, 2);
    assert.equal(result.usageEvents.length, 2);
    assert.equal(result.stats.dailyPages, 2);
  });
});

describe("empty feeds", () => {
  it("treats an empty usageEvents list as no data, not as an error", async () => {
    const fetchImpl = routeFetch(defaultRoutes());
    const result = await collectCursorEvents({ window: WINDOW, apiKey: "test-key", fetchImpl, now: NOW });
    assert.equal(result.stats.usageFeedRows, 0);
    assert.equal(result.stats.usageFeedError, null);
    assert.equal(result.usageEvents.length, 1);
    assert.equal(result.spendEvents.length, 1);
  });
});

describe("dry run", () => {
  it("makes no request to Usage Monitor and prints no key", async () => {
    const fetchImpl = routeFetch(defaultRoutes());
    const lines = [];
    let posted = 0;
    const result = await runCursorCollector({
      dryRun: true,
      window: WINDOW,
      now: NOW,
      apiKey: "super-secret-cursor-key",
      fetchImpl,
      post: async () => {
        posted += 1;
        return { received: 0, persisted: 0, rejected: 0 };
      },
      log: (message) => lines.push(message),
    });
    assert.equal(posted, 0);
    assert.equal(result.dryRun, true);
    const printed = lines.join("\n");
    assert.equal(printed.includes("super-secret-cursor-key"), false);
    assert.equal(printed.includes(USER_EMAIL), false);
    assert.equal(printed.includes(USER_ID), false);
    assert.equal(printed.includes("2133.62178"), false);
    assert.equal(printed.includes("55397.17694726"), false);
    assert.equal(printed.includes("claude-sonnet-4-5"), false);
    // Only the Cursor API was read: the daily feed, the per-event feed and
    // one request per closed month.
    const paths = fetchImpl.calls.map((call) => call.path).sort();
    assert.deepEqual(paths, [
      "/teams/daily-usage-data",
      "/teams/filtered-usage-events",
      "/teams/spend",
      "/teams/spend",
      "/teams/spend",
    ]);
    assert.equal(printed.includes("usage events: 1"), true);
    assert.equal(printed.includes("spend events: 1"), true);
  });
});
