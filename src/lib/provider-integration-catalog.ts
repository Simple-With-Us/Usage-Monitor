import type { BuiltInProviderName } from "@/lib/provider-definitions";

export type IntegrationMode =
  | "direct"
  | "partial"
  | "push-only"
  | "manual"
  | "health-only"
  | "configurable";

export type BillingVisibility =
  | "actual"
  | "partial"
  | "metadata"
  | "manual"
  | "none";

export type IntegrationConfidence = "high" | "medium";

export type CatalogProviderName =
  | BuiltInProviderName
  | "agent-sync-relay"
  | "custom"
  | "generic";

export interface ProviderIntegrationProfile {
  name: CatalogProviderName;
  displayName: string;
  category: string;
  mode: IntegrationMode;
  summary: string;
  reads: string[];
  stores: string[];
  shares: string[];
  credentialInputs: string[];
  billing: {
    visibility: BillingVisibility;
    summary: string;
  };
  canAdd: string[];
  cannotAdd: string[];
  limitations: string[];
  provenance: {
    reviewedOn: "2026-07-11";
    confidence: IntegrationConfidence;
    sources: string[];
  };
}

type ProfileInput = Omit<
  ProviderIntegrationProfile,
  "stores" | "shares" | "provenance"
> & {
  stores?: string[];
  shares?: string[];
  confidence?: IntegrationConfidence;
  source: string;
};

const DEFAULT_STORES = [
  "Normalized balance, cost, request, and credit fields when the provider returns them.",
  "Selected response metadata in server-side snapshots; authoritative plan or billing records when supported.",
];

const DEFAULT_SHARES = [
  "Only the credential and configured account/resource identifiers needed for read-only provider requests.",
  "No budgets, project allocations, notes, or data from other providers are uploaded.",
];

function defineProfile(input: ProfileInput): ProviderIntegrationProfile {
  const { confidence = "high", source, ...profile } = input;
  return {
    ...profile,
    stores: input.stores ?? DEFAULT_STORES,
    shares: input.shares ?? DEFAULT_SHARES,
    provenance: {
      reviewedOn: "2026-07-11",
      confidence,
      sources: [source, "src/lib/provider-secret-config.ts", "src/app/api/providers/route.ts"],
    },
  };
}

type BlindInput = {
  name: BuiltInProviderName;
  displayName: string;
  category: string;
  reason: string;
  source: string;
  canAdd?: string[];
  cannotAdd?: string[];
};

function defineBlindProfile(input: BlindInput): ProviderIntegrationProfile {
  return defineProfile({
    name: input.name,
    displayName: input.displayName,
    category: input.category,
    mode: "push-only",
    summary: "The poll adapter intentionally makes no provider request; this account is manual or push-primary.",
    reads: [input.reason],
    stores: ["A capability note and any usage telemetry pushed into the monitor by another app."],
    shares: ["Nothing is sent to the provider during monitor polling."],
    credentialInputs: ["No API key is requested for new built-in rows and polling sends none. A legacy row may still contain an unused encrypted key."],
    billing: {
      visibility: "manual",
      summary: "Plan price, renewal, budget, and subscription state must be entered manually; pushed cost events can supplement them.",
    },
    canAdd: input.canAdd ?? ["Producer apps can push metered usage or cost through the authenticated usage-ingest endpoint."],
    cannotAdd: input.cannotAdd ?? ["Automatic billing, invoice, or subscription sync is unavailable without a documented account API."],
    limitations: ["The monitor will not spend a billable or quota-limited API call merely to validate a key."],
    confidence: "medium",
    source: input.source,
  });
}

