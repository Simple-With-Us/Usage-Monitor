/**
 * Payments platform probes.
 *
 * Stripe is the fleet's only payments dependency.  This card is deliberately a
 * status check rather than a revenue report: it proves the configured key still
 * authenticates and surfaces the handful of signals an owner would act on.  Can
 * the account take money, can it pay money out, and is the key in use a live key
 * or a test key.  Balances and processing fees stay on the provider pages.
 *
 * The key itself never leaves this module.  Live versus test is derived from the
 * key prefix, because Stripe's Account object carries no `livemode` field, and
 * only the three-value verdict is ever rendered.
 */

import {
  asArray,
  asRecord,
  envValue,
  failureResult,
  formatCount,
  hasEnv,
  metric,
  requestJson,
  upstreamFailure,
} from "../probe-helpers";
import type { PlatformMetric, PlatformProbe, PlatformProbeResult } from "../types";

/**
 * Canonical name first.  `STRIPE_API_KEY` is the legacy alias that
 * `infisical-provider-sync` already maps onto the same provider, so honour it
 * here rather than reporting a live integration as unconfigured.
 */
const STRIPE_ENV_NAMES = ["STRIPE_SECRET_KEY", "STRIPE_API_KEY"] as const;

const STRIPE_ACCOUNT_URL = "https://api.stripe.com/v1/account";
const STRIPE_DASHBOARD_URL = "https://dashboard.stripe.com/";

type StripeKeyMode = "live" | "test" | "unknown";

const MODE_VALUES: Record<StripeKeyMode, string> = {
  live: "Live",
  test: "Test",
  unknown: "Unknown",
};

const MODE_SUBJECTS: Record<StripeKeyMode, string> = {
  live: "Live key",
  test: "Test key",
  unknown: "Stripe key",
};

/**
 * Classify a secret key by prefix alone.  Standard secret keys are `sk_live_` /
 * `sk_test_`; restricted keys are `rk_live_` / `rk_test_`.  Anything else stays
 * "unknown" rather than being guessed at.
 */
