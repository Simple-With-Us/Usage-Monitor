/**
 * Edge & Network probes.
 *
 * Cloudflare is the only platform in this category.  R2 free-tier storage is
 * the storage card's job, so this probe answers a narrower, complementary
 * question: can every Cloudflare account the fleet depends on still
 * authenticate?  A silently expired or revoked token is invisible until a
 * backup, a DNS change, or an analytics pull fails — this surfaces it first.
 *
 * Account credentials are the fleet slots already defined in `r2-usage.ts`
 * (`loadR2FleetAccounts`), so the Platforms page and the Operations page agree
 * on exactly which Cloudflare accounts exist and which env vars name them.
 * Tokens are read, sent as a bearer header, and never rendered — a failing
 * account is named by its human label only.
 */

import { loadR2FleetAccounts, type R2FleetAccountConfig } from "@/lib/r2-usage";
import {
  asRecord,
  failureResult,
  finiteNumber,
  formatCount,
  httpErrorCode,
  metric,
  requestJson,
  upstreamFailure,
} from "../probe-helpers";
import type { PlatformMetric, PlatformProbe, PlatformProbeResult } from "../types";
import { MAX_PLATFORM_METRICS } from "../types";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_CONSOLE_URL = "https://dash.cloudflare.com";

/**
 * Shown verbatim on an unconfigured card.  The generic pair covers the UM
 * account (`loadR2FleetAccounts` also accepts the `R2_USAGE_*` / `CLOUDFLARE_JAY_*`
 * aliases for it); ST/CT/Old add the other three dashboard accounts.
 */
const CLOUDFLARE_REQUIRED_ENV = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_FLEET_API_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ST_ACCOUNT_ID",
  "CLOUDFLARE_ST_API_TOKEN",
  "CLOUDFLARE_CT_ACCOUNT_ID",
  "CLOUDFLARE_CT_API_TOKEN",
  "CLOUDFLARE_OLD_ACCOUNT_ID",
  "CLOUDFLARE_OLD_API_TOKEN",
];

interface VerifiedAccount {
  ok: true;
  label: string;
  /** ISO expiry from the token itself, when Cloudflare reports one. */
  expiresOn: string | null;
  /** Zones on this account, or null when the token lacks Zone Read. */
  zones: number | null;
}

interface FailedAccount {
  ok: false;
  label: string;
  /** "rejected" = Cloudflare answered and refused; "unreachable" = no answer. */
  kind: "rejected" | "unreachable";
  /** HTTP status when there was one, else null. */
  status: number | null;
  errorCode: string;
  /** Transport error, used only to distinguish timeout from network failure. */
  cause?: unknown;
}

type AccountOutcome = VerifiedAccount | FailedAccount;

function authHeaders(apiToken: string): Record<string, string> {
  return { Authorization: `Bearer ${apiToken}`, Accept: "application/json" };
}

/**
 * Zone count for one account.  Strictly best effort: an Account-Analytics-only
 * token cannot read zones, and that is a normal, non-alarming configuration.
 */
async function countZones(
  accountId: string,
  headers: Record<string, string>
): Promise<number | null> {
  try {
    const params = new URLSearchParams({ "account.id": accountId, per_page: "1" });
    const response = await requestJson(`${CLOUDFLARE_API_BASE}/zones?${params}`, {
      headers,
    });
    if (!response.ok) return null;
    const info = asRecord(asRecord(response.data)?.result_info);
    return finiteNumber(info?.total_count);
  } catch {
    return null;
  }
}

/**
 * Verify one account's token.  Never throws.
 *
 * Cloudflare has TWO token verify endpoints, and each only answers for its
 * own token kind: an ACCOUNT-OWNED token 401s at `/user/tokens/verify` while
 * being perfectly valid, and a USER-OWNED token 401s at
 * `/accounts/{id}/tokens/verify` the same way.  The fleet mixes both kinds
 * (ST/CT are account-owned Analytics tokens, the jay/UM one is user-owned),
 * so this tries the account endpoint first — every slot carries its account
 * id — and falls back to the user endpoint.  A token is dead only when BOTH
 * reject it.  Verifying only the user endpoint reported valid ST/CT tokens
 * as expired for days and burned real operator trust; don't reintroduce it.
 */
async function verifyAccount(account: R2FleetAccountConfig): Promise<AccountOutcome> {
  const headers = authHeaders(account.apiToken);
  const endpoints = [
    `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(account.accountId)}/tokens/verify`,
    `${CLOUDFLARE_API_BASE}/user/tokens/verify`,
  ];

  let response;
  let lastRejection: { status: number } | null = null;
  for (const endpoint of endpoints) {
    try {
      const attempt = await requestJson(endpoint, { headers });
      if (attempt.ok) {
        response = attempt;
        break;
      }
      lastRejection = { status: attempt.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        label: account.label,
        kind: "unreachable",
        status: null,
        errorCode: /abort|timeout|timed out/i.test(message) ? "timeout" : "unreachable",
        cause: error,
      };
    }
  }

  if (!response) {
    const status = lastRejection?.status ?? 401;
    return {
      ok: false,
      label: account.label,
      kind: "rejected",
      status,
      errorCode: httpErrorCode(status),
    };
  }

  const body = asRecord(response.data);
  const result = asRecord(body?.result);
  const tokenStatus = typeof result?.status === "string" ? result.status : null;
  // Cloudflare answers 200 for a well-formed request with a disabled or
  // expired token, so the body decides, not the status line.
  if (body?.success === false || tokenStatus !== "active") {
    return {
      ok: false,
      label: account.label,
      kind: "rejected",
      status: null,
      errorCode: "unauthorized",
    };
  }

  const expiresOn =
    typeof result?.expires_on === "string" && Number.isFinite(Date.parse(result.expires_on))
      ? result.expires_on
      : null;

  return {
    ok: true,
    label: account.label,
    expiresOn,
    zones: await countZones(account.accountId, headers),
  };
}