const CATALOG: Record<CatalogProviderName, ProviderIntegrationProfile> = {
  openai: defineProfile({
    name: "openai", displayName: "OpenAI", category: "LLM/AI", mode: "direct",
    summary: "Reads organization month-to-date cost and selected usage/billing metadata; an Organization Admin key gives the authoritative cost path.",
    reads: ["Organization Costs API buckets for the current month.", "Daily request count plus legacy credit-grant, limit, and billing-usage endpoints when available."],
    stores: ["Aggregated USD cost, request count, credit balance, and limit metadata; never prompt or response content."],
    credentialInputs: ["Primary API key.", "Optional Organization Admin key, encrypted separately, for organization cost access."],
    billing: { visibility: "actual", summary: "Actual organization MTD cost is direct with an Admin key; legacy credit/limit endpoints are best-effort, not subscription authority." },
    canAdd: ["Organization usage breakdowns by project, user, model, or API key could be mapped from official admin reporting."],
    cannotAdd: ["ChatGPT consumer subscriptions, payment methods, and invoice PDFs are not exposed to project API keys."],
    limitations: ["A normal project key may validate and show partial legacy data but cannot read authoritative organization cost."],
    source: "src/lib/adapters/openai.ts",
  }),
  anthropic: defineProfile({
    name: "anthropic", displayName: "Anthropic", category: "LLM/AI", mode: "direct",
    summary: "Reads paginated organization cost-report buckets; Claude Code OTLP and generic pushed telemetry can supplement account polling.",
    reads: ["Organization cost report for the current month."],
    stores: ["Aggregated USD cost and billing-period metadata; no prompts, completions, or message bodies.", "Separately ingested Claude Code token/cost metrics when OTLP is configured."],
    credentialInputs: ["Organization Admin API key; an optional encrypted admin key can be separate from the inference key."],
    billing: { visibility: "actual", summary: "Actual MTD cost is direct; provider subscription tier, invoices, and renewal are not returned by this connector." },
    canAdd: ["Claude Code OTLP or generic pushed telemetry can add token, request, and project detail without sharing message content."],
    cannotAdd: ["A standard Messages API key cannot read organization billing; subscription status and invoice documents are unavailable here."],
    limitations: ["Non-USD cost rows are not folded into the USD total."],
    source: "src/lib/adapters/anthropic.ts",
  }),
  "google-ai": defineProfile({
    name: "google-ai", displayName: "Google AI", category: "LLM/AI", mode: "partial",
    summary: "Validates the Gemini key through a non-inference model-list request and records model-count/rate-limit metadata; it cannot read AI Studio billing.",
    reads: ["Available model count and any rate-limit headers returned by the Gemini API."],
    credentialInputs: ["Gemini API key."],
    billing: { visibility: "manual", summary: "Google AI Studio usage, plan, renewal, and spend remain manual." },
    canAdd: ["Google Cloud Billing export/API could provide spend through a separate service-account connector."],
    cannotAdd: ["The Gemini API key itself has no public AI Studio billing or subscription endpoint."],
    limitations: ["Model availability proves authentication, not billing ownership or spend completeness."],
    source: "src/lib/adapters/google-ai.ts",
  }),
  deepseek: defineProfile({
    name: "deepseek", displayName: "DeepSeek", category: "LLM/AI", mode: "partial",
    summary: "Reads the official account balance and granted-credit balance without generating inference.",
    reads: ["Account availability, total balance, granted balance, and top-up balance metadata."],
    credentialInputs: ["DeepSeek API key."],
    billing: { visibility: "partial", summary: "Prepaid balance is direct; spend history, invoices, plan, and renewal are not exposed." },
    canAdd: ["Producer-side request/cost events can be pushed for spend tracking."],
    cannotAdd: ["Invoice and subscription status cannot be synchronized from the current public API."],
    limitations: ["A balance is not month-to-date spend."],
    source: "src/lib/adapters/deepseek.ts",
  }),
  xai: defineProfile({
    name: "xai", displayName: "xAI (Grok)", category: "LLM/AI", mode: "direct",
    summary: "Reads team prepaid balance, postpaid invoice preview, billing cycle, and spending limits from the Management API.",
    reads: ["Prepaid balance.", "Current postpaid invoice preview and billing window.", "Soft/effective/hard spending limits."],
    credentialInputs: ["Team ID.", "Management API key; it can be stored separately from the normal API key."],
    billing: { visibility: "actual", summary: "Current invoice preview and spending limits are direct; finalized invoices and payment methods are not stored." },
    canAdd: ["Additional team-level billing breakdowns can be mapped if the Management API exposes them."],
    cannotAdd: ["A standard inference key without Management API access cannot read team billing."],
    limitations: ["Requires an exact team ID and billing-capable management credential."],
    source: "src/lib/adapters/xai.ts",
  }),
  mistral: defineProfile({
    name: "mistral", displayName: "Mistral AI", category: "LLM/AI", mode: "partial",
    summary: "Reads minimized organization usage-category metadata, payment/limit state, spend cap, and rate limits; it does not currently claim actual cost.",
    reads: ["Current-month usage categories and reporting window when present.", "Spend-limit counters, payment-failure/limit state, and requests-per-second limit."],
    stores: ["Minimized reporting-window, capability, limit-state, and rate-limit summaries; raw admin responses and spend-limit counters are not stored as cost."],
    credentialInputs: ["Backoffice Admin API key; optional encrypted admin key can be separate from the inference key."],
    billing: { visibility: "metadata", summary: "Spend-limit and payment-state metadata are direct, but those counters are not invoice cost. MTD cost remains manual/pushed pending a documented stable cost schema." },
    canAdd: ["A documented stable cost total/parser could make billing direct; per-model token limits can be normalized separately."],
    cannotAdd: ["A normal inference key cannot read organization admin metadata; current public usage categories do not provide a stable authoritative total."],
    limitations: ["No Mistral admin counter is promoted into provider spend without a documented currency/window contract."],
    source: "src/lib/adapters/mistral.ts",
  }),
  github: defineProfile({
    name: "github", displayName: "GitHub", category: "Developer Platform", mode: "direct",
    summary: "Reads organization enhanced-billing usage and net amount for the current month.",
    reads: ["Metered usage items, products/SKUs, quantities, and net USD amounts for one configured organization."],
    stores: ["Aggregated MTD cost plus per-product/SKU quantity and amount; no repository content, source code, issues, or user data."],
    credentialInputs: ["GitHub token with organization Administration read access.", "Organization login."],
    billing: { visibility: "actual", summary: "Actual enhanced-billing usage is direct; base-plan invoices, payment methods, and renewal are not synchronized." },
    canAdd: ["Other organizations can be represented as separate provider rows with separate scoped tokens."],
    cannotAdd: ["Personal-account billing and organizations outside the token's scope cannot be read by this org endpoint."],
    limitations: ["Requires GitHub's enhanced billing platform and the configured organization permission."],
    source: "src/lib/adapters/github.ts",
  }),
  vercel: defineProfile({
    name: "vercel", displayName: "Vercel", category: "Developer Platform", mode: "direct",
    summary: "Reads FOCUS billing charges for a personal scope or one configured team.",
    reads: ["Current-month billed cost, service/category, charge period, and consumed quantity."],
    credentialInputs: ["Vercel token with billing access.", "Optional team ID; blank selects personal scope."],
    billing: { visibility: "actual", summary: "Actual FOCUS charges are direct for eligible Pro/Enterprise scopes; plan renewal and invoice documents remain outside this connector." },
    canAdd: ["Separate provider rows can track multiple Vercel teams."],
    cannotAdd: ["Scopes without billing-read access and unsupported plan tiers cannot expose FOCUS charges."],
    limitations: ["The API may include fixed and variable charges together; the monitor marks that composition as unknown."],
    source: "src/lib/adapters/vercel.ts",
  }),
  render: defineProfile({
    name: "render", displayName: "Render", category: "Developer Platform", mode: "partial",
    summary: "Reads one Render service's plan, runtime, identity, and suspended/active state.",
    reads: ["Configured service metadata, plan name, runtime, status, and update time."],
    credentialInputs: ["Render API key.", "Service ID."],
    billing: { visibility: "metadata", summary: "Service plan/status are direct, but price, actual invoice cost, and account subscription are not returned." },
    canAdd: ["Additional services can be tracked as separate rows; provider-published plan prices could be mapped as estimates with explicit versioning."],
    cannotAdd: ["The service API does not expose invoice totals or payment/subscription records."],
    limitations: ["One row represents one service, not the entire Render account."],
    source: "src/lib/adapters/render.ts",
  }),
  pinecone: defineProfile({
    name: "pinecone", displayName: "Pinecone", category: "Vector DB", mode: "partial",
    summary: "Lists indexes and reads non-billable index statistics from provider-approved Pinecone hosts.",
    reads: ["Index inventory, minimal index metadata, and total vector counts."],
    stores: ["Index names/counts and minimized statistics/capability summaries; full provider responses are not persisted."],
    credentialInputs: ["Pinecone API key."],
    billing: { visibility: "manual", summary: "Usage price, credits, plan, invoice, and renewal remain manual." },
    canAdd: ["Serverless usage metrics could be mapped if Pinecone exposes a supported account metering API."],
    cannotAdd: ["Current control-plane and index-stat endpoints do not provide account billing."],
    limitations: ["Index hosts are allow-listed to Pinecone service domains; arbitrary hosts are rejected."],
    source: "src/lib/adapters/pinecone.ts",
  }),
  voyage: defineBlindProfile({ name: "voyage", displayName: "Voyage AI", category: "Vector DB", reason: "No documented non-billable account, credit, invoice, or subscription endpoint is available.", source: "src/lib/adapters/voyage.ts" }),
  fmp: defineBlindProfile({ name: "fmp", displayName: "FMP", category: "Market Data", reason: "Usage and billing are dashboard-only; the monitor does not consume a market-data call to test the key.", source: "src/lib/adapters/fmp.ts" }),
  finnhub: defineBlindProfile({ name: "finnhub", displayName: "Finnhub", category: "Market Data", reason: "No documented account usage or billing endpoint is available.", source: "src/lib/adapters/finnhub.ts" }),
  alphavantage: defineBlindProfile({ name: "alphavantage", displayName: "Alpha Vantage", category: "Market Data", reason: "No documented account usage or billing endpoint is available.", source: "src/lib/adapters/alphavantage.ts" }),
  tradier: defineProfile({
    name: "tradier", displayName: "Tradier", category: "Market Data", mode: "partial",
    summary: "Resolves a brokerage account when needed, then reads a portfolio summary and documented API rate-limit headers.",
    reads: ["Account equity/cash, open P/L, buying power, and rate-limit allowed/used/available/reset metadata."],
    stores: ["Portfolio and quota summaries; holdings and orders are not requested. Portfolio value is never counted as API spend."],
    credentialInputs: ["Tradier bearer token.", "Optional account ID; otherwise the first account in the profile is selected."],
    billing: { visibility: "manual", summary: "API quota is direct; subscription price, market-data plan, and renewal remain manual." },
    canAdd: ["A configured account selector could support multiple brokerage accounts explicitly."],
    cannotAdd: ["Brokerage assets, P/L, and cash cannot be treated as provider cost; Tradier billing is not exposed by these endpoints."],
    limitations: ["Automatic account resolution chooses the first profile account when none is configured."],
    source: "src/lib/adapters/tradier.ts",
  }),
  marketstack: defineBlindProfile({ name: "marketstack", displayName: "Marketstack", category: "Market Data", reason: "Plan usage is dashboard-only; no documented account API is available.", source: "src/lib/adapters/marketstack.ts" }),
  intrinio: defineProfile({
    name: "intrinio", displayName: "Intrinio", category: "Market Data", mode: "partial",
    summary: "Reads official per-feed current usage, limit, remaining calls, and reset windows.",
    reads: ["Usage count, limit, percentage, restriction/access code, and seconds until reset for each feed."],
    stores: ["Aggregated calls/remaining credits and per-feed limit records; the account email returned by Intrinio is intentionally discarded."],
    credentialInputs: ["Intrinio API key."],
    billing: { visibility: "metadata", summary: "Entitlement/quota metadata is direct; price, invoice, subscription status, and renewal remain manual." },
    canAdd: ["Manual subscriptions can link the known plan price to this provider row."],
    cannotAdd: ["Pricing is not present in the current-usage response."],
    limitations: ["Provider-defined feed windows may not align with a calendar month."],
    source: "src/lib/adapters/intrinio.ts",
  }),
  tiingo: defineBlindProfile({ name: "tiingo", displayName: "Tiingo", category: "Market Data", reason: "No documented account usage or billing endpoint is available; the old key-test poll was removed.", source: "src/lib/adapters/tiingo.ts" }),
  twelvedata: defineProfile({
    name: "twelvedata", displayName: "Twelve Data", category: "Market Data", mode: "partial",
    summary: "Reads the documented API-usage response and real-time credit headers.",
    reads: ["Current plan name, credits used, credits remaining, and the derived provider-window limit."],
    stores: ["Only plan, credit, limit, and capability summaries; the full provider response is not persisted."],
    credentialInputs: ["Twelve Data API key."],
    billing: { visibility: "metadata", summary: "Plan/quota are direct; plan price, actual spend, and renewal remain manual." },
    canAdd: ["Manual subscription records can supply price and renewal while keeping provider quotas direct."],
    cannotAdd: ["The usage endpoint does not return invoices or authoritative price."],
    limitations: ["Credit-window semantics are provider-defined and may not be monthly."],
    source: "src/lib/adapters/twelvedata.ts",
  }),
  "fintech-studios": defineBlindProfile({ name: "fintech-studios", displayName: "Fintech Studios", category: "Market Data", reason: "No documented account usage or billing API was found.", source: "src/lib/adapters/fintech_studios.ts" }),
  massive: defineBlindProfile({ name: "massive", displayName: "Massive", category: "Market Data", reason: "Account and invoice information are dashboard-only; aggregate-data calls are not used for monitoring.", source: "src/lib/adapters/massive.ts" }),
  fred: defineBlindProfile({ name: "fred", displayName: "FRED", category: "Market Data", reason: "FRED data is free and exposes no account billing state.", source: "src/lib/adapters/fred.ts", cannotAdd: ["There is no paid plan, invoice, or subscription state to synchronize for the public API."] }),
  sentry: defineProfile({
    name: "sentry", displayName: "Sentry", category: "Observability", mode: "partial",
    summary: "Reads 30-day organization stats_v2 category totals across projects and calculates a unit-safe event activity total.",
    reads: ["Grouped stats_v2 quantities by project and data category for the configured organization slug."],
    stores: ["Aggregated count-like event quantities plus minimized per-category totals; issue payloads are not requested, and attachment bytes/profile-duration milliseconds are excluded from the event total."],
    credentialInputs: ["Sentry API token.", "Organization slug."],
    billing: { visibility: "manual", summary: "Plan price, quota entitlement, renewal, and invoice cost remain manual." },
    canAdd: ["Additional documented stats categories and time windows could provide richer activity reporting.", "The separate Sentry Health card can read unresolved issue counts through server env credentials."],
    cannotAdd: ["The provider row does not share credentials or state with the separate fixed-project Sentry Health connector."],
    limitations: ["The 30-day count-like activity total is not billing cost or necessarily the plan quota window; byte and duration units remain separate metadata."],
    source: "src/lib/adapters/sentry.ts",
  }),
  langfuse: defineProfile({
    name: "langfuse", displayName: "Langfuse", category: "Observability", mode: "partial",
    summary: "Reads 31 days of daily metrics from Langfuse Cloud or a configured self-hosted endpoint.",
    reads: ["Observation count, trace count, and model cost observed by Langfuse."],
    stores: ["Observation counts and tracked model cost as diagnostic metadata; model cost is not counted as the Langfuse vendor fee."],
    credentialInputs: ["Langfuse public key plus encrypted secret key.", "Optional host for self-hosted Langfuse."],
    billing: { visibility: "manual", summary: "The Langfuse subscription price/status is not exposed; tracked LLM spend belongs to underlying model providers and is not double-counted." },
    canAdd: ["Manual subscription tracking can represent the Langfuse plan fee."],
    cannotAdd: ["Observed model cost cannot be relabeled as Langfuse subscription cost."],
    limitations: ["Custom hosts are treated as untrusted outbound URLs and pass SSRF checks."],
    source: "src/lib/adapters/langfuse.ts",
  }),
  twilio: defineProfile({
    name: "twilio", displayName: "Twilio", category: "Notifications", mode: "direct",
    summary: "Reads account balance and the official current-month total-price Usage Record.",
    reads: ["Account balance/currency and current billing-period total price."],
    credentialInputs: ["Account SID.", "Auth Token, or restricted API key secret plus optional API Key SID/auth username."],
    billing: { visibility: "actual", summary: "Current-month Twilio usage cost and billing window are direct; product-level breakdown, plan renewal, and invoices are not synchronized." },
    canAdd: ["Additional Usage Record categories could provide product-level cost breakdown."],
    cannotAdd: ["Restricted keys without billing usage read permission cannot access cost."],
    limitations: ["The total-price record may include fixed charges whose split is not identified."],
    source: "src/lib/adapters/twilio.ts",
  }),
  resend: defineProfile({
    name: "resend", displayName: "Resend", category: "Notifications", mode: "partial",
    summary: "Validates authentication through the non-sending API-key control plane and records only key count.",
    reads: ["Count of API keys visible to the supplied credential."],
    stores: ["API-key count and capability note; key values, email content, recipients, and delivery events are not stored."],
    credentialInputs: ["Resend API key."],
    billing: { visibility: "manual", summary: "Email quota, plan, subscription status, spend, and renewal remain manual." },
    canAdd: ["Producer apps can push send counts/cost; delivery telemetry could be added with explicitly scoped webhooks."],
    cannotAdd: ["Resend's API does not expose remaining plan quota or billing cost through this control-plane endpoint."],
    limitations: ["Authentication success does not prove a specific plan or remaining quota."],
    source: "src/lib/adapters/resend.ts",
  }),
  pushover: defineProfile({
    name: "pushover", displayName: "Pushover", category: "Notifications", mode: "partial",
    summary: "Reads application message limit, remaining messages, used count, and reset date.",
    reads: ["Application-level monthly message quota and reset timestamp."],
    credentialInputs: ["Pushover application API token."],
    billing: { visibility: "metadata", summary: "Quota is direct; purchase/subscription price and renewal are not exposed." },
    canAdd: ["Manual plan/subscription records can represent purchase cost if needed."],
    cannotAdd: ["The limits API does not return account purchase or subscription billing."],
    limitations: ["This is an application quota, not a complete user-account view."],
    source: "src/lib/adapters/pushover.ts",
  }),
  cloudflare: defineProfile({
    name: "cloudflare", displayName: "Cloudflare", category: "Infrastructure", mode: "direct",
    summary: "Reads account request analytics, fixed subscriptions, eligible PayGo billing, and optional D1/R2/KV/Queue readability metadata.",
    reads: ["30-day account request analytics, using Workers analytics only as a fallback when account totals are unavailable.", "All fixed subscriptions with price, status, billing period, and renewal.", "Billing-grade PayGo charges when the alpha endpoint is enabled for the account.", "Optional configured D1, R2, KV, and Queue metadata/readability checks."],
    credentialInputs: ["Account ID.", "Preferred scoped API token; or Global API key plus account email.", "Optional resource IDs/names for D1, R2, KV, and Queue reads."],
    billing: { visibility: "actual", summary: "Fixed subscription charges are direct; PayGo actual cost is direct only for eligible accounts. Analytics is never treated as billing-grade spend." },
    canAdd: ["More Cloudflare resource inventories or GraphQL analytics can be mapped with least-privilege scopes."],
    cannotAdd: ["PayGo billing cannot be forced for accounts that receive 403/404 from the restricted alpha endpoint."],
    limitations: ["Account and Workers request totals are never summed; Workers is fallback-only to avoid double-counting.", "Optional resource calls prove readability/metadata only and are not billing usage.", "Token permissions determine each capability independently; partial success is expected and recorded.", "Global API key auth is broader and should be avoided when a scoped Billing Read token works."],
    source: "src/lib/adapters/cloudflare.ts",
  }),
  hetzner: defineProfile({
    name: "hetzner", displayName: "Hetzner Cloud", category: "Infrastructure", mode: "partial",
    summary: "Reads server inventory plus the provider pricing catalog to resolve location-specific monthly run-rate in the owner's billing currency.",
    reads: ["Server ID/name/status/type/location and outgoing traffic.", "The /pricing catalog, currency, and location-specific monthly plan price."],
    credentialInputs: ["Hetzner Cloud API token."],
    billing: { visibility: "metadata", summary: "Current resource run-rate and actual provider currency are direct metadata; amountUsd is set only when that currency is explicitly USD. Accrued invoice cost remains unavailable." },
    canAdd: ["Other billable Hetzner resources could be inventoried and added to run-rate estimates."],
    cannotAdd: ["Published plan prices cannot be represented as an actual accrued invoice."],
    limitations: ["Non-USD plan prices remain in their owner currency and are never mislabeled as USD; discounts, tax, and accrued invoice totals are unavailable."],
    source: "src/lib/adapters/hetzner.ts",
  }),
  apify: defineProfile({
    name: "apify", displayName: "Apify", category: "Data", mode: "direct",
    summary: "Reads billing cycle, usage USD, maximum usage, active plan, base price, and included credits.",
    reads: ["Current monthly usage cycle and usage/limit USD.", "Payment state, plan ID/description, base price, included credits, and discount."],
    stores: ["Billing-safe selected fields only; the proxy password present in the account response is deliberately discarded."],
    credentialInputs: ["Apify API token."],
    billing: { visibility: "actual", summary: "Current-cycle bill estimate, base plan, included credits, cap, status, and renewal are direct; only a cycle starting in the current calendar month enters MTD budget math." },
    canAdd: ["Usage by actor/task could be added from additional scoped APIs if needed."],
    cannotAdd: ["Out-of-month provider billing cycles are not silently relabeled as calendar-month spend."],
    limitations: ["Estimated current bill depends on the plan/usage fields returned by Apify and may differ from a finalized invoice."],
    source: "src/lib/adapters/apify.ts",
  }),
  llamaindex: defineProfile({
    name: "llamaindex", displayName: "LlamaIndex Cloud", category: "Data", mode: "partial",
    summary: "Validates the credential by listing projects or reading one project without running parsing/inference.",
    reads: ["Project count or the configured project control-plane record."],
    credentialInputs: ["LlamaIndex Cloud API key.", "Optional project ID and optional custom host."],
    billing: { visibility: "manual", summary: "Credits, usage, plan, subscription status, spend, and renewal remain manual." },
    canAdd: ["A supported account credit/billing API could be connected if LlamaIndex exposes one."],
    cannotAdd: ["The projects endpoint does not return remaining credits or billing."],
    limitations: ["Custom hosts are SSRF-checked; authentication proves project access only."],
    source: "src/lib/adapters/llamaindex.ts",
  }),
  stripe: defineProfile({
    name: "stripe", displayName: "Stripe", category: "Payments", mode: "direct",
    summary: "Reads merchant balance and sums actual current-month Stripe processing fees from balance transactions.",
    reads: ["Available/pending USD merchant balance and paginated balance-transaction fees."],
    stores: ["Aggregated processing fee, transaction counts, and balance summary; customer identities, payment details, and subscription objects are not requested."],
    credentialInputs: ["Stripe restricted or secret key with read access to balance and balance transactions."],
    billing: { visibility: "actual", summary: "Actual processing fees are direct. Customer subscription revenue is intentionally not counted as the Stripe provider's cost; Stripe's own account plan is not exposed." },
    canAdd: ["Fee totals could be broken down by reporting category without ingesting customer data."],
    cannotAdd: ["Customer subscriptions/revenue cannot be treated as vendor spend, and payment-method data is out of scope."],
    limitations: ["Only USD fees are included in the normalized total."],
    source: "src/lib/adapters/stripe.ts",
  }),
  robinhood: defineBlindProfile({ name: "robinhood", displayName: "Robinhood", category: "Brokerage", reason: "Robinhood has no supported public retail account usage or billing API for this monitor.", source: "src/lib/adapters/robinhood.ts", canAdd: ["The trading app can push operational usage/cost telemetry that does not expose brokerage credentials or holdings."], cannotAdd: ["Unofficial, reverse-engineered, or browser-session access is not suitable for unattended billing sync."] }),
  alpaca: defineProfile({
    name: "alpaca", displayName: "Alpaca", category: "Brokerage", mode: "partial",
    summary: "Reads paper or live brokerage account status and portfolio summary.",
    reads: ["Equity, cash, buying power, portfolio value, and account status."],
    stores: ["Account-level portfolio summary; positions, orders, trades, and credentials are not returned to the browser."],
    credentialInputs: ["API key ID plus encrypted API secret.", "Paper/live environment selector."],
    billing: { visibility: "none", summary: "Brokerage account assets are not provider spend; API/data subscription cost and renewal remain manual." },
    canAdd: ["A separate provider billing endpoint could be added if Alpaca exposes account plan charges."],
    cannotAdd: ["Portfolio equity, cash, P/L, and buying power cannot be counted as cost."],
    limitations: ["One row represents one credential/environment pair."],
    source: "src/lib/adapters/alpaca.ts",
  }),
  "agent-sync-relay": defineProfile({
    name: "agent-sync-relay", displayName: "Agent Sync Relay", category: "Operations", mode: "health-only",
    summary: "Checks the relay health endpoint; this is service availability monitoring, not a third-party billing account.",
    reads: ["Health response and HTTP availability."],
    stores: ["UP/error state and returned health metadata."],
    shares: ["No credential is sent to the default public health endpoint."],
    credentialInputs: ["None for the built-in endpoint; an optional custom endpoint may be configured."],
    billing: { visibility: "none", summary: "There is no provider plan, invoice, subscription, or usage cost to sync." },
    canAdd: ["Authenticated health or service-level metrics could be added if the relay exposes them safely."],
    cannotAdd: ["Slack message content and agent coordination data are not read by this adapter."],
    limitations: ["A custom endpoint is treated as untrusted and SSRF-checked."],
    source: "src/lib/adapters/agent-sync-relay.ts",
  }),
  custom: defineProfile({
    name: "custom", displayName: "Custom API", category: "Custom", mode: "configurable",
    summary: "Performs a server-side authenticated GET to a configured endpoint and maps simple JSON paths into balance, cost, requests, and credits.",
    reads: ["A bounded JSON response from the configured endpoint; selected numeric paths become normalized snapshot fields."],
    stores: ["Only normalized numeric fields plus minimized capability/endpoint metadata; the arbitrary full response is not persisted."],
    shares: ["Configured API key, auth scheme/header, and extra headers are sent only to the configured endpoint.", "No monitor budgets, projects, or other-provider data are sent unless the custom endpoint itself is configured to return them."],
    credentialInputs: ["API key plus optional encrypted extra headers.", "HTTPS endpoint, auth type/header, and JSON paths."],
    billing: { visibility: "partial", summary: "Any numeric cost path can be tracked, but the monitor cannot independently prove its scope, currency, billing window, or invoice authority." },
    canAdd: ["Additional normalized fields or a signed webhook/push contract can be implemented for a known service."],
    cannotAdd: ["Arbitrary JSON cannot establish trustworthy subscription/invoice semantics without a service-specific contract."],
    limitations: ["Untrusted URLs are SSRF-checked and redirects are rejected.", "Only simple numeric JSON paths are normalized; unrecognized or nonnumeric fields are discarded."],
    source: "src/lib/adapters/custom.ts",
  }),
  generic: defineProfile({
    name: "generic", displayName: "Manual / Generic", category: "Custom", mode: "manual",
    summary: "Represents a service whose plan, budget, renewal, and subscription data are maintained manually; no account API is configured.",
    reads: ["No third-party account data."],
    stores: ["Only values entered in this app plus any pushed usage events explicitly associated with the provider name."],
    shares: ["No credentials or account data should be sent to the third party."],
    credentialInputs: ["None required."],
    billing: { visibility: "manual", summary: "All plan/budget/subscription values are manual; a producer may push metered cost separately." },
    canAdd: ["Upgrade to a Custom API or a dedicated adapter if a stable account endpoint becomes available."],
    cannotAdd: ["No direct billing or usage sync is possible without an endpoint and credential contract."],
    limitations: ["Manual values can drift and require an owner to keep them current."],
    source: "src/components/AddProviderModal.tsx",
  }),
};

const ALIASES: Readonly<Record<string, CatalogProviderName>> = {
  google: "google-ai",
  googleai: "google-ai",
  google_ai: "google-ai",
  agent_sync_relay: "agent-sync-relay",
};

export const PROVIDER_INTEGRATION_PROFILES = Object.values(CATALOG);

export function getProviderIntegrationProfile(
  providerName: string,
  providerType?: string
): ProviderIntegrationProfile {
  if (providerType === "custom") return CATALOG.custom;
  if (providerType === "generic") return CATALOG.generic;
  const normalized = providerName.trim().toLowerCase();
  const canonical = ALIASES[normalized] ?? normalized;
  return CATALOG[canonical as CatalogProviderName] ?? CATALOG.generic;
}
