/**
 * Messaging & delivery probes — the channels the fleet uses to reach humans.
 *
 * Every card here answers one operator question: "if something breaks tonight,
 * can this channel still tell me?"  So the states lean on delivery readiness
 * rather than raw reachability — an unverified Resend domain or an exhausted
 * Pushover quota is a real outage even though every request returned 200.
 *
 * Credentials are read from env and used only as request auth.  Nothing that
 * leaves this module contains a token, and no raw upstream payload is passed
 * through: every value is a rendered display string.
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

// ---------------------------------------------------------------------------
// Local formatting helpers.
// ---------------------------------------------------------------------------

/**
 * Join sentences with the fleet's two-space gap.  Headlines are assembled here
 * rather than by hand so the spacing rule cannot drift per probe.
 */
function sentences(...parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0)
    .join("  ");
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Numbers arrive as JSON numbers from some upstreams and strings from others. */
function numberFrom(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b[a-z]/g, (character) => character.toUpperCase());
}

function money(amount: number, currency: string | null): string {
  const rendered = amount.toFixed(2);
  const code = currency?.trim().toUpperCase();
  return !code || code === "USD" ? `$${rendered}` : `${rendered} ${code}`;
}

function wholeNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** UTC calendar day for a quota reset.  Never relative — no wall-clock drift. */
function utcDay(epochSeconds: number | null): string | null {
  if (epochSeconds === null || !Number.isFinite(epochSeconds)) return null;
  const parsed = new Date(epochSeconds * 1000);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/**
 * Reduce an upstream-supplied error string to a short, safe slug.  Upstream
 * text is never rendered verbatim.
 */
function errorSlug(value: unknown, fallback: string): string {
  const raw = text(value);
  if (!raw) return fallback;
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : fallback;
}

// ---------------------------------------------------------------------------
// Twilio — SMS and voice.
// ---------------------------------------------------------------------------

/** Below this the prepaid balance is close enough to zero to act on. */
const TWILIO_LOW_BALANCE_USD = 5;

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function probeTwilio(): Promise<PlatformProbeResult> {
  const accountSid = envValue("TWILIO_ACCOUNT_SID");
  const authToken = envValue("TWILIO_AUTH_TOKEN");
  if (!accountSid || !authToken) {
    return {
      state: "unavailable",
      headline: sentences(
        "Twilio credentials are incomplete.",
        "Set both the account SID and the auth token."
      ),
      metrics: [],
      error: "unauthorized",
    };
  }

  const headers = {
    Authorization: basicAuth(accountSid, authToken),
    Accept: "application/json",
  };
  const base = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}`;

  try {
    // Settled rather than all: a transport failure on the balance call alone
    // must not decide the whole card.  The account call still decides
    // reachability, so a rejection there keeps the existing unreachable path.
    const [accountSettled, balanceSettled] = await Promise.allSettled([
      requestJson(`${base}.json`, { headers }),
      requestJson(`${base}/Balance.json`, { headers }),
    ]);
    if (accountSettled.status === "rejected") throw accountSettled.reason;
    const account = accountSettled.value;

    if (!account.ok) {
      return upstreamFailure(account.status, "Twilio rejected the account lookup.");
    }

    // A failed balance request is not the same fact as "this account has no
    // balance".  Keeping the two apart is what stops depleted prepaid credit
    // from rendering green.
    const balance = balanceSettled.status === "fulfilled" ? balanceSettled.value : null;
    const balanceReadable = balance?.ok === true;

    const accountRecord = asRecord(account.data);
    const status = text(accountRecord?.status);
    const accountType = text(accountRecord?.type);
    const balanceRecord = balance?.ok ? asRecord(balance.data) : undefined;
    const balanceAmount = numberFrom(balanceRecord?.balance);
    const currency = text(balanceRecord?.currency);

    const metrics: PlatformMetric[] = [
      metric("Account Status", status ? titleCase(status) : "Unknown"),
      metric("Account Type", accountType ? titleCase(accountType) : "Unknown"),
      metric(
        "Balance",
        balanceAmount === null ? "Unavailable" : money(balanceAmount, currency),
        balanceReadable ? undefined : "balance lookup failed"
      ),
    ];

    if (status !== null && status.toLowerCase() !== "active") {
      return {
        state: "degraded",
        headline: sentences(
          `Twilio reports account status ${status.toLowerCase()}.`,
          "Messages will not send until the account is restored."
        ),
        metrics,
        error: "account_not_active",
      };
    }

    // Reported after the account check so a suspended account keeps the more
    // urgent headline, and before the healthy return so a card can never claim
    // "no balance reported" on the strength of a request that never answered.
    if (!balanceReadable) {
      return {
        state: "degraded",
        headline: sentences(
          "Twilio is active.",
          "The balance could not be read, so a low prepaid balance would go unnoticed."
        ),
        metrics,
        error: "balance_unavailable",
      };
    }

    if (balanceAmount !== null && balanceAmount < TWILIO_LOW_BALANCE_USD) {
      return {
        state: "degraded",
        headline: sentences(
          "Twilio is active.",
          `Balance is ${money(balanceAmount, currency)}, below the ${money(
            TWILIO_LOW_BALANCE_USD,
            currency
          )} top-up line.`
        ),
        metrics,
        error: "low_balance",
      };
    }

    return {
      state: "healthy",
      headline: sentences(
        "Twilio is active.",
        balanceAmount === null
          ? "Balance is not reported for this account."
          : `Balance is ${money(balanceAmount, currency)}.`
      ),
      metrics,
    };
  } catch (error) {
    return failureResult(error, "Twilio did not answer the status check.");
  }
}

// ---------------------------------------------------------------------------
// SendGrid — transactional email.
// ---------------------------------------------------------------------------

/** Under this share of the monthly allowance, headroom is worth acting on. */
const SENDGRID_LOW_CREDIT_RATIO = 0.1;

async function probeSendGrid(): Promise<PlatformProbeResult> {
  const apiKey = envValue("SENDGRID_API_KEY");
  if (!apiKey) {
    return {
      state: "unavailable",
      headline: "SendGrid has no API key configured.",
      metrics: [],
      error: "unauthorized",
    };
  }

  try {
    // The cheapest call that both proves the key and shows send headroom.
    const response = await requestJson("https://api.sendgrid.com/v3/user/credits", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });

    if (!response.ok) {
      return upstreamFailure(response.status, "SendGrid rejected the credits lookup.");
    }

    const record = asRecord(response.data);
    const remaining = numberFrom(record?.remain);
    const total = numberFrom(record?.total);
    const overage = numberFrom(record?.overage);
    const nextReset = text(record?.next_reset);
    const frequency = text(record?.reset_frequency);

    const metrics: PlatformMetric[] = [
      metric("Credits Remaining", remaining === null ? "Unavailable" : wholeNumber(remaining)),
      metric(
        "Monthly Allowance",
        total === null ? "Unavailable" : wholeNumber(total),
        frequency ? `${frequency} reset` : undefined
      ),
      metric("Overage", overage === null ? "Unavailable" : wholeNumber(overage)),
      metric("Next Reset", nextReset ?? "Unknown"),
    ];

    if (remaining !== null && remaining <= 0) {
      return {
        state: "degraded",
        headline: sentences(
          "SendGrid accepted the API key.",
          "The send allowance is exhausted, so new mail will bounce."
        ),
        metrics,
        error: "quota_exhausted",
      };
    }

    if (
      remaining !== null &&
      total !== null &&
      total > 0 &&
      remaining / total < SENDGRID_LOW_CREDIT_RATIO
    ) {
      return {
        state: "degraded",
        headline: sentences(
          "SendGrid accepted the API key.",
          `Only ${wholeNumber(remaining)} of ${wholeNumber(total)} credits remain this cycle.`
        ),
        metrics,
        error: "quota_low",
      };
    }

    return {
      state: "healthy",
      headline: sentences(
        "SendGrid accepted the API key.",
        remaining === null
          ? "Send allowance is not reported for this plan."
          : `${formatCount(remaining, "credit")} remaining this cycle.`
      ),
      metrics,
    };
  } catch (error) {
    return failureResult(error, "SendGrid did not answer the status check.");
  }
}

// ---------------------------------------------------------------------------
// Resend — transactional email with per-domain verification.
// ---------------------------------------------------------------------------

const RESEND_VERIFIED_STATUS = "verified";

async function probeResend(): Promise<PlatformProbeResult> {
  const apiKey = envValue("RESEND_API_KEY");
  if (!apiKey) {
    return {
      state: "unavailable",
      headline: "Resend has no API key configured.",
      metrics: [],
      error: "unauthorized",
    };
  }

  try {
    const response = await requestJson("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });

    if (!response.ok) {
      return upstreamFailure(response.status, "Resend rejected the domain lookup.");
    }

    const body = asRecord(response.data);
    const rows = asArray(body?.data ?? response.data)
      .map((row) => asRecord(row))
      .filter((row): row is Record<string, unknown> => row !== undefined);

    const domains = rows.map((row) => ({
      name: text(row.name) ?? "unnamed domain",
      status: (text(row.status) ?? "unknown").toLowerCase(),
    }));
    const verified = domains.filter((domain) => domain.status === RESEND_VERIFIED_STATUS);
    const unverified = domains.filter((domain) => domain.status !== RESEND_VERIFIED_STATUS);

    const metrics: PlatformMetric[] = [
      metric("Sending Domains", formatCount(domains.length, "domain")),
      metric("Verified", `${verified.length} of ${domains.length}`),
    ];
    if (unverified.length > 0) {
      metrics.push(
        metric("Needs Verification", unverified.map((domain) => domain.name).join(", ")),
        metric("Verification State", titleCase(unverified[0].status), "first blocked domain")
      );
    }

    if (domains.length === 0) {
      return {
        state: "degraded",
        headline: sentences(
          "Resend accepted the API key.",
          "No sending domain is configured, so mail cannot go out."
        ),
        metrics,
        error: "no_sending_domain",
      };
    }

    if (unverified.length > 0) {
      return {
        state: "degraded",
        headline: sentences(
          `Resend has ${formatCount(unverified.length, "unverified sending domain")}.`,
          "Mail from those domains will not deliver."
        ),
        metrics,
        error: "domain_unverified",
      };
    }

    return {
      state: "healthy",
      headline: sentences(
        "Resend accepted the API key.",
        `All ${formatCount(domains.length, "sending domain")} verified.`
      ),
      metrics,
    };
  } catch (error) {
    return failureResult(error, "Resend did not answer the status check.");
  }
}

// ---------------------------------------------------------------------------
// Slack — bot token identity.
// ---------------------------------------------------------------------------

/** Slack body errors that mean the credential itself is dead. */
const SLACK_CREDENTIAL_ERRORS = new Set([
  "account_inactive",
  "invalid_auth",
  "invalid_token",
  "not_authed",
  "token_expired",
  "token_revoked",
]);

/**
 * Slack issues several OAuth token prefixes and only `xoxb-` (Bot User OAuth
 * Token) works with `auth.test` the way this probe expects.  Pasting a User
 * OAuth token (`xoxp-`) or a legacy workspace token (`xoxa-`/`xoxr-`) into
 * `SLACK_BOT_TOKEN` is a common agent mistake, and Slack's own error body
 * (`invalid_auth`) does not distinguish "wrong token type" from "revoked
 * token" — so a credentialDead card gave no hint which one it was.  This
 * checks only the token's own prefix, never Slack's response, and returns a
 * label, never the token itself.
 */
const SLACK_TOKEN_TYPE_LABELS: Readonly<Record<string, string>> = {
  xoxb: "Bot User OAuth Token",
  xoxp: "User OAuth Token",
  xoxa: "legacy workspace app token",
  xoxr: "legacy refresh token",
  xoxe: "app-level token exchange token",
  xapp: "app-level token",
};

function slackTokenTypeLabel(token: string): string {
  const prefixMatch = /^(xox[a-z]|xapp)-/.exec(token);
  const prefix = prefixMatch?.[1];
  return (prefix && SLACK_TOKEN_TYPE_LABELS[prefix]) || "an unrecognized token format";
}

async function probeSlack(): Promise<PlatformProbeResult> {
  const botToken = envValue("SLACK_BOT_TOKEN");
  if (!botToken) {
    return {
      state: "unavailable",
      headline: "Slack has no bot token configured.",
      metrics: [],
      error: "unauthorized",
    };
  }

  try {
    const response = await requestJson("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${botToken}`, Accept: "application/json" },
    });

    if (!response.ok) {
      return upstreamFailure(response.status, "Slack rejected the auth check.");
    }

    // Slack answers HTTP 200 even for a dead token, so the body decides.
    const record = asRecord(response.data);
    if (record?.ok !== true) {
      const slug = errorSlug(record?.error, "invalid_response");
      const credentialDead = SLACK_CREDENTIAL_ERRORS.has(slug);
      // Only worth naming the token type when the credential itself is dead
      // and it is not already a bot token — a live xoxb- that Slack still
      // rejects is a revoked/expired token, not a type mismatch, so the hint
      // would be noise there.
      const tokenTypeLabel = credentialDead ? slackTokenTypeLabel(botToken) : null;
      const wrongTokenType = tokenTypeLabel !== null && !botToken.startsWith("xoxb-");
      return {
        state: credentialDead ? "unavailable" : "degraded",
        headline: sentences(
          credentialDead ? "Slack rejected the bot token." : "Slack refused the auth check.",
          `The API returned ${slug}.`,
          wrongTokenType
            ? `SLACK_BOT_TOKEN looks like ${tokenTypeLabel}, not a Bot User OAuth Token (xoxb-) — replace it with the token from Slack app → OAuth & Permissions → Bot User OAuth Token.`
            : null
        ),
        metrics: wrongTokenType ? [metric("Configured Token Type", tokenTypeLabel ?? "Unknown")] : [],
        error: credentialDead
          ? wrongTokenType
            ? "wrong_token_type"
            : "unauthorized"
          : slug === "ratelimited"
            ? "rate_limited"
            : `slack_${slug}`,
      };
    }

    const team = text(record.team);
    const teamId = text(record.team_id);
    const identity = text(record.user);

    return {
      state: "healthy",
      headline: sentences(
        team ? `Slack bot token is valid for ${team}.` : "Slack bot token is valid.",
        identity ? `Posting as ${identity}.` : null
      ),
      metrics: [
        metric("Workspace", team ?? "Unknown"),
        metric("Workspace ID", teamId ?? "Unknown"),
        metric("Bot Identity", identity ?? "Unknown"),
      ],
    };
  } catch (error) {
    return failureResult(error, "Slack did not answer the auth check.");
  }
}