function stripeKeyMode(key: string): StripeKeyMode {
  if (/^(?:sk|rk)_live_/.test(key)) return "live";
  if (/^(?:sk|rk)_test_/.test(key)) return "test";
  return "unknown";
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Stripe accepts the secret key as the HTTP Basic user with an empty password. */
function authorizationHeader(key: string): string {
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

function upstreamHeadline(status: number): string {
  if (status === 401 || status === 403) {
    return "Stripe rejected the configured key.  Rotate it or restore its read permissions.";
  }
  if (status === 429) {
    return "Stripe rate limited the status check.  Try again shortly.";
  }
  return `Stripe could not report account status.  The API answered with HTTP ${status}.`;
}

/**
 * Turn a `/v1/account` payload into a card.  Pure and non-throwing: every read
 * is defensive so a shape change downgrades the card instead of failing the
 * sweep.
 */
function renderAccount(data: unknown, mode: StripeKeyMode): PlatformProbeResult {
  const account = asRecord(data);
  if (!account) {
    return {
      state: "degraded",
      headline: "Stripe answered with an account payload this probe could not read.",
      metrics: [],
      error: "invalid_response",
    };
  }

  const chargesEnabled = account.charges_enabled === true;
  // Payouts is tri-state, and the field NAME depends on the account's pinned
  // API version: `payouts_enabled` today, `transfers_enabled` before Stripe's
  // 2017-04-06 rename — a 2016-era account answers with only the old name.
  // Reading just the modern name scored a healthy paying-out account as
  // "cannot pay out", a fabricated problem.  Absence of both names is
  // "unknown", never "disabled" — a missing field is not evidence.
  const payoutsFlag =
    typeof account.payouts_enabled === "boolean"
      ? account.payouts_enabled
      : typeof account.transfers_enabled === "boolean"
        ? account.transfers_enabled
        : null;
  const detailsSubmitted = account.details_submitted === true;

  const requirements = asRecord(account.requirements);
  const currentlyDue = asArray(requirements?.currently_due).length;
  const pastDue = asArray(requirements?.past_due).length;
  const disabledReason = nonEmptyString(requirements?.disabled_reason);

  // Public-facing merchant name only.  Never the account id, never the key.
  const displayName =
    nonEmptyString(asRecord(asRecord(account.settings)?.dashboard)?.display_name) ??
    nonEmptyString(asRecord(account.business_profile)?.name);

  // A test key in production means real money silently never moves, which is
  // worse than a loud failure.  Flag it.
  const testKeyInProduction = mode === "test" && process.env.NODE_ENV === "production";

  const metrics: PlatformMetric[] = [
    metric(
      "Key Mode",
      MODE_VALUES[mode],
      testKeyInProduction ? "test key in production" : undefined
    ),
    metric(
      "Charges",
      chargesEnabled ? "Enabled" : "Disabled",
      !chargesEnabled && disabledReason ? `reason: ${disabledReason}` : undefined
    ),
    metric(
      "Payouts",
      payoutsFlag === null ? "Not reported" : payoutsFlag ? "Enabled" : "Disabled",
      payoutsFlag === null ? "account API version predates the field" : undefined
    ),
    metric("Onboarding", detailsSubmitted ? "Complete" : "Details outstanding"),
    metric(
      "Requirements Due",
      formatCount(currentlyDue, "item"),
      pastDue > 0 ? `${pastDue} past due` : undefined
    ),
  ];
  if (displayName) metrics.push(metric("Account", displayName));

  const problems: Array<{ code: string; text: string }> = [];
  if (testKeyInProduction) {
    problems.push({
      code: "test_key_in_production",
      text: "A test key is configured in production.",
    });
  }
  if (!chargesEnabled) {
    problems.push({ code: "charges_disabled", text: "The account cannot accept charges." });
  }
  if (payoutsFlag === false) {
    problems.push({ code: "payouts_disabled", text: "The account cannot pay out." });
  }
  if (pastDue > 0) {
    problems.push({
      code: "requirements_past_due",
      text: `${formatCount(pastDue, "requirement")} ${pastDue === 1 ? "is" : "are"} past due.`,
    });
  }

  if (problems.length === 0) {
    return {
      state: "healthy",
      headline:
        payoutsFlag === null
          ? `${MODE_SUBJECTS[mode]} is working.  Charges are enabled.`
          : `${MODE_SUBJECTS[mode]} is working.  Charges and payouts are enabled.`,
      metrics,
    };
  }

  return {
    state: "degraded",
    headline: problems
      .slice(0, 2)
      .map((problem) => problem.text)
      .join("  "),
    metrics,
    error: problems[0].code,
  };
}

async function probeStripe(): Promise<PlatformProbeResult> {
  const key = envValue(...STRIPE_ENV_NAMES);
  if (key === null) {
    // `isConfigured()` gates this call, so only an env unset between the gate
    // and the fetch can land here.
    return {
      state: "unavailable",
      headline: "Stripe key is no longer readable.",
      metrics: [],
      error: "unauthorized",
    };
  }

  const mode = stripeKeyMode(key);

  try {
    const response = await requestJson(STRIPE_ACCOUNT_URL, {
      headers: { Authorization: authorizationHeader(key) },
    });
    if (!response.ok) return upstreamFailure(response.status, upstreamHeadline(response.status));
    return renderAccount(response.data, mode);
  } catch (error) {
    return failureResult(error, "Stripe did not answer the account status check.");
  }
}

export const PAYMENTS_PROBES: readonly PlatformProbe[] = [
  {
    id: "stripe",
    name: "Stripe",
    category: "payments",
    requiredEnv: ["STRIPE_SECRET_KEY"],
    consoleUrl: STRIPE_DASHBOARD_URL,
    isConfigured: () => hasEnv(...STRIPE_ENV_NAMES),
    probe: probeStripe,
  },
];
