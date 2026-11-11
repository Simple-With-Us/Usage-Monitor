import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Probes reach the network only through `requestJson`, which delegates to the
// adapter HTTP stack.  Mocking that one export keeps every test offline.
vi.mock("@/lib/adapters/helpers", () => ({
  fetchJson: vi.fn(),
}));

import { fetchJson } from "@/lib/adapters/helpers";
import { MESSAGING_PROBES } from "@/lib/platform-status/probes/messaging";
import type { PlatformProbe } from "@/lib/platform-status/types";

const fetchJsonMock = vi.mocked(fetchJson);

/** Every env var these probes read.  Cleared before each test. */
const MESSAGING_ENV = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "SENDGRID_API_KEY",
  "RESEND_API_KEY",
  "SLACK_BOT_TOKEN",
  "PUSHOVER_USER_KEY",
  "PUSHOVER_USAGE_API_TOKEN",
  "PUSHOVER_UM_API_TOKEN",
  "PUSHOVER_API_TOKEN",
  "PUSHOVER_APP_TOKEN",
  "PUSHOVER_ST_API_TOKEN",
  "PUSHOVER_CT_API_TOKEN",
];

function probeFor(id: string): PlatformProbe {
  const probe = MESSAGING_PROBES.find((entry) => entry.id === id);
  if (!probe) throw new Error(`no messaging probe with id ${id}`);
  return probe;
}

function response(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    data,
    headers: new Headers(),
  };
}

/** Route each mocked request by URL so parallel probes stay independent. */
function routeByUrl(routes: Array<[RegExp, ReturnType<typeof response>]>): void {
  fetchJsonMock.mockImplementation(async (url: string) => {
    for (const [pattern, result] of routes) {
      if (pattern.test(url)) return result;
    }
    throw new Error(`unrouted request: ${url}`);
  });
}

