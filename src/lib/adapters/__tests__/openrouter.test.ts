import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "../openrouter";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MANAGEMENT_KEY_INFO = {
  data: {
    label: "sk-or-v1-9f2...c31",
    limit: null,
    limit_reset: null,
    limit_remaining: null,
    include_byok_in_limit: false,
    usage: 0,
    usage_daily: 0,
    usage_weekly: 0,
    usage_monthly: 0,
    is_free_tier: false,
    is_management_key: true,
    is_provisioning_key: true,
    creator_user_id: "user_owner",
    expires_at: null,
  },
};

const STANDARD_KEY_INFO = {
  data: {
    label: "sk-or-v1-au7...890",
    limit: 100,
    limit_reset: "monthly",
    limit_remaining: 74.5,
    include_byok_in_limit: false,
    usage: 25.5,
    usage_daily: 25.5,
    usage_weekly: 25.5,
    usage_monthly: 25.5,
    is_free_tier: false,
    is_management_key: false,
    is_provisioning_key: false,
    creator_user_id: "user_2dHFtVWx2n56w6HkM0000000000",
    expires_at: "2027-12-31T23:59:59Z",
  },
};

const CREDITS_OK = { data: { total_credits: 250.0, total_usage: 187.42 } };

const KEYS_OK = {
  data: [
    {
      hash: "aaa...111",
      label: "sk-or-v1-9f2...c31",
      name: "Owner console key",
      disabled: false,
      limit: null,
      limit_remaining: null,
      limit_reset: null,
      usage: 12.4,
      workspace_id: "default-ws-uuid",
    },
    {
      hash: "bbb...222",
      label: "sk-or-v1-0e6...1c96",
      name: "Socratic.Trade inference key",
      disabled: false,
      limit: 50,
      limit_remaining: 41.3,
      limit_reset: "monthly",
      usage: 88.7,
      workspace_id: "default-ws-uuid",
    },
    {
      hash: "ccc...333",
      label: "sk-or-v1-au7...890",
      name: "Congress.Trade inference key",
      disabled: false,
      limit: 50,
      limit_remaining: 3.15,
      limit_reset: "monthly",
      usage: 210.55,
      workspace_id: "default-ws-uuid",
    },
  ],
};

const ACTIVITY_OK = {
  data: [
    {
      date: "2026-07-15",
      model: "anthropic/claude-sonnet-5",
      requests: 42,
      usage: 3.71,
    },
    {
      date: "2026-07-14",
      model: "openai/gpt-5.2",
      requests: 19,
      usage: 1.98,
    },
  ],
};

const FORBIDDEN_MANAGEMENT_ONLY = {
  error: { code: 403, message: "Only management keys can perform this operation" },
};