// ---------------------------------------------------------------------------
// Pushover — per-app push quotas.
// ---------------------------------------------------------------------------

/** Under this share of the monthly message quota, start rationing. */
const PUSHOVER_LOW_QUOTA_RATIO = 0.1;

/**
 * One Pushover application per fleet app.  Env fallbacks mirror
 * `resolveSubjectPushoverAppToken` in `r2-usage.ts` so both surfaces agree on
 * which token belongs to which logo.
 */
const PUSHOVER_APPS: ReadonlyArray<{ label: string; envNames: string[] }> = [
  {
    label: "Usage Monitor",
    envNames: [
      "PUSHOVER_USAGE_API_TOKEN",
      "PUSHOVER_UM_API_TOKEN",
      "PUSHOVER_API_TOKEN",
      "PUSHOVER_APP_TOKEN",
    ],
  },
  { label: "Socratic Trade", envNames: ["PUSHOVER_ST_API_TOKEN"] },
  { label: "Congress Trade", envNames: ["PUSHOVER_CT_API_TOKEN"] },
];

const PUSHOVER_APP_ENV_NAMES = PUSHOVER_APPS.flatMap((app) => app.envNames);

/** Distinct configured application tokens, in fleet display order. */
function resolvePushoverApps(): Array<{ label: string; token: string }> {
  const seen = new Set<string>();
  const apps: Array<{ label: string; token: string }> = [];
  for (const app of PUSHOVER_APPS) {
    const token = envValue(...app.envNames);
    if (token === null || seen.has(token)) continue;
    seen.add(token);
    apps.push({ label: app.label, token });
  }
  return apps;
}