describe("platform-status messaging probes", () => {
  beforeEach(() => {
    for (const name of MESSAGING_ENV) vi.stubEnv(name, "");
    fetchJsonMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fetchJsonMock.mockReset();
  });

  it("registers every messaging platform in the messaging category", () => {
    expect(MESSAGING_PROBES.map((probe) => probe.id)).toEqual([
      "twilio",
      "sendgrid",
      "resend",
      "slack",
      "pushover",
    ]);
    for (const probe of MESSAGING_PROBES) {
      expect(probe.category).toBe("messaging");
      expect(probe.requiredEnv.length).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // Twilio
  // -------------------------------------------------------------------------

  describe("twilio", () => {
    it("is unconfigured without credentials", () => {
      expect(probeFor("twilio").isConfigured()).toBe(false);
      vi.stubEnv("TWILIO_ACCOUNT_SID", "ACfake-not-a-real-sid");
      // The SID alone is not enough to authenticate.
      expect(probeFor("twilio").isConfigured()).toBe(false);
      expect(fetchJsonMock).not.toHaveBeenCalled();
    });

    it("reports an active account with its balance", async () => {
      vi.stubEnv("TWILIO_ACCOUNT_SID", "ACfake-not-a-real-sid");
      vi.stubEnv("TWILIO_AUTH_TOKEN", "twilio-auth-token-value");
      routeByUrl([
        [
          /\/Balance\.json$/,
          response(200, {
            account_sid: "ACfake-not-a-real-sid",
            balance: "42.75",
            currency: "USD",
          }),
        ],
        [
          /\/Accounts\/AC[\w-]+\.json$/,
          response(200, {
            friendly_name: "Fleet Alerts",
            status: "active",
            type: "Full",
          }),
        ],
      ]);

      const result = await probeFor("twilio").probe();

      expect(probeFor("twilio").isConfigured()).toBe(true);
      expect(result.state).toBe("healthy");
      expect(result.headline).toBe("Twilio is active.  Balance is $42.75.");
      expect(result.metrics).toEqual([
        { label: "Account Status", value: "Active" },
        { label: "Account Type", value: "Full" },
        { label: "Balance", value: "$42.75" },
      ]);
      expect(JSON.stringify(result)).not.toContain("twilio-auth-token-value");
    });

    it("degrades when the account is suspended", async () => {
      vi.stubEnv("TWILIO_ACCOUNT_SID", "ACfake-not-a-real-sid");
      vi.stubEnv("TWILIO_AUTH_TOKEN", "twilio-auth-token-value");
      routeByUrl([
        [/\/Balance\.json$/, response(200, { balance: "18.00", currency: "USD" })],
        [/\/Accounts\/AC[\w-]+\.json$/, response(200, { status: "suspended", type: "Full" })],
      ]);

      const result = await probeFor("twilio").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("account_not_active");
      expect(result.headline).toContain("suspended.  Messages will not send");
    });

    it("degrades when the balance lookup fails on an otherwise healthy account", async () => {
      vi.stubEnv("TWILIO_ACCOUNT_SID", "ACfake-not-a-real-sid");
      vi.stubEnv("TWILIO_AUTH_TOKEN", "twilio-auth-token-value");
      routeByUrl([
        [/\/Balance\.json$/, response(500, { message: "Service unavailable" })],
        [/\/Accounts\/AC[\w-]+\.json$/, response(200, { status: "active", type: "Full" })],
      ]);

      const result = await probeFor("twilio").probe();

      // A failed request is not evidence of a healthy account: reporting this
      // as healthy would show depleted prepaid credit as green.
      expect(result.state).toBe("degraded");
      expect(result.error).toBe("balance_unavailable");
      expect(result.headline).toBe(
        "Twilio is active.  The balance could not be read, so a low prepaid balance would go unnoticed."
      );
      expect(result.metrics).toContainEqual({
        label: "Balance",
        value: "Unavailable",
        hint: "balance lookup failed",
      });
    });

    it("degrades when only the balance request fails in transport", async () => {
      vi.stubEnv("TWILIO_ACCOUNT_SID", "ACfake-not-a-real-sid");
      vi.stubEnv("TWILIO_AUTH_TOKEN", "twilio-auth-token-value");
      fetchJsonMock.mockImplementation(async (url: string) => {
        if (/\/Balance\.json$/.test(url)) throw new Error("socket hang up");
        return response(200, { status: "active", type: "Full" });
      });

      const result = await probeFor("twilio").probe();

      // The account answered, so the card degrades rather than declaring the
      // whole platform unreachable.
      expect(result.state).toBe("degraded");
      expect(result.error).toBe("balance_unavailable");
    });

    it("keeps the suspended-account verdict when the balance also fails", async () => {
      vi.stubEnv("TWILIO_ACCOUNT_SID", "ACfake-not-a-real-sid");
      vi.stubEnv("TWILIO_AUTH_TOKEN", "twilio-auth-token-value");
      routeByUrl([
        [/\/Balance\.json$/, response(503, {})],
        [/\/Accounts\/AC[\w-]+\.json$/, response(200, { status: "suspended", type: "Full" })],
      ]);

      const result = await probeFor("twilio").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("account_not_active");
    });

    it("stays healthy when Twilio answers with no balance for the account", async () => {
      vi.stubEnv("TWILIO_ACCOUNT_SID", "ACfake-not-a-real-sid");
      vi.stubEnv("TWILIO_AUTH_TOKEN", "twilio-auth-token-value");
      routeByUrl([
        // A 200 with no balance field is the genuine "not reported" case, and
        // it must stay distinguishable from a request that never answered.
        [/\/Balance\.json$/, response(200, { account_sid: "ACfake-not-a-real-sid" })],
        [/\/Accounts\/AC[\w-]+\.json$/, response(200, { status: "active", type: "Trial" })],
      ]);

      const result = await probeFor("twilio").probe();

      expect(result.state).toBe("healthy");
      expect(result.error).toBeUndefined();
      expect(result.headline).toBe(
        "Twilio is active.  Balance is not reported for this account."
      );
      expect(result.metrics).toContainEqual({ label: "Balance", value: "Unavailable" });
    });

    it("maps a rejected account lookup to unavailable", async () => {
      vi.stubEnv("TWILIO_ACCOUNT_SID", "ACfake-not-a-real-sid");
      vi.stubEnv("TWILIO_AUTH_TOKEN", "twilio-auth-token-value");
      routeByUrl([
        [/\/Balance\.json$/, response(401, { message: "Authenticate" })],
        [/\/Accounts\/AC[\w-]+\.json$/, response(401, { message: "Authenticate" })],
      ]);

      const result = await probeFor("twilio").probe();

      expect(result.state).toBe("unavailable");
      expect(result.error).toBe("unauthorized");
      expect(result.metrics).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // SendGrid
  // -------------------------------------------------------------------------

  describe("sendgrid", () => {
    it("is unconfigured without an API key", () => {
      expect(probeFor("sendgrid").isConfigured()).toBe(false);
      expect(fetchJsonMock).not.toHaveBeenCalled();
    });

    it("reports remaining send credits", async () => {
      vi.stubEnv("SENDGRID_API_KEY", "SG.sendgrid-secret-key");
      routeByUrl([
        [
          /api\.sendgrid\.com\/v3\/user\/credits$/,
          response(200, {
            remain: 84_120,
            total: 100_000,
            overage: 0,
            last_reset: "2026-08-01",
            next_reset: "2026-09-01",
            reset_frequency: "monthly",
          }),
        ],
      ]);

      const result = await probeFor("sendgrid").probe();

      expect(result.state).toBe("healthy");
      expect(result.headline).toBe(
        "SendGrid accepted the API key.  84,120 credits remaining this cycle."
      );
      expect(result.metrics).toEqual([
        { label: "Credits Remaining", value: "84,120" },
        { label: "Monthly Allowance", value: "100,000", hint: "monthly reset" },
        { label: "Overage", value: "0" },
        { label: "Next Reset", value: "2026-09-01" },
      ]);
      expect(JSON.stringify(result)).not.toContain("SG.sendgrid-secret-key");
    });

    it("degrades when the send allowance is nearly gone", async () => {
      vi.stubEnv("SENDGRID_API_KEY", "SG.sendgrid-secret-key");
      routeByUrl([
        [
          /^https:\/\/api\.sendgrid\.com\//,
          response(200, { remain: 400, total: 100_000, overage: 0, next_reset: "2026-09-01" }),
        ],
      ]);

      const result = await probeFor("sendgrid").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("quota_low");
      expect(result.headline).toContain("Only 400 of 100,000 credits remain");
    });

    it("maps a 403 to unavailable", async () => {
      vi.stubEnv("SENDGRID_API_KEY", "SG.sendgrid-secret-key");
      routeByUrl([[/^https:\/\/api\.sendgrid\.com\//, response(403, { errors: [{ message: "access forbidden" }] })]]);

      const result = await probeFor("sendgrid").probe();

      expect(result.state).toBe("unavailable");
      expect(result.error).toBe("unauthorized");
      expect(result.headline).toBe("SendGrid rejected the credits lookup.");
    });

    it("maps a 429 to degraded and rate_limited", async () => {
      vi.stubEnv("SENDGRID_API_KEY", "SG.sendgrid-secret-key");
      routeByUrl([[/^https:\/\/api\.sendgrid\.com\//, response(429, { errors: [] })]]);

      const result = await probeFor("sendgrid").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("rate_limited");
    });
  });

  // -------------------------------------------------------------------------
  // Resend
  // -------------------------------------------------------------------------

  describe("resend", () => {
    it("is unconfigured without an API key", () => {
      expect(probeFor("resend").isConfigured()).toBe(false);
      expect(fetchJsonMock).not.toHaveBeenCalled();
    });

    it("is healthy when every sending domain is verified", async () => {
      vi.stubEnv("RESEND_API_KEY", "re_resend_secret_key");
      routeByUrl([
        [
          /api\.resend\.com\/domains$/,
          response(200, {
            data: [
              {
                id: "d91cd9bd-1176-453e-8fc1-35364d380206",
                name: "mail.jays.services",
                status: "verified",
                created_at: "2026-04-02T10:14:00.000Z",
                region: "us-east-1",
              },
              {
                id: "b8617ad3-b712-41d9-9c22-14b1a2b1c7f0",
                name: "alerts.jays.services",
                status: "verified",
                created_at: "2026-05-19T08:01:00.000Z",
                region: "us-east-1",
              },
            ],
          }),
        ],
      ]);

      const result = await probeFor("resend").probe();

      expect(result.state).toBe("healthy");
      expect(result.headline).toBe(
        "Resend accepted the API key.  All 2 sending domains verified."
      );
      expect(result.metrics).toEqual([
        { label: "Sending Domains", value: "2 domains" },
        { label: "Verified", value: "2 of 2" },
      ]);
      expect(JSON.stringify(result)).not.toContain("re_resend_secret_key");
    });

    it("degrades on an unverified sending domain", async () => {
      vi.stubEnv("RESEND_API_KEY", "re_resend_secret_key");
      routeByUrl([
        [
          /api\.resend\.com\/domains$/,
          response(200, {
            data: [
              { id: "1", name: "mail.jays.services", status: "verified" },
              { id: "2", name: "alerts.jays.services", status: "pending" },
            ],
          }),
        ],
      ]);

      const result = await probeFor("resend").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("domain_unverified");
      expect(result.headline).toBe(
        "Resend has 1 unverified sending domain.  Mail from those domains will not deliver."
      );
      expect(result.metrics).toContainEqual({
        label: "Needs Verification",
        value: "alerts.jays.services",
      });
    });

    it("degrades when no sending domain exists at all", async () => {
      vi.stubEnv("RESEND_API_KEY", "re_resend_secret_key");
      routeByUrl([[/api\.resend\.com\/domains$/, response(200, { data: [] })]]);

      const result = await probeFor("resend").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("no_sending_domain");
    });

    it("maps a 401 to unavailable", async () => {
      vi.stubEnv("RESEND_API_KEY", "re_resend_secret_key");
      routeByUrl([
        [
          /api\.resend\.com\/domains$/,
          response(401, { name: "restricted_api_key", message: "invalid" }),
        ],
      ]);

      const result = await probeFor("resend").probe();

      expect(result.state).toBe("unavailable");
      expect(result.error).toBe("unauthorized");
      expect(result.metrics).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Slack
  // -------------------------------------------------------------------------

  describe("slack", () => {
    it("is unconfigured without a bot token", () => {
      expect(probeFor("slack").isConfigured()).toBe(false);
      expect(fetchJsonMock).not.toHaveBeenCalled();
    });

    it("reports the workspace and bot identity", async () => {
      vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-slack-bot-secret");
      routeByUrl([
        [
          /slack\.com\/api\/auth\.test$/,
          response(200, {
            ok: true,
            url: "https://jays-fleet.slack.com/",
            team: "Jays Fleet",
            user: "usage-monitor",
            team_id: "T0BEZDJDNK",
            user_id: "U0BEZDJDNK",
            bot_id: "B0BEZDJDNK",
          }),
        ],
      ]);

      const result = await probeFor("slack").probe();

      expect(result.state).toBe("healthy");
      expect(result.headline).toBe(
        "Slack bot token is valid for Jays Fleet.  Posting as usage-monitor."
      );
      expect(result.metrics).toEqual([
        { label: "Workspace", value: "Jays Fleet" },
        { label: "Workspace ID", value: "T0BEZDJDNK" },
        { label: "Bot Identity", value: "usage-monitor" },
      ]);
      expect(JSON.stringify(result)).not.toContain("xoxb-slack-bot-secret");
    });

    it("treats an HTTP 200 body with ok:false as a rejected credential", async () => {
      vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-slack-bot-secret");
      routeByUrl([
        [/slack\.com\/api\/auth\.test$/, response(200, { ok: false, error: "invalid_auth" })],
      ]);

      const result = await probeFor("slack").probe();

      expect(result.state).toBe("unavailable");
      expect(result.error).toBe("unauthorized");
      expect(result.headline).toBe(
        "Slack rejected the bot token.  The API returned invalid_auth."
      );
      expect(result.metrics).toEqual([]);
    });

    it("names the wrong-token-type trap when SLACK_BOT_TOKEN is a User OAuth token", async () => {
      vi.stubEnv("SLACK_BOT_TOKEN", "xoxp-user-oauth-secret");
      routeByUrl([
        [/slack\.com\/api\/auth\.test$/, response(200, { ok: false, error: "invalid_auth" })],
      ]);

      const result = await probeFor("slack").probe();

      expect(result.state).toBe("unavailable");
      expect(result.error).toBe("wrong_token_type");
      expect(result.headline).toBe(
        "Slack rejected the bot token.  The API returned invalid_auth.  SLACK_BOT_TOKEN looks like User OAuth Token, not a Bot User OAuth Token (xoxb-) — replace it with the token from Slack app → OAuth & Permissions → Bot User OAuth Token."
      );
      expect(result.metrics).toEqual([{ label: "Configured Token Type", value: "User OAuth Token" }]);
      expect(JSON.stringify(result)).not.toContain("xoxp-user-oauth-secret");
    });

    it("does not add a token-type hint when an already-correct xoxb- token is rejected", async () => {
      vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-slack-bot-secret");
      routeByUrl([
        [/slack\.com\/api\/auth\.test$/, response(200, { ok: false, error: "token_revoked" })],
      ]);

      const result = await probeFor("slack").probe();

      expect(result.state).toBe("unavailable");
      expect(result.error).toBe("unauthorized");
      expect(result.headline).toBe("Slack rejected the bot token.  The API returned token_revoked.");
      expect(result.metrics).toEqual([]);
    });

    it("degrades on a non-credential body error", async () => {
      vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-slack-bot-secret");
      routeByUrl([
        [/slack\.com\/api\/auth\.test$/, response(200, { ok: false, error: "ratelimited" })],
      ]);

      const result = await probeFor("slack").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("rate_limited");
    });

    it("maps a 500 to degraded and upstream_error", async () => {
      vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-slack-bot-secret");
      routeByUrl([[/slack\.com\/api\/auth\.test$/, response(500, null)]]);

      const result = await probeFor("slack").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("upstream_error");
      expect(result.headline).toBe("Slack rejected the auth check.");
    });
  });

  // -------------------------------------------------------------------------
  // Pushover
  // -------------------------------------------------------------------------

  describe("pushover", () => {
    // Fixed epoch so the rendered reset day never depends on the wall clock.
    const RESET_EPOCH_SECONDS = Math.floor(Date.UTC(2026, 8, 1, 0, 0, 0) / 1000);

    it("is unconfigured without any application token", () => {
      expect(probeFor("pushover").isConfigured()).toBe(false);
      expect(fetchJsonMock).not.toHaveBeenCalled();
    });

    it("reports remaining monthly quota per configured app", async () => {
      vi.stubEnv("PUSHOVER_USER_KEY", "pushover-user-key-secret");
      vi.stubEnv("PUSHOVER_USAGE_API_TOKEN", "pushover-um-token-secret");
      vi.stubEnv("PUSHOVER_ST_API_TOKEN", "pushover-st-token-secret");
      routeByUrl([
        [
          /token=pushover-um-token-secret$/,
          response(200, {
            status: 1,
            request: "8b1c1e08-0b7c-4b93-9a2a-7a2f1d0f3d4e",
            limit: 10_000,
            remaining: 9_120,
            reset: RESET_EPOCH_SECONDS,
          }),
        ],
        [
          /token=pushover-st-token-secret$/,
          response(200, {
            status: 1,
            limit: 10_000,
            remaining: 7_450,
            reset: RESET_EPOCH_SECONDS,
          }),
        ],
      ]);

      const result = await probeFor("pushover").probe();

      expect(result.state).toBe("healthy");
      expect(result.headline).toBe(
        "Pushover accepted 2 application tokens.  Lowest remaining quota is 7,450 messages."
      );
      expect(result.metrics).toEqual([
        { label: "Usage Monitor Quota", value: "9,120 messages", hint: "of 10,000" },
        { label: "Socratic Trade Quota", value: "7,450 messages", hint: "of 10,000" },
        { label: "Quota Resets", value: "2026-09-01", hint: "UTC" },
        { label: "User Key", value: "Set" },
      ]);
      expect(JSON.stringify(result)).not.toContain("pushover-um-token-secret");
      expect(JSON.stringify(result)).not.toContain("pushover-user-key-secret");
    });

    it("degrades when remaining quota falls under the low-water mark", async () => {
      vi.stubEnv("PUSHOVER_USER_KEY", "pushover-user-key-secret");
      vi.stubEnv("PUSHOVER_CT_API_TOKEN", "pushover-ct-token-secret");
      routeByUrl([
        [
          /token=pushover-ct-token-secret$/,
          response(200, {
            status: 1,
            limit: 10_000,
            remaining: 240,
            reset: RESET_EPOCH_SECONDS,
          }),
        ],
      ]);

      const result = await probeFor("pushover").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("quota_low");
      expect(result.headline).toBe(
        "Pushover monthly quota is running low.  Congress Trade has 240 of 10,000 messages left."
      );
    });

    it("degrades when the user key is missing so nothing can be delivered", async () => {
      vi.stubEnv("PUSHOVER_USAGE_API_TOKEN", "pushover-um-token-secret");
      routeByUrl([
        [
          /token=pushover-um-token-secret$/,
          response(200, {
            status: 1,
            limit: 10_000,
            remaining: 9_999,
            reset: RESET_EPOCH_SECONDS,
          }),
        ],
      ]);

      const result = await probeFor("pushover").probe();

      expect(result.state).toBe("degraded");
      expect(result.error).toBe("missing_user_key");
      expect(result.metrics).toContainEqual({ label: "User Key", value: "Missing" });
    });

    it("maps a rejected token to unavailable", async () => {
      vi.stubEnv("PUSHOVER_USER_KEY", "pushover-user-key-secret");
      vi.stubEnv("PUSHOVER_USAGE_API_TOKEN", "pushover-um-token-secret");
      routeByUrl([
        [
          /token=pushover-um-token-secret$/,
          response(401, { token: "invalid", errors: ["application token is invalid"], status: 0 }),
        ],
      ]);

      const result = await probeFor("pushover").probe();

      expect(result.state).toBe("unavailable");
      expect(result.error).toBe("unauthorized");
      expect(result.headline).toBe("Pushover rejected every application token.");
      expect(result.metrics).toEqual([]);
    });

    it("returns unreachable when the network fails", async () => {
      vi.stubEnv("PUSHOVER_USER_KEY", "pushover-user-key-secret");
      vi.stubEnv("PUSHOVER_USAGE_API_TOKEN", "pushover-um-token-secret");
      fetchJsonMock.mockRejectedValue(
        new Error("Request to https://api.pushover.net/1/apps/limits.json?[REDACTED] failed")
      );

      const result = await probeFor("pushover").probe();

      expect(result.state).toBe("unreachable");
      expect(result.error).toBe("unreachable");
      expect(result.headline).toBe("Pushover did not answer the quota check.");
      expect(JSON.stringify(result)).not.toContain("pushover-um-token-secret");
    });
  });
});
