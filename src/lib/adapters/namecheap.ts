import {
  AdapterError,
  configurationError,
  errorResult,
  fetchJson,
  parseNumber,
  type UsageResult,
} from "./helpers";

export interface NamecheapDomainRecord {
  id: string;
  name: string;
  user?: string;
  created?: string;
  expires?: string;
  isExpired?: boolean;
  isLocked?: boolean;
  autoRenew?: boolean;
  whoisGuard?: string;
}

export interface NamecheapBalances {
  currency: string;
  availableBalance: number | null;
  accountBalance: number | null;
  earnedAmount: number | null;
  withdrawableAmount: number | null;
  fundsRequiredForAutoRenew: number | null;
}

/**
 * Parses XML attributes from a given tag string into a key-value map.
 */
function parseXmlAttributes(tagString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(tagString)) !== null) {
    attrs[match[1]] = match[2] ?? match[3] ?? "";
  }
  return attrs;
}

/**
 * Extracts error messages from Namecheap XML API response.
 */
export function extractNamecheapErrors(xml: string): string[] {
  const errors: string[] = [];
  const errorRegex = /<Error[^>]*>([^<]+)<\/Error>/gi;
  let match: RegExpExecArray | null;
  while ((match = errorRegex.exec(xml)) !== null) {
    const msg = match[1]?.trim();
    if (msg) errors.push(msg);
  }
  return errors;
}

/**
 * Parses the UserGetBalancesResult element from XML response.
 */
export function parseBalancesXml(xml: string): NamecheapBalances | null {
  const match = /<UserGetBalancesResult\b([^>]*)\/?>/i.exec(xml);
  if (!match) return null;

  const attrs = parseXmlAttributes(match[1]);
  return {
    currency: attrs.Currency || "USD",
    availableBalance: parseNumber(attrs.AvailableBalance),
    accountBalance: parseNumber(attrs.AccountBalance),
    earnedAmount: parseNumber(attrs.EarnedAmount),
    withdrawableAmount: parseNumber(attrs.WithdrawableAmount),
    fundsRequiredForAutoRenew: parseNumber(attrs.FundsRequiredForAutoRenew),
  };
}

/**
 * Parses domain items from DomainGetListResult XML response.
 */
export function parseDomainsXml(
  xml: string
): { domains: NamecheapDomainRecord[]; totalItems: number | null; pageSize: number } {
  const domains: NamecheapDomainRecord[] = [];
  const domainRegex = /<Domain\b([^>]*)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = domainRegex.exec(xml)) !== null) {
    const attrs = parseXmlAttributes(match[1]);
    if (attrs.Name) {
      domains.push({
        id: attrs.ID || attrs.Name,
        name: attrs.Name,
        user: attrs.User,
        created: attrs.Created,
        expires: attrs.Expires,
        isExpired: attrs.IsExpired?.toLowerCase() === "true",
        isLocked: attrs.IsLocked?.toLowerCase() === "true",
        autoRenew: attrs.AutoRenew?.toLowerCase() === "true",
        whoisGuard: attrs.WhoisGuard,
      });
    }
  }

  const pagingMatch = /<TotalItems>(\d+)<\/TotalItems>/i.exec(xml);
  const totalItems = pagingMatch ? Number.parseInt(pagingMatch[1], 10) : domains.length;

  const pageSizeMatch = /<PageSize>(\d+)<\/PageSize>/i.exec(xml);
  const pageSize = pageSizeMatch ? Number.parseInt(pageSizeMatch[1], 10) : 100;

  return { domains, totalItems, pageSize };
}

/**
 * Validates and normalizes the Namecheap API base URL to ensure credential-bearing
 * requests are only sent to official Namecheap endpoints.
 */
export function validateNamecheapBaseUrl(rawUrl?: string): string {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return "https://api.namecheap.com/xml.response";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") {
      configurationError("baseUrl for Namecheap must use HTTPS protocol");
    }
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname !== "api.namecheap.com" &&
      hostname !== "api.sandbox.namecheap.com"
    ) {
      configurationError(
        `baseUrl must be an official Namecheap endpoint (https://api.namecheap.com/xml.response or https://api.sandbox.namecheap.com/xml.response), got: ${hostname}`
      );
    }
    return parsed.toString();
  } catch (err) {
    if (err instanceof AdapterError) throw err;
    configurationError(`Invalid Namecheap baseUrl: ${trimmed}`);
  }
}