async function probePushover(): Promise<PlatformProbeResult> {
  const apps = resolvePushoverApps();
  if (apps.length === 0) {
    return {
      state: "unavailable",
      headline: "Pushover has no application token configured.",
      metrics: [],
      error: "unauthorized",
    };
  }
  const userKey = envValue("PUSHOVER_USER_KEY");

  try {
    const responses = await Promise.all(
      apps.map(async (app) => ({
        app,
        // The token is a query parameter here by Pushover's design.  The
        // adapter stack redacts query strings from any error it raises, so it
        // cannot reach a log or a card.
        response: await requestJson(
          `https://api.pushover.net/1/apps/limits.json?token=${encodeURIComponent(app.token)}`
        ),
      }))
    );

    const quotas: Array<{
      label: string;
      limit: number | null;
      remaining: number | null;
      reset: number | null;
    }> = [];
    let rejected = 0;
    let firstFailureStatus: number | null = null;

    for (const { app, response } of responses) {
      const record = asRecord(response.data);
      // Pushover signals application-level failure with status !== 1.
      if (!response.ok || numberFrom(record?.status) !== 1) {
        rejected += 1;
        if (firstFailureStatus === null) {
          firstFailureStatus = response.ok ? 400 : response.status;
        }
        continue;
      }
      quotas.push({
        label: app.label,
        limit: numberFrom(record?.limit),
        remaining: numberFrom(record?.remaining),
        reset: numberFrom(record?.reset),
      });
    }

    if (quotas.length === 0) {
      return upstreamFailure(
        firstFailureStatus ?? 500,
        "Pushover rejected every application token."
      );
    }

    const metrics: PlatformMetric[] = quotas.map((quota) =>
      metric(
        `${quota.label} Quota`,
        quota.remaining === null ? "Unavailable" : formatCount(quota.remaining, "message"),
        quota.limit === null ? undefined : `of ${wholeNumber(quota.limit)}`
      )
    );
    const resetDay = utcDay(
      quotas.map((quota) => quota.reset).find((reset) => reset !== null) ?? null
    );
    metrics.push(metric("Quota Resets", resetDay ?? "Unknown", "UTC"));
    metrics.push(metric("User Key", userKey === null ? "Missing" : "Set"));
    if (rejected > 0) metrics.push(metric("Rejected Tokens", formatCount(rejected, "app")));

    if (rejected > 0) {
      return {
        state: "degraded",
        headline: sentences(
          `Pushover rejected ${formatCount(rejected, "application token")}.`,
          "Alerts for those apps will not arrive."
        ),
        metrics,
        error: "token_rejected",
      };
    }

    if (userKey === null) {
      return {
        state: "degraded",
        headline: sentences(
          "Pushover application tokens are valid.",
          "PUSHOVER_USER_KEY is missing, so no alert can be delivered."
        ),
        metrics,
        error: "missing_user_key",
      };
    }

    const measured = quotas
      .flatMap((quota) =>
        quota.remaining !== null && quota.limit !== null && quota.limit > 0
          ? [{ label: quota.label, remaining: quota.remaining, limit: quota.limit }]
          : []
      )
      .sort((a, b) => a.remaining / a.limit - b.remaining / b.limit);
    const lowest = measured[0];

    if (lowest && lowest.remaining / lowest.limit < PUSHOVER_LOW_QUOTA_RATIO) {
      return {
        state: "degraded",
        headline: sentences(
          "Pushover monthly quota is running low.",
          `${lowest.label} has ${wholeNumber(lowest.remaining)} of ${wholeNumber(
            lowest.limit
          )} messages left.`
        ),
        metrics,
        error: "quota_low",
      };
    }

    return {
      state: "healthy",
      headline: sentences(
        `Pushover accepted ${formatCount(quotas.length, "application token")}.`,
        lowest ? `Lowest remaining quota is ${wholeNumber(lowest.remaining)} messages.` : null
      ),
      metrics,
    };
  } catch (error) {
    return failureResult(error, "Pushover did not answer the quota check.");
  }
}

