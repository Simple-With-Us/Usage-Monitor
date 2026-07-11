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
  helpNote?: string;
  needsConfig?: {
    fields: {
      key: string;
      label: string;
      placeholder: string;
      required?: boolean;
      type?: string;
    }[];
  };
}

const DEFINITIONS = [
  { name: "openai", displayName: "OpenAI", type: "builtin", category: "LLM/AI", helpNote: "For authoritative organization cost, add an Organization Admin key below. It is encrypted separately from the normal API key.", needsConfig: { fields: [{ key: "adminApiKey", label: "Organization Admin key (optional)", placeholder: "sk-admin-...", type: "password" }] } },
  { name: "anthropic", displayName: "Anthropic", type: "builtin", category: "LLM/AI", helpNote: "The Usage & Cost API requires an organization Admin API key. A standard Messages API key cannot read billing.", needsConfig: { fields: [{ key: "adminApiKey", label: "Organization Admin API key (optional)", placeholder: "sk-ant-admin...", type: "password" }] } },
  { name: "google-ai", displayName: "Google AI", type: "builtin", category: "LLM/AI", helpNote: "Google AI Studio has no public usage API. Usage is visible at aistudio.google.com/app/apikey. Configure Google Cloud Billing for spend tracking." },
  { name: "deepseek", displayName: "DeepSeek", type: "builtin", category: "LLM/AI", helpNote: "Reads the official prepaid/granted balance endpoint; DeepSeek does not expose invoice or subscription status here." },
  { name: "xai", displayName: "xAI (Grok)", type: "builtin", category: "LLM/AI", helpNote: "Reads prepaid balance, postpaid invoice preview, billing cycle, and spending limits through the Management API.", needsConfig: { fields: [{ key: "teamId", label: "Team ID", placeholder: "xAI team ID", required: true }, { key: "managementKey", label: "Management API key (optional)", placeholder: "Management API key", type: "password" }] } },
  { name: "mistral", displayName: "Mistral AI", type: "builtin", category: "LLM/AI", helpNote: "Reads organization usage, payment/limit status, spend cap, and rate limits with a Backoffice Admin key.", needsConfig: { fields: [{ key: "adminApiKey", label: "Backoffice Admin API key (optional)", placeholder: "Admin API key", type: "password" }] } },
  { name: "github", displayName: "GitHub", type: "builtin", category: "Developer Platform", helpNote: "Uses GitHub enhanced-billing APIs for metered usage and net cost. Enter the organization login the token can read.", needsConfig: { fields: [{ key: "org", label: "Organization", placeholder: "GitHub organization login", required: true }] } },
  { name: "vercel", displayName: "Vercel", type: "builtin", category: "Developer Platform", helpNote: "Reads account/team billing and usage. Leave Team ID blank for the token owner's personal scope.", needsConfig: { fields: [{ key: "teamId", label: "Team ID (optional)", placeholder: "team_..." }] } },
  { name: "render", displayName: "Render", type: "builtin", category: "Developer Platform", helpNote: "Reads the service plan and suspended/active state. Render's service API does not expose invoice cost, so none is inferred.", needsConfig: { fields: [{ key: "serviceId", label: "Service ID", placeholder: "srv-...", required: true }] } },
  { name: "pinecone", displayName: "Pinecone", type: "builtin", category: "Vector DB", helpNote: "Fetches index stats (record count, dimension). No billing API." },
  { name: "voyage", displayName: "Voyage AI", type: "builtin", category: "Vector DB", usesApiKey: false, helpNote: "No non-billable account or usage API is available. This row is push/manual; no key is requested or polled." },
  { name: "fmp", displayName: "FMP", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public usage API. This row is push/manual; no market-data call or key is used by polling." },
  { name: "finnhub", displayName: "Finnhub", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public account usage API. This row is push/manual; no market-data call or key is used by polling." },
  { name: "alphavantage", displayName: "Alpha Vantage", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public account usage API. This row is push/manual; no market-data call or key is used by polling." },
  { name: "tradier", displayName: "Tradier", type: "builtin", category: "Market Data", helpNote: "Reads documented API rate-limit headers and a brokerage account portfolio summary; portfolio value is not treated as provider spend." },
  { name: "marketstack", displayName: "Marketstack", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public account usage API. This row is push/manual; no market-data call or key is used by polling." },
  { name: "intrinio", displayName: "Intrinio", type: "builtin", category: "Market Data", helpNote: "Reads the official per-feed current-usage, limit, remaining-call, and reset-window endpoint. Pricing remains manual." },
  { name: "tiingo", displayName: "Tiingo", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public account usage API. This row is push/manual; no API-test call or key is used by polling." },
  { name: "twelvedata", displayName: "Twelve Data", type: "builtin", category: "Market Data", helpNote: "Reads the documented plan response and real-time credits-used/remaining headers. Price and renewal remain manual." },
  { name: "fintech-studios", displayName: "Fintech Studios", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public account usage API. This row is push/manual; no key is used by polling." },
  { name: "massive", displayName: "Massive", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "No public account usage API. This row is push/manual; no aggregate-data call or key is used by polling." },
  { name: "fred", displayName: "FRED", type: "builtin", category: "Market Data", usesApiKey: false, helpNote: "Free federal data with no account billing state. No key or data request is used by polling." },
  { name: "sentry", displayName: "Sentry", type: "builtin", category: "Observability", needsOrgSlug: true, helpNote: "Enter the Sentry org slug to fetch a 30-day project activity stats summary. This is not quota or billing data." },
  { name: "langfuse", displayName: "Langfuse", type: "builtin", category: "Observability", helpNote: "Reads daily observation/trace metrics; tracked model cost is diagnostic and is not the Langfuse subscription fee.", needsConfig: { fields: [{ key: "publicKey", label: "Public key (optional if API Key is the public key)", placeholder: "pk-lf-..." }, { key: "secretKey", label: "Secret key", placeholder: "sk-lf-...", required: true, type: "password" }, { key: "host", label: "Host (optional)", placeholder: "https://cloud.langfuse.com" }] } },
  { name: "twilio", displayName: "Twilio", type: "builtin", category: "Notifications", needsAccountId: true, helpNote: "Reads account balance and the official ThisMonth Usage Record total price. Use an Auth Token or restricted key with billing usage read access.", needsConfig: { fields: [{ key: "apiKeySid", label: "Restricted API Key SID (optional)", placeholder: "SK..." }] } },
  { name: "resend", displayName: "Resend", type: "builtin", category: "Notifications", helpNote: "Email provider. Free: 100/day. Check resend.com dashboard." },
  { name: "pushover", displayName: "Pushover", type: "builtin", category: "Notifications", helpNote: "Reads the application message limit, remaining messages, and reset date. The API does not expose subscription price." },
  { name: "cloudflare", displayName: "Cloudflare", type: "builtin", category: "Infrastructure", needsAccountId: true, helpNote: "Reads fixed subscriptions and, for eligible PayGo accounts, billing-grade usage cost. A Billing Read API token needs no email; email is only for a Global API key." },
  { name: "hetzner", displayName: "Hetzner Cloud", type: "builtin", category: "Infrastructure", helpNote: "Reads server plan, status, location, and provider-published monthly run-rate. The API does not expose accrued invoice cost." },
  { name: "apify", displayName: "Apify", type: "builtin", category: "Data", creditBased: true, helpNote: "Reads billing cycle, usage USD, maximum usage, active plan, base price, and included credits from official account APIs." },
  { name: "llamaindex", displayName: "LlamaIndex Cloud", type: "builtin", category: "Data", helpNote: "Validates project access through the non-inference control plane; credits and billing are not exposed.", needsConfig: { fields: [{ key: "projectId", label: "Project ID (optional)", placeholder: "Project UUID" }, { key: "host", label: "Host (optional)", placeholder: "https://api.cloud.llamaindex.ai" }] } },
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
