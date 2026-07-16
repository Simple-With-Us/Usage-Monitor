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
  { name: "openai", displayName: "OpenAI", type: "builtin", category: "LLM/AI", helpNote: "For authoritative organization cost, add an Organization Admin key below. It is encrypted separately from the normal API key.", needsConfig: { fields: [{ key: "adminApiKey", label: "Organization Admin key (optional)", placeholder: "sk-admin-...", type: "password" }] } },
  { name: "anthropic", displayName: "Anthropic", type: "builtin", category: "LLM/AI", usesApiKey: false, helpNote: "Individual accounts cannot use Anthropic's Admin or Usage & Cost APIs, so no standard Messages API key is requested or polled for billing. Observed API activity and cost can come from pushed per-request telemetry but remains incomplete until reconciled with the Anthropic Console; paid Claude subscriptions require Subscription or receipt reconciliation. Organization accounts may optionally add an Admin API key under Advanced configuration.", needsConfig: { fields: [{ key: "adminApiKey", label: "Organization Admin API key (organization accounts only)", placeholder: "sk-ant-admin...", type: "password", advanced: true }] } },
  { name: "google-ai", displayName: "Google AI", type: "builtin", category: "LLM/AI", helpNote: "Gemini keys created in Google Cloud Console or Google AI Studio are supported. Verify & fetch checks the key without inference. For automatic project-level requests and quota limits, set the exact Gemini project and grant the encrypted service account Monitoring Viewer. The same credential can independently read actual spend when a standard Cloud Billing export dataset is configured. AI Studio prepaid balance, tier, and renewal are not exposed programmatically.", needsConfig: { fields: [
    { key: "billingDataset", label: "Billing export dataset (optional)", placeholder: "billing-project.billing_export" },
    { key: "serviceAccountJson", label: "Google read-only service-account JSON (optional)", placeholder: "Paste the complete service-account JSON", type: "textarea" },
    { key: "googleProjectId", label: "Exact Gemini project ID (for usage/quota)", placeholder: "gemini-production" },
    { key: "billingTable", label: "Standard billing table ID (optional)", placeholder: "gcp_billing_export_v1_...", advanced: true },
  ] } },
  { name: "deepseek", displayName: "DeepSeek", type: "builtin", category: "LLM/AI", helpNote: "Reads the official prepaid/granted balance endpoint; DeepSeek does not expose invoice or subscription status here." },
  { name: "xai", displayName: "xAI (Grok)", type: "builtin", category: "LLM/AI", helpNote: "Reads prepaid balance, postpaid invoice preview, billing cycle, and spending limits through the Management API.", needsConfig: { fields: [{ key: "teamId", label: "Team ID", placeholder: "xAI team ID", required: true }, { key: "managementKey", label: "Management API key (optional)", placeholder: "Management API key", type: "password" }] } },
  { name: "mistral", displayName: "Mistral AI", type: "builtin", category: "LLM/AI", helpNote: "Reads organization usage, payment/limit status, spend cap, and rate limits with a Backoffice Admin key.", needsConfig: { fields: [{ key: "adminApiKey", label: "Backoffice Admin API key (optional)", placeholder: "Admin API key", type: "password" }] } },
  { name: "openrouter", displayName: "OpenRouter", type: "builtin", category: "LLM/AI", helpNote: "Reads this key's own usage and limit from GET /key with any key. An OpenRouter Management (Provisioning) API key additionally unlocks account-wide prepaid credit balance, every configured key's individual usage/limit without exposing secrets, and a derived calendar-month-to-date cost estimate from 30-day activity history. A standard inference key degrades to reporting only its own usage and limit." },
  { name: "github", displayName: "GitHub", type: "builtin", category: "Developer Platform", helpNote: "Uses GitHub enhanced-billing APIs for metered usage and net cost. Enter the organization login the token can read.", needsConfig: { fields: [{ key: "org", label: "Organization", placeholder: "GitHub organization login", required: true }] } },
  { name: "vercel", displayName: "Vercel", type: "builtin", category: "Developer Platform", helpNote: "Reads account/team billing and usage. Leave Team ID blank for the token owner's personal scope.", needsConfig: { fields: [{ key: "teamId", label: "Team ID (optional)", placeholder: "team_..." }] } },
  { name: "render", displayName: "Render", type: "builtin", category: "Developer Platform", helpNote: "Automatically inventories account services, Postgres databases, Key Value instances, paid plans, status, and attached disks from one read-only API key. Render does not expose invoice cost here." },
  { name: "pinecone", displayName: "Pinecone", type: "builtin", category: "Vector DB", helpNote: "Automatically inventories indexes and non-billable index statistics plus backups, collections, and assistants when those control-plane APIs are available. Pinecone billing cost and renewal are not exposed." },
  { name: "voyage", displayName: "Voyage AI", type: "builtin", category: "Vector DB", usesApiKey: false, helpNote: "No non-billable account or usage API is available. This row is push/manual; no key is requested or polled." },
  { name: "fmp", displayName: "FMP", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public usage API. This row is push/manual; no market-data call or key is used by polling." },
  { name: "finnhub", displayName: "Finnhub", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public account usage API. This row is push/manual; no market-data call or key is used by polling." },
  { name: "alphavantage", displayName: "Alpha Vantage", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public account usage API. This row is push/manual; no market-data call or key is used by polling." },
  { name: "tradier", displayName: "Tradier", type: "builtin", category: "Market Data", helpNote: "Reads documented API rate-limit headers and a brokerage account portfolio summary; portfolio value is not treated as provider spend." },
  { name: "marketstack", displayName: "Marketstack", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public account usage API. This row is push/manual; no market-data call or key is used by polling." },
  { name: "intrinio", displayName: "Intrinio", type: "builtin", category: "Market Data", helpNote: "Reads the official per-feed current-usage, limit, remaining-call, and reset-window endpoint. Pricing remains manual." },
  { name: "tiingo", displayName: "Tiingo", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public account usage API. This row is push/manual; no API-test call or key is used by polling." },
  { name: "twelvedata", displayName: "Twelve Data", type: "builtin", category: "Market Data", defaultRefreshIntervalMin: 1440, helpNote: "Reads the current /api_usage response for plan plus separate minute and daily used/limit/remaining quotas, with legacy header fallback. Each poll consumes one API credit, so new connections default to daily sync. Price and renewal remain manual." },
  { name: "fintech-studios", displayName: "FinTech Studios", type: "builtin", category: "Market Data", defaultRefreshIntervalMin: 360, helpNote: "Reads the zero-credit /me account endpoint for tier, credit balance, monthly allowance, daily cap/usage/reset, and API rate-limit metadata. USD billing cost, invoices, and renewal are not exposed." },
  { name: "massive", displayName: "Massive", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public account usage API. This row is push/manual; no aggregate-data call or key is used by polling." },
  { name: "fred", displayName: "FRED", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "Free federal data with no account billing state. No key or data request is used by polling." },
  { name: "quiver-quant", displayName: "Quiver Quantitative", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "Quiver Quantitative does not expose a billing or usage quota API endpoint. This row is push/manual; no market-data call or key is used by polling. Usage is tracked via the provider dashboard." },
  { name: "unusual-whales", displayName: "Unusual Whales", type: "builtin", category: "Market Data", defaultRefreshIntervalMin: 1440, helpNote: "Unusual Whales exposes no account, plan, or billing endpoint. Each poll makes one minimal /api/congress/recent-trades request (limit=1) solely to read the x-uw-daily-req-count response header, the account's cumulative request count for the current provider day (resets 8:00pm ET, not midnight). That poll consumes exactly one request against the same daily counter as any other authenticated call, so new connections default to daily sync. Request limit, USD price, and renewal date are not exposed. Trial accounts convert to the paid Premium tier (~$50/mo) when the free trial ends; track the exact conversion date on this provider's Subscription record." },
  { name: "sentry", displayName: "Sentry", type: "builtin", category: "Observability", needsOrgSlug: true, helpNote: "Enter the Sentry org slug to fetch exact UTC calendar-month-to-date stats by project, category, and outcome. Event counts, bytes, and duration stay unit-separated; this is usage metadata, not invoice cost or plan quota." },
  { name: "langfuse", displayName: "Langfuse", type: "builtin", category: "Observability", defaultRefreshIntervalMin: 360, helpNote: "Reads calendar-month trace, observation, numeric-score, and categorical-score counts. Four metrics reads are required per sync, so new connections default to every six hours. Tracked model cost is diagnostic and is not the Langfuse subscription fee.", needsConfig: { fields: [{ key: "publicKey", label: "Public key (optional if API Key is the public key)", placeholder: "pk-lf-..." }, { key: "secretKey", label: "Secret key", placeholder: "sk-lf-...", required: true, type: "password" }, { key: "host", label: "Host (optional)", placeholder: "https://cloud.langfuse.com" }] } },
  { name: "twilio", displayName: "Twilio", type: "builtin", category: "Notifications", needsAccountId: true, helpNote: "Reads account balance and the official ThisMonth Usage Record total price. Use an Auth Token or restricted key with billing usage read access.", needsConfig: { fields: [{ key: "apiKeySid", label: "Restricted API Key SID (optional)", placeholder: "SK..." }] } },
  { name: "resend", displayName: "Resend", type: "builtin", category: "Notifications", helpNote: "Reads the non-sending API-key control plane plus provider-reported monthly and daily email counts used. Those headers are usage counts, not limits; plan, remaining quota, price, and renewal stay unknown." },
  { name: "pushover", displayName: "Pushover", type: "builtin", category: "Notifications", helpNote: "Reads the application message limit, remaining messages, and reset date. The API does not expose subscription price." },
  { name: "cloudflare", displayName: "Cloudflare", type: "builtin", category: "Infrastructure", needsAccountId: true, helpNote: "Reads fixed subscriptions and, for eligible PayGo accounts, billing-grade usage cost. A Billing Read API token needs no email; email is only for a Global API key. The optional D1, R2, KV, and Queue fields are single-resource metadata/readability probes only; they do not affect billing, subscriptions, spend, usage, quotas, or PayGo eligibility." },
  { name: "hetzner", displayName: "Hetzner Cloud", type: "builtin", category: "Infrastructure", helpNote: "Inventories servers, volumes, floating/primary IPs, load balancers, and snapshots and resolves provider-catalog monthly run-rate in the account currency with backup double-count guards. Accrued invoice cost is not exposed." },
  { name: "apify", displayName: "Apify", type: "builtin", category: "Data", creditBased: true, helpNote: "Reads billing cycle, usage USD, maximum usage, active plan, base price, and included credits from official account APIs." },
  { name: "firecrawl", displayName: "Firecrawl", type: "builtin", category: "Data", creditBased: true, helpNote: "Reads the authenticated team's current plan-credit allowance, remaining credits, and available billing-period boundaries. The endpoint does not report credits used, plan tier, USD cost, or renewal status; add-on credits can make remaining credits exceed the plan allowance." },
  { name: "llamaindex", displayName: "LlamaIndex Cloud", type: "builtin", category: "Data", defaultRefreshIntervalMin: 360, helpNote: "Discovers organizations and reads paginated UTC month-to-date product credits consumed from the beta usage-metrics control plane, optionally filtered by project. Remaining balance, USD cost, plan, and renewal are not exposed.", needsConfig: { fields: [{ key: "projectId", label: "Project ID (optional)", placeholder: "Project UUID" }, { key: "host", label: "Host (optional)", placeholder: "https://api.cloud.llamaindex.ai" }] } },
  { name: "stripe", displayName: "Stripe", type: "builtin", category: "Payments", helpNote: "Tracks merchant balance and actual month-to-date Stripe processing fees. Customer subscriptions and merchant revenue are never counted as provider cost." },
  { name: "robinhood", displayName: "Robinhood", type: "builtin", category: "Brokerage", usesApiKey: false, helpNote: "No supported public retail usage or billing API. This row is push/manual; polling sends no key or account request." },
  { name: "alpaca", displayName: "Alpaca", type: "builtin", category: "Brokerage", helpNote: "Reads account equity, cash, buying power, portfolio value, and status; brokerage assets are not provider spend.", needsConfig: { fields: [{ key: "apiSecret", label: "API secret", placeholder: "Alpaca API secret", required: true, type: "password" }, { key: "environment", label: "Environment (optional)", placeholder: "paper or live" }] } },
] as const satisfies readonly ProviderDefinition[];

export type BuiltInProviderName = (typeof DEFINITIONS)[number]["name"];

export const BUILT_IN_PROVIDERS: readonly ProviderDefinition[] = DEFINITIONS;

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
