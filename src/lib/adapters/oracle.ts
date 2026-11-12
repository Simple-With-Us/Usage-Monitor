import { createHash, createSign } from "node:crypto";
import {
  AdapterError,
  configurationError,
  errorResult,
  fetchJson,
  type AdapterExternalBillingRecord,
  type AdapterExternalBillingSync,
  type UsageResult,
} from "./helpers";

const MAX_USAGE_PAGES = 100;
const MAX_COST_COMPONENTS = 250;
const MAX_LIMIT_SERVICES = 20;
const MAX_LIMIT_RECORDS = 500;
// This connector constructs the OC1 endpoint suffix itself. Keep this allowlist
// aligned with Oracle's authoritative region/realm table and fail closed for
// other realms or newly announced regions until their realm is verified:
// https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm
const OC1_COMMERCIAL_REGIONS = new Set([
  "af-casablanca-1",
  "af-johannesburg-1",
  "ap-batam-1",
  "ap-chuncheon-1",
  "ap-hyderabad-1",
  "ap-kulai-2",
  "ap-melbourne-1",
  "ap-mumbai-1",
  "ap-osaka-1",
  "ap-seoul-1",
  "ap-singapore-1",
  "ap-singapore-2",
  "ap-sydney-1",
  "ap-tokyo-1",
  "ca-montreal-1",
  "ca-toronto-1",
  "eu-amsterdam-1",
  "eu-frankfurt-1",
  "eu-madrid-1",
  "eu-madrid-3",
  "eu-marseille-1",
  "eu-milan-1",
  "eu-paris-1",
  "eu-stockholm-1",
  "eu-turin-1",
  "eu-zurich-1",
  "il-jerusalem-1",
  "me-abudhabi-1",
  "me-dubai-1",
  "me-jeddah-1",
  "me-riyadh-1",
  "mx-monterrey-1",
  "mx-queretaro-1",
  "sa-bogota-1",
  "sa-santiago-1",
  "sa-saopaulo-1",
  "sa-valparaiso-1",
  "sa-vinhedo-1",
  "us-ashburn-1",
  "us-chicago-1",
  "us-phoenix-1",
  "us-sanjose-1",
  "uk-cardiff-1",
  "uk-london-1",
]);
const OCI_PUBLICATION_LAG_CAVEAT = {
  code: "oci_usage_cost_publication_lag",
  message: "OCI Usage API cost can publish up to 48 hours late. The reported USD amount is preserved exactly, but current-month spend coverage is incomplete until OCI publishes delayed usage.",
} as const;

interface OciConfig {
  tenancyOcid: string;
  userOcid: string;
  fingerprint: string;
  privateKey: string;
  region: string;
  compartmentOcid: string;
  limitServices: string[];
  budgetCurrency: string | null;
}

interface OciUsageItem {
  computedAmount?: unknown;
  currency?: unknown;
  service?: unknown;
  timeUsageStarted?: unknown;
  timeUsageEnded?: unknown;
}

interface OciLimitItem {
  name?: unknown;
  value?: unknown;
  scopeType?: unknown;
  availabilityDomain?: unknown;
}

interface OciBudgetItem {
  id?: unknown;
  displayName?: unknown;
  amount?: unknown;
  actualSpend?: unknown;
  forecastedSpend?: unknown;
  lifecycleState?: unknown;
  resetPeriod?: unknown;
  processingPeriodType?: unknown;
  timeSpendComputed?: unknown;
  startDate?: unknown;
  endDate?: unknown;
}

function invalidResponse(message: string): never {
  throw new AdapterError(`OCI: ${message}`, { code: "INVALID_RESPONSE" });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requiredConfig(config: Record<string, unknown>, key: string): string {
  const value = stringValue(config[key]);
  if (!value) configurationError(`OCI ${key} is required`);
  return value;
}

function parseRegion(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!OC1_COMMERCIAL_REGIONS.has(normalized)) {
    configurationError(
      "OCI region must be a currently supported commercial-realm (OC1) region identifier"
    );
  }
  return normalized;
}

function parseLimitServices(value: unknown): string[] {
  if (value == null || value === "") return [];
  if (typeof value !== "string") {
    configurationError("OCI limitServices must be a comma-separated list of OCI service names");
  }
  const services = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (services.length > MAX_LIMIT_SERVICES) {
    configurationError(`OCI limitServices supports at most ${MAX_LIMIT_SERVICES} services`);
  }
  for (const service of services) {
    // This segment is encoded before use, but retain a conservative name rule
    // so service names cannot create misleading display records.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(service)) {
      configurationError("OCI limitServices contains an invalid service name");
    }
  }
  return services;
}

