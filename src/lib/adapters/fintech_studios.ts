import {
  AdapterError,
  errorResult,
  fetchJson,
  parseNumber,
  type AdapterExternalBillingRecord,
  type UsageResult,
} from "./helpers";

function nonNegativeNumber(value: unknown): number | null {
  const parsed = parseNumber(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isoDateOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function invalidAccountField(field: string): never {
  throw new AdapterError(
    `FinTech Studios account response contained an invalid ${field} field`,
    { code: "INVALID_RESPONSE" }
  );
}

function readOptionalNonNegativeNumber(
  record: Record<string, unknown>,
  field: string
): number | null {
  if (!Object.hasOwn(record, field)) return null;
  const value = nonNegativeNumber(record[field]);
  if (value == null) invalidAccountField(`credits.${field}`);
  return value;
}

function readOptionalIsoDate(
  record: Record<string, unknown>,
  field: string
): string | null {
  if (!Object.hasOwn(record, field)) return null;
  const value = isoDateOrNull(record[field]);
  if (value == null) invalidAccountField(`credits.${field}`);
  return value;
}

export async function fetchUsage(apiKey: string): Promise<UsageResult> {
  // /me is explicitly zero-credit in the provider's OpenAPI contract. Do not
  // call /usage until FinTech Studios publishes a response schema we can parse
  // without guessing.
  const response = await fetchJson(
    "https://studio.fintechstudios.com/api/v1/me",
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );
  if (!response.ok) return errorResult(response.status);
  if (!isRecord(response.data)) {
    throw new AdapterError("FinTech Studios returned an invalid account response", {
      code: "INVALID_RESPONSE",
    });
  }

  const payload = response.data;
  if (!isRecord(payload.data)) {
    throw new AdapterError("FinTech Studios account response omitted data", {
      code: "INVALID_RESPONSE",
    });
  }

  const account = payload.data;
  if (Object.hasOwn(account, "credits") && !isRecord(account.credits)) {
    invalidAccountField("credits");
  }
  const creditData = isRecord(account.credits) ? account.credits : {};
  const meta =
    isRecord(payload.meta)
      ? payload.meta
      : {};
  const rateLimit =
    isRecord(meta.rate_limit)
      ? meta.rate_limit
      : {};

  const tier = nonEmptyString(account.tier);
  if (Object.hasOwn(account, "tier") && tier == null) {
    invalidAccountField("tier");
  }
  const creditBalance = readOptionalNonNegativeNumber(creditData, "balance");
  const monthlyAllowance = readOptionalNonNegativeNumber(
    creditData,
    "monthly_allowance"
  );
  const dailyCap = readOptionalNonNegativeNumber(creditData, "daily_burn_cap");
  const dailyUsed = readOptionalNonNegativeNumber(creditData, "daily_burn_used");
  const dailyRemaining =
    dailyCap != null && dailyUsed != null
      ? Math.max(0, dailyCap - dailyUsed)
      : null;
  const resetAt = readOptionalIsoDate(creditData, "reset_date");
  if (
    tier == null &&
    creditBalance == null &&
    monthlyAllowance == null &&
    dailyCap == null &&
    dailyUsed == null &&
    resetAt == null
  ) {
    throw new AdapterError(
      "FinTech Studios account response contained no recognized plan or credit fields",
      { code: "INVALID_RESPONSE" }
    );
  }

  const records: AdapterExternalBillingRecord[] = [];
  if (creditBalance != null) {
    records.push({
      externalId: "account-credit-balance",
      kind: "account",
      serviceName: "FinTech Studios API credits",
      planName: tier,
      status: "active",
      remainingQuantity: creditBalance,
      usageUnit: "credits",
      rollupRole: "metadata",
    });
  }
  if (monthlyAllowance != null) {
    records.push({
      externalId: "monthly-credit-allowance",
      kind: "plan",
      serviceName: "FinTech Studios API credits",
      planName: tier,
      status: "active",
      requestLimit: monthlyAllowance,
      requestLimitWindow: "month",
      usageUnit: "credits",
      rollupRole: "metadata",
    });
  }
  if (dailyCap != null || dailyUsed != null || resetAt != null) {
    records.push({
      externalId: "daily-credit-cap",
      kind: "plan",
      serviceName: "FinTech Studios API credits",
      planName: tier,
      status: "active",
      requestLimit: dailyCap,
      requestLimitWindow: "day",
      usageQuantity: dailyUsed,
      remainingQuantity: dailyRemaining,
      usageUnit: "credits",
      currentPeriodEnd: resetAt,
      rollupRole: "metadata",
      dateKind: "quota_reset",
    });
  }
  if (records.length === 0 && tier) {
    records.push({
      externalId: "account-plan",
      kind: "plan",
      serviceName: "FinTech Studios API",
      planName: tier,
      status: "active",
      rollupRole: "metadata",
    });
  }

  return {
    balance: null,
    totalCost: null,
    costScope: "unknown",
    totalRequests: null,
    credits: creditBalance,
    rawData: {
      // Deliberately omit the account email/name returned by /me.
      tier,
      creditBalance,
      monthlyCreditAllowance: monthlyAllowance,
      dailyCreditCap: dailyCap,
      dailyCreditsUsed: dailyUsed,
      dailyCreditsRemaining: dailyRemaining,
      creditResetAt: resetAt,
      apiRateLimit: {
        limit: nonNegativeNumber(rateLimit.limit),
        remaining: nonNegativeNumber(rateLimit.remaining),
        reset: nonNegativeNumber(rateLimit.reset),
      },
      note: "The zero-credit /me endpoint exposes plan and credit quota metadata, not USD billing cost, invoice history, or renewal dates.",
      capabilities: {
        zeroCreditAccountRead: true,
        tier: tier != null,
        creditBalance: creditBalance != null,
        monthlyAllowance: monthlyAllowance != null,
        dailyCreditCap: dailyCap != null || dailyUsed != null,
        billingCost: false,
        renewalDate: false,
      },
    },
    externalBilling: {
      source: "fintech-studios-account",
      authoritative: true,
      records,
    },
  };
}
