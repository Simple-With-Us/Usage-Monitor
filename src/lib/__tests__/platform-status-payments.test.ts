import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above the imports, so the spy has to be hoisted too.
const { fetchJson } = vi.hoisted(() => ({ fetchJson: vi.fn() }));

vi.mock("@/lib/adapters/helpers", () => ({ fetchJson }));

import { PAYMENTS_PROBES } from "../platform-status/probes/payments";

const LIVE_KEY = "sk_live_FAKE";
const TEST_KEY = "sk_test_FAKE";

function stripeProbe() {
  const probe = PAYMENTS_PROBES.find((entry) => entry.id === "stripe");
  if (!probe) throw new Error("stripe probe missing from PAYMENTS_PROBES");
  return probe;
}

/**
 * Shape mirrors a real `GET /v1/account` body.  Nothing here is time-relative,
 * so no clock freeze is needed; add `vi.useFakeTimers()` if that ever changes.
 */
function accountBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "acct_1MFixture0000000",
    object: "account",
    business_profile: {
      mcc: "5817",
      name: "Congress.Trade",
      url: "https://congress.trade",
    },
    business_type: "company",
    capabilities: { card_payments: "active", transfers: "active" },
    charges_enabled: true,
    country: "US",
    created: 1_668_000_000,
    default_currency: "usd",
    details_submitted: true,
    payouts_enabled: true,
    requirements: {
      alternatives: [],
      current_deadline: null,
      currently_due: [],
      disabled_reason: null,
      errors: [],
      eventually_due: [],
      past_due: [],
      pending_verification: [],
    },
    settings: {
      dashboard: { display_name: "Congress.Trade", timezone: "US/Eastern" },
    },
    type: "standard",
    ...overrides,
  };
}

function okResponse(data: unknown) {
  return { ok: true, status: 200, data, headers: new Headers() };
}

function errorResponse(status: number, data: unknown = { error: { type: "invalid_request_error" } }) {
  return { ok: false, status, data, headers: new Headers() };
}