export async function fetchUsage(
  apiKey: string,
  config?: Record<string, unknown>
): Promise<UsageResult> {
  const trimmedKey = apiKey?.trim();
  if (!trimmedKey) {
    configurationError("apiKey is required for Namecheap");
  }

  const apiUser = (
    (config?.apiUser as string | undefined) ||
    (config?.userName as string | undefined) ||
    (config?.username as string | undefined) ||
    process.env.NAMECHEAP_API_USER ||
    process.env.NAMECHEAP_USER_NAME ||
    ""
  ).trim();

  if (!apiUser) {
    configurationError(
      "apiUser (Namecheap Account Username) is required in config or NAMECHEAP_API_USER env"
    );
  }

  const userName = (
    (config?.userName as string | undefined) ||
    (config?.username as string | undefined) ||
    process.env.NAMECHEAP_USER_NAME ||
    apiUser
  ).trim();

  const clientIp = (
    (config?.clientIp as string | undefined) ||
    (config?.clientIP as string | undefined) ||
    process.env.NAMECHEAP_CLIENT_IP ||
    ""
  ).trim();

  if (!clientIp || clientIp === "127.0.0.1" || clientIp === "localhost") {
    configurationError(
      "clientIp (whitelisted public IP) is required for Namecheap in config or NAMECHEAP_CLIENT_IP env"
    );
  }

  const baseUrl = validateNamecheapBaseUrl(config?.baseUrl as string | undefined);

  const balancesUrl = new URL(baseUrl);
  balancesUrl.searchParams.set("ApiUser", apiUser);
  balancesUrl.searchParams.set("ApiKey", trimmedKey);
  balancesUrl.searchParams.set("UserName", userName);
  balancesUrl.searchParams.set("ClientIP", clientIp);
  balancesUrl.searchParams.set("Command", "namecheap.users.getBalances");

  const domainsUrl = new URL(baseUrl);
  domainsUrl.searchParams.set("ApiUser", apiUser);
  domainsUrl.searchParams.set("ApiKey", trimmedKey);
  domainsUrl.searchParams.set("UserName", userName);
  domainsUrl.searchParams.set("ClientIP", clientIp);
  domainsUrl.searchParams.set("Command", "namecheap.domains.getList");
  domainsUrl.searchParams.set("PageSize", "100");
  domainsUrl.searchParams.set("Page", "1");

  const [balancesRes, domainsRes] = await Promise.all([
    fetchJson(balancesUrl.toString()),
    fetchJson(domainsUrl.toString()),
  ]);

  const balancesRawText = typeof balancesRes.data === "string" ? balancesRes.data : "";
  const domainsRawText = typeof domainsRes.data === "string" ? domainsRes.data : "";

  // Check for API-level errors in XML envelopes
  const balancesErrors = extractNamecheapErrors(balancesRawText);
  if (!balancesRes.ok || balancesErrors.length > 0) {
    const status = balancesRes.status || 400;
    const isRetryable = status === 429 || (status >= 500 && status < 600);
    const errorMsg =
      balancesErrors.length > 0
        ? balancesErrors.join("; ")
        : `HTTP ${status}`;
    throw new AdapterError(`Namecheap API balance error: ${errorMsg}`, {
      code: "HTTP_ERROR",
      status,
      retryable: isRetryable,
    });
  }

  const domainsErrors = extractNamecheapErrors(domainsRawText);
  if (!domainsRes.ok || domainsErrors.length > 0) {
    const status = domainsRes.status || 400;
    const isRetryable = status === 429 || (status >= 500 && status < 600);
    const errorMsg =
      domainsErrors.length > 0
        ? domainsErrors.join("; ")
        : `HTTP ${status}`;
    throw new AdapterError(`Namecheap API domain list error: ${errorMsg}`, {
      code: "HTTP_ERROR",
      status,
      retryable: isRetryable,
    });
  }

  const balances = parseBalancesXml(balancesRawText);
  const firstPage = parseDomainsXml(domainsRawText);
  const allDomains: NamecheapDomainRecord[] = [...firstPage.domains];
  const totalItems = firstPage.totalItems ?? allDomains.length;
  const pageSize = firstPage.pageSize > 0 ? firstPage.pageSize : 100;
  const totalPages = Math.ceil(totalItems / pageSize);
  const maxPages = 200;
  const pagesToFetch = Math.min(totalPages, maxPages);

  // Fetch remaining domain pages if inventory exceeds page 1
  for (let page = 2; page <= pagesToFetch && allDomains.length < totalItems; page++) {
    const pageUrl = new URL(baseUrl);
    pageUrl.searchParams.set("ApiUser", apiUser);
    pageUrl.searchParams.set("ApiKey", trimmedKey);
    pageUrl.searchParams.set("UserName", userName);
    pageUrl.searchParams.set("ClientIP", clientIp);
    pageUrl.searchParams.set("Command", "namecheap.domains.getList");
    pageUrl.searchParams.set("PageSize", String(pageSize));
    pageUrl.searchParams.set("Page", String(page));

    const pageRes = await fetchJson(pageUrl.toString());
    const pageRawText = typeof pageRes.data === "string" ? pageRes.data : "";
    const pageErrors = extractNamecheapErrors(pageRawText);
    if (!pageRes.ok || pageErrors.length > 0) {
      const status = pageRes.status || 400;
      const isRetryable = status === 429 || (status >= 500 && status < 600);
      const errorMsg =
        pageErrors.length > 0
          ? pageErrors.join("; ")
          : `HTTP ${status}`;
      throw new AdapterError(`Namecheap API domain list page ${page} error: ${errorMsg}`, {
        code: "HTTP_ERROR",
        status,
        retryable: isRetryable,
      });
    }

    const { domains: pageDomains } = parseDomainsXml(pageRawText);
    if (pageDomains.length === 0) break;
    allDomains.push(...pageDomains);
  }

  const isPartial = allDomains.length < totalItems;
  const availableBalance = balances?.availableBalance ?? balances?.accountBalance ?? null;

  return {
    balance: availableBalance,
    totalCost: null,
    totalRequests: totalItems,
    credits: availableBalance,
    rawData: {
      balances,
      domains: allDomains,
      totalDomains: totalItems,
      apiUser,
      ...(isPartial ? { isPartial: true } : {}),
    },
  };
}
