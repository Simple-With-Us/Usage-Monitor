import {
  BUILT_IN_PROVIDERS,
  isBuiltInProviderActive,
  type BuiltInProviderName,
} from "@/lib/provider-definitions";
import { canonicalProviderKey } from "@/lib/provider-identity";

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

const BUILT_IN_PROVIDER_NAMES = new Set<string>(
  BUILT_IN_PROVIDERS.map((provider) => provider.name)
);

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
    reviewedOn: "2026-07-13";
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
      reviewedOn: "2026-07-13",
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
    summary: "Reads one canonical organization month-to-date cash total plus non-additive project, line-item, and API-key-ID cost components; an Organization Admin key gives the authoritative cost path.",
    reads: ["Organization Costs API buckets for the current month, plus bounded project, line-item, and API-key-ID cost breakdowns.", "Daily request count plus legacy credit-grant, limit, and billing-usage endpoints when available."],
    stores: ["One canonical aggregated USD cost, non-additive project/line-item/API-key-ID component rows, request count, credit balance, and limit metadata; never prompt or response content."],
    credentialInputs: ["Primary API key.", "Optional Organization Admin key, encrypted separately, for organization cost access."],
    billing: { visibility: "actual", summary: "Actual organization MTD cost is direct with an Admin key; legacy credit/limit endpoints are best-effort, not subscription authority." },
    canAdd: ["Usage-only reporting can separately add project, user, model, or API-key activity without treating it as canonical cash spend."],
    cannotAdd: ["This monitor never infers a key secret or name: it retains only provider-returned API key IDs as non-additive components, separate from one canonical cash total.", "ChatGPT Plus/Pro, Codex CLI, and ChatGPT consumer subscriptions are MANUALLY ONLY. They are a separate billing product from the Organization Costs API."],
    limitations: ["A normal project key may validate and show partial legacy data but cannot read authoritative organization cost.", "Codex / ChatGPT subscription quota is not fetchable. Do not add a provider row hoping setup will unlock it."],
    source: "src/lib/adapters/openai.ts",
  }),
  anthropic: defineProfile({
    name: "anthropic", displayName: "Anthropic", category: "LLM/AI", mode: "partial",
    summary: "Individual accounts rely on explicitly incomplete pushed per-request telemetry plus Console and subscription reconciliation; organization accounts can optionally read paginated cost-report buckets with an Admin API key.",
    reads: ["No provider billing request for an individual account with only a standard Messages API key.", "Organization cost report for the current month when an Admin API key is explicitly configured."],
    stores: ["Pushed API request, token, and cost telemetry without prompts, completions, or message bodies.", "For organization accounts, aggregated USD cost and billing-period metadata from the cost report.", "Explicit recurring subscription records and receipt-reconciled amounts when configured."],
    shares: ["A standard Messages API key is not sent during billing polling.", "Only an explicitly configured organization Admin API key is sent to Anthropic's read-only cost-report endpoint."],
    credentialInputs: ["Optional organization Admin API key under Advanced configuration; individual accounts do not have or need one."],
    billing: { visibility: "partial", summary: "Actual API cost is direct only for organization accounts with an Admin key. Individual observed API activity and cost can come from producer telemetry but must be reconciled with the Anthropic Console; Claude subscription tier, invoices, and renewal require explicit reconciliation." },
    canAdd: ["Claude Code OTLP or generic pushed telemetry can add request, token, project, and estimated-cost detail without sharing message content.", "Subscription records can account for fixed Claude plan charges separately from metered API spend."],
    cannotAdd: ["Anthropic does not offer the Admin or Usage & Cost APIs to individual accounts.", "A standard Messages API key cannot read billing, subscription status, renewal dates, or invoice documents."],
    limitations: ["Pushed cost is only as complete as producer instrumentation and should not be presented as an authoritative invoice.", "Non-USD organization cost rows are not folded into the USD total."],
    source: "src/lib/adapters/anthropic.ts",
  }),
  "google-ai": defineProfile({
    name: "google-ai", displayName: "Google AI", category: "LLM/AI", mode: "partial",
    summary: "Validates a Cloud Console- or AI Studio-managed Gemini key without inference, reads project request/quota metrics through Cloud Monitoring, and independently reads actual month-to-date spend from the standard Cloud Billing BigQuery export when configured.",
    reads: ["Available model count and any rate-limit headers returned by the Gemini API.", "Exact model, tier, and location dimensions from active `generativelanguage.googleapis.com/quota/.../usage` and `/limit` metrics discovered through Cloud Monitoring; aggregate Service Runtime request_count is retained only as a fallback total.", "Gemini API regular cost, credits, project, SKU, usage quantity, and report-through time from the configured standard billing export."],
    stores: ["Sanitized month-to-date aggregate request counts and native quota metadata with model, tier, and location; method and credential identifiers are discarded.", "Standard billing export cost/SKU rows when that independent channel is configured."],
    credentialInputs: ["Gemini API key managed in Google Cloud Console or Google AI Studio; the request uses the official x-goog-api-key header.", "Exact Gemini project ID plus one encrypted service-account JSON credential with Monitoring Viewer; OAuth is restricted to monitoring.read.", "Optional standard billing dataset; the same service account separately uses BigQuery read-only access for actual cash cost."],
    billing: { visibility: "actual", summary: "Actual calendar-month Gemini API net cost is direct when Cloud Billing export is configured; AI Studio prepaid balance, paid tier, transactions, and renewal remain unavailable." },
    canAdd: ["Producer telemetry can supplement delayed project metrics and billing export while Cloud Monitoring remains the quota authority and BigQuery remains the cash-cost authority."],
    cannotAdd: ["The Gemini API key itself has no public AI Studio balance, transaction, tier, or renewal endpoint.", "Cloud Monitoring quotas apply at project/model/location dimensions rather than to one API key.", "Google Antigravity / Gemini Code Assist consumer subscription quota is MANUALLY ONLY. It is not the Gemini API or Cloud Billing export path."],
    limitations: ["Native Gemini quota metrics can be ALPHA or BETA and are currently documented with up to 150 seconds of visibility delay. Aggregate Service Runtime request_count can be delayed by up to 30 minutes; an empty response remains unknown rather than false zero.", "Cloud Billing export is delayed, can take days to backfill initially, and requires an exact Gemini project when the dataset contains more than one.", "A replacement key is shown as unchecked until Verify & fetch binds a fresh validation result to that credential."],
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
    cannotAdd: ["A standard inference key without Management API access cannot read team billing.", "SuperGrok, Grok.com, and Grok Build CLI subscription quota are MANUALLY ONLY. They are a separate product from xAI Management API prepaid/postpaid billing."],
    limitations: ["Requires an exact team ID and billing-capable management credential.", "Do not treat a SuperGrok seat as a fetchable xAI connection."],
    source: "src/lib/adapters/xai.ts",
  }),
  minimax: defineBlindProfile({
    name: "minimax", displayName: "MiniMax", category: "LLM/AI",
    reason: "MiniMax exposes no documented account/billing API here; subscription quota is read by the Mac-side quota collector, or entered manually.",
    source: "src/lib/provider-definitions.ts",
  }),
  mistral: defineProfile({
    name: "mistral", displayName: "Mistral AI", category: "LLM/AI", mode: "partial",
    summary: "Enumerates Mistral workspaces and reads each current-month Admin Usage report, plus organization payment/limit state, spend cap, and rate limits; no undocumented counter is represented as cash cost.",
    reads: ["Current UTC-month organization and bounded per-workspace billing-usage reports with their reporting window/currency.", "Paginated workspace inventory, spend-limit counters, payment-failure/limit state, and requests-per-second limit."],
    stores: ["Minimized reporting-window/currency and workspace-coverage status, plus limit/rate metadata. Workspace reports are non-additive components; raw admin responses and spend-limit counters are never stored as cash cost."],
    credentialInputs: ["Backoffice Admin API key; optional encrypted admin key can be separate from the inference key."],
    billing: { visibility: "metadata", summary: "The Admin Usage and workspace APIs are directly connected, but the published usage schema does not define a stable numeric organization cash-total field. Spend-limit counters are cap/consumption metadata only. MTD cash remains manual/pushed until Mistral documents an exact amount schema." },
    canAdd: ["A documented numeric organization-cost aggregate with currency and period semantics could make billing cash direct; per-model token limits can be normalized separately."],
    cannotAdd: ["A normal inference key cannot read organization admin metadata; the current published usage schema does not define a stable authoritative cash total."],
    limitations: ["No Mistral admin counter or open-ended usage-category value is promoted into provider spend. Workspace components are bounded and never add to canonical spend."],
    source: "src/lib/adapters/mistral.ts",
  }),
  openrouter: defineProfile({
    name: "openrouter", displayName: "OpenRouter", category: "LLM/AI", mode: "partial",
    summary: "Reads this key's own usage and limit from GET /key with any key tier; a Management (Provisioning) API key additionally unlocks account-wide prepaid credit balance, every configured key's individual usage/limit without exposing secrets, and a derived calendar-month-to-date cost estimate from 30-day activity history.",
    reads: ["This key's own label, limit, limit_remaining, and usage rollups from GET /key.", "With a Management key: account-wide prepaid credit balance from GET /credits, every API key's already-masked label, name, usage, and limit from GET /keys (default workspace only), and per-day per-model USD usage/request counts from GET /activity for the trailing 30 completed UTC days."],
    stores: ["Selected key and account balance/limit/usage fields plus a minimized per-key breakdown array; full provider responses and unmasked key secrets are never persisted."],
    credentialInputs: ["OpenRouter API key. A Management (Provisioning) API key is required to read account-wide credits, the per-key breakdown, and activity history; a standard inference key still validates and reports only its own usage/limit."],
    billing: { visibility: "partial", summary: "Prepaid credit balance is direct with a Management API key. Month-to-date cost is a derived estimate summed from 30-day activity history, not an authoritative invoice, and is intentionally left unknown on the one day per 31-day month when the trailing window cannot be proven to reach the 1st. A standard inference key exposes no account-wide balance or cost." },
    canAdd: ["Multi-workspace enumeration could complete per-key coverage for accounts with non-default workspaces.", "Per-key activity could be filtered by api_key_hash to attribute cost to individual downstream apps."],
    cannotAdd: ["OpenRouter has no subscription or invoice-cycle concept; credits are a lifetime-cumulative prepaid balance, not a billing period.", "A standard inference key cannot read account-wide credits, the per-key breakdown, or activity under any configuration."],
    limitations: ["GET /api/v1/keys returns only the default workspace; accounts with additional workspaces need per-workspace enumeration, not implemented here.", "Derived month-to-date cost trusts activity data being complete for every day since the 1st of the month and is withheld when that cannot be proven."],
    source: "src/lib/adapters/openrouter.ts",
  }),
  kimi: defineBlindProfile({
    name: "kimi", displayName: "Kimi", category: "LLM/AI",
    reason: "Kimi is accessed exclusively through OpenRouter in this fleet; the retired definition exists only so boot-time retirement deactivates stray rows using this name.",
    cannotAdd: ["The provider is retired: no direct Kimi connection, key, or polling is supported."],
    source: "src/lib/provider-definitions.ts",
  }),
  moonshot: defineBlindProfile({
    name: "moonshot", displayName: "Moonshot AI", category: "LLM/AI",
    reason: "Moonshot (Kimi) is accessed exclusively through OpenRouter in this fleet; the retired definition exists only so boot-time retirement deactivates stray rows using this name.",
    cannotAdd: ["The provider is retired: no direct Moonshot connection, key, or polling is supported."],
    source: "src/lib/provider-definitions.ts",
  }),
  github: defineProfile({
    name: "github", displayName: "GitHub", category: "Developer Platform", mode: "direct",
    summary: "Reads direct enhanced-billing net usage, configured budget caps, and Copilot AI-credit/premium-request detail for one organization, personal user, or enterprise account boundary.",
    reads: ["Current calendar-month aggregate net billed usage, products/SKUs, quantities, and units.", "Configured organization/enterprise budget caps and enforcement state (GitHub does not document a personal-user budget list).", "Copilot AI-credit and premium-request product/model detail when GitHub exposes it for the configured account boundary."],
    stores: ["Canonical MTD net cost plus product/SKU breakdowns, read-only budget-cap records, and separate Copilot detail components. Exact documented metered products/SKUs are stored as USD caps; known license counts and unknown units remain labeled metadata and are never represented as request limits. No repository names, code, issues, alert recipients, or user activity are stored."],
    credentialInputs: ["Organization: GitHub token with Organization Administration read and an org-admin or billing-manager identity.", "Personal user: token with Plan read.", "Enterprise: a classic PAT; GitHub explicitly rejects fine-grained PATs and GitHub App user or installation tokens for enterprise billing endpoints. For GHE.com, also provide the exact `https://api.<enterprise>.ghe.com` API origin.", "Configured account login or slug; legacy org config remains supported."],
    billing: { visibility: "actual", summary: "Enhanced-billing summary netAmount is direct actual MTD spend. Copilot AI-credit/premium detail is stored as a breakdown only, never added to canonical spend a second time. Budget caps are direct, but USD is assigned only to exact documented metered products/SKUs; license and unknown-unit amounts remain metadata, and GitHub does not expose their general consumed amount in the documented list response." },
    canAdd: ["Separate rows can track each independent organization, personal account, or enterprise billing boundary."],
    cannotAdd: ["GitHub's billing REST APIs do not expose a general base-plan price, renewal date, receipt history, payment method, or subscription status. Marketplace publisher endpoints are not a general billing feed."],
    limitations: ["Detailed usage requires GitHub enhanced billing. Enterprise completeness requires the all-cost-center summary; the adapter never falls back to the cost-center-specific detailed endpoint when that summary is unavailable. Most license budgets cannot stop further usage, so ProductPricing license budgets are never called enforced solely because prevent_further_usage is true; only the three exact documented GitHub Advanced Security SkuPricing IDs retain that state. Budget inventory is authoritative only after stable total_count pagination exactly matches the completed collection. Missing account access, unsupported enhanced billing, and unavailable optional Copilot/budget surfaces remain explicit capability states rather than `$0`."],
    source: "src/lib/adapters/github.ts",
  }),
  vercel: defineProfile({
    name: "vercel", displayName: "Vercel", category: "Developer Platform", mode: "direct",
    summary: "Reads FOCUS billing charges for a personal scope or one configured team, including the documented Vercel ProjectId/ProjectName charge tags when returned.",
    reads: ["Current-month billed cost, service/category, charge period, and consumed quantity.", "Per-charge Vercel ProjectId and ProjectName tags for non-additive project/service attribution when the FOCUS response returns valid tags."],
    stores: ["One canonical billed-cost total per currency plus bounded non-additive service and project/service components; project identity is Vercel ProjectId and ProjectName is display metadata only.", "Counts/capability states for missing or cardinality-suppressed detail; raw tag values are not retained in snapshot raw data."],
    credentialInputs: ["Vercel token with billing access.", "Optional team ID; blank selects personal scope."],
    billing: { visibility: "actual", summary: "Actual FOCUS billed charges are direct for eligible Pro/Enterprise scopes. Project/service rows are a breakdown of that canonical total, never an additional charge; plan renewal and invoice documents remain outside this connector." },
    canAdd: ["Separate provider rows can track multiple Vercel teams."],
    cannotAdd: ["Scopes without billing-read access and unsupported plan tiers cannot expose FOCUS charges."],
    limitations: ["The API may include fixed and variable charges together; the monitor marks that composition as unknown.", "Project detail is emitted only for Vercel's documented FOCUS Tags.ProjectId dimension. A valid Tags object without ProjectId is treated as genuinely untagged; absent/non-object Tags or a malformed present ProjectId withhold the optional project sync rather than inferring or pruning prior detail. More than 250 distinct project/service dimensions also suppresses that optional sync while retaining the canonical billed total."],
    source: "src/lib/adapters/vercel.ts",
  }),
  oracle: defineProfile({
    name: "oracle", displayName: "Oracle Cloud Infrastructure", category: "Infrastructure", mode: "direct",
    summary: "Reads OCI Usage API cost for completed UTC days in the current month with separately reconciled, non-additive service detail; all OCI requests are server-side RSA API-signature requests.",
    reads: ["OCI Usage API COST aggregation for the configured tenancy, first UTC day of the month through the latest complete UTC day.", "Paginated OCI ListBudgets inventory for the tenancy, plus optional OCI Limits API values for explicitly configured service names and compartment."],
    stores: ["One canonical USD MTD cost record, bounded non-additive per-service cost components, configured-budget cap/actual/forecast metadata, and configured-service limit metadata.", "Region, report window, currency coverage, and capability state only; no private key, signed headers, OCIDs, or raw OCI response payload."],
    credentialInputs: ["Tenancy OCID, user OCID, API-key fingerprint, a supported commercial-realm (OC1) tenancy home region identifier, and a PEM API signing private key encrypted in server-only provider secret config. Other OCI realms and unverified new regions are rejected rather than signed with the commercial endpoint. COST queries require OCI USAGE_REPORT_READ or USAGE_REPORT_MANAGE; USAGE_ANALYSIS_READ is usage-only.", "Optional verified budget currency, quota compartment OCID, and an explicit bounded list of OCI service names."],
    billing: { visibility: "actual", summary: "USD Usage API COST preserves the provider-reported amount for completed UTC days. OCI can publish cost up to 48 hours late, so current-spend coverage is marked incomplete until delayed usage is visible. Non-USD amounts are not FX-converted or counted as USD." },
    canAdd: ["A separate provider row can track another tenancy or billing identity.", "Configured OCI service limits can surface hard resource ceilings without calling workload or mutating resources."],
    cannotAdd: ["The connector does not infer exchange rates, subscription price, renewal, invoices, payment method, or a recurring charge from OCI cost rows.", "OCI Budget amounts are customer-rate-card currency without a returned ISO code, so they become USD caps only after an operator explicitly verifies `budgetCurrency=USD`. Generic current quota consumption is not exposed by ListLimitValues; resource-availability calls require specific limit/resource dimensions and are not guessed."],
    limitations: ["Usage API DAILY aggregation reports complete day-aligned data but can publish cost up to 48 hours late; the exact reported amount remains visible with incomplete coverage.", "The connector uses Oracle's documented OC1 region allowlist because it constructs the commercial endpoint. Other realms and newly announced regions are rejected until their realm mapping is verified and the allowlist is updated.", "Optional service detail or limit metadata is fail-open and never prunes prior detail when its source is unavailable, malformed, or over the bounded cardinality limit."],
    source: "src/lib/adapters/oracle.ts",
  }),
  render: defineProfile({
    name: "render", displayName: "Render", category: "Infrastructure", mode: "partial",
    summary: "Inventories the Render account's services, Postgres databases, Key Value instances, paid plan names, statuses, and attached disks, plus account-wide bandwidth usage.",
    reads: ["Paginated account-wide service, Postgres, and Key Value control-plane records.", "Plan name, runtime/version, region, instance/autoscaling state, disk size, replicas, persistence, and suspension/status metadata.", "Per-service bandwidth usage (bytes) from the metrics API for the current UTC calendar month to date."],
    stores: ["Minimized resource and plan inventory plus authoritative paid-service records and aggregated bandwidth (whole megabytes in the request-count metric, exact bytes/GB in raw data); environment variables, connection strings, logs, and application data are never requested."],
    credentialInputs: ["Render API key with read access to the account resources being monitored."],
    billing: { visibility: "metadata", summary: "Paid service/plan presence and status are direct, as is metered bandwidth quantity; price, actual invoice/overage cost, billing cycle, and renewal are not returned." },
    canAdd: ["Provider-published prices or invoice totals can be mapped if Render exposes an authoritative account billing API.", "Bandwidth broken down by traffic source (HTTP/WebSocket/NAT/PrivateLink) is available from a second metrics endpoint if finer attribution is needed."],
    cannotAdd: ["Current control-plane responses cannot prove invoice totals, payment state, or renewal dates.", "Render does not expose the workspace-level included bandwidth allowance, so overage in USD cannot be computed - only the metered quantity is reported."],
    limitations: ["Plan labels identify paid resources but do not carry authoritative prices; the connector reconciles only after every resource class and cursor page succeeds.", "Bandwidth is aggregated for the current UTC calendar month to date (to match the monthly limit it feeds and Render's monthly reset) and reported in whole megabytes because the snapshot metric column is an integer; exact bytes are retained in raw data. It is reported partial - with the monthly total withheld - for accounts beyond 200 services and on the late-month days when Render's 30-day metrics floor cannot reach the 1st; a bandwidth-metrics failure does not discard the rest of the inventory and is surfaced separately for retry."],
    source: "src/lib/adapters/render.ts",
  }),
  pinecone: defineProfile({
    name: "pinecone", displayName: "Pinecone", category: "Vector DB", mode: "partial",
    summary: "Inventories indexes and vector counts plus backups, legacy collections, and assistants from Pinecone's control plane.",
    reads: ["Index inventory and non-billable index statistics from provider-approved Pinecone hosts.", "Paginated backup and assistant inventories plus collection inventory when those APIs are available to the account."],
    stores: ["Minimized index, count, backup, collection, assistant, status, size, cloud/region, and capability summaries; full provider responses are not persisted."],
    credentialInputs: ["Pinecone API key."],
    billing: { visibility: "metadata", summary: "Paid resource/service presence and usage quantities are direct; usage price, credits, account tier, invoice, and renewal remain unavailable." },
    canAdd: ["Serverless usage metrics could be mapped if Pinecone exposes a supported account metering API."],
    cannotAdd: ["Current control-plane and index-stat endpoints do not provide account billing, subscription tier, or renewal."],
    limitations: ["Index hosts are allow-listed to Pinecone service domains; arbitrary hosts are rejected.", "Optional inventory APIs reconcile independently so one unsupported capability does not erase successful index state."],
    source: "src/lib/adapters/pinecone.ts",
  }),
  voyage: defineBlindProfile({ name: "voyage", displayName: "Voyage AI", category: "Vector DB", reason: "No documented non-billable account, credit, invoice, or subscription endpoint is available.", source: "src/lib/adapters/voyage.ts" }),
  roic: defineBlindProfile({ name: "roic", displayName: "ROIC.ai", category: "Market Data", reason: "No documented non-billable ROIC.ai usage/billing API is wired; track plan cost via Subscription or push telemetry.", source: "src/lib/adapters/index.ts" }),
  fmp: defineBlindProfile({ name: "fmp", displayName: "FMP", category: "Market Data", reason: "Usage and billing are dashboard-only; the monitor does not consume a market-data call to test the key.", source: "src/lib/adapters/fmp.ts" }),
  finnhub: defineBlindProfile({ name: "finnhub", displayName: "Finnhub", category: "Market Data", reason: "No documented account usage or billing endpoint is available.", source: "src/lib/adapters/finnhub.ts" }),
  alphavantage: defineBlindProfile({ name: "alphavantage", displayName: "Alpha Vantage", category: "Market Data", reason: "No documented account usage or billing endpoint is available.", source: "src/lib/adapters/alphavantage.ts" }),
  tradier: defineProfile({
    name: "tradier", displayName: "Tradier", category: "Brokerage", mode: "partial",
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
    summary: "Reads the current API-usage response for plan plus separate minute and daily quota windows, with legacy header fallback.",
    reads: ["Current plan category and minute/daily used, limit, and derived remaining quantities."],
    stores: ["Only plan, credit, limit, and capability summaries; the full provider response is not persisted."],
    credentialInputs: ["Twelve Data API key."],
    billing: { visibility: "metadata", summary: "Plan/quota are direct; plan price, actual spend, and renewal remain manual." },
    canAdd: ["Manual subscription records can supply price and renewal while keeping provider quotas direct."],
    cannotAdd: ["The usage endpoint does not return invoices or authoritative price."],
    limitations: ["Minute and daily quotas remain separate and are never combined.", "The /api_usage request itself consumes one API credit, so new connections default to a daily sync cadence."],
    source: "src/lib/adapters/twelvedata.ts",
  }),
  "fintech-studios": defineProfile({
    name: "fintech-studios", displayName: "FinTech Studios", category: "Market Data", mode: "partial",
    summary: "Reads the documented zero-credit account endpoint for tier, credit balance, quota allowances, daily burn, reset, and API rate-limit metadata.",
    reads: ["Account tier, remaining credit balance, monthly credit allowance, daily burn cap and usage, reset date, and control-plane rate-limit metadata."],
    stores: ["Selected tier/quota fields only; account name, email, and full provider responses are discarded."],
    credentialInputs: ["FinTech Studios API key."],
    billing: { visibility: "metadata", summary: "Tier and credit/quota state are direct; USD price, invoices, subscription payment state, and renewal are not exposed." },
    canAdd: ["A usage breakdown can be added after the provider publishes a stable response schema for its usage endpoint."],
    cannotAdd: ["Credits cannot be converted to USD cost without an authoritative provider price contract."],
    limitations: ["The connector intentionally avoids the undocumented usage response and relies on the zero-credit account read."],
    source: "src/lib/adapters/fintech_studios.ts",
  }),
  massive: defineBlindProfile({ name: "massive", displayName: "Massive", category: "Market Data", reason: "Account and invoice information are dashboard-only; aggregate-data calls are not used for monitoring.", source: "src/lib/adapters/massive.ts" }),
  fred: defineBlindProfile({ name: "fred", displayName: "FRED", category: "Market Data", reason: "FRED data is free and exposes no account billing state.", source: "src/lib/adapters/fred.ts", cannotAdd: ["There is no paid plan, invoice, or subscription state to synchronize for the public API."] }),
  "quiver-quant": defineBlindProfile({ name: "quiver-quant", displayName: "Quiver Quantitative", category: "Market Data", reason: "Quiver Quantitative does not expose a billing or usage quota API endpoint; usage is tracked via the provider dashboard.", source: "src/lib/adapters/quiver.ts" }),
  "unusual-whales": defineProfile({
    name: "unusual-whales", displayName: "Unusual Whales", category: "Market Data", mode: "partial",
    summary: "Reads the account's cumulative daily request count from a documented response header returned on a minimal, authenticated congress-trades read.",
    reads: ["The x-uw-daily-req-count header from one minimal (limit=1) /api/congress/recent-trades request; no trade data from that response is read or stored."],
    stores: ["Only the daily request count and a static, provider-documented note that the reset window is 8:00pm ET; the response body is discarded."],
    credentialInputs: ["Unusual Whales API key."],
    billing: { visibility: "metadata", summary: "The account's cumulative daily request count is direct; no documented endpoint exposes a request limit, USD price, plan tier, or renewal date." },
    canAdd: ["A request-limit or plan endpoint could be added if Unusual Whales documents one."],
    cannotAdd: ["No documented account, plan, or billing endpoint exists to read price, invoice, or renewal state."],
    limitations: ["Every poll consumes one request against the same daily counter as any other authenticated call, so new connections default to daily sync.", "The provider does not return a reset timestamp; the monitor never computes or invents one from the documented 8:00pm ET reset time."],
    source: "src/lib/adapters/unusualwhales.ts",
  }),
  sentry: defineProfile({
    name: "sentry", displayName: "Sentry", category: "Observability", mode: "partial",
    summary: "Reads exact UTC calendar-month-to-date organization stats_v2 quantities across projects, categories, and outcomes.",
    reads: ["Grouped stats_v2 quantities by project, data category, and outcome for the configured organization slug."],
    stores: ["Aggregated count-like event quantities plus minimized per-category totals; issue payloads are not requested, and attachment bytes/profile-duration milliseconds are excluded from the event total."],
    credentialInputs: ["Sentry API token.", "Organization slug."],
    billing: { visibility: "metadata", summary: "Exact calendar-month usage quantities are direct; plan price, quota entitlement, renewal, and invoice cost remain unavailable." },
    canAdd: ["Additional documented stats categories and time windows could provide richer activity reporting.", "The separate Sentry Health card can read unresolved issue counts through server env credentials."],
    cannotAdd: ["The provider row does not share credentials or state with the separate fixed-project Sentry Health connector."],
    limitations: ["Count-like activity is not billing cost or necessarily the plan quota; event, byte, and duration units remain separate metadata."],
    source: "src/lib/adapters/sentry.ts",
  }),
  langfuse: defineProfile({
    name: "langfuse", displayName: "Langfuse", category: "Observability", mode: "partial",
    summary: "Reads UTC calendar-month-to-date traces, observations, numeric/boolean scores, and categorical scores from Langfuse Cloud or a configured self-hosted endpoint.",
    reads: ["Billable-unit counts across four documented metrics views plus model cost observed by Langfuse for diagnostics."],
    stores: ["Unit-separated usage counts and tracked model cost as diagnostic metadata; model cost is never counted as the Langfuse vendor fee."],
    credentialInputs: ["Langfuse public key plus encrypted secret key.", "Optional host for self-hosted Langfuse."],
    billing: { visibility: "metadata", summary: "Langfuse billable-unit usage is direct; subscription price/status is not exposed, and tracked LLM spend belongs to underlying model providers." },
    canAdd: ["Manual subscription tracking can represent the Langfuse plan fee."],
    cannotAdd: ["Observed model cost cannot be relabeled as Langfuse subscription cost."],
    limitations: ["Custom hosts are treated as untrusted outbound URLs and pass SSRF checks.", "Each sync performs four metrics reads, so new connections default to a six-hour cadence to stay below common hosted-plan API limits."],
    source: "src/lib/adapters/langfuse.ts",
  }),
  twilio: defineProfile({
    name: "twilio", displayName: "Twilio", category: "Notifications", mode: "direct",
    summary: "Reads account balance plus the official current-month total-price and product-category Usage Records.",
    reads: ["Account balance/currency, canonical current billing-period total price, and paginated service/category quantity and estimated-price breakdowns."],
    credentialInputs: ["Account SID.", "Auth Token, or restricted API key secret plus optional API Key SID/auth username."],
    billing: { visibility: "actual", summary: "Current-month Twilio usage cost, report-through window, and product-level breakdown are direct; plan renewal and finalized invoices are not synchronized." },
    canAdd: ["Historical Usage Record windows could extend cost trends without storing message content."],
    cannotAdd: ["Restricted keys without billing usage read permission cannot access cost."],
    limitations: ["The total-price record may include fixed charges whose split is not identified."],
    source: "src/lib/adapters/twilio.ts",
  }),
  resend: defineProfile({
    name: "resend", displayName: "Resend", category: "Notifications", mode: "partial",
    summary: "Validates authentication through the non-sending API-key control plane and captures API rate state plus provider-reported daily/monthly email usage counts.",
    reads: ["Count of API keys visible to the supplied credential, API request limit/remaining/reset headers, and monthly/daily emails-used headers when returned."],
    stores: ["API-key count, rate metadata, and email usage counts; key values, email content, recipients, and delivery events are not stored."],
    credentialInputs: ["Resend API key."],
    billing: { visibility: "metadata", summary: "Email counts used are direct; the headers are not quota limits, so remaining allowance, plan, subscription status, spend, and renewal remain unavailable." },
    canAdd: ["Producer apps can push email send counts/cost; delivery telemetry could be added with explicitly scoped webhooks."],
    cannotAdd: ["Resend's control-plane response does not expose authoritative quota limits, remaining plan allowance, price, or billing cost."],
    limitations: ["The monthly/daily quota-named headers are used-email counts, not limits; API request-rate headers are a separate window."],
    source: "src/lib/adapters/resend.ts",
  }),
  pushover: defineProfile({
    name: "pushover", displayName: "Pushover", category: "Notifications", mode: "partial",
    summary: "Reads the pooled account/team message limit, remaining messages, used count, and reset date.",
    reads: ["Pooled account/team monthly message quota and reset timestamp."],
    credentialInputs: ["Pushover application API token."],
    billing: { visibility: "metadata", summary: "Quota is direct; purchase/subscription price and renewal are not exposed." },
    canAdd: ["Manual plan/subscription records can represent purchase cost if needed."],
    cannotAdd: ["The limits API does not return account purchase or subscription billing."],
    limitations: ["Since May 1, 2026, the returned allowance is pooled across the account or team rather than isolated per application."],
    source: "src/lib/adapters/pushover.ts",
  }),
  cloudflare: defineProfile({
    name: "cloudflare", displayName: "Cloudflare", category: "Infrastructure", mode: "direct",
    summary: "Reads account request analytics, fixed subscriptions, eligible PayGo billing, and optional single-resource D1/R2/KV/Queue metadata probes.",
    reads: ["30-day account request analytics, using Workers analytics only as a fallback when account totals are unavailable.", "All fixed subscriptions with price, status, billing period, and renewal.", "Billing-grade PayGo charges when the alpha endpoint is enabled for the account.", "Optional D1, R2, KV, and Queue fields each run one metadata/readability check for only the named resource."],
    credentialInputs: ["Account ID.", "Preferred scoped API token; or Global API key plus account email.", "Optional D1 database ID, R2 bucket name, KV namespace ID, and Queue ID for single-resource metadata/readability probes only."],
    billing: { visibility: "actual", summary: "Fixed subscription charges are direct; PayGo actual cost is direct only for eligible accounts. Analytics is never treated as billing-grade spend." },
    canAdd: ["More Cloudflare resource inventories or GraphQL analytics can be mapped with least-privilege scopes."],
    cannotAdd: ["PayGo billing cannot be forced for accounts that receive 403/404 or Cloudflare error 10000 from the restricted alpha endpoint."],
    limitations: ["Account and Workers request totals are never summed; Workers is fallback-only to avoid double-counting.", "Optional resource probes do not affect billing, subscriptions, spend, usage, quotas, or PayGo eligibility.", "Token permissions determine each capability independently; partial success is expected and recorded.", "Global API key auth is broader and should be avoided when a scoped Billing Read token works."],
    source: "src/lib/adapters/cloudflare.ts",
  }),
  hetzner: defineProfile({
    name: "hetzner", displayName: "Hetzner Cloud", category: "Infrastructure", mode: "partial",
    summary: "Inventories major Hetzner Cloud billable resources and resolves provider-catalog monthly run-rate in the account currency without claiming invoice spend.",
    reads: ["Paginated servers, volumes, floating and primary IPs, load balancers, snapshots, and automatic backup artifacts.", "The pricing catalog, currency, location-specific monthly prices, backup percentage, storage price, and observed bandwidth metadata."],
    stores: ["Minimized resource identity/status/capacity and native-currency catalog run-rate metadata; credentials, server contents, traffic payloads, and full responses are not persisted."],
    credentialInputs: ["Hetzner Cloud API token."],
    billing: { visibility: "metadata", summary: "Current resource run-rate is preserved in the provider's actual currency for display; only explicit USD values can enter normalized spend. Accrued invoice cost remains unavailable." },
    canAdd: ["Invoice totals, credits, tax, and discounts can be mapped if Hetzner exposes a supported billing API."],
    cannotAdd: ["Published plan prices cannot be represented as an actual accrued invoice."],
    limitations: ["Non-USD plan prices remain in their owner currency and are never mislabeled as USD; discounts, tax, and accrued invoice totals are unavailable.", "Automatic backup images are not priced again because the server backup add-on already represents that charge."],
    source: "src/lib/adapters/hetzner.ts",
  }),
  backblaze: defineProfile({
    name: "backblaze", displayName: "Backblaze B2", category: "Infrastructure", mode: "partial",
    summary: "Inventories B2 buckets and file versions for storage footprint and estimates storage MTD from public B2 pricing without claiming invoice spend or download charges.",
    reads: [
      "Buckets visible to the application key (listBuckets or a single scoped bucket).",
      "File version inventory per bucket via list_file_versions, including hidden versions that still bill until permanently deleted.",
      "Derived storage bytes/GB, free-allowance-adjusted billable GB, and pro-rated catalog storage MTD.",
    ],
    stores: [
      "Minimized bucket identity, file-version counts, and storage totals; credentials, object payloads, and full list responses are not persisted as content.",
    ],
    credentialInputs: [
      "Application Key ID.",
      "Application Key (prefer a dedicated read-only key with listBuckets + listFiles; do not reuse write/delete backup keys).",
      "Optional soft storage cap GB and catalog price / free-allowance overrides.",
    ],
    billing: {
      visibility: "metadata",
      summary: "Storage MTD is a public-catalog estimate pro-rated by UTC month; download bandwidth and Class A/B transactions are not included. Not an invoice.",
    },
    canAdd: [
      "Download and Class A/B transaction usage if Backblaze exposes a supported account usage API.",
      "Invoice totals if a billing-history endpoint becomes available.",
    ],
    cannotAdd: [
      "Console Caps & Alerts hard limits cannot be set or read via the public API.",
      "Download egress and Class A/B API transaction spend cannot be reconstructed from inventory APIs alone.",
    ],
    limitations: [
      "totalCost is public storage price × billable GB × UTC month fraction only.",
      "totalRequests is whole megabytes of storage so request-limit budgets can soft-cap footprint; as a storage gauge it is excluded from request-anomaly detection.",
      "Very large buckets may truncate inventory at a safety max file-version count.",
    ],
    source: "src/lib/adapters/backblaze.ts",
  }),
  coolify: defineProfile({
    name: "coolify", displayName: "Coolify", category: "Infrastructure", mode: "health-only",
    summary: "Reads server reachability/usability and application deployment status from a Coolify instance's REST API; this is service-health monitoring of self-hosted infrastructure, not a third-party billing account.",
    reads: ["Account-wide server inventory with reachability/usability flags.", "Account-wide application inventory with Docker-derived deployment status (running/exited/restarting plus health).", "Best-effort per-server resource inventory (applications, databases, services and their status) via one bounded request per discovered server."],
    stores: ["Minimized server/application identity, reachability, and up/down/degraded status derived from the documented status string; environment variables, git contents, logs, and deployment payloads are never requested."],
    credentialInputs: ["Coolify API token (Bearer) with read access.", "Optional instance host; defaults to Coolify Cloud, set explicitly for a self-hosted instance."],
    billing: { visibility: "none", summary: "Coolify is a self-hosted PaaS control plane and exposes no cost, invoice, or subscription API to this connector; there is no billing state to sync." },
    canAdd: ["Authenticated resource-usage metrics could be added if Coolify documents a REST endpoint for its Sentinel-collected CPU/memory/disk data."],
    cannotAdd: ["Live CPU/memory/disk utilization is pushed by Coolify's optional Sentinel agent directly into the instance's own database and is not exposed by any documented GET endpoint, so it cannot be read without an undocumented integration."],
    limitations: ["A configured self-hosted host is treated as an untrusted, SSRF-checked outbound URL.", "Per-server resource detail is capped and best-effort: a failure or an account past the server cap only downgrades that optional detail, never the core server/application health snapshot.", "An application with a null/empty status has never been deployed and is reported as not-yet-deployed rather than down."],
    source: "src/lib/adapters/coolify.ts",
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
  firecrawl: defineProfile({
    name: "firecrawl", displayName: "Firecrawl", category: "Data", mode: "partial",
    summary: "Reads the authenticated team's current plan-credit allowance, remaining credits, available billing-period boundaries, and bounded month-by-month historical credit usage.",
    reads: ["Current team plan-credit allowance, remaining credits, and billing-period start/end plus the separate historical account endpoint with byApiKey explicitly disabled."],
    stores: ["Selected current credit totals and normalized timestamps plus one non-money metadata row per completely validated historical period; no crawled content, URLs, API-key identifier/value, activity records, or raw provider response."],
    credentialInputs: ["Firecrawl API key."],
    billing: { visibility: "metadata", summary: "Plan allowance, remaining credits, available billing-period boundaries, and monthly historical credit consumption are direct non-money metadata. Plan tier, price, actual USD spend, subscription renewal, and invoices are not exposed." },
    canAdd: ["Additional usage granularity can be added only if Firecrawl publishes another non-generative account endpoint with a complete documented schema."],
    cannotAdd: ["Credit counts cannot be converted to USD or labeled as a paid subscription without an authoritative price or plan response."],
    limitations: ["The current endpoint does not report credits used. The monitor never subtracts remaining credits from the plan allowance because add-on credits can make the balance exceed that allowance.", "Historical usage is bounded, rejects a malformed/overlapping collection as a whole, and is omitted on optional endpoint failure so prior valid rows are not pruned.", "Billing-period start and end are independently nullable, and a period end is not claimed as a quota reset or subscription renewal."],
    source: "src/lib/adapters/firecrawl.ts",
  }),
  deno: defineProfile({
    name: "deno", displayName: "Deno Deploy", category: "Developer Platform", mode: "partial",
    summary: "Retired.  Legacy Deno Deploy records remain for a dead host.  Congress.Trade and other Jay apps now run on Coolify, not Deno Deploy.",
    reads: ["Historical user ID, name, email, and organization billing metadata when a leftover token is still present."],
    stores: ["User name/email and external billing account identity from leftover rows."],
    credentialInputs: ["Optional leftover Deno Deploy Personal Access Token (ddp_...).", "Optional historical organization slug."],
    billing: { visibility: "partial", summary: "Deno Deploy is retired and is not a live production host.  Leftover identity metadata may still exist on historical rows; Coolify is the Congress.Trade host now." },
    canAdd: ["Nothing further — Deno Deploy is retired.  Track Congress.Trade host cost on Coolify."],
    cannotAdd: ["Inference or code execution is not performed.", "This connector must not be treated as a current hosting target."],
    limitations: ["Deno Deploy is retired.  The leftover adapter exists only so historical rows stay legible; Jay apps do not host on Deno Deploy."],
    source: "src/lib/adapters/deno.ts",
  }),
  llamaindex: defineProfile({
    name: "llamaindex", displayName: "LlamaIndex Cloud", category: "Data", mode: "partial",
    summary: "Discovers accessible organizations and reads paginated UTC calendar-month-to-date product-credit usage without running parsing or inference.",
    reads: ["Organization identity plus beta usage-metrics rows, event types, quantities, and credits consumed, optionally filtered to one project."],
    stores: ["Organization names and aggregated event/credit usage only; user IDs and aggregation keys returned by the provider are discarded."],
    credentialInputs: ["LlamaIndex Cloud API key.", "Optional project ID and optional custom host."],
    billing: { visibility: "metadata", summary: "Product credits consumed are direct; remaining credit balance, USD cost, plan, subscription status, and renewal are not exposed." },
    canAdd: ["A supported account balance, price, or invoice API could complete the billing picture if LlamaIndex exposes one."],
    cannotAdd: ["Consumed product credits cannot be treated as remaining balance or converted to USD without an authoritative price contract."],
    limitations: ["Custom hosts are SSRF-checked.", "A failure in any organization or pagination page aborts the authoritative sync instead of preserving a partial report."],
    source: "src/lib/adapters/llamaindex.ts",
  }),
  stripe: defineProfile({
    name: "stripe", displayName: "Stripe", category: "Payments", mode: "direct",
    summary: "Reads merchant balance and sums actual current-month Stripe processing fees from balance transactions.",
    reads: ["Available/pending USD merchant balance and paginated balance-transaction fees."],
    stores: ["Aggregated processing fee, transaction counts, and balance summary; customer identities, payment details, and subscription objects are not requested."],
    credentialInputs: ["Stripe restricted or secret key with read access to balance and balance transactions."],
    billing: { visibility: "actual", summary: "Actual processing fees are direct. Customer subscription revenue is intentionally not counted as the Stripe provider's cost; Stripe's own account plan is not exposed." },
    canAdd: ["Additional fee dimensions could be added without ingesting customer data; currency and reporting-category breakdowns already sync."],
    cannotAdd: ["Customer subscriptions/revenue cannot be treated as vendor spend, and payment-method data is out of scope."],
    limitations: ["Only USD fees are included in the normalized total."],
    source: "src/lib/adapters/stripe.ts",
  }),
  namecheap: defineProfile({
    name: "namecheap", displayName: "Namecheap", category: "Infrastructure", mode: "direct",
    summary: "Reads prepaid account balance, funds required for auto-renewal, and active domain inventory with upcoming expiration dates from the official Namecheap XML API.",
    reads: ["Account balance, available balance, earned/withdrawable funds, funds required for auto-renew, and active domains with expiration dates."],
    stores: ["Prepaid balance, total active domain count, and domain renewal metadata; billing payment methods and registrar contact details are not requested."],
    credentialInputs: ["Namecheap API key.", "Account username.", "Optional whitelisted client IP."],
    billing: { visibility: "actual", summary: "Prepaid available balance is direct. Domain renewals and auto-renew required funds are visible in snapshot metadata." },
    canAdd: ["Domain auto-renewal status, expiration timeline, and DNS host inspection."],
    cannotAdd: ["Domains registered with third-party registrars are not visible through Namecheap API."],
    limitations: ["Namecheap API requires IP address whitelisting in the account security settings."],
    source: "src/lib/adapters/namecheap.ts",
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
  agent_sync_relay: "agent-sync-relay",
};

// The connection catalog is intentionally narrower than CATALOG: CATALOG
// retains profiles needed to explain historical rows, while dormant/retired
// built-ins are not offered as new integrations.
export const PROVIDER_INTEGRATION_PROFILES = Object.values(CATALOG).filter(
  (profile) =>
    !BUILT_IN_PROVIDER_NAMES.has(profile.name) || isBuiltInProviderActive(profile.name)
);

export function getProviderIntegrationProfile(
  providerName: string,
  providerType?: string
): ProviderIntegrationProfile {
  const normalizedType = providerType?.trim().toLowerCase();
  if (normalizedType === "custom") return CATALOG.custom;
  if (normalizedType === "generic" || normalizedType === "push") {
    return CATALOG.generic;
  }
  const normalized = providerName.trim().toLowerCase();
  const identity = canonicalProviderKey(providerName);
  const canonical =
    identity === "google-ai" ? identity : ALIASES[normalized] ?? normalized;
  return CATALOG[canonical as CatalogProviderName] ?? CATALOG.generic;
}
