# Direct billing and account integrations

Last verified: 2026-07-11. Links below are provider-owned documentation.

## Data model and safety boundary

Adapters return two independent channels:

- `totalCost` is only actual month-to-date/provider-reported spend that may enter budget math.
- `externalBilling` is authoritative plan, status, billing-period, renewal, price, and limit metadata from an official API. It is idempotently reconciled into `ProviderExternalBilling` by `(providerId, source, externalId)`.

External billing rows are deliberately **not** copied into local `Subscription` rows. A local Subscription materializes a charge event; doing that for an account whose adapter already reports the same invoice/period cost would charge it twice. The direct rows are read-only state for Settings/provider detail. An operator may choose to replace a manual Subscription after comparing the external record, but that remains an explicit action.

No adapter sends an inference, email, market-data, or other quota-bearing request merely to validate a credential. Dynamic endpoints are HTTPS-only, redirect-denied, DNS-pinned, private-address-blocked, and response-size-bounded. Pinecone-discovered data-plane hosts must also match a Pinecone-controlled `*.svc.*.pinecone.io` host before the API key is forwarded.

Credential-shaped provider configuration is stored in encrypted `Provider.secretConfig`. `config.adminApiKey`, `managementKey`, `apiSecret`, `secretKey`, tokens, passwords, authorization headers, and `extraHeaders` are decrypted only inside the adapter registry. Provider API responses return only public config and `secretConfigMeta` field names.

## Direct cost and billing connections implemented