describe("platform status payments probes", () => {
  beforeEach(() => {
    fetchJson.mockReset();
    vi.unstubAllEnvs();
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("exposes exactly the Stripe payments probe", () => {
    expect(PAYMENTS_PROBES.map((probe) => probe.id)).toEqual(["stripe"]);
    expect(stripeProbe()).toMatchObject({
      name: "Stripe",
      category: "payments",
      requiredEnv: ["STRIPE_SECRET_KEY"],
      consoleUrl: "https://dashboard.stripe.com/",
    });
  });

  it("reports unconfigured without touching the network when no key is set", () => {
    expect(stripeProbe().isConfigured()).toBe(false);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("accepts either the canonical name or the legacy alias", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", LIVE_KEY);
    expect(stripeProbe().isConfigured()).toBe(true);

    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_API_KEY", LIVE_KEY);
    expect(stripeProbe().isConfigured()).toBe(true);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("renders a healthy card from a live-key account payload", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", LIVE_KEY);
    fetchJson.mockResolvedValue(okResponse(accountBody()));

    const result = await stripeProbe().probe();

    expect(result.state).toBe("healthy");
    expect(result.error).toBeUndefined();
    expect(result.headline).toBe("Live key is working.  Charges and payouts are enabled.");
    expect(result.metrics).toEqual([
      { label: "Key Mode", value: "Live" },
      { label: "Charges", value: "Enabled" },
      { label: "Payouts", value: "Enabled" },
      { label: "Onboarding", value: "Complete" },
      { label: "Requirements Due", value: "0 items" },
      { label: "Account", value: "Congress.Trade" },
    ]);
    expect(result.metrics.length).toBeLessThanOrEqual(6);

    const [url, init] = fetchJson.mock.calls[0];
    expect(url).toBe("https://api.stripe.com/v1/account");
    expect(init.headers.Authorization).toContain("Basic ");
  });

  it("reads the pre-2017 transfers_enabled name and stays healthy", async () => {
    // Regression for a live false alarm: a 2016-era account whose pinned API
    // version predates Stripe's 2017-04-06 rename answers with
    // `transfers_enabled` and NO `payouts_enabled` at all.  Reading only the
    // modern name scored a healthy, paying-out account as "cannot pay out".
    vi.stubEnv("STRIPE_SECRET_KEY", LIVE_KEY);
    const body = accountBody({ transfers_enabled: true });
    delete (body as Record<string, unknown>).payouts_enabled;
    fetchJson.mockResolvedValue(okResponse(body));

    const result = await stripeProbe().probe();

    expect(result.state).toBe("healthy");
    expect(result.error).toBeUndefined();
    const payouts = result.metrics.find((m) => m.label === "Payouts");
    expect(payouts?.value).toBe("Enabled");
  });

  it("reports payouts as not reported, without degrading, when neither field exists", async () => {
    // Absence of both names is not evidence of anything.  The card must say
    // so instead of inventing a disabled state.
    vi.stubEnv("STRIPE_SECRET_KEY", LIVE_KEY);
    const body = accountBody();
    delete (body as Record<string, unknown>).payouts_enabled;
    fetchJson.mockResolvedValue(okResponse(body));

    const result = await stripeProbe().probe();

    expect(result.state).toBe("healthy");
    expect(result.error).toBeUndefined();
    expect(result.headline).toBe("Live key is working.  Charges are enabled.");
    const payouts = result.metrics.find((m) => m.label === "Payouts");
    expect(payouts?.value).toBe("Not reported");
    expect(payouts?.hint).toBe("account API version predates the field");
  });

  it("still degrades when payouts_enabled is explicitly false", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", LIVE_KEY);
    fetchJson.mockResolvedValue(okResponse(accountBody({ payouts_enabled: false })));

    const result = await stripeProbe().probe();

    expect(result.state).toBe("degraded");
    expect(result.error).toBe("payouts_disabled");
  });

  it("never leaks the key into the rendered card", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", LIVE_KEY);
    fetchJson.mockResolvedValue(okResponse(accountBody()));

    const serialized = JSON.stringify(await stripeProbe().probe());

    expect(serialized).not.toContain(LIVE_KEY);
    expect(serialized).not.toContain("sk_live");
    expect(serialized).not.toContain("acct_1MFixture0000000");
  });

  it("flags a test key configured in production as degraded", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", TEST_KEY);
    fetchJson.mockResolvedValue(okResponse(accountBody()));

    const result = await stripeProbe().probe();

    expect(result.state).toBe("degraded");
    expect(result.error).toBe("test_key_in_production");
    expect(result.headline).toBe("A test key is configured in production.");
    expect(result.metrics[0]).toEqual({
      label: "Key Mode",
      value: "Test",
      hint: "test key in production",
    });
  });

  it("treats a test key outside production as healthy", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", TEST_KEY);
    fetchJson.mockResolvedValue(okResponse(accountBody()));

    const result = await stripeProbe().probe();

    expect(result.state).toBe("healthy");
    expect(result.headline).toBe("Test key is working.  Charges and payouts are enabled.");
  });

  it("degrades when charges are disabled and surfaces the outstanding requirements", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", LIVE_KEY);
    fetchJson.mockResolvedValue(
      okResponse(
        accountBody({
          charges_enabled: false,
          details_submitted: false,
          requirements: {
            currently_due: ["individual.verification.document", "tos_acceptance.date"],
            past_due: ["individual.verification.document"],
            disabled_reason: "requirements.past_due",
          },
        })
      )
    );

    const result = await stripeProbe().probe();

    expect(result.state).toBe("degraded");
    expect(result.error).toBe("charges_disabled");
    expect(result.headline).toBe(
      "The account cannot accept charges.  1 requirement is past due."
    );
    expect(result.metrics).toContainEqual({
      label: "Charges",
      value: "Disabled",
      hint: "reason: requirements.past_due",
    });
    expect(result.metrics).toContainEqual({
      label: "Requirements Due",
      value: "2 items",
      hint: "1 past due",
    });
    expect(result.metrics).toContainEqual({
      label: "Onboarding",
      value: "Details outstanding",
    });
  });

  it("maps a rejected key to unavailable with an unauthorized code", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", LIVE_KEY);
    fetchJson.mockResolvedValue(errorResponse(401));

    const result = await stripeProbe().probe();

    expect(result).toEqual({
      state: "unavailable",
      headline:
        "Stripe rejected the configured key.  Rotate it or restore its read permissions.",
      metrics: [],
      error: "unauthorized",
    });
  });

  it("maps rate limiting and server errors to degraded", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", LIVE_KEY);

    fetchJson.mockResolvedValue(errorResponse(429));
    await expect(stripeProbe().probe()).resolves.toMatchObject({
      state: "degraded",
      error: "rate_limited",
      headline: "Stripe rate limited the status check.  Try again shortly.",
    });

    fetchJson.mockResolvedValue(errorResponse(503));
    await expect(stripeProbe().probe()).resolves.toMatchObject({
      state: "degraded",
      error: "upstream_error",
      headline: "Stripe could not report account status.  The API answered with HTTP 503.",
    });
  });

  it("maps a transport failure to unreachable without throwing", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", LIVE_KEY);
    fetchJson.mockRejectedValue(new Error("Request to https://api.stripe.com failed: ECONNRESET"));

    await expect(stripeProbe().probe()).resolves.toEqual({
      state: "unreachable",
      headline: "Stripe did not answer the account status check.",
      metrics: [],
      error: "unreachable",
    });
  });

  it("maps a timeout to the timeout code", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", LIVE_KEY);
    fetchJson.mockRejectedValue(new Error("Request to https://api.stripe.com timed out after 8000ms"));

    await expect(stripeProbe().probe()).resolves.toMatchObject({
      state: "unreachable",
      error: "timeout",
    });
  });

  it("degrades rather than throwing when the payload is not an account object", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", LIVE_KEY);
    fetchJson.mockResolvedValue(okResponse("<html>maintenance</html>"));

    await expect(stripeProbe().probe()).resolves.toMatchObject({
      state: "degraded",
      error: "invalid_response",
    });
  });
});