function parseCurrencyConfig(value: unknown, name: string): string | null {
  if (value == null || value === "") return null;
  const parsed = stringValue(value)?.toUpperCase() ?? null;
  if (!parsed || !/^[A-Z]{3}$/.test(parsed)) {
    configurationError(`OCI ${name} must be a three-letter ISO currency code`);
  }
  return parsed;
}

function parseConfig(config: Record<string, unknown>): OciConfig {
  const tenancyOcid = requiredConfig(config, "tenancyOcid");
  const userOcid = requiredConfig(config, "userOcid");
  const fingerprint = requiredConfig(config, "fingerprint");
  const privateKey = requiredConfig(config, "privateKey").replace(/\\n/g, "\n");
  if (!privateKey.includes("-----BEGIN") || !privateKey.includes("PRIVATE KEY-----")) {
    configurationError("OCI privateKey must be a PEM API signing private key");
  }
  if (!/^[0-9a-f]{2}(?::[0-9a-f]{2}){15}$/i.test(fingerprint)) {
    configurationError("OCI fingerprint must be the colon-delimited API-key fingerprint");
  }
  return {
    tenancyOcid,
    userOcid,
    fingerprint: fingerprint.toLowerCase(),
    privateKey,
    region: parseRegion(requiredConfig(config, "region")),
    compartmentOcid: stringValue(config.compartmentOcid) ?? tenancyOcid,
    limitServices: parseLimitServices(config.limitServices),
    budgetCurrency: parseCurrencyConfig(config.budgetCurrency, "budgetCurrency"),
  };
}

function bodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("base64");
}

function signHeaders(
  config: OciConfig,
  method: "POST" | "GET",
  url: URL,
  body?: string
): Record<string, string> {
  const date = new Date().toUTCString();
  const headerNames = method === "POST"
    ? ["(request-target)", "date", "host", "content-length", "content-type", "x-content-sha256"]
    : ["(request-target)", "date", "host"];
  const requestTarget = `${method.toLowerCase()} ${url.pathname}${url.search}`;
  const lines = [
    `(request-target): ${requestTarget}`,
    `date: ${date}`,
    `host: ${url.host}`,
  ];
  const headers: Record<string, string> = { date };
  if (method === "POST") {
    const content = body ?? "";
    const length = String(Buffer.byteLength(content, "utf8"));
    const sha = bodyHash(content);
    headers["content-length"] = length;
    headers["content-type"] = "application/json";
    headers["x-content-sha256"] = sha;
    lines.push(`content-length: ${length}`, "content-type: application/json", `x-content-sha256: ${sha}`);
  }
  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(lines.join("\n"), "utf8").end().sign(config.privateKey, "base64");
  } catch {
    configurationError("OCI privateKey could not sign an API request; verify the PEM and uploaded public key fingerprint");
  }
  headers.authorization = [
    "Signature version=\"1\"",
    `keyId=\"${config.tenancyOcid}/${config.userOcid}/${config.fingerprint}\"`,
    "algorithm=\"rsa-sha256\"",
    `headers=\"${headerNames.join(" ")}\"`,
    `signature=\"${signature}\"`,
  ].join(",");
  return headers;
}

function monthWindow(now = new Date()): { start: string; end: string; key: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  // OCI DAILY aggregation is day-aligned. End at this UTC day's boundary: it
  // is an exact complete-period report and avoids presenting a partial day as
  // finalized billing. OCI billing's own report latency still applies.
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start: start.toISOString(), end: end.toISOString(), key: start.toISOString().slice(0, 7) };
}

async function usageQuery(
  config: OciConfig,
  window: { start: string; end: string },
  groupBy: string[]
): Promise<OciUsageItem[]> {
  const url = new URL(`https://usageapi.${config.region}.oci.oraclecloud.com/20200107/usage`);
  const items: OciUsageItem[] = [];
  const seenPages = new Set<string>();
  let page: string | null = null;
  for (let index = 0; index < MAX_USAGE_PAGES; index += 1) {
    const requestUrl = new URL(url);
    if (page) requestUrl.searchParams.set("page", page);
    const payload: Record<string, unknown> = {
      tenantId: config.tenancyOcid,
      timeUsageStarted: window.start,
      timeUsageEnded: window.end,
      granularity: "DAILY",
      queryType: "COST",
      groupBy,
      isAggregateByTime: true,
    };
    const body = JSON.stringify(payload);
    const response = await fetchJson(requestUrl.toString(), {
      method: "POST",
      headers: signHeaders(config, "POST", requestUrl, body),
      body,
    });
    if (!response.ok) errorResult(response.status, { note: "OCI Usage API cost query failed" });
    if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) {
      invalidResponse("Usage API returned an invalid response object");
    }
    const rows = (response.data as { items?: unknown }).items;
    if (!Array.isArray(rows)) invalidResponse("Usage API response omitted items[]");
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        invalidResponse("Usage API returned an invalid item");
      }
      items.push(row as OciUsageItem);
    }
    const next = response.headers.get("opc-next-page")?.trim() || null;
    if (!next) return items;
    if (seenPages.has(next)) invalidResponse("Usage API pagination repeated an opc-next-page token");
    seenPages.add(next);
    page = next;
  }
  invalidResponse(`Usage API pagination exceeded ${MAX_USAGE_PAGES} pages`);
}