| Provider | Direct data | Required credential/config | Official source |
|---|---|---|---|
| OpenAI | Organization Costs API plus legacy usage/balance fallback | Organization Admin key in encrypted `adminApiKey`; normal API key remains separate | [Costs API](https://platform.openai.com/docs/api-reference/usage/costs) |
| Anthropic | Organization month-to-date cost report; cents converted to USD | Admin API key (`sk-ant-admin...`) in encrypted `adminApiKey` or primary key field | [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api) |
| DeepSeek | Prepaid/granted balance and availability | API key | [User balance API](https://api-docs.deepseek.com/api/get-user-balance/) |
| xAI | Prepaid balance, postpaid current invoice preview, billing cycle, monthly spending limits | `teamId`; encrypted `managementKey` (or primary key if it is a Management API key) | [Billing Management API](https://docs.x.ai/developers/rest-api-reference/management/billing) |
| Mistral | Organization current usage/cost, payment/limit status, monthly spend cap, request/token limits | Backoffice Admin API key in encrypted `adminApiKey` | [Admin usage metrics](https://docs.mistral.ai/admin/admin-api/usage-metrics) |
| Cloudflare | Fixed account subscriptions plus billing-grade PayGo contracted cost for the current billing period (restricted alpha); analytics remains usage-only | `accountId`; API token with Billing Read, or encrypted global key plus `accountEmail` | [Account subscriptions](https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get/) and [PayGo billable usage](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/paygo) |
| Twilio | Account balance and ThisMonth `totalprice` Usage Record | `accountId` (Account SID); auth token/restricted key with `/twilio/billing/usage/read` | [Usage Records API](https://www.twilio.com/docs/usage/api/usage-record) |
| Apify | Billing cycle, usage USD, maximum usage, active plan, monthly base price and included credits | API token | [Account limits API](https://docs.apify.com/api/v2/users-me-limits-get) and [account API](https://docs.apify.com/api/v2/users-me-get) |
| Stripe | Available merchant balance and actual month-to-date Stripe fees from balance transactions | Restricted/secret key able to read Balance and Balance Transactions | [Balance](https://docs.stripe.com/api/balance) and [Balance Transactions](https://docs.stripe.com/api/balance_transactions/list) |
| GitHub | Organization enhanced-billing usage; sums `netAmount` without retaining repository-level details | `org`; fine-grained token with Organization Administration read | [Billing usage API](https://docs.github.com/en/rest/billing/usage) |
| Vercel | Month-to-date FOCUS 1.3 billing charges; sums `BilledCost` and stores service-level aggregates without project tags | Access token with billing access; optional `teamId`; Pro/Enterprise availability | [FOCUS billing charges](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges) |

Stripe customer subscriptions are merchant revenue, not the cost of the Stripe account. They are never treated as provider spend. Pending merchant balance is also not spend; only the `fee` on balance transactions feeds `totalCost`.

## Direct plan, status, quota, or run-rate connections implemented

These APIs are useful direct replacements for manually typed status/limits, but do not expose an authoritative invoice cost. Their plan/limit state is first-class `externalBilling`; it does not enter budget spend.

| Provider | Direct state | Boundary | Official source |
|---|---|---|---|
| Render | Service plan and suspended/active status (`serviceId`) | Service API has no invoice amount/cadence, so no cost is invented | [Retrieve service](https://api-docs.render.com/reference/retrieve-service) and [service fields](https://api-docs.render.com/reference/service-fields) |
| Hetzner Cloud | Server type, status, location and provider-published monthly plan run-rate per server | `/servers` exposes resource prices, not accrued invoice cost; run-rate stays metadata | [Cloud API](https://docs.hetzner.cloud/reference/cloud) |
| Twelve Data | Current plan body plus real-time credits used/remaining from documented response headers | No billing price or renewal API | [API usage endpoint](https://twelvedata.com/docs/advanced/api-usage) |
| Intrinio | Per-feed current usage, limit, remaining calls and reset window | No subscription price/invoice API | [Current usage](https://docs.intrinio.com/documentation/web_api/get_account_current_usage_v2) |
| Pushover | Monthly application message limit, remaining messages and reset | No subscription price/status in the application limits API | [Application limits](https://pushover.net/api) |
| Tradier | Documented API rate-limit allowed/used/available/reset plus brokerage account status | Portfolio P/L and buying power are not API spend; they remain account metadata | [Rate limiting](https://docs.tradier.com/docs/rate-limiting) |
| Sentry | Organization event/transaction consumption summary | No documented account billing/subscription endpoint | [Organizations API](https://docs.sentry.io/api/organizations/) |
| Pinecone | Read-only index inventory and vector count | No public billing endpoint; discovered hosts are allowlisted before credential forwarding | [Usage reports and billing](https://docs.pinecone.io/guides/organizations/manage-billing/download-usage-report) |
| Resend | Non-sending API-key control-plane authentication | Quota and plan are dashboard-only; key names/details are not persisted | [API reference](https://resend.com/docs/api-reference/introduction) |
| LlamaIndex Cloud | Non-inference project control-plane authentication | No documented remaining-credit or billing endpoint; project details are not persisted | [API overview](https://developers.llamaindex.ai/python/cloud/llamaparse/api-v2-guide/) |
| Google Gemini API | Non-inference models control-plane authentication and any returned rate-limit headers | Gemini API key does not grant Cloud Billing cost access | [Gemini billing](https://ai.google.dev/gemini-api/docs/billing) |
| Alpaca | Brokerage account equity/status | Buying power/equity is not API credit or provider spend | [Trading API account](https://docs.alpaca.markets/reference/getaccount-1) |

Langfuse's metrics API reports the cost of model calls observed by Langfuse, not the Langfuse subscription invoice. The adapter exposes `trackedLlmCostUsd` as diagnostic metadata but does not book it against the Langfuse provider, avoiding double count with OpenAI/Anthropic/etc. See [Langfuse Metrics API](https://langfuse.com/docs/metrics/features/metrics-api).

Cloudflare analytics is not billing-grade. Fixed subscription prices/status are direct, and the restricted PayGo alpha supplies `ContractedCost` where the account is eligible. The broader v2 usage alpha currently documents cost fields as unpopulated, so the adapter does not infer missing cost from analytics.

## No safe direct billing endpoint found

The following adapters no longer consume a paid/quota-bearing product call for a fake “usage check.” They return a typed `UNSUPPORTED` result (no false successful snapshot) and rely on pushed telemetry or local Subscription/ProviderPlan data until the provider publishes a non-billable account API.

| Provider | Current authoritative surface |
|---|---|
| Voyage AI | Dashboard only; inference endpoints would create billable embeddings. [Pricing](https://docs.voyageai.com/docs/pricing) |
| FMP | Developer dashboard usage/billing. [Developer docs](https://site.financialmodelingprep.com/developer/docs/quickstart) |
| Finnhub | Dashboard/contract; no documented billing endpoint. [API docs](https://finnhub.io/docs/api) |
| Alpha Vantage | Dashboard/plan; no documented account billing endpoint. [Documentation](https://www.alphavantage.co/documentation/) |
| Tiingo | Account dashboard; no documented account billing endpoint. [API docs](https://www.tiingo.com/documentation/general/overview) |
| Marketstack | Dashboard usage and plan. [FAQ](https://marketstack.com/faq) |
| Massive (Polygon) | Account/billing dashboard. [Account help](https://massive.com/knowledge-base/categories/account) |
| Fintech Studios | No documented account usage/billing endpoint found |
| FRED | Free API; no billing state. [API docs](https://fred.stlouisfed.org/docs/api/fred/) |
| Robinhood retail | No public retail subscription/billing API |

Google Cloud cost data can be automated only through a separate Cloud Billing/BigQuery billing-export integration using Google Cloud identity and a billing project; a Gemini API key is intentionally insufficient. Pinecone usage reports are downloadable CSVs in the console rather than a documented API. Render and Hetzner expose resource plan/state but not invoices. Those boundaries are kept explicit instead of scraping dashboards or storing interactive-login credentials.

## Operations

- `npm run migrate:provider-secrets` is dry-run by default; add `-- --apply` only after a database backup and schema deployment. It reports field paths, never values.
- `npm run audit:provider-duplicates` is read-only and prints only normalized provider names and IDs. Duplicate rows are warned in provider GET responses but are never auto-merged/deleted because each may own different credentials, plans, snapshots, subscriptions, or project allocations.
- Schema deployment creates `ProviderExternalBilling` and `Provider.secretConfig` through the existing additive-only `scripts/migrate-safe.mjs` startup path.