// ---------------------------------------------------------------------------
// Registry entries.
// ---------------------------------------------------------------------------

export const MESSAGING_PROBES: readonly PlatformProbe[] = [
  {
    id: "twilio",
    name: "Twilio",
    category: "messaging",
    requiredEnv: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
    consoleUrl: "https://console.twilio.com",
    isConfigured: () => hasEnv("TWILIO_ACCOUNT_SID") && hasEnv("TWILIO_AUTH_TOKEN"),
    probe: probeTwilio,
  },
  {
    id: "sendgrid",
    name: "SendGrid",
    category: "messaging",
    requiredEnv: ["SENDGRID_API_KEY"],
    consoleUrl: "https://app.sendgrid.com/settings/billing",
    isConfigured: () => hasEnv("SENDGRID_API_KEY"),
    probe: probeSendGrid,
  },
  {
    id: "resend",
    name: "Resend",
    category: "messaging",
    requiredEnv: ["RESEND_API_KEY"],
    consoleUrl: "https://resend.com/domains",
    isConfigured: () => hasEnv("RESEND_API_KEY"),
    probe: probeResend,
  },
  {
    id: "slack",
    name: "Slack",
    category: "messaging",
    requiredEnv: ["SLACK_BOT_TOKEN"],
    consoleUrl: "https://api.slack.com/apps",
    isConfigured: () => hasEnv("SLACK_BOT_TOKEN"),
    probe: probeSlack,
  },
  {
    id: "pushover",
    name: "Pushover",
    category: "messaging",
    requiredEnv: [
      "PUSHOVER_USER_KEY",
      "PUSHOVER_USAGE_API_TOKEN",
      "PUSHOVER_ST_API_TOKEN",
      "PUSHOVER_CT_API_TOKEN",
    ],
    consoleUrl: "https://pushover.net/apps",
    isConfigured: () => hasEnv(...PUSHOVER_APP_ENV_NAMES),
    probe: probePushover,
  },
];