function currency(value: unknown): string | null {
  const parsed = stringValue(value)?.toUpperCase() ?? null;
  return parsed && /^[A-Z]{3}$/.test(parsed) ? parsed : null;
}

function sumCost(rows: OciUsageItem[], expectedCurrency: string): number | null {
  let total = 0;
  let matched = false;
  for (const row of rows) {
    const rowCurrency = currency(row.currency);
    const amount = finiteNumber(row.computedAmount);
    // The canonical source is authoritative only as a complete validated set.
    // Do not quietly omit a malformed row and retain an undercounted USD total.
    if (!rowCurrency || amount == null) {
      invalidResponse("canonical cost row omitted a valid currency or computedAmount");
    }
    if (rowCurrency === expectedCurrency && amount != null) {
      total += amount;
      matched = true;
    }
  }
  return matched ? total : null;
}

function idFor(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex");
}

function serviceDetailRecords(
  rows: OciUsageItem[],
  window: { start: string; end: string; key: string }
): AdapterExternalBillingRecord[] | null {
  const grouped = new Map<string, { service: string; currency: string; amount: number }>();
  for (const row of rows) {
    const service = stringValue(row.service);
    const rowCurrency = currency(row.currency);
    const amount = finiteNumber(row.computedAmount);
    if (!service || !rowCurrency || amount == null) invalidResponse("service cost detail was incomplete");
    const key = `${service}\u0000${rowCurrency}`;
    const existing = grouped.get(key) ?? { service, currency: rowCurrency, amount: 0 };
    existing.amount += amount;
    grouped.set(key, existing);
  }
  if (grouped.size > MAX_COST_COMPONENTS) return null;
  return [...grouped.values()].sort((left, right) =>
    left.currency.localeCompare(right.currency) || left.service.localeCompare(right.service)
  ).map((item) => ({
    externalId: idFor("oci-service-cost", window.key, item.currency, item.service),
    kind: "billing_period",
    serviceName: item.service,
    planName: "OCI Usage API service cost detail",
    status: "open",
    // amountUsd intentionally stays null for non-USD rows: this schema has no
    // generic foreign-currency amount field, so never mislabel it as USD.
    amountUsd: item.currency === "USD" ? item.amount : null,
    currency: item.currency,
    currentPeriodStart: window.start,
    currentPeriodEnd: window.end,
    rollupRole: "component",
    dateKind: "report_through",
  }));
}

async function fetchLimitRecords(config: OciConfig): Promise<{
  sync: AdapterExternalBillingSync | null;
  state: "not_configured" | "ready" | "partial" | "unavailable";
}> {
  if (config.limitServices.length === 0) return { sync: null, state: "not_configured" };
  const records: AdapterExternalBillingRecord[] = [];
  let failures = 0;
  for (const service of config.limitServices) {
    try {
      const seenPages = new Set<string>();
      let page: string | null = null;
      for (let index = 0; index < MAX_USAGE_PAGES; index += 1) {
        // The Limits API reference is versioned 20181025, but the documented
        // ListLimitValues operation path itself is /20190729/limitValues.
        const url = new URL(`https://limits.${config.region}.oci.oraclecloud.com/20190729/limitValues`);
        url.searchParams.set("compartmentId", config.compartmentOcid);
        url.searchParams.set("serviceName", service);
        if (page) url.searchParams.set("page", page);
        const response = await fetchJson(url.toString(), { headers: signHeaders(config, "GET", url) });
        if (!response.ok || !Array.isArray(response.data)) {
          failures += 1;
          break;
        }
        for (const row of response.data) {
          if (!row || typeof row !== "object" || Array.isArray(row)) {
            failures += 1;
            break;
          }
          const item = row as OciLimitItem;
          const name = stringValue(item.name);
          const value = finiteNumber(item.value);
          if (!name || value == null || value < 0) {
            failures += 1;
            break;
          }
          if (records.length >= MAX_LIMIT_RECORDS) return { sync: null, state: "partial" };
          const scope = stringValue(item.scopeType) ?? "unknown";
          const availabilityDomain = stringValue(item.availabilityDomain) ?? "all";
          records.push({
            externalId: idFor("oci-limit", service, name, scope, availabilityDomain),
            kind: "service_plan",
            serviceName: service,
            planName: name,
            status: "active",
            requestLimit: value,
            requestLimitWindow: scope,
            usageUnit: "resource limit",
            rollupRole: "metadata",
          });
        }
        if (failures > 0) break;
        const next = response.headers.get("opc-next-page")?.trim() || null;
        if (!next) break;
        if (seenPages.has(next)) {
          failures += 1;
          break;
        }
        seenPages.add(next);
        page = next;
        if (index === MAX_USAGE_PAGES - 1) failures += 1;
      }
    } catch {
      failures += 1;
    }
  }
  if (failures > 0) return { sync: null, state: records.length > 0 ? "partial" : "unavailable" };
  return { sync: { source: "oci-service-limits", authoritative: true, records }, state: "ready" };
}

