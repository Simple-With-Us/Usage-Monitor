import { canonicalProviderKey } from "@/lib/provider-identity";

export interface ProviderDefinition {
  name: string;
  displayName: string;
  type: "builtin";
  category: string;
  needsAccountId?: boolean;
  needsOrgId?: boolean;
  needsOrgSlug?: boolean;
  creditBased?: boolean;
  usesApiKey?: boolean;
  defaultRefreshIntervalMin?: number;
  helpNote?: string;
  // Heading the dashboard shows for this provider's latest
  // UsageSnapshot.totalRequests. Most providers count requests, but some
  // repurpose that scalar (e.g. Render stores bandwidth in MB), so they set a
  // truthful unit label here. Unset defaults to DEFAULT_USAGE_UNIT_LABEL.
  usageUnitLabel?: string;
  // True when totalRequests is a stock/gauge at poll time (e.g. Backblaze
  // storage MB inventoried now), not a cumulative month-to-date flow.
  // Differencing a gauge into "daily requests" manufactures request spikes
  // from inventory swings, so gauge series are excluded from request-anomaly
  // detection (UM-1622). The value still drives request-limit soft caps,
  // labelled with usageUnitLabel.
  totalRequestsIsGauge?: boolean;
  /**
   * Built-ins stay in this historical registry so existing records remain
   * legible. Only `active` providers are offered for new connections or
   * automatic credential/poll maintenance.
   */
  lifecycle?: "active" | "dormant" | "retired";
  needsConfig?: {
    fields: {
      key: string;
      label: string;
      placeholder: string;
      required?: boolean;
      type?: string;
      advanced?: boolean;
      options?: { value: string; label: string }[];
    }[];
  };
}

export function hasConfiguredProviderField(
  config: Record<string, unknown>,
  fieldKey: string,
  protectedFieldPaths: string[] = []
): boolean {
  const value = config[fieldKey];
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    protectedFieldPaths.includes(fieldKey)
  );
}