/** "A", "A and B", "A, B, and C" — labels only, never tokens. */
function joinLabels(labels: string[]): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function accountStatusValue(outcome: AccountOutcome): string {
  if (outcome.ok) return "Token active";
  return outcome.kind === "unreachable" ? "Unreachable" : "Token rejected";
}

function buildMetrics(
  outcomes: AccountOutcome[],
  verified: VerifiedAccount[],
  accountCount: number
): PlatformMetric[] {
  const metrics: PlatformMetric[] = [];

  if (accountCount > 1) {
    metrics.push(metric("Accounts Verified", `${verified.length} of ${accountCount}`));
  }

  for (const outcome of outcomes) {
    metrics.push(metric(outcome.label, accountStatusValue(outcome)));
  }

  const zoneTotal = verified.reduce<number | null>(
    (total, account) => (account.zones === null ? total : (total ?? 0) + account.zones),
    null
  );
  if (zoneTotal !== null) {
    metrics.push(
      metric(
        "Zones",
        formatCount(zoneTotal, "zone"),
        accountCount > 1 ? "across verified accounts" : undefined
      )
    );
  }

  // Earliest expiry is the one that will bite first.  A calendar date, not a
  // countdown, so this string never goes stale against the wall clock.
  const soonest = verified
    .filter((account): account is VerifiedAccount & { expiresOn: string } =>
      account.expiresOn !== null
    )
    .sort((a, b) => Date.parse(a.expiresOn) - Date.parse(b.expiresOn))[0];
  metrics.push(
    soonest
      ? metric(
          "Token Expiry",
          soonest.expiresOn.slice(0, 10),
          accountCount > 1 ? soonest.label : undefined
        )
      : metric("Token Expiry", "No expiry set")
  );

  // Four accounts + roll-up + Zones + Expiry is 7.  Keep per-account
  // status; drop the trailing expiry row if we would overflow the card.
  return metrics.slice(0, MAX_PLATFORM_METRICS);
}

async function probeCloudflare(): Promise<PlatformProbeResult> {
  const accounts = loadR2FleetAccounts();
  if (accounts.length === 0) {
    // The registry gates on isConfigured(), but a probe that trusts its caller
    // is a probe that throws one day.
    return {
      state: "unavailable",
      headline: "No Cloudflare account credentials are readable.",
      metrics: [],
      error: "unauthorized",
    };
  }

  let outcomes: AccountOutcome[];
  try {
    outcomes = await Promise.all(accounts.map((account) => verifyAccount(account)));
  } catch (error) {
    return failureResult(error, "Could not reach the Cloudflare API.");
  }

  const verified = outcomes.filter((outcome): outcome is VerifiedAccount => outcome.ok);
  const failed = outcomes.filter((outcome): outcome is FailedAccount => !outcome.ok);

  if (verified.length === 0) {
    const rejected = failed.filter((outcome) => outcome.kind === "rejected");

    if (rejected.length === 0) {
      return failureResult(failed[0]?.cause, "Could not reach the Cloudflare API.");
    }

    const rejectedLabels = joinLabels(rejected.map((outcome) => outcome.label));
    const headline =
      accounts.length === 1
        ? `Cloudflare rejected the ${rejectedLabels} API token.`
        : `Cloudflare rejected every configured API token.  Check ${rejectedLabels}.`;

    const httpFailure = rejected.find((outcome) => outcome.status !== null);
    if (httpFailure && httpFailure.status !== null) {
      return upstreamFailure(httpFailure.status, headline);
    }
    return { state: "unavailable", headline, metrics: [], error: "unauthorized" };
  }

  const metrics = buildMetrics(outcomes, verified, accounts.length);

  if (failed.length === 0) {
    const headline =
      accounts.length === 1
        ? `${verified[0].label} API token is valid.`
        : `All ${verified.length} Cloudflare API tokens are valid.`;
    return { state: "healthy", headline, metrics };
  }

  const rejected = failed.filter((outcome) => outcome.kind === "rejected");
  const unreachable = failed.filter((outcome) => outcome.kind === "unreachable");
  const problem =
    rejected.length > 0
      ? `${joinLabels(rejected.map((outcome) => outcome.label))} failed token verification.`
      : `${joinLabels(unreachable.map((outcome) => outcome.label))} did not respond.`;

  return {
    state: "degraded",
    headline: `${problem}  ${verified.length} of ${accounts.length} accounts still authenticate.`,
    metrics,
    error: failed[0].errorCode,
  };
}

export const EDGE_PROBES: readonly PlatformProbe[] = [
  {
    id: "cloudflare",
    name: "Cloudflare",
    category: "edge",
    requiredEnv: CLOUDFLARE_REQUIRED_ENV,
    consoleUrl: CLOUDFLARE_CONSOLE_URL,
    isConfigured: () => loadR2FleetAccounts().length > 0,
    probe: probeCloudflare,
  },
];