function validOptionalDate(value: unknown): string | null {
  const text = stringValue(value);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

async function fetchBudgetRecords(config: OciConfig): Promise<{
  sync: AdapterExternalBillingSync | null;
  state: "ready" | "unavailable" | "invalid";
}> {
  const records: AdapterExternalBillingRecord[] = [];
  const seenPages = new Set<string>();
  let page: string | null = null;
  try {
    for (let index = 0; index < MAX_USAGE_PAGES; index += 1) {
      const url = new URL(`https://usage.${config.region}.oci.oraclecloud.com/20190111/budgets`);
      url.searchParams.set("compartmentId", config.tenancyOcid);
      url.searchParams.set("targetType", "ALL");
      url.searchParams.set("limit", "1000");
      if (page) url.searchParams.set("page", page);
      const response = await fetchJson(url.toString(), { headers: signHeaders(config, "GET", url) });
      if (!response.ok) return { sync: null, state: "unavailable" };
      // OCI ListBudgets returns a top-level array of BudgetSummary.
      if (!Array.isArray(response.data)) return { sync: null, state: "invalid" };
      const rows = response.data;
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row)) return { sync: null, state: "invalid" };
        const item = row as OciBudgetItem;
        const id = stringValue(item.id);
        const name = stringValue(item.displayName);
        const amount = finiteNumber(item.amount);
        const actualSpend = item.actualSpend == null ? null : finiteNumber(item.actualSpend);
        const forecastedSpend = item.forecastedSpend == null ? null : finiteNumber(item.forecastedSpend);
        const status = stringValue(item.lifecycleState);
        const resetPeriod = stringValue(item.resetPeriod);
        if (!id || !name || amount == null || amount < 0 || !status || !resetPeriod ||
          (item.actualSpend != null && actualSpend == null) ||
          (item.forecastedSpend != null && forecastedSpend == null)) {
          return { sync: null, state: "invalid" };
        }
        // OCI reports the customer-rate-card currency but not its code. Treat
        // it as a generic quota unless the operator explicitly verifies USD.
        const verifiedUsd = config.budgetCurrency === "USD";
        records.push({
          externalId: id,
          kind: "plan",
          serviceName: "Oracle Cloud Infrastructure budget",
          planName: `${name} (${resetPeriod})`,
          status: status.toLowerCase(),
          spendLimitUsd: verifiedUsd ? amount : null,
          spendLimitWindow: verifiedUsd ? resetPeriod.toLowerCase() : null,
          requestLimit: verifiedUsd ? null : amount,
          requestLimitWindow: verifiedUsd ? null : resetPeriod.toLowerCase(),
          usageQuantity: actualSpend,
          remainingQuantity: actualSpend == null ? null : Math.max(0, amount - actualSpend),
          usageUnit: verifiedUsd ? "USD" : "customer rate-card currency (unverified)",
          currentPeriodStart: validOptionalDate(item.startDate),
          currentPeriodEnd: validOptionalDate(item.endDate),
          nextRenewalAt: null,
          rollupRole: "metadata",
          dateKind: validOptionalDate(item.timeSpendComputed) ? "report_through" : null,
        });
      }
      const next = response.headers.get("opc-next-page")?.trim() || null;
      if (!next) return { sync: { source: "oci-budgets", authoritative: true, records }, state: "ready" };
      if (seenPages.has(next)) return { sync: null, state: "invalid" };
      seenPages.add(next);
      page = next;
    }
  } catch {
    return { sync: null, state: "unavailable" };
  }
  return { sync: null, state: "invalid" };
}