const DEFINITIONS = [
  { name: "openai", displayName: "OpenAI", type: "builtin", category: "LLM/AI", helpNote: "For authoritative organization cost, add an Organization Admin key below. It is encrypted separately from the normal API key. ChatGPT Plus/Pro and Codex CLI subscription quota are MANUALLY ONLY — they are not this connector.", needsConfig: { fields: [{ key: "adminApiKey", label: "Organization Admin key (optional)", placeholder: "sk-admin-...", type: "password" }] } },
  { name: "anthropic", displayName: "Anthropic", type: "builtin", category: "LLM/AI", usesApiKey: false, helpNote: "Individual accounts cannot use Anthropic's Admin or Usage & Cost APIs, so no standard Messages API key is requested or polled for billing. Observed API activity and cost can come from pushed per-request telemetry but remains incomplete until reconciled with the Anthropic Console; paid Claude subscriptions require Subscription or receipt reconciliation. Organization accounts may optionally add an Admin API key under Advanced configuration.", needsConfig: { fields: [{ key: "adminApiKey", label: "Organization Admin API key (organization accounts only)", placeholder: "sk-ant-admin...", type: "password", advanced: true }] } },
  { name: "google-ai", displayName: "Google AI", type: "builtin", category: "LLM/AI", helpNote: "Gemini keys created in Google Cloud Console or Google AI Studio are supported. Verify & fetch checks the key without inference. For automatic project-level requests and quota limits, set the exact Gemini project and grant the encrypted service account Monitoring Viewer. The same credential can independently read actual spend when a standard Cloud Billing export dataset is configured. AI Studio prepaid balance, tier, and renewal are not exposed programmatically. Antigravity / Gemini Code Assist consumer quota is MANUALLY ONLY — use the local collector, not this connector.", needsConfig: { fields: [
    { key: "billingDataset", label: "Billing export dataset (optional)", placeholder: "billing-project.billing_export" },
    { key: "serviceAccountJson", label: "Google read-only service-account JSON (optional)", placeholder: "Paste the complete service-account JSON", type: "textarea" },
    { key: "googleProjectId", label: "Exact Gemini project ID (for usage/quota)", placeholder: "gemini-production" },
    { key: "billingTable", label: "Standard billing table ID (optional)", placeholder: "gcp_billing_export_v1_...", advanced: true },
  ] } },
  { name: "deepseek", displayName: "DeepSeek", type: "builtin", category: "LLM/AI", helpNote: "Reads the official prepaid/granted balance endpoint; DeepSeek does not expose invoice or subscription status here." },
  { name: "xai", displayName: "xAI (Grok)", type: "builtin", category: "LLM/AI", helpNote: "Requires a Management API key (not an inference key) and Team ID. Reads prepaid balance, postpaid invoice preview, billing cycle, and spending limits from xAI's billing API. SuperGrok, Grok.com, and Grok Build CLI seats are MANUALLY ONLY — they are not this connector.", needsConfig: { fields: [{ key: "teamId", label: "Team ID", placeholder: "xAI team ID", required: true }, { key: "managementKey", label: "Management API key override (optional)", placeholder: "Leave blank to use the main API key", type: "password", advanced: true }] } },
  { name: "minimax", displayName: "MiniMax", type: "builtin", category: "LLM/AI", usesApiKey: false, helpNote: "MiniMax Code subscription quota is read by the Mac-side quota collector, or entered manually — MiniMax exposes no account/billing API this connector polls. This row is MANUALLY ONLY (no fetch); no MiniMax key is requested or polled." },
  { name: "mistral", displayName: "Mistral AI", type: "builtin", category: "LLM/AI", helpNote: "Reads organization and workspace usage metadata, payment/limit status, spend cap, and rate limits with a Backoffice Admin key. Published Mistral schemas do not yet expose a safe automatic cash-total field.", needsConfig: { fields: [{ key: "adminApiKey", label: "Backoffice Admin API key (optional)", placeholder: "Admin API key", type: "password" }] } },
  { name: "kimi", displayName: "Kimi", type: "builtin", category: "LLM/AI", lifecycle: "retired", usesApiKey: false, helpNote: "Kimi is accessed exclusively through OpenRouter in this fleet, so no direct Kimi connection, key, or polling is supported. This entry exists only so boot-time retirement deactivates stray rows using this name." },
  { name: "moonshot", displayName: "Moonshot AI", type: "builtin", category: "LLM/AI", lifecycle: "retired", usesApiKey: false, helpNote: "Moonshot (Kimi) is accessed exclusively through OpenRouter in this fleet, so no direct Moonshot connection, key, or polling is supported. This entry exists only so boot-time retirement deactivates stray rows using this name." },
  { name: "openrouter", displayName: "OpenRouter", type: "builtin", category: "LLM/AI", helpNote: "Reads this key's own usage and limit from GET /key with any key. An OpenRouter Management (Provisioning) API key additionally unlocks account-wide prepaid credit balance, every configured key's individual usage/limit without exposing secrets, and a derived calendar-month-to-date cost estimate from 30-day activity history. A standard inference key degrades to reporting only its own usage and limit." },
  { name: "github", displayName: "GitHub", type: "builtin", category: "Developer Platform", helpNote: "Directly reads GitHub enhanced-billing monthly net usage, organization/enterprise budget caps, and Copilot AI-credit/premium-request detail without browser access. Use a token with Administration read (organization) or Plan read (personal). Enterprise billing endpoints require a classic PAT and reject fine-grained PATs and GitHub App user or installation tokens. No REST endpoint exposes general plan price, renewal date, receipts, or payment method.", needsConfig: { fields: [{ key: "accountType", label: "Billing account type", placeholder: "organization", options: [{ value: "organization", label: "Organization" }, { value: "user", label: "Personal user" }, { value: "enterprise", label: "Enterprise" }] }, { key: "org", label: "Account login or slug", placeholder: "organization, user, or enterprise login", required: true }, { key: "apiOrigin", label: "Enterprise API origin (optional)", placeholder: "https://api.example.ghe.com", advanced: true }] } },
  { name: "vercel", displayName: "Vercel", type: "builtin", category: "Developer Platform", lifecycle: "retired", helpNote: "Legacy Vercel records are retained for historical reporting. New Vercel connections and automatic polling are retired because this deployment does not use Vercel." },
  { name: "render", displayName: "Render", type: "builtin", category: "Infrastructure", usageUnitLabel: "Bandwidth (MB)", helpNote: "Automatically inventories account services, Postgres databases, Key Value instances, paid plans, status, and attached disks from one read-only API key. The same key also polls account-wide bandwidth for the current UTC calendar month to date (matching Render's monthly bandwidth reset) via Render's metrics API, reported in whole megabytes through the usual request-count field so a monthly limit set in MB (e.g. 200000 for ~200 GB) triggers the existing request-limit budget alerts on a spike. Render does not expose invoice/overage cost here; a bandwidth-metrics failure degrades gracefully without affecting the rest of the inventory. Bandwidth is reported as partial (and the monthly total withheld) for accounts over 200 services, and on the one or two days at the end of a long month when Render's 30-day metrics floor cannot reach the 1st." },
  { name: "oracle", displayName: "Oracle Cloud Infrastructure", type: "builtin", category: "Infrastructure", lifecycle: "retired", usesApiKey: false, defaultRefreshIntervalMin: 360, helpNote: "Legacy Oracle Cloud records are retained for historical reporting. New OCI connections and automatic polling are retired because this deployment does not use Oracle Cloud. This connector accepts Oracle's documented commercial-realm (OC1) tenancy home regions and rejects other realms or unverified new regions rather than signing the wrong endpoint. OCI cost can publish up to 48 hours late, so the exact reported USD amount is labelled incomplete until delayed usage is visible. Configure an OCI user API signing key with USAGE_REPORT_READ (or USAGE_REPORT_MANAGE) for COST queries; USAGE_ANALYSIS_READ permits only USAGE_ONLY. The private key is encrypted and never persisted in snapshots. Optional comma-separated service names fetch resource-limit metadata only. OCI budgets are customer-rate-card currency: enter budget currency only after verifying it; generic current quota consumption, subscription tier, invoice, and renewal are not exposed through this connector.", needsConfig: { fields: [{ key: "tenancyOcid", label: "Tenancy OCID", placeholder: "ocid1.tenancy.oc1...", required: true }, { key: "userOcid", label: "User OCID", placeholder: "ocid1.user.oc1...", required: true }, { key: "fingerprint", label: "API signing key fingerprint", placeholder: "aa:bb:...", required: true }, { key: "privateKey", label: "API signing private key (PEM)", placeholder: "-----BEGIN PRIVATE KEY-----", required: true, type: "textarea" }, { key: "region", label: "Supported commercial-realm (OC1) tenancy home region", placeholder: "us-ashburn-1", required: true }, { key: "budgetCurrency", label: "Verified OCI budget currency (optional)", placeholder: "USD", advanced: true }, { key: "compartmentOcid", label: "Quota compartment OCID (optional; defaults to tenancy)", placeholder: "ocid1.compartment.oc1...", advanced: true }, { key: "limitServices", label: "Quota service names (optional, comma-separated)", placeholder: "compute,blockstorage", advanced: true }] } },
  { name: "pinecone", displayName: "Pinecone", type: "builtin", category: "Vector DB", helpNote: "Automatically inventories indexes and non-billable index statistics plus backups, collections, and assistants when those control-plane APIs are available. Pinecone billing cost and renewal are not exposed." },
  { name: "voyage", displayName: "Voyage AI", type: "builtin", category: "Vector DB", usesApiKey: false, helpNote: "No non-billable account or usage API is available. This row is MANUALLY ONLY (no fetch); no key is requested or polled. Add a Subscription or push cost events so projected charts include Voyage." },
  { name: "roic", displayName: "ROIC.ai", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No documented non-billable usage/billing API is wired here yet. This row is MANUALLY ONLY (no fetch): track the ROIC plan as a Subscription (or push cost events) so it appears in projected costs and Overview. ROIC_API_KEY is not used for polling." },
  { name: "fmp", displayName: "FMP", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public usage API. This row is MANUALLY ONLY (no fetch); no market-data call or key is used by polling." },
  { name: "finnhub", displayName: "Finnhub", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public account usage API. This row is MANUALLY ONLY (no fetch); no market-data call or key is used by polling." },
  { name: "alphavantage", displayName: "Alpha Vantage", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public account usage API. This row is MANUALLY ONLY (no fetch); no market-data call or key is used by polling." },
  { name: "tradier", displayName: "Tradier", type: "builtin", category: "Brokerage", lifecycle: "retired", helpNote: "Legacy Tradier records are retained for historical reporting. New broker connections and automatic polling are retired because their limited usage is not a monitored paid service." },
  { name: "marketstack", displayName: "Marketstack", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public account usage API. This row is MANUALLY ONLY (no fetch); no market-data call or key is used by polling." },
  { name: "intrinio", displayName: "Intrinio", type: "builtin", category: "Market Data", lifecycle: "retired", helpNote: "Legacy Intrinio records are retained for historical reporting. New connections and automatic polling are retired." },
  { name: "tiingo", displayName: "Tiingo", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public account usage API. This row is MANUALLY ONLY (no fetch); no API-test call or key is used by polling." },
  { name: "twelvedata", displayName: "Twelve Data", type: "builtin", category: "Market Data", defaultRefreshIntervalMin: 1440, usageUnitLabel: "API credits", helpNote: "Reads the current /api_usage response for plan plus separate minute and daily used/limit/remaining quotas, with legacy header fallback. Each poll consumes one API credit, so new connections default to daily sync. Price and renewal remain manual." },
  { name: "fintech-studios", displayName: "FinTech Studios", type: "builtin", category: "Market Data", defaultRefreshIntervalMin: 360, helpNote: "Reads the zero-credit /me account endpoint for tier, credit balance, monthly allowance, daily cap/usage/reset, and API rate-limit metadata. USD billing cost, invoices, and renewal are not exposed." },
  { name: "massive", displayName: "Massive", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public account usage API. This row is MANUALLY ONLY (no fetch); no aggregate-data call or key is used by polling." },
  { name: "fred", displayName: "FRED", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "Free federal data with no account billing state. No key or data request is used by polling." },
  { name: "quiver-quant", displayName: "Quiver Quantitative", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "Quiver Quantitative does not expose a billing or usage quota API endpoint. This row is MANUALLY ONLY (no fetch); no market-data call or key is used by polling. Usage is tracked via the provider dashboard." },
  { name: "unusual-whales", displayName: "Unusual Whales", type: "builtin", category: "Market Data", defaultRefreshIntervalMin: 1440, helpNote: "Unusual Whales exposes no account, plan, or billing endpoint. Each poll makes one minimal /api/congress/recent-trades request (limit=1) solely to read the x-uw-daily-req-count response header, the account's cumulative request count for the current provider day (resets 8:00pm ET, not midnight). That poll consumes exactly one request against the same daily counter as any other authenticated call, so new connections default to daily sync. Request limit, USD price, and renewal date are not exposed. Trial accounts convert to the paid Premium tier (~$50/mo) when the free trial ends; track the exact conversion date on this provider's Subscription record." },
  { name: "sentry", displayName: "Sentry", type: "builtin", category: "Observability", needsOrgSlug: true, usageUnitLabel: "Events", helpNote: "Enter the Sentry org slug to fetch exact UTC calendar-month-to-date stats by project, category, and outcome (Errors, Transactions, Replays, Attachments, Profiles, Monitors).  Event counts, bytes, and duration stay unit-separated.  This is usage metadata, not invoice cost, prepaid credit, remaining sponsored balance, or plan quota." },
  { name: "langfuse", displayName: "Langfuse", type: "builtin", category: "Observability", defaultRefreshIntervalMin: 360, usageUnitLabel: "Billable units", helpNote: "Reads calendar-month trace, observation, numeric-score, and categorical-score counts. Four metrics reads are required per sync, so new connections default to every six hours. Tracked model cost is diagnostic and is not the Langfuse subscription fee.", needsConfig: { fields: [{ key: "publicKey", label: "Public key (optional if API Key is the public key)", placeholder: "pk-lf-..." }, { key: "secretKey", label: "Secret key", placeholder: "sk-lf-...", required: true, type: "password" }, { key: "host", label: "Host (optional)", placeholder: "https://cloud.langfuse.com" }] } },
  { name: "twilio", displayName: "Twilio", type: "builtin", category: "Notifications", needsAccountId: true, helpNote: "Reads account balance and the official ThisMonth Usage Record total price. Use an Auth Token or restricted key with billing usage read access.", needsConfig: { fields: [{ key: "apiKeySid", label: "Restricted API Key SID (optional)", placeholder: "SK..." }] } },
  { name: "resend", displayName: "Resend", type: "builtin", category: "Notifications", helpNote: "Reads the non-sending API-key control plane plus provider-reported monthly and daily email counts used. Those headers are usage counts, not limits; plan, remaining quota, price, and renewal stay unknown." },
  { name: "pushover", displayName: "Pushover", type: "builtin", category: "Notifications", usageUnitLabel: "Messages", helpNote: "Reads the application message limit, remaining messages, and reset date. The API does not expose subscription price." },
  { name: "cloudflare", displayName: "Cloudflare", type: "builtin", category: "Infrastructure", needsAccountId: true, helpNote: "Reads fixed subscriptions and, for eligible PayGo accounts, billing-grade usage cost. A Billing Read API token needs no email; email is only for a Global API key. The optional D1, R2, KV, and Queue fields are single-resource metadata/readability probes only; they do not affect billing, subscriptions, spend, usage, quotas, or PayGo eligibility." },
  { name: "hetzner", displayName: "Hetzner Cloud", type: "builtin", category: "Infrastructure", helpNote: "Inventories servers, volumes, floating/primary IPs, load balancers, and snapshots from the Hetzner Cloud API (one read token per project). totalCost is an estimated month-to-date from the public pricing catalog × current inventory, pro-rated by UTC month elapsed — labelled with a costCoverageCaveat (not an invoice). Accrued invoice / billing-history endpoints are not available on the public API." },
  { name: "backblaze", displayName: "Backblaze B2", type: "builtin", category: "Infrastructure", usageUnitLabel: "Storage (MB)", totalRequestsIsGauge: true, defaultRefreshIntervalMin: 360, helpNote: "Inventories B2 buckets and file versions (including hidden versions that still bill) via the Native API with a read-only application key (listBuckets + listFiles). totalRequests is whole megabytes of stored data so a monthly request limit in MB can soft-cap storage (it is a storage gauge, excluded from request-anomaly detection); totalCost is an estimated MTD from public storage pricing × billable GB after the free allowance, pro-rated by UTC month — labelled with a costCoverageCaveat (not an invoice). Download bandwidth and Class A/B API transactions are not exposed by inventory APIs; set ProviderPlan.monthlyBudgetUsd and console Caps & Alerts for hard protection. Prefer a dedicated read-only key (not write/delete backup keys). API key = applicationKey; Application Key ID is required config (or pass keyId:applicationKey as the single API key field).", needsConfig: { fields: [{ key: "applicationKeyId", label: "Application Key ID", placeholder: "003…", required: true }, { key: "storageCapGb", label: "Soft storage cap (GB, optional)", placeholder: "50", advanced: true }, { key: "storagePricePerGbMonth", label: "Storage price $/GB-month (optional)", placeholder: "0.006", advanced: true }, { key: "freeStorageGb", label: "Free storage allowance GB (optional)", placeholder: "10", advanced: true }] } },
  { name: "coolify", displayName: "Coolify", type: "builtin", category: "Infrastructure", helpNote: "Reads server reachability/usability and application deployment status (up/down, degraded) from a Coolify instance's REST API, plus a best-effort per-server inventory of its applications, databases, and services. Coolify is a self-hosted PaaS control plane, not a metered vendor, so this connector reports no cost, invoice, or subscription state - that is intentionally left blank rather than shown as $0. Live CPU/memory/disk utilization is pushed by Coolify's optional Sentinel agent into the instance's own database and is not exposed by any documented REST endpoint, so it is not read here. Defaults to the Coolify Cloud API; set Host for a self-hosted instance.", needsConfig: { fields: [{ key: "host", label: "Host (optional; defaults to Coolify Cloud)", placeholder: "https://coolify.example.com" }] } },
  { name: "deno", displayName: "Deno Deploy", type: "builtin", category: "Developer Platform", lifecycle: "retired", helpNote: "Legacy Deno Deploy records are retained for historical reporting.  New Deno Deploy connections and automatic polling are retired because this host is dead.  Congress.Trade and other Jay apps now run on Coolify, not Deno Deploy.", needsConfig: { fields: [{ key: "orgSlug", label: "Organization slug (optional, historical)", placeholder: "legacy-org" }] } },
  { name: "apify", displayName: "Apify", type: "builtin", category: "Data", creditBased: true, helpNote: "Reads billing cycle, usage USD, maximum usage, active plan, base price, and included credits from official account APIs." },
  { name: "firecrawl", displayName: "Firecrawl", type: "builtin", category: "Data", lifecycle: "dormant", creditBased: true, helpNote: "Firecrawl support is retained but dormant until this deployment uses it. Historical records remain available; new connections and automatic polling are off." },
  { name: "llamaindex", displayName: "LlamaIndex Cloud", type: "builtin", category: "Data", defaultRefreshIntervalMin: 360, helpNote: "Discovers organizations and reads paginated UTC month-to-date product credits consumed from the beta usage-metrics control plane, optionally filtered by project. Remaining balance, USD cost, plan, and renewal are not exposed.", needsConfig: { fields: [{ key: "projectId", label: "Project ID (optional)", placeholder: "Project UUID" }, { key: "host", label: "Host (optional)", placeholder: "https://api.cloud.llamaindex.ai" }] } },
  { name: "stripe", displayName: "Stripe", type: "builtin", category: "Payments", helpNote: "Tracks merchant balance and actual month-to-date Stripe processing fees. Customer subscriptions and merchant revenue are never counted as provider cost." },
  { name: "namecheap", displayName: "Namecheap", type: "builtin", category: "Infrastructure", usageUnitLabel: "Domains", helpNote: "Reads prepaid account balance, funds required for auto-renewal, and active domain inventory with upcoming expiration dates from the official Namecheap XML API. Requires an API key, the Namecheap account username, and whitelisted IP address.", needsConfig: { fields: [{ key: "apiUser", label: "Namecheap Account Username", placeholder: "jaywedgeworth", required: true }, { key: "clientIp", label: "Whitelisted Client IP", placeholder: "99.44.91.248", required: true }] } },
  { name: "robinhood", displayName: "Robinhood", type: "builtin", category: "Brokerage", lifecycle: "retired", usesApiKey: false, helpNote: "Legacy Robinhood records are retained for historical reporting. New broker connections and automatic polling are retired." },
  { name: "alpaca", displayName: "Alpaca", type: "builtin", category: "Brokerage", lifecycle: "retired", helpNote: "Legacy Alpaca records are retained for historical reporting. New broker connections and automatic polling are retired because their limited usage is not a monitored paid service." },
] as const satisfies readonly ProviderDefinition[];

export type BuiltInProviderName = (typeof DEFINITIONS)[number]["name"];

export const BUILT_IN_PROVIDERS: readonly ProviderDefinition[] = DEFINITIONS;

export type BuiltInProviderLifecycle = NonNullable<ProviderDefinition["lifecycle"]>;

export function builtInProviderLifecycle(
  name: string,
  providerType: string = "builtin"
): BuiltInProviderLifecycle {
  if (providerType.trim().toLowerCase() !== "builtin") return "active";
  const definition = BUILT_IN_PROVIDERS.find(
    (provider) => canonicalProviderKey(provider.name) === canonicalProviderKey(name)
  );
  return definition?.lifecycle ?? "active";
}

export function isBuiltInProviderActive(
  name: string,
  providerType: string = "builtin"
): boolean {
  return builtInProviderLifecycle(name, providerType) === "active";
}

export function isDecommissionedBuiltInProvider(provider: {
  name: string;
  type?: string | null;
}): boolean {
  return (
    provider.type?.trim().toLowerCase() === "builtin" &&
    !isBuiltInProviderActive(provider.name, provider.type)
  );
}

/**
 * Creation and fetch boundaries use the canonical name without trusting a
 * caller-supplied type. Otherwise a retired integration could be reintroduced
 * as `custom` while still presenting itself as the retired provider.
 */
export function isDecommissionedProviderName(name: string): boolean {
  return builtInProviderLifecycle(name) !== "active";
}

/**
 * Fleet policy category for chat/inference vendors. Because all chat LLM
 * traffic routes through OpenRouter, no provider in this category is a hard
 * production dependency and none may demand `mustKeepFunded`.
 */
export const LLM_PROVIDER_CATEGORY = "LLM/AI";

/**
 * Category of the built-in definition matching this canonical name, or null
 * for unknown/custom names. Like isDecommissionedProviderName, this keys off
 * the canonical name alone so a caller-supplied type cannot dodge policy.
 */
export function builtInProviderCategory(name: string): string | null {
  const definition = BUILT_IN_PROVIDERS.find(
    (provider) => canonicalProviderKey(provider.name) === canonicalProviderKey(name)
  );
  return definition?.category ?? null;
}

/** True when the canonical name belongs to the LLM/AI definitions category. */
export function isLlmProviderName(name: string): boolean {
  return builtInProviderCategory(name) === LLM_PROVIDER_CATEGORY;
}

/** Built-ins offered when an operator creates a new connection. */
export const ADDABLE_BUILT_IN_PROVIDERS = BUILT_IN_PROVIDERS.filter((provider) =>
  isBuiltInProviderActive(provider.name)
);

/**
 * Fallback heading for the UsageSnapshot.totalRequests dashboard stat when a
 * provider has not declared a more specific usageUnitLabel.
 */
export const DEFAULT_USAGE_UNIT_LABEL = "Requests";

/**
 * Resolve the unit heading the shared dashboard should show for a provider's
 * latest totalRequests value. Keyed by canonical provider name so alias forms
 * (e.g. "google_ai") resolve alongside their built-in definition. Unknown or
 * custom providers fall back to "Requests".
 */
export function usageUnitLabelForProvider(
  name: string,
  providerType: string = "builtin"
): string {
  if (providerType.trim().toLowerCase() !== "builtin") {
    return DEFAULT_USAGE_UNIT_LABEL;
  }
  const canonical = canonicalProviderKey(name);
  const definition = BUILT_IN_PROVIDERS.find(
    (provider) => canonicalProviderKey(provider.name) === canonical
  );
  return definition?.usageUnitLabel ?? DEFAULT_USAGE_UNIT_LABEL;
}

/**
 * True when a built-in provider's totalRequests is a gauge (stock at poll
 * time, e.g. Backblaze storage MB) rather than a cumulative flow. Keyed by
 * canonical name like usageUnitLabelForProvider. Gauge series must not be
 * differenced into daily "requests" for anomaly detection (UM-1622).
 */
export function isTotalRequestsGaugeProvider(
  name: string,
  providerType: string = "builtin"
): boolean {
  if (providerType.trim().toLowerCase() !== "builtin") {
    return false;
  }
  const canonical = canonicalProviderKey(name);
  const definition = BUILT_IN_PROVIDERS.find(
    (provider) => canonicalProviderKey(provider.name) === canonical
  );
  return definition?.totalRequestsIsGauge ?? false;
}

export const PROVIDER_CATEGORIES = [
  "LLM/AI",
  "Developer Platform",
  "Vector DB",
  "Market Data",
  "Observability",
  "Notifications",
  "Infrastructure",
  "Data",
  "Payments",
  "Brokerage",
] as const;