describe("OpenRouter usage adapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads account credits, per-key breakdown, and calendar-MTD activity for a management key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(MANAGEMENT_KEY_INFO))
      .mockResolvedValueOnce(json(CREDITS_OK))
      .mockResolvedValueOnce(json(KEYS_OK))
      .mockResolvedValueOnce(json(ACTIVITY_OK));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("management-key");

    expect(result.balance).toBeCloseTo(62.58, 5);
    expect(result.credits).toBe(250);
    expect(result.totalCost).toBeCloseTo(5.69, 5);
    expect(result.totalRequests).toBe(61);
    expect(result.costScope).toBe("calendar_month_to_date");

    const rawData = result.rawData as Record<string, unknown>;
    const keys = rawData.keys as Array<Record<string, unknown>>;
    expect(keys).toHaveLength(3);
    expect(keys[1]).toMatchObject({
      name: "Socratic.Trade inference key",
      label: "sk-or-v1-0e6...1c96",
      hash: "bbb...222",
      usageUsd: 88.7,
      limitUsd: 50,
      limitRemainingUsd: 41.3,
    });

    const capabilities = rawData.capabilities as Record<string, unknown>;
    expect(capabilities).toMatchObject({
      managementKeyConfirmed: true,
      accountCreditsAvailable: true,
      perKeyBreakdownAvailable: true,
      activityAvailable: true,
    });

    expect(result.externalBilling).toMatchObject({
      source: "openrouter-credits",
      authoritative: true,
      records: [
        expect.objectContaining({
          kind: "account",
          remainingQuantity: expect.closeTo(62.58, 5),
          usageUnit: "USD credits",
          rollupRole: "metadata",
        }),
      ],
    });

    expect(fetchMock.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/key");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer management-key");
  });

  it("degrades gracefully to per-key info for a standard inference key without erroring", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(STANDARD_KEY_INFO));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("inference-key");

    expect(result.balance).toBeNull();
    expect(result.credits).toBeNull();
    expect(result.totalCost).toBeNull();
    expect(result.costScope).toBe("unknown");

    const rawData = result.rawData as Record<string, unknown>;
    const keyInfo = rawData.keyInfo as Record<string, unknown>;
    expect(keyInfo).toMatchObject({
      limitUsd: 100,
      limitRemainingUsd: 74.5,
      usageUsd: 25.5,
    });
    const capabilities = rawData.capabilities as Record<string, unknown>;
    expect(capabilities).toMatchObject({ managementKeyConfirmed: false });
    expect(rawData.note).toMatch(/Management \(Provisioning\) API key/i);

    // Only /key should ever be called for a standard key - the account-wide
    // endpoints are never attempted since they would just 403.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the credit balance null but still derives cost when /credits 403s despite a management key", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(MANAGEMENT_KEY_INFO))
      .mockResolvedValueOnce(json(FORBIDDEN_MANAGEMENT_ONLY, 403))
      .mockResolvedValueOnce(json(KEYS_OK))
      .mockResolvedValueOnce(json(ACTIVITY_OK));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("management-key");

    expect(result.balance).toBeNull();
    expect(result.credits).toBeNull();
    expect(result.totalCost).toBeCloseTo(5.69, 5);
    expect(result.externalBilling).toBeUndefined();

    const rawData = result.rawData as Record<string, unknown>;
    expect(rawData.credits).toMatchObject({ available: false, status: 403 });
    const capabilities = rawData.capabilities as Record<string, unknown>;
    expect(capabilities).toMatchObject({ accountCreditsAvailable: false, perKeyBreakdownAvailable: true });
  });

  it("throws a retryable-aware AdapterError when /key itself is unauthorized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(json({ error: { code: 401, message: "Missing Authentication header" } }, 401))
    );

    await expect(fetchUsage("bad-key")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 401,
      retryable: false,
    });
  });

  it("fails closed when all three management-only endpoints fail", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(MANAGEMENT_KEY_INFO))
      .mockResolvedValueOnce(json(FORBIDDEN_MANAGEMENT_ONLY, 403))
      .mockResolvedValueOnce(json(FORBIDDEN_MANAGEMENT_ONLY, 403))
      .mockResolvedValueOnce(json(FORBIDDEN_MANAGEMENT_ONLY, 403));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchUsage("management-key")).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 403,
      retryable: false,
    });
  });

  it("tolerates absurd/missing fields without throwing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(MANAGEMENT_KEY_INFO))
      .mockResolvedValueOnce(json({ data: { total_credits: "not-a-number" } }))
      .mockResolvedValueOnce(json({ data: [{ hash: 12345, name: null, usage: "??" }] }))
      .mockResolvedValueOnce(json({ data: [{ date: "2026-07-10" }, { not: "a row" }, null] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("management-key");

    expect(result.balance).toBeNull();
    expect(result.credits).toBeNull();
    // No usage field on the only well-formed activity row, so MTD sums to 0
    // rather than null - the window is present and safe, just empty.
    expect(result.totalCost).toBe(0);
    expect(result.totalRequests).toBe(0);

    const rawData = result.rawData as Record<string, unknown>;
    const keys = rawData.keys as Array<Record<string, unknown>>;
    expect(keys[0]).toMatchObject({ hash: null, name: null, usageUsd: null });
  });

  it("withholds totalCost on day 31 of a 31-day month while keeping the raw sum as a diagnostic", async () => {
    vi.setSystemTime(new Date("2026-07-31T12:00:00Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(MANAGEMENT_KEY_INFO))
      .mockResolvedValueOnce(json(CREDITS_OK))
      .mockResolvedValueOnce(json(KEYS_OK))
      .mockResolvedValueOnce(json(ACTIVITY_OK));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchUsage("management-key");

    expect(result.totalCost).toBeNull();
    expect(result.costScope).toBe("unknown");

    const rawData = result.rawData as Record<string, unknown>;
    const activity = rawData.activity as Record<string, unknown>;
    expect(activity.monthToDateSafe).toBe(false);
    expect(activity.monthToDateUsd).toBeCloseTo(5.69, 5);
  });
});