export async function fetchUsage(_apiKey: string, rawConfig: Record<string, unknown> = {}): Promise<UsageResult> {
  const config = parseConfig(rawConfig);
  const window = monthWindow();
  if (window.start === window.end) {
    // OCI DAILY aggregation requires complete day boundaries. On UTC day one
    // there is no completed in-month day yet, so withhold cash instead of
    // making a zero-length query or fabricating $0.
    const limits = await fetchLimitRecords(config);
    const budgets = await fetchBudgetRecords(config);
    return {
      balance: null,
      totalCost: null,
      costScope: "unknown",
      totalRequests: null,
      credits: null,
      rawData: {
        region: config.region,
        billingWindow: { start: window.start, end: window.end, dailyAligned: true },
        capabilities: {
          actualMonthToDateCost: "awaiting_first_complete_utc_day",
          serviceCostDetail: "not_queried",
          serviceLimitMetadata: limits.state,
          budgets: budgets.state,
          quotaUsage: "not_exposed_without_per-resource-availability inputs",
          subscriptionRenewal: "not_exposed",
        },
      },
      externalBillingSyncs: [limits.sync, budgets.sync].filter(
        (sync): sync is AdapterExternalBillingSync => sync != null
      ),
    };
  }
  // OCI adds currency automatically for COST queries.  It is deliberately not
  // supplied as a user groupBy dimension (the documented user dimensions do
  // not include it), while keeping it in every returned row for USD validation.
  const canonicalRows = await usageQuery(config, window, []);
  const usdCost = canonicalRows.length === 0 ? 0 : sumCost(canonicalRows, "USD");
  const currencies = [...new Set(canonicalRows.map((row) => currency(row.currency)).filter((value): value is string => value != null))].sort();

  // Detail is independent so an optional bad/oversized service breakdown can
  // never erase the canonical source or turn a successful cash response into $0.
  let detailRows: OciUsageItem[] | null = null;
  let detailState: "ready" | "unavailable" | "invalid_or_truncated" = "ready";
  try {
    detailRows = await usageQuery(config, window, ["service"]);
  } catch {
    detailState = "unavailable";
  }
  let detailRecords: AdapterExternalBillingRecord[] | null = null;
  if (detailRows) {
    try {
      detailRecords = serviceDetailRecords(detailRows, window);
      if (detailRecords == null) detailState = "invalid_or_truncated";
    } catch {
      detailState = "invalid_or_truncated";
    }
  }
  const limits = await fetchLimitRecords(config);
  const budgets = await fetchBudgetRecords(config);
  const externalBillingSyncs: AdapterExternalBillingSync[] = [];
  if (usdCost != null) {
    externalBillingSyncs.push({
      source: "oci-usage-canonical",
      authoritative: true,
      records: [{
        externalId: `${window.key}:USD`,
        kind: "billing_period",
        serviceName: "Oracle Cloud Infrastructure",
        planName: "OCI Usage API canonical cost",
        status: "open",
        amountUsd: usdCost,
        currency: "USD",
        currentPeriodStart: window.start,
        currentPeriodEnd: window.end,
        rollupRole: "canonical",
        dateKind: "report_through",
      }],
    });
  }
  if (detailRecords != null) {
    externalBillingSyncs.push({ source: "oci-usage-service-detail", authoritative: true, records: detailRecords });
  }
  if (limits.sync) externalBillingSyncs.push(limits.sync);
  if (budgets.sync) externalBillingSyncs.push(budgets.sync);
  return {
    balance: null,
    totalCost: usdCost,
    costWindowStart: usdCost == null ? null : window.start,
    costWindowEnd: usdCost == null ? null : window.end,
    costScope: usdCost == null ? "unknown" : "calendar_month_to_date",
    costCoverageCaveat: currencies.some((value) => value !== "USD")
      ? { code: "oci_non_usd_cost_not_converted", message: "OCI returned non-USD costs; only the direct USD amount is included because no FX conversion is inferred." }
      : OCI_PUBLICATION_LAG_CAVEAT,
    totalRequests: null,
    credits: null,
    rawData: {
      region: config.region,
      billingWindow: { start: window.start, end: window.end, dailyAligned: true },
      currencies,
      canonicalCost: usdCost == null ? "non_usd_only" : "usd_direct",
      capabilities: {
        actualMonthToDateCost: usdCost != null,
        serviceCostDetail: detailState,
        serviceLimitMetadata: limits.state,
        budgets: budgets.state,
        quotaUsage: "not_exposed_without_per-resource-availability inputs",
        subscriptionRenewal: "not_exposed",
      },
    },
    externalBillingSyncs,
  };
}
