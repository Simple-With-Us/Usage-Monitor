# Billing / subscription API coverage research

**Date:** 2026-08-05  
**Scope:** Hard look for **invoice, billing-history, and subscription** APIs — LLMs first, then other fleet sources that still lack full programmatic cash insight.  
**Method:** Official docs, OpenAPI where available, existing adapter catalog (`src/lib/provider-integration-catalog.ts`), public REST references.

**Legend**

| Label | Meaning |
|---|---|
| **Have** | We already poll cash-ish data on the **remote** monitor |
| **API exists — not wired** | Documented REST we could integrate |
| **Console only** | Humans can see invoices/history; **no public API** found |
| **Impossible / separate product** | Consumer SaaS subscription ≠ API billing; no bridge API |
| **Estimate path** | Inventory + public price list (not invoice) |

---

## 1. LLMs — API spend vs consumer subscription

Critical split for almost every vendor:

- **API / platform billing** (token usage, prepaid credits, org invoices)  
- **Consumer chat subscription** (Claude Max, ChatGPT Plus/Pro, SuperGrok, etc.)

These are almost always **separate products**. There is **no** public API that returns “my Claude Max $200 Apple charge history” or “ChatGPT Plus invoices” for automation.

### Anthropic / Claude

| Channel | Billing history / subscription API? | Notes |
|---|---|---|
| **API org (Console)** | **Partial — Have (Admin)** | Cost report API for **organization Admin keys** only. Console cost page + CSV export for humans ([support](https://support.claude.com/en/articles/9534590-cost-and-usage-reporting-in-the-claude-console)). |
| **Individual API key** | **No billing poll** | Admin/Usage APIs **not** offered to individual accounts; we correctly avoid polluting with Messages keys. |
| **Claude Pro / Max / Team (claude.ai)** | **Console only / Impossible via API** | Subscription managed in product / App Store / Google Play. No public “list my Max invoices” API. Claude Code `/usage` shows plan bars for subscribers, **not** a machine bill API. |
| **Apple-billed Claude** | **Impossible via Anthropic API** | Charge lives in Apple; we already model via manual/receipt import when needed. |

**Actionable:** Keep Admin cost report; never expect Max subscription history from Anthropic APIs. Receipt/Apple/App Store import remains the path for Max.

### OpenAI

| Channel | Billing history / subscription API? | Notes |
|---|---|---|
| **API organization** | **Have (Admin Costs)** | Organization Costs API = actual MTD cash (we poll). Billing history for invoices is primarily **Console UI** (`platform.openai.com` → Org → Billing → History). No first-class “list all invoices” REST equivalent called out like Costs API. |
| **ChatGPT Plus / Pro / Go** | **Console only / separate product** | Explicit: ChatGPT and API are **separate billing systems** ([help](https://help.openai.com/en/articles/9039756-managing-billing-settings-on-chatgpt-web-and-platform)). No API that returns Plus/Pro subscription invoices to a project key. |
| **ChatGPT Business/Enterprise** | **Console admin** | Workspace billing in ChatGPT admin; not the same as Organization Costs API. |

**Actionable:** API cash = Costs API (done). ChatGPT consumer subscription = not API-automatable; treat as fixed subscription or receipt.

### xAI / Grok

| Channel | Billing history / subscription API? | Notes |
|---|---|---|
| **API (console.x.ai)** | **API exists — Management REST** | Documented Management Billing: prepaid balance, **postpaid invoice preview**, spending limits, **`GET /v1/billing/teams/{team_id}/invoices`** (list invoices) ([docs](https://docs.x.ai/developers/rest-api-reference/management/billing)). We already poll balance + invoice **preview** when Management key + `teamId` are set. **Invoice list history** is an incremental win if not fully consumed. |
| **SuperGrok / X Premium consumer** | **Separate product** | FAQ: large unknown invoices often SuperGrok Heavy **subscription**, not API. API credits ≠ SuperGrok. No public API for SuperGrok subscription history found. |

**Actionable:** On remote: ensure xAI is configured (`teamId` + Management key). Extend adapter to persist **invoice list** if preview alone under-reports. SuperGrok = subscription row / receipt.

### Google Gemini / AI Studio

| Channel | Billing history / subscription API? | Notes |
|---|---|---|
| **Gemini API (AI Studio paid)** | **Console + Cloud Billing** | Usage/spend dashboards in AI Studio; transaction history for prepay in UI. Full finance history via **Google Cloud Billing** (Console reports / BigQuery export) when linked — we already support billing export path for actual cash on remote. |
| **No simple “list invoices” Gemini key API** | — | Spend caps and daily cost graphs are product UI; authoritative history is Cloud Billing, not a Gemini-only REST invoice list. |

**Actionable:** Prefer Cloud Billing export for programmatic Gemini API cash (already the designed path). Don’t expect AI Studio UI parity from a Gemini API key alone.

### Mistral

| Channel | Billing history / subscription API? | Notes |
|---|---|---|
| **API org admin** | **Partial — Admin usage/spend** | Admin panel documents invoices (UI). Beta admin endpoints include **spend limits** and **usage** (`GET /v1/admin/usage`, spend-limit routes) — not a full invoice PDF API in public docs, but **programmatic spend/usage** exists for admin keys. |
| **Le Chat Pro consumer** | **Separate SaaS stream** | Docs/community: API token bill ≠ Le Chat subscription. |

**Actionable:** Tighten Mistral adapter toward admin usage/spend (we currently treat much as metadata); still no Chat subscription API.

### DeepSeek

| Channel | Billing history / subscription API? | Notes |
|---|---|---|
| **API platform** | **Balance only (Have partial)** | Documented `user/balance` style access; no public invoice-history REST found in docs sweep. Console for top-ups. |
| **Chat consumer app** | Separate / free-tier product | Not the API bill. |

**Actionable:** Keep balance poll; no invoice list API found.

### OpenRouter

| Channel | Billing history / subscription API? | Notes |
|---|---|---|
| **API** | **Have partial** | Management key: credits, activity MTD estimate, keys. Not a full multi-year invoice archive API; prepaid + activity based. |

### Voyage AI

| Channel | Billing history / subscription API? | Notes |
|---|---|---|
| **API** | **None found (blind)** | Catalog: no non-billable account/invoice/subscription endpoint. Console only if any. |
| **Remote Usage Monitor** | **Push/manual + Subscription row** | Blind adapter; no key poll. Cost via `ExternalUsageEvent` push or Settings subscription. |
| **Local Usage Monitor** | **Subscription shell only** | Same reality — no phone poll. Catalog entry `voyage` seeds for historical tracking. |

### Oracle Cloud Infrastructure (OCI)

| Channel | Billing history / subscription API? | Notes |
|---|---|---|
| **Remote** | **Have — OCI Usage API (COST)** | RSA-signed Usage API for completed UTC days MTD; budgets; service detail. Up to ~48h publication lag (caveat). |
| **Local (iPhone)** | **Subscription shell only** | OCI RSA private-key signing is server-side; phone does not embed RSA tenancy poll in v1. Track paid add-ons as subscription; use **remote** for live OCI cash. |

### Hetzner Cloud

| Channel | Billing history / subscription API? | Notes |
|---|---|---|
| **Invoice / billing history REST** | **Not in public Cloud API** | Account invoices stay on accounts.hetzner.com UI. |
| **Remote** | **Estimate path — Have** | Full inventory + public pricing catalog; `totalCost` = pro-rated UTC MTD catalog run-rate with `hetzner_catalog_runrate_prorated` caveat. |
| **Local** | **Estimate path — Have** | Same idea: project token → servers/volumes/IPs/LBs + pricing catalog × month fraction. |

### Cursor (IDE — LLM-adjacent spend)

| Channel | Billing history / subscription API? | Notes |
|---|---|---|
| **Cursor Pro / Business** | **Console / Stripe portal only** | No public Cursor “list invoices” API found for end users. Business may use Stripe customer portal (not Cursor REST). |

---

## 2. Non-LLM sources without full cash insight (hard look)

### Render — invoice/billing API

**Official OpenAPI** (`render-public-api-1.json`, ~130 paths, 2026-08-05 dig):

- **Zero** paths matching invoice / billing / charges / payment history.
- **Metrics:** `/metrics/bandwidth`, CPU, memory, disk, HTTP, etc. (usage quantities).
- **Inventory:** services, Postgres, Key Value, plans, disks.

Dashboard Billing page shows accrued charges and past invoices — **UI only**, not in public OpenAPI.

| Path | Status |
|---|---|
| Invoice/billing REST | **Not public** |
| Bandwidth / inventory | **Have** |
| Estimated $ from plan price list + inventory | **Not built yet** (should be) |

**Keep watching:** re-fetch OpenAPI periodically for any `/billing` or `/invoices` addition.

### Cloudflare

| Channel | Status |
|---|---|
| **Have** | Account billing / GraphQL usage paths already in adapter family (actual visibility in catalog). |
| **New opportunity** | **Billable Usage API** announced for self-serve (programmatic usage + cost by product/period) — worth integrating if not already covering all products. |

### Vercel / Oracle / Stripe / Twilio / GitHub / Apify

Catalog marks **actual** cash visibility — already in “have programmatic insight” bucket (not the focus of this gap list).

### Hetzner / Pinecone / Sentry / Resend / Pushover / Firecrawl / LlamaIndex / Coolify

Mostly **metadata / inventory / partial** — plan labels without invoice APIs, or metrics without $.

| Provider | Billing history API? | Better path |
|---|---|---|
| Hetzner | **No public invoice API** (re-verified). Catalog MTD estimate wired on **remote + Local** | Keep watching accounts API; until then catalog pro-rate |
| Pinecone | Console billing; control-plane inventory only in our adapter | Plan estimate + console |
| Sentry | Org stats / subscription often console or partner | Stats ≠ invoice |
| Coolify | Self-hosted / host bill, not Coolify SaaS invoice | Host cost (Hetzner/Oracle) |
| Deno Deploy | Retired (dead host) | Historical only — Congress.Trade now hosts on Coolify |

### Market data (FMP, Tiingo, Finnhub, AV, FRED, Massive, …)

**Blind by design** for $: rate limits / credits, not USD invoices. Subscription tiers are SaaS; almost never a “list my FMP invoices” public API. Track as fixed subscription or receipt.

---

## 3. Consumer **subscriptions** (the hard problem)

For **Claude Max, ChatGPT Plus/Pro, SuperGrok, Cursor, Apple-billed anything**:

| Source of truth | Automatable with vendor API? |
|---|---|
| Vendor consumer billing page | Rarely |
| **Apple / Google Play** | No public “list my app subscriptions” for third-party tools; Apple has App Store Connect for **developers**, not consumers |
| **Bank / card export** | Possible via Plaid-class (out of scope, privacy-heavy) |
| **Email invoices** | Our receipt-inbox / HMAC import path |
| **User-confirmed fixed Subscription row** | Works; not “insight” |

**There is no legitimate public REST API** that returns a unified “all my LLM consumer subscriptions billing history” for Claude Max / ChatGPT Plus / SuperGrok. Anyone claiming otherwise is scraping logged-in HTML or abusing private mobile APIs (fragile, ToS risk).

---

## 4. Priority matrix (build order if we invest)

### A — Real API cash we underuse

1. **xAI** — confirm Management + `teamId` on prod; add **invoice list** endpoint if preview under-reports history.  
2. **Cloudflare Billable Usage API** — if self-serve and not fully covered, wire for product-level cost.  
3. **Mistral admin usage/spend** — tighten from metadata → budget-facing where safe.  
4. **Google** — ensure Cloud Billing export path is live for Gemini projects that matter.

### B — Estimate money (no invoice API)

1. **Render** — plan/disk/instance × published price table + bandwidth quantity (+ overage estimate only if included GB known from workspace tier). Label **estimate**.  
2. **Hetzner** — **done (remote + Local)**: catalog run-rate × UTC month fraction → `totalCost` with explicit non-invoice caveat.

### C — Cannot automate vendor-side (honest)

- Claude Max / Pro (consumer)  
- ChatGPT Plus / Pro  
- SuperGrok / X Premium Grok  
- Cursor consumer  
- Voyage invoices  
- Render invoice PDFs (until API exists)  
- Most market-data “pro” seats  

→ Receipt import, email intake, or fixed Subscription with known $20/$100/$200 SKUs.

---

## 5. Standing watchlist (re-check quarterly)

| Vendor | What to re-check |
|---|---|
| **Render** | OpenAPI for `/billing`, `/invoices`, accrued usage REST |
| **Anthropic** | Individual cost APIs; Claude.ai subscription API (unlikely) |
| **OpenAI** | Invoices REST beyond Costs; ChatGPT billing API (unlikely) |
| **xAI** | New Management billing fields; SuperGrok API (unlikely) |
| **Voyage** | Any account/usage billing endpoint |
| **Cloudflare** | Billable Usage API rollout completeness |
| **Google** | AI Studio billing export APIs beyond Cloud Billing |

---

## 6. Dual-app historical coverage (remote + Local)

**Product rule:** both apps must surface **every provider ever used** (active, dormant, retired), not only current spend sources. Missing rows hide cost.

| Layer | Remote (Next.js / Oracle) | Local Usage Monitor (iOS) |
|---|---|---|
| **Catalog** | `PROVIDER_DEFINITIONS` (42 builtins) + lifecycle retired/dormant retained | `LocalProviderCatalog` = all 42 + Claude sub, Cursor, Ag*** S**c, custom |
| **Seed** | DB rows from UI / Infisical / poll | `seedMissingCatalogProviders()` inserts inactive shells for every missing entry |
| **Voyage** | Blind push/manual | Subscription shell |
| **Oracle** | OCI Usage API cash (RSA) | Subscription shell (use remote for live $) |
| **Hetzner** | Catalog pro-rated MTD estimate | Same pattern via phone poll adapter |
| **True poll $ on phone** | n/a | OpenRouter, OpenAI Admin, DeepSeek balance, Anthropic Admin, Hetzner estimate |
| **Everything else** | Per-adapter poll or blind | Subscription / key shell until ported |

Retired brokers (Tradier, Alpaca, Robinhood), retired Deno Deploy (dead host; Congress.Trade now runs on Coolify), and dormant Firecrawl stay in both catalogs for **historical** tracking even when auto-poll is off.

---

## 7. Bottom line for the product

1. **API token spend** for major LLMs is largely solvable (and partly already solved) via **Admin / Management / Costs** APIs — **not** via consumer Max/Plus portals.  
2. **Consumer subscriptions** (Max, Plus, SuperGrok, Cursor) will not become “full insight” through vendor REST without scraping; receipt/email/subscription SKU is correct.  
3. **Render** still has **no** public invoice endpoint after a full OpenAPI dig; next best is **SKU estimate + bandwidth**, and keep watching for billing APIs.  
4. **Hetzner** is on the estimate path for **both apps** (not invoice truth).  
5. **Voyage** remains non-automatable until they ship a usage API; **Oracle live $** is remote-only.  
6. Highest remaining ROI automation: **xAI invoices + Render estimates + Cloudflare billable usage**.

---

## References (anchors)

- Render OpenAPI: `https://api-docs.render.com/v1.0/openapi/render-public-api-1.json` (dig 2026-08-05: 0 invoice paths)  
- xAI Management billing: `https://docs.x.ai/developers/rest-api-reference/management/billing`  
- OpenAI ChatGPT vs API billing separation: OpenAI help “Managing Billing Settings on ChatGPT Web and Platform”  
- Anthropic cost reporting roles / Console: support article 9534590  
- Mistral admin billing/usage docs: `docs.mistral.ai/admin/billing-usage/*`, beta admin spend/usage endpoints  
- Internal catalog: `src/lib/provider-integration-catalog.ts`
