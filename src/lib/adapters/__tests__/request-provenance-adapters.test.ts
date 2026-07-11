import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchJson = vi.hoisted(() => vi.fn());

vi.mock("../helpers", async () => {
  const actual = await vi.importActual<typeof import("../helpers")>("../helpers");
  return { ...actual, fetchJson };
});

import { fetchUsage as fetchCustom } from "../custom";
import { fetchUsage as fetchLangfuse } from "../langfuse";
import { fetchUsage as fetchTradier } from "../tradier";

describe("request provenance for remaining request-emitting adapters", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T17:00:00.000Z"));
    fetchJson.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks Langfuse observations as a rolling 31-day count", async () => {
    fetchJson.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        data: [
          { countObservations: 12, totalCost: 1.5 },
          { countObservations: 8, totalCost: 2.5 },
        ],
      },
      headers: new Headers(),
    });

    const result = await fetchLangfuse("public-key", {
      secretKey: "secret-key",
    });

    expect(result.totalRequests).toBe(20);
    expect(result.requestUnit).toBe("observations");
    expect(result.requestWindow).toBe("rolling_31_days");
    expect(new Date(result.requestWindowStart!).toISOString()).toBe(
      "2026-06-10T17:00:00.000Z"
    );
    expect(new Date(result.requestWindowEnd!).toISOString()).toBe(
      "2026-07-11T17:00:00.000Z"
    );
  });

  it("marks Tradier header usage as a per-minute count with reset bounds", async () => {
    fetchJson.mockResolvedValue({
      ok: true,
      status: 200,
      data: { balances: { total_equity: 1_000 } },
      headers: new Headers({
        "x-ratelimit-allowed": "120",
        "x-ratelimit-used": "37",
        "x-ratelimit-available": "83",
        "x-ratelimit-expiry": "2026-07-11T17:01:00.000Z",
      }),
    });

    const result = await fetchTradier("token", { accountId: "account-1" });

    expect(result.totalRequests).toBe(37);
    expect(result.requestUnit).toBe("requests");
    expect(result.requestWindow).toBe("minute");
    expect(new Date(result.requestWindowStart!).toISOString()).toBe(
      "2026-07-11T17:00:00.000Z"
    );
    expect(new Date(result.requestWindowEnd!).toISOString()).toBe(
      "2026-07-11T17:01:00.000Z"
    );
  });

  it("defaults custom counts to unknown and supports declared monthly provenance", async () => {
    fetchJson.mockResolvedValue({
      ok: true,
      status: 200,
      data: { requests: 750 },
      headers: new Headers(),
    });

    const unknown = await fetchCustom("token", {
      endpoint: "https://collector.example/usage",
    });
    expect(unknown).toMatchObject({
      totalRequests: 750,
      requestUnit: "requests",
      requestWindow: "unknown",
      requestWindowStart: null,
      requestWindowEnd: null,
    });

    const monthly = await fetchCustom("token", {
      endpoint: "https://collector.example/usage",
      requestUnit: "jobs",
      requestWindow: "month",
    });
    expect(monthly.totalRequests).toBe(750);
    expect(monthly.requestUnit).toBe("jobs");
    expect(monthly.requestWindow).toBe("calendar_month_to_date");
    expect(new Date(monthly.requestWindowStart!).toISOString()).toBe(
      "2026-07-01T00:00:00.000Z"
    );
    expect(new Date(monthly.requestWindowEnd!).toISOString()).toBe(
      "2026-07-11T17:00:00.000Z"
    );
  });
});
