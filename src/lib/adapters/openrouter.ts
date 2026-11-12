import {
  AdapterError,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

// OpenRouter has two key tiers. GET /key works with any key and reports only
// that key's own usage/limit. GET /credits, GET /keys, and GET /activity all
// require a "Management" (formerly "Provisioning") key - a standard
// inference key gets 403 {"error":{"code":403,"message":"Only management
// keys can perform this operation"}} from all three. The response schema
// still carries both is_management_key and is_provisioning_key booleans for
// back-compat; either true means the key can reach the account-wide reads.
//
// /credits is lifetime-cumulative prepaid balance, not a billing cycle -
// OpenRouter has no subscription/invoice concept. That makes this adapter
// closer to deepseek.ts's balance-only shape than an invoiced-cost shape.
// The only lever for a calendar-month-to-date cost figure is summing
// /activity's trailing-30-completed-UTC-day rows since the 1st of the
// month, which is only safe while the window can be proven to still reach
// back to day 1 (see windowCoversMonthStart below).

const KEYS_PAGE_SIZE = 100;
const MAX_KEYS_PAGES = 50;

function extractDataObject(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const inner = (payload as Record<string, unknown>).data;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null;
  return inner as Record<string, unknown>;
}

interface ActivityRow {
  date: string | null;
  usage: number | null;
  requests: number | null;
}

function extractActivityRows(payload: unknown): ActivityRow[] | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const rows = (payload as Record<string, unknown>).data;
  if (!Array.isArray(rows)) return null;
  return rows.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { date: null, usage: null, requests: null };
    }
    const row = raw as Record<string, unknown>;
    return {
      date: typeof row.date === "string" ? row.date : null,
      usage: parseNumber(row.usage),
      requests: parseNumber(row.requests),
    };
  });
}

interface KeyRow {
  name: string | null;
  label: string | null;
  hash: string | null;
  disabled: boolean;
  usageUsd: number | null;
  limitUsd: number | null;
  limitRemainingUsd: number | null;
  workspaceId: string | null;
}

interface KeysListResult {
  ok: boolean;
  status: number;
  keys: KeyRow[];
}

// Mirrors the bounded-pagination guard in openai.ts's fetchOrganizationCosts:
// /keys has no documented `limit` param, so 100 rows/page is treated as the
// assumed page size and pagination ends when a page returns fewer than that.
// Any page failing or returning a malformed body fails the whole read - a
// partial key list would misrepresent which of the account's keys exist.
async function fetchAllKeys(headers: Record<string, string>): Promise<KeysListResult> {
  const keys: KeyRow[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_KEYS_PAGES; page += 1) {
    const url = new URL("https://openrouter.ai/api/v1/keys");
    url.searchParams.set("include_disabled", "true");
    url.searchParams.set("offset", String(offset));
    const res = await fetchJson(url.toString(), { headers });
    if (!res.ok) {
      return { ok: false, status: res.status, keys: [] };
    }

    const payload = res.data;
    const rows =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).data
        : null;
    if (!Array.isArray(rows)) {
      return { ok: false, status: 502, keys: [] };
    }

    for (const raw of rows) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      keys.push({
        name: typeof row.name === "string" ? row.name : null,
        label: typeof row.label === "string" ? row.label : null,
        hash: typeof row.hash === "string" ? row.hash : null,
        disabled: row.disabled === true,
        usageUsd: parseNumber(row.usage),
        limitUsd: parseNumber(row.limit),
        limitRemainingUsd: parseNumber(row.limit_remaining),
        workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : null,
      });
    }

    if (rows.length < KEYS_PAGE_SIZE) {
      return { ok: true, status: res.status, keys };
    }
    offset += rows.length;
  }

  // Pagination exceeded the bound without terminating - treat as failed
  // rather than silently reporting a truncated key list.
  return { ok: false, status: 502, keys: [] };
}

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  const headers = { Authorization: `Bearer ${apiKey}` };

  // GET /key works with any key tier and is a cheap, zero-side-effect
  // connectivity/validity check that also tells us which tier this key is.
  const keyRes = await fetchJson("https://openrouter.ai/api/v1/key", { headers });
  if (!keyRes.ok) {
    return errorResult(keyRes.status, {
      note: "OpenRouter rejected GET /key for this API key.",
      response: keyRes.data,
    });
  }

  const keyPayload = extractDataObject(keyRes.data);
  if (!keyPayload) {
    throw new AdapterError("OpenRouter returned an invalid /key response", {
      code: "INVALID_RESPONSE",
    });
  }

  const keyInfo = {
    label: typeof keyPayload.label === "string" ? keyPayload.label : null,
    limitUsd: parseNumber(keyPayload.limit),
    limitRemainingUsd: parseNumber(keyPayload.limit_remaining),
    limitReset: typeof keyPayload.limit_reset === "string" ? keyPayload.limit_reset : null,
    usageUsd: parseNumber(keyPayload.usage),
    usageDailyUsd: parseNumber(keyPayload.usage_daily),
    usageWeeklyUsd: parseNumber(keyPayload.usage_weekly),
    usageMonthlyUsd: parseNumber(keyPayload.usage_monthly),
    isFreeTier: keyPayload.is_free_tier === true,
  };

  const isManagementKey =
    keyPayload.is_management_key === true || keyPayload.is_provisioning_key === true;

  if (!isManagementKey) {
    // Not an error - a working, reduced-capability result. Account-wide
    // credits, the per-key breakdown, and activity history are simply
    // unreachable with a standard inference key.
    return {
      balance: null,
      totalCost: null,
      totalRequests: null,
      credits: null,
      costScope: "unknown",
      rawData: {
        keyInfo,
        capabilities: {
          managementKeyConfirmed: false,
          accountCreditsAvailable: false,
          perKeyBreakdownAvailable: false,
          activityAvailable: false,
        },
        note:
          "This is a standard OpenRouter inference key. Account-wide prepaid credit balance, the per-key breakdown, and 30-day activity history all require an OpenRouter Management (Provisioning) API key; only this key's own usage and limit are reported above.",
      },
    };
  }

  const [creditsRes, keysResult, activityRes] = await Promise.all([
    fetchJson("https://openrouter.ai/api/v1/credits", { headers }),
    fetchAllKeys(headers),
    fetchJson("https://openrouter.ai/api/v1/activity", { headers }),
  ]);

  if (!creditsRes.ok && !keysResult.ok && !activityRes.ok) {
    return errorResult(creditsRes.status || keysResult.status || activityRes.status, {
      note:
        "OpenRouter requires a Management (Provisioning) API key for /credits, /keys, and /activity; a standard inference key only self-reports via /key.",
    });
  }

  let balance: number | null = null;
  let credits: number | null = null;
  if (creditsRes.ok) {
    const creditsPayload = extractDataObject(creditsRes.data);
    if (creditsPayload) {
      const totalCredits = parseNumber(creditsPayload.total_credits);
      const totalUsage = parseNumber(creditsPayload.total_usage);
      if (totalCredits != null && totalUsage != null) {
        credits = totalCredits;
        balance = totalCredits - totalUsage;
      }
    }
  }

  const now = new Date();
  const monthStartDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthStartStr = monthStartDate.toISOString().slice(0, 10);

  let totalCost: number | null = null;
  let totalRequests: number | null = null;
  let activitySummary: Record<string, unknown>;

  if (activityRes.ok) {
    const rows = extractActivityRows(activityRes.data);
    if (rows) {
      let windowUsd = 0;
      let windowRequests = 0;
      let monthToDateUsd = 0;
      for (const row of rows) {
        if (row.usage != null) windowUsd += row.usage;
        if (row.requests != null) windowRequests += row.requests;
        if (row.date != null && row.date >= monthStartStr && row.usage != null) {
          monthToDateUsd += row.usage;
        }
      }
      totalRequests = windowRequests;

      // /activity only guarantees the trailing 30 completed UTC days. On
      // day 31 of a 31-day month that window can no longer be proven to
      // reach back to the 1st, so the derived figure is withheld from the
      // budget-facing totalCost (it stays visible below as a diagnostic).
      const windowCoversMonthStart = now.getUTCDate() <= 30;
      totalCost = windowCoversMonthStart ? monthToDateUsd : null;
      activitySummary = {
        available: true,
        windowUsd,
        windowRequests,
        monthToDateUsd,
        monthToDateSafe: windowCoversMonthStart,
      };
    } else {
      activitySummary = {
        available: false,
        status: activityRes.status,
        error: "Malformed /activity response",
      };
    }
  } else {
    activitySummary = { available: false, status: activityRes.status };
  }

  // Wave E / E3: when MTD cash is derived from /activity, surface an explicit
  // coverage caveat so dashboards never present the estimate as invoice truth.
  // Multi-workspace accounts are also incomplete in the keys enumeration.
  const workspaceIds = new Set(
    (keysResult.ok ? keysResult.keys : [])
      .map((k) => k.workspaceId)
      .filter((id): id is string => Boolean(id))
  );
  const multiWorkspace = workspaceIds.size > 1;
  const costCoverageCaveat =
    totalCost != null
      ? {
          code: "openrouter_activity_mtd_estimate",
          message: multiWorkspace
            ? "Month-to-date cost is estimated from OpenRouter /activity (not an invoice). Multiple workspaces were observed on keys; this v1 read only fully covers the default workspace, so spend may be understated."
            : "Month-to-date cost is estimated from OpenRouter /activity rows since the UTC month start (trailing ~30 completed days), not from an invoice or statement. Treat as a best-effort estimate.",
        }
      : null;

  return {
    balance,
    totalCost,
    costWindowStart: totalCost != null ? monthStartDate : null,
    costWindowEnd: totalCost != null ? now : null,
    costScope: totalCost != null ? "calendar_month_to_date" : "unknown",
    costCoverageCaveat,
    totalRequests,
    credits,
    rawData: {
      keyInfo,
      credits: creditsRes.ok
        ? { totalCreditsUsd: credits, balanceUsd: balance }
        : { available: false, status: creditsRes.status },
      keys: keysResult.ok ? keysResult.keys : undefined,
      keysAvailable: keysResult.ok,
      ...(keysResult.ok ? {} : { keysStatus: keysResult.status }),
      activity: activitySummary,
      multiWorkspaceDetected: multiWorkspace,
      capabilities: {
        managementKeyConfirmed: true,
        accountCreditsAvailable: creditsRes.ok && balance != null,
        perKeyBreakdownAvailable: keysResult.ok,
        activityAvailable: activityRes.ok,
      },
      limitations: [
        "GET /api/v1/keys returns only the default workspace; accounts with additional workspaces are not fully enumerated in this v1 read.",
        "Month-to-date cost sums /activity rows since the 1st of the UTC month and is withheld on the one day per 31-day month when the trailing 30-day window cannot be proven to reach that far back.",
      ],
    },
    externalBilling:
      balance != null
        ? {
            source: "openrouter-credits",
            authoritative: true,
            records: [
              {
                externalId: "account",
                kind: "account",
                serviceName: "OpenRouter API",
                planName: "OpenRouter prepaid credits",
                status: "active",
                remainingQuantity: balance,
                usageUnit: "USD credits",
                rollupRole: "metadata",
              },
            ],
          }
        : undefined,
  };
}
