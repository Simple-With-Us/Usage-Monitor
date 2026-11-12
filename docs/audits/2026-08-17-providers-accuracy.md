# Usage Monitor — provider-connectors accuracy audit

**Date:** 2026-08-17
**Owner:** Grok (read-only)
**Branch:** `cursor/providers-accuracy-audit-9579`
**HEAD reviewed:** `8db78b58ef12ed45ec73df8fdb162596c96b03b4`
**Method:** Static review of every poll adapter, the adapter router, `UsageResult` persistence, budget/reconciliation/alert consumers, and adapter test fixtures.  No production calls, no credential use, no code changes.

**Keepout:** Product-level burn-rate / remaining-days / free-tier UX lives on `cursor/outcomes-projections-audit-4269`.  This report stays on connector truth: what each provider actually returns, how units and windows are labeled, and whether tests pin the money path.

**Prior art:** `src/lib/provider-integration-catalog.ts` (provenance `reviewedOn: "2026-07-13"`), `docs/research/2026-08-05-billing-api-coverage.md`, `docs/audits/2026-07-20-grok3-full-app-expert-review.md`.

---

## Verdict

The poll layer is unusually honest for a multi-vendor cost monitor.  Blind market-data adapters refuse to spend a quota call.  OpenAI / Anthropic / Stripe / GitHub / Twilio / Google Billing fail closed on malformed or non-USD cash.  Estimates (Hetzner, Backblaze, OpenRouter activity) carry `costCoverageCaveat` and mark spend coverage partial.

Residual accuracy risk is concentrated in five places:

1.  **Catalog FX vs code.**  Hetzner converts EUR→USD (live rate, env override, or hardcoded `1.09`) and writes the result into `totalCost`.  The integration catalog still says only explicit USD enters normalized spend.
2.  **`amountUsd` is a misnomer.**  Stripe and Cloudflare correctly withhold non-USD from `UsageResult.totalCost`, then persist native-currency amounts in `AdapterExternalBillingRecord.amountUsd` with a `currency` tag.  Any consumer that sums `amountUsd` without checking `currency` books euros as dollars.
3.  **Alert path still treats missing snapshot cost as $0** when `trackedSpendUsd` is absent (`latestSnapshot?.totalCost ?? 0`).
4.  **`totalRequests` is not always monthly requests.**  Render stores bandwidth MB, Backblaze stores storage MB, Unusual Whales stores a *daily* header, Twelve Data stores daily or minute used.  `request_limit` alerts compare that scalar to `ProviderPlan.monthlyRequestLimit`.
5.  **Catalog provenance is stale** (`2026-07-13`) against later Hetzner FX, OpenRouter activity MTD, Backblaze storage estimates, and Cloudflare PayGo caveats.

No P0 “this adapter silently books a wrong invoice as cash” was found on the live `totalCost` path for the actual-cash adapters (OpenAI Admin, Anthropic Admin, Stripe USD fees, Twilio ThisMonth USD, GitHub enhanced billing, Apify current-cycle, Cloudflare USD subscriptions + eligible PayGo, Google Billing export).  The P1s below are trust and unit-contract bugs, not a proven live double-count of two USD invoices.

---

## Severity legend

| Sev | Meaning |
|-----|---------|
| **P0** | Live cash number can be wrong and look authoritative (invoice-grade). |
| **P1** | High trust risk: unit/currency/window mismatch, estimate presented as cash, or alert on a false zero. |
| **P2** | Coverage gap, fixture hole, or catalog drift that will bite the next change. |
| **P3** | Cleanup, naming, retired-adapter leftover. |

---

## How adapter output becomes money

```
Provider row
  → fetchProviderUsage (src/lib/adapters/index.ts)
  → adapter.fetchUsage → UsageResult
  → usage-recorder persists UsageSnapshot + reconcileProviderExternalBilling
  → budget-status.ts: spentUsd = max(snapshot variable, pushed usage) + fixed
  → provider-alerts.ts: budget / request_limit / balance / discrepancy
  → provider-usage-reconciliation.ts: snapshot variable vs pushed (audit only)
```

Evidence:

- `UsageResult` contract: `src/lib/adapters/helpers.ts:30-57` (`balance`, `totalCost`, `fixedCostIncludedUsd`, `costWindow*`, `costScope`, `costIncludesUnknownFixed`, `costCoverageCaveat`, `externalBilling*`).
- Persistence: `src/lib/usage-recorder.ts:88-113`.  Caveats and partial failures are stuffed into `rawData.__apiUsageMonitor`, not first-class columns (`src/lib/snapshot-sync-status.ts:77-100`).
- Budget variable usage: `src/lib/budget-status.ts:1352-1363` — `max(snapshotVariable, pushed.usagePushed)`.  Receipt cash is funding, not spend (comment at 1356-1359).
- Caveat → coverage: if the latest cost snapshot has a caveat code, `spendCoverage` cannot stay `"complete"` (`src/lib/budget-status.ts:617-621`, IDs collected at 1157-1171).
- Discrepancy alerts fire only on `status === "discrepancy"` with `|delta| > $0.01` (`src/lib/provider-alerts.ts:372-377`).  Zero pushed events is `unverifiable`, not a 100% discrepancy (`src/lib/provider-usage-reconciliation.ts:256-275`).  Tolerance: $0.01 absolute or 5% of verified (`:31-32`, `:75-88`).
- Visibility gate: only catalog `actual` / `partial` providers are reconcilable (`:71-73`).  Metadata/manual/none are explicit `unverifiable`.
- Shared HTTP: `fetchJson` — 30s timeout, 2 retries on 429/502/503/504, Retry-After capped at 15s, 2 MiB body, HTTPS only, redirects rejected (`src/lib/adapters/helpers.ts:214-218`, `:276-364`, `:397-399`).

### Shared P1 / P2

| ID | Sev | Finding | Evidence |
|----|-----|---------|----------|
| S1 | P1 | Alert estimate uses `latestSnapshot?.totalCost ?? 0` when `trackedSpendUsd` is omitted.  A missing poll looks like $0 spend. | `src/lib/provider-alerts.ts:214-215` |
| S2 | P1 | `stale_snapshot` is intentionally never emitted.  A hung or skipped poller is silent unless `missing_snapshot` (no row at all). | `src/lib/provider-alerts.ts:243-247` |
| S3 | P1 | `request_limit` compares `latestSnapshot.totalRequests` to `monthlyRequestLimit` with no unit or window check. | `src/lib/provider-alerts.ts:275-301`; unit labels in `src/lib/provider-definitions.ts:15-18`, `:179-199` |
| S4 | P1 | `AdapterExternalBillingRecord.amountUsd` stores native-currency amounts for Stripe/Cloudflare non-USD while `totalCost` stays null.  Field name invites USD summing. | Stripe test pins `amountUsd: 1, currency: "EUR"` (`src/lib/adapters/__tests__/stripe.test.ts:48-53`, `:119-134`).  Cloudflare PayGo same (`cloudflare.test.ts:569-576`).  Mistral correctly uses `amountUsd: null` for EUR (`mistral.test.ts:354`). |
| S5 | P1 | Hetzner writes FX-converted catalog estimates into `totalCost` with `costScope: "calendar_month_to_date"`.  Catalog text contradicts the code. | Code: `src/lib/adapters/hetzner.ts:321-350`, `:628-638`.  Catalog: `src/lib/provider-integration-catalog.ts:427` (“only explicit USD values can enter normalized spend”). |
| S6 | P2 | `costCoverageCaveat` is documented as an under-count flag (`helpers.ts:6-21`) but is also used for “this is an estimate, not an invoice” (Hetzner/Backblaze/OpenRouter).  Downstream treats any caveat as incomplete coverage, which is right for trust, wrong if someone later assumes “under-count only.” | `helpers.ts:23-28`; Hetzner `:639-646`; Backblaze `:438-443`; OpenRouter `:270-277` |
| S7 | P2 | Integration catalog `reviewedOn` is still `2026-07-13` (`provider-integration-catalog.ts:53`, `:86`). | Drift vs Hetzner FX, OpenRouter activity MTD, Backblaze estimates, Cloudflare PayGo caveat. |
| S8 | P2 | Custom adapter has no dedicated fixture file.  It maps untyped JSON numbers into cash with no `costScope` / currency / window. | `src/lib/adapters/custom.ts:66-77`.  Persistence strips raw body (`src/lib/data-privacy.ts:160-171`) — privacy is handled; money semantics are not. |
| S9 | P3 | Shared `fetchJson` has no pagination helper.  Each adapter reimplements cursor loops with different fail-closed rules.  That is fine today; a shared helper would prevent the next incomplete-page bug. | Contrast OpenAI `parseCostsPagination` (`openai.ts:37-51`) vs OpenRouter assumed page size 100 (`openrouter.ts:75-79`). |

---

## Provider matrix

Legend for **Cash**: what lands in `UsageSnapshot.totalCost`.
**Bal / Cred / Req**: snapshot scalars.
**Inv**: invoices or receipt-grade history from the poll.
**Page**: pagination completeness.
**Life**: `active` / `dormant` / `retired` from `provider-definitions.ts`.
**Tests**: dedicated adapter test file unless noted.

| Provider | Life | Mode | Identity | Cash | Bal | Cred | Req | Inv | Page | Currency / units | Caveat / fallback | Tests | Top sev |
|----------|------|------|----------|------|-----|------|-----|-----|------|------------------|-------------------|-------|---------|
| openai | active | direct | project key + optional Admin | Org Costs MTD USD; legacy cents fallback | grants or limit−cost | — | **today only** | no | fail-closed, 100/20 pages | USD only; non-USD page rejected | skip legacy if Costs ok | `openai.test.ts` | P2 |
| anthropic | active | partial | Admin key only; Messages key blind | cost_report cents/100 USD | — | — | — | no | fail-closed, 10k pages | non-USD rows skipped | individual = UNSUPPORTED | `anthropic.test.ts` | P1 |
| google-ai | active | partial | Gemini key + optional SA + billing dataset | BigQuery export net USD or null | — | — | Monitoring / model count | no | BQ 10/20 pages fail-closed | USD export | empty export = pending, not $0 | `google-ai.test.ts`, `google-cloud-monitoring.test.ts` | P2 |
| deepseek | active | partial | API key | **null** (balance ≠ spend) | USD total | granted | — | no | n/a | USD preferred; others metadata | — | `deepseek.test.ts` | P2 |
| xai | active | direct | Management key + `teamId` | postpaid **invoice preview** | prepaid abs(cents)/100 | = balance | — | preview only; list API unwired | n/a | cents → USD | 0/3 endpoints fail; 1/3 ok | `xai.test.ts` | P1 |
| mistral | active | partial | Backoffice Admin | **null** (schema has no cash total) | — | — | — | no | workspace concurrency | currency tagged; USD cap only | caveat `mistral_usage_cash_total_schema_unavailable` | `mistral.test.ts` | P2 |
| openrouter | active | partial | any key; Management for account | activity MTD **estimate**; withheld day 31 | credits−usage | total credits | 30-day activity | no | keys: assume 100/page, fail if cap | USD | caveat; default workspace only | `openrouter.test.ts` | P1 |
| github | active | direct | org/user/enterprise + token | enhanced-billing `netAmount` as USD | — | — | — | no | budgets `total_count` exact | **currency assumed USD** | enterprise: no detailed fallback | `github.test.ts` | P1 |
| render | active | partial | API key | **null** | — | — | **bandwidth MB** if complete | no | inventory fail-closed; BW cap 200 | MB ≠ requests | partial/error withhold MB | `render.test.ts` | P1 |
| pinecone | active | partial | API key | **null** | — | — | — | no | 1000 pages | vectors / backups | optional APIs fail-open | security tests only | P2 |
| voyage | active | push-only | none | — | — | — | — | — | n/a | — | blind in `index.ts` | routing / catalog | — |
| roic | active | push-only | none | — | — | — | — | — | n/a | — | blind in `index.ts` | routing / catalog | — |
| fmp | active | push-only | unused key | — | — | — | — | — | n/a | — | no quote probe | `non-billable-blind-adapters.test.ts` | — |
| finnhub | active | push-only | unused key | — | — | — | — | — | n/a | — | blind | same | — |
| alphavantage | active | push-only | unused key | — | — | — | — | — | n/a | — | blind | same | — |
| marketstack | active | push-only | unused key | — | — | — | — | — | n/a | — | blind | same | — |
| tiingo | active | push-only | unused key | — | — | — | — | — | n/a | — | blind | same | — |
| twelvedata | active | partial | API key | **null** | — | remaining | **daily or minute used** | no | n/a | credits/requests | **poll costs 1 credit** | `twelvedata.test.ts` | P1 |
| fintech-studios | active | partial | API key | **null** | — | remaining | — | no | n/a | credits | `/me` only; no `/usage` | `fintech-studios.test.ts` | P2 |
| massive | active | push-only | unused key | — | — | — | — | — | n/a | — | blind | blind suite | — |
| fred | active | push-only | unused key | — | — | — | — | — | n/a | free | blind | blind suite | — |
| quiver-quant | active | push-only | none | — | — | — | — | — | n/a | — | blind in `index.ts` | catalog | — |
| unusual-whales | active | partial | API key | **null** | — | — | **daily header** | no | n/a | requests / day (8pm ET) | **poll costs 1 request** | `unusualwhales.test.ts` | P1 |
| sentry | active | partial | token + org slug | **null** | — | — | events only | no | stats groups | events ≠ bytes ≠ ms | bytes/duration excluded from total | `sentry.test.ts` | P2 |
| langfuse | active | partial | pk+sk + host | **null** (observed LLM $ is diagnostic) | — | — | 4-view unit sum | no | n/a | traces/obs/scores | 4 reads / poll; 6h default | `langfuse.test.ts` | P2 |
| twilio | active | direct | Account SID + token or SK | ThisMonth `totalprice` USD | account balance | — | — | no | 100 pages; URL origin pin | USD only for `totalCost` | `costIncludesUnknownFixed: true` | `twilio.test.ts` | P1 |
| resend | active | partial | API key | **null** | — | — | — | no | n/a | emails **used**, not limits | headers misnamed quota | `resend.test.ts` | P2 |
| pushover | active | partial | app token (query) | **null** | — | remaining msgs | used = limit−remain | no | n/a | messages / month pool | token redacted in errors | `pushover.test.ts` | P2 |
| cloudflare | active | direct | account + token (or global+email) | USD subs this month + eligible PayGo | — | — | analytics (not cash) | no | subs `total_count` exact | USD cash; EUR stored tagged | PayGo 403/404 → caveat | `cloudflare.test.ts` | P1 |
| hetzner | active | partial | project token | **catalog × inventory × month fraction** | — | — | — | no | resource pages | EUR→USD FX | caveat; default rate 1.09 | `hetzner.test.ts` | P1 |
| backblaze | active | partial | keyId + applicationKey | **storage $ × month fraction** | — | free GB remain | **storage MB** | no | 100 pages / 50k files | USD catalog; no egress | truncate → partial caveat | `backblaze.test.ts` | P1 |
| coolify | active | health-only | token + host | **null** (never $0) | — | — | — | no | server cap best-effort | health strings | untrusted host SSRF | `coolify.test.ts` | — |
| deno | retired | partial | PAT + org | not polled | — | — | — | — | — | — | decommissioned router | `deno.test.ts` | P3 |
| apify | active | direct | token | base + overage if cycle in UTC month | included−used | = balance | — | no | n/a | USD | out-of-month cycle withheld | `apify.test.ts` | P2 |
| firecrawl | dormant | partial | API key | not polled | remaining credits | remaining | — | no | historical fail-open | credits ≠ USD | never subtract remain from plan | `firecrawl.test.ts` | P3 |
| llamaindex | active | partial | key + optional project/host | **null** | — | **null** (consumed ≠ remain) | credits consumed | no | fail-closed | product credits | custom host SSRF | `llamaindex.test.ts` | P2 |
| stripe | active | direct | secret/restricted key | USD fees only | available USD | — | — | no | 10k pages fail-closed | fees ≠ revenue; EUR tagged | non-USD-only → `totalCost` null | `stripe.test.ts` | P1 |
| robinhood | retired | push-only | none | — | — | — | — | — | n/a | — | no adapter file | catalog | P3 |
| alpaca | retired | partial | key+secret; paper/live | not polled | **equity as balance** | — | — | no | n/a | brokerage ≠ vendor $ | retired gate | no adapter test | P3 |
| ag***-s**c-relay | active | health-only | optional custom URL | **null** | — | — | — | no | n/a | UP/error | untrusted custom URL | `src/lib/__tests__/ag***-s**c-relay.test.ts` | — |
| custom | active | configurable | key + HTTPS endpoint | mapped number or null | mapped | mapped | mapped | no | n/a | **unproven** | untrusted fetch; raw stripped | **none** | P1 |
| generic / push | active | manual | none | — | — | — | — | — | n/a | manual / ingest | router `UNSUPPORTED` | `provider-routing.test.ts` | — |
| vercel | retired | direct | token + team | not polled | — | — | — | FOCUS | fail-closed | USD / tagged FX | retired | `vercel.test.ts` | P3 |
| oracle | retired | direct | RSA tenancy | not polled | — | — | — | no | fail-closed | USD; 48h delay caveat | retired | `oracle.test.ts` | P3 |
| tradier | retired | partial | bearer + account | not polled | portfolio | — | rate headers | no | n/a | not spend | retired | `tradier.test.ts` | P3 |
| intrinio | retired | partial | API key | not polled | — | remaining | feed usage | no | n/a | calls | retired | `intrinio.test.ts` | P3 |
| kimi / moonshot | retired | push-only | none | — | — | — | — | — | n/a | via OpenRouter | boot retirement | catalog | — |

Decommissioned names never reach their adapter: `fetchProviderUsage` throws `UNSUPPORTED` first (`src/lib/adapters/index.ts:157-160`, `isDecommissionedProviderName`).

---

## Per-provider evidence

### LLM / AI

#### OpenAI — actual MTD with Admin key

- Identity: primary key for usage/grants; `config.adminApiKey` preferred for Costs (`openai.ts:345-347`, `:455-457`).
- Cash: `GET /v1/organization/costs` daily buckets, USD-only, `has_more`/`next_page` must be consistent or the page is rejected (`:37-51`, `:69-77`).  Cap 100 pages (`:14`).  Components (project / line_item / api_key_id) are non-additive (`:545-567`).
- Fallback: legacy `dashboard/billing/usage` `total_usage / 100` only if Costs failed (`:477-492`).  Today’s `/v1/usage` is diagnostic and **must not** become MTD (`:536-542`).
- Balance: credit grants, else `hard_limit − totalCost` (`:495-516`) — that is remaining limit, not prepaid cash.
- Missing: ChatGPT Plus/Pro invoices (separate product; `docs/research/2026-08-05-billing-api-coverage.md`).  No invoice PDF list.
- Fixtures: pagination, non-USD reject, Admin vs project key — `openai.test.ts` (strong).
- **Upgrade:** treat `balanceIsLimit` as metadata, not `UsageResult.balance`, so `balance_low` cannot fire on a spend cap.  **P2.**

#### Anthropic — Admin only; individual is blind

- Messages keys never hit cost_report (`anthropic.ts:50-68` → `blindProviderResult`).
- Amounts summed as **cents**, USD only; other currencies skipped (`:154-169`).  Mixed-currency months understate without a caveat.  **P1.**
- Window: UTC month start → now; `costScope: calendar_month_to_date`.
- No subscription / Claude Max / App Store path (catalog + research doc).
- Fixtures: `anthropic.test.ts` exists; confirm it pins the cents conversion and non-USD skip.

#### Google AI — two independent channels

- Gemini key: validate without inference (`google-ai.ts` help in definitions `:54-59`).
- Usage/quota: Cloud Monitoring; empty gauges stay unknown, not zero (catalog `:161`).
- Cash: standard Billing export via BigQuery.  Empty table → `status: "pending"`, `totalCostUsd: null` (`google-cloud-billing.ts:426-438`, `:468-484`).  Multi-project without `googleProjectId` fails closed (`:420-424`).
- Unreadable Gemini secrets are the only router special case (`index.ts:207-232`).
- Missing dedicated `google-cloud-billing.test.ts` (coverage via `google-ai` + `gemini-external-billing`).  **P2.**
- AI Studio prepaid / tier / renewal: not exposed.

#### DeepSeek — prepaid balance only

- `GET /user/balance`; first USD row → `balance` + granted `credits` (`deepseek.ts:43-48`).
- `totalCost` always null.  Correct: a balance is not MTD spend.
- No invoice API in the 2026-08-05 research sweep.

#### xAI — preview billed as actual

- Requires `teamId`; Management key from config or primary (`xai.ts:45-50`).
- Parallel: prepaid balance, **postpaid invoice preview**, spending limits (`:54-58`).
- `totalCost = max(0, preview)` when window parses (`:93-100`).  Catalog billing visibility is `"actual"` (`provider-integration-catalog.ts:184`).
- Documented `GET /v1/billing/teams/{team_id}/invoices` (research 2026-08-05) is **not called**.  Preview can drift from finalized invoices.  **P1.**
- `costScope` labeled `calendar_month_to_date` from provider `billingCycle.year/month` (`:19-38`, `:186`).  Safe only if xAI cycles are calendar months.
- Partial success: any one of three endpoints is enough to return (`:60-68`).
- SuperGrok / X Premium: separate product; not this adapter.

#### Mistral — refuse to invent cash

- Admin usage + workspaces + spend-limit.  `totalCost: null` with an explicit caveat (`mistral.ts:483-489`).
- Spend-limit counters are caps, not USD (`:123-124`).
- EUR spend limit → `amountUsd: null` (test-pinned).  Best-in-class currency hygiene.
- Catalog visibility `metadata` → reconciliation `unverifiable`.  Correct.

#### OpenRouter — estimate with a honest hole on day 31

- Inference key: key-only usage/limit; `totalCost` null (`openrouter.ts:163-184`).
- Management: `/credits` lifetime prepaid (`:17-19`, `:202-211`); `/activity` summed since UTC 1st if `UTC date ≤ 30` (`:237-242`).
- Caveat `openrouter_activity_mtd_estimate`; multi-workspace note (`:270-277`).
- `/keys` assumes 100-row pages and fails the whole list if the cap is hit (`:75-125`).  Default workspace only.
- Visibility `partial` → reconcilable against pushed telemetry.  An activity estimate vs incomplete producer events will alert.  **P1** if CT/ST push is a subset of the account.
- Budget has an optional OpenRouter verified-cash override (default off) (`budget-status.ts:1364-1368`).

### Infrastructure / platforms

#### Cloudflare — fixed USD + optional PayGo

- Account ID required.  Analytics never become cash (catalog `:415`).
- Subscriptions: USD + paid + period-in-this-month only add to `totalCost` (`cloudflare.ts:439-460`).  Expired/Paid twin dedupe (`:447-460`).
- Pagination requires stable `total_count` (`:225-258`).
- PayGo alpha: 403/404/error 10000 → capability unavailable; if subscription cash exists, caveat `cloudflare_paygo_usage_unavailable` (`:885-890`).
- Non-USD PayGo: excluded from `totalCost`, stored as `amountUsd` + `currency` (S4).
- Optional D1/R2/KV/Queue probes do not affect billing (`index` help + catalog `:413`).

#### Hetzner — estimate in the cash column

- Inventories servers, volumes, IPs, LBs, snapshots.  Backup images not priced twice (`hetzner.ts:684`).
- EUR catalog × `open.er-api.com` USD rate, else `HETZNER_EUR_USD_RATE`, else **`1.09`** (`:322-341`).  Tests pin the live-rate and env paths (`hetzner.test.ts:417-459`).
- `totalCost = runRate × UTC month fraction` (`:628-635`) + caveat.
- No public invoice API (adapter comment `:619-621`; research 2026-08-05).
- Catalog drift (S5) is the accuracy bug: dashboards that trust `totalCost` + `calendar_month_to_date` will treat FX catalog math as a bill.  Coverage is marked partial via caveat, but `spentUsd` still includes the number.

#### Backblaze — storage estimate; egress invisible

- `listBuckets` + `list_file_versions` including hidden versions (`backblaze.ts` header `:21`).
- Truncation at 50k files / 100 pages per bucket (`:37-39`, `:388`, `:421-424`) → caveat `backblaze_storage_estimate_partial` but **still writes `totalCost`**.  **P1** under-count on large buckets.
- `totalRequests` = whole MB (`:394-396`, `:444`) — S3 unit reuse.
- Download and Class A/B transactions cannot be reconstructed.  Console Caps & Alerts are the hard limit.

#### GitHub — enhanced billing, currency assumed

- Scope org / user / enterprise; GHE.com origin allowlist (`github.ts:222`).
- `netAmount` summed as `netAmountUsd` with **no currency field check** (`:266-285`, `:655`).  GitHub documents USD for enhanced billing; a future non-USD item would be booked as USD.  **P1** (latent).
- Enterprise: no fallback to cost-center-specific `/usage` (would undercount) (`:619-625`).
- Copilot AI-credit / premium detail is component-only, not added again (`:591` comment).
- No plan price, renewal, receipts (catalog `:230`).

#### Render — inventory + bandwidth, no invoice

- Account-wide services / Postgres / KV.  Partial inventory is not reconciled (comment `:434`).
- Bandwidth MTD in **whole MB** into `totalRequests` only when `status === "ready"` (`render.ts:697-698`).  >200 services or 30-day floor missing the 1st → partial, scalar withheld (`:138-139`, `:628-631`).
- No invoice/overage USD.  `monthlyRequestLimit` in MB is the documented alert hook — operators must not enter a request count.

#### Coolify / Ag*** S**c — health, never $0 cash

- Coolify: servers + apps; `totalCost` null by design (`coolify.ts` + catalog `:474`).
- Ag*** S**c: health GET; comment forbids `$0` complete cash (`ag***-s**c-relay.ts:21-28`).

### Market data

Blind adapters (`fmp`, `finnhub`, `alphavantage`, `marketstack`, `tiingo`, `massive`, `fred`) take an `apiKey` argument, ignore it, and throw `UNSUPPORTED` without `fetch` (`fmp.ts:3-8`; suite `non-billable-blind-adapters.test.ts:13-36`).  Voyage / ROIC / Quiver are inline blinds in `index.ts:97-120`.

#### Twelve Data — poll spends a credit

- `/api_usage`; body minute/daily quotas; legacy header fallback, never mixed (`twelvedata.ts:42-70`).
- `totalRequests = dailyUsed ?? minuteUsed` (`:139`).  Daily default refresh 1440 min.
- **Each poll costs 1 credit** (`:157-158`).  **P1** if anyone shortens the interval.

#### Unusual Whales — poll spends a request

- `GET /api/congress/recent-trades?limit=1` solely for `x-uw-daily-req-count` (`unusualwhales.ts:31-48`).
- Implausible ≥ 1e6 discarded (`:23-28`).
- Reset is 8:00pm ET; no timestamp invented (`:9-14`).
- `totalRequests` is **daily**, not monthly — S3.  **P1.**

#### FinTech Studios — zero-credit `/me`

- Tier, credit balance, monthly allowance, daily burn (`fintech_studios.ts:56-59`).
- Email/name dropped (`:183`).  No USD.  `/usage` intentionally unused until schema exists.

### Observability / notifications / data / payments

#### Sentry

- `stats_v2` MTD by project/category/outcome.  `totalRequests` = event-like units only; attachments (bytes) and profile duration (ms) excluded (`sentry.ts:286-315`).
- Not invoice or quota.  Separate Sentry Health card uses env token, not this row.

#### Langfuse

- Four metrics views per poll (`langfuse.ts:167-177`).  Observed `totalCost` on observations is **underlying LLM $**, never Langfuse’s fee (`:210-212`).
- Custom host = untrusted fetch.

#### Twilio

- Balance + `Category=totalprice` + paginated ThisMonth breakdown (`twilio.ts:84-94`).
- `totalCost` only if `price_unit === "USD"` (`:113-117`).
- `costIncludesUnknownFixed: true` whenever cost exists (`:163`) — fixed vs usage split unknown.
- Pagination pins origin + path (`:52-57`).
- Historical PagerDuty false discrepancy (bill vs zero telemetry) fixed 2026-08-12 (`docs/EFFORT-LOG.md` PR #1131).  Tests pin `unverifiable` for zero events.

#### Resend

- Lists API keys (non-sending).  `x-resend-monthly-quota` / daily are **used counts**, never limits (`resend.ts:35-38`, `:97`).
- Email usage sync omitted when headers absent (preserve prior; `:132-143`).

#### Pushover

- `limits.json?token=` — query credential; `redactUrlForError` strips query (`helpers.ts:228-236`).
- Pooled account/team quota since 2026-05-01 (`pushover.ts:47`).

#### Apify

- `currentBill = base + max(0, used − included)` when all three exist; else `max(base, used)` (`apify.ts:60-65`).  Incomplete-field fallback can overstate.  **P2.**
- Canonical cash only if cycle start is in the current UTC month (`:72-76`).
- `paidRecurringAuthoritative` when paying + enabled + base > 0 (`:141-145`).
- Proxy password stripped from `/users/me` (`:94-95`).

#### LlamaIndex

- Org discovery + paginated usage metrics.  Any page failure aborts (`llamaindex.ts:186-191`, catalog `:525`).
- Consumed credits are **not** written to `UsageResult.credits` (that field means remaining) (`:317-325`).

#### Stripe

- Merchant `balance` (available USD) + MTD **processing fees** (`stripe.ts:48-90`).
- Customer subscriptions/revenue never requested (catalog `:534`).
- USD fees → `totalCost`; EUR-only → null cash, tagged records (S4).
- Fail-closed pagination (`:76-79`, `:96-114`).

#### Custom

- Untrusted HTTPS GET; simple `$.path` maps (`custom.ts:8-19`, `:58`).
- Only `typeof === "number"` (string `"1.25"` discarded).
- No `costScope`, currency, or window.  Catalog visibility `partial`.
- Raw body strip-all at persist (`data-privacy.ts:160-171`).
- **No `custom.test.ts`.**  Need: SSRF reject, string-vs-number, missing path → null not 0, no costScope.  **P1 fixtures.**

---

## Projections and discrepancy alerts (connector view)

What connectors owe the forecast / alert layer:

| Input | Who sets it | Accuracy note |
|-------|-------------|---------------|
| `totalCost` + `costScope` | adapter | Only `calendar_month_to_date` snapshots enter reconciliation (`provider-usage-reconciliation.ts:136-140`).  Hetzner/Backblaze/OpenRouter estimates **do** set that scope.  OpenRouter is reconcilable (`partial`); Hetzner/Backblaze are `metadata` → unverifiable. |
| `fixedCostIncludedUsd` | Apify (base price) | Subtracted before compare (`snapshotVariableCostUsd`, `:95-106`). |
| `costIncludesUnknownFixed` | Twilio always | Budget treats composition as unknown (`budget-status.ts` snapshot flags). |
| `costCoverageCaveat` | CF PayGo miss, Hetzner/B2/OR estimates, Mistral, Oracle (retired) | Forces spendCoverage off `complete`.  Does **not** remove the dollars from `spentUsd`. |
| `balance` / `credits` | DeepSeek, xAI, OpenRouter, Twilio, FTS, Pushover, OpenAI | `balance_low` / `credits_low` if plan floors set.  OpenAI limit-as-balance and Alpaca equity-as-balance are the foot-guns. |
| `totalRequests` | many | `request_limit` assumes monthly requests (S3). |
| Pushed telemetry | ingest / OTLP | `max(snapshot, push)` under-counts complementary slices (prior GROK3 audit).  Connectors that only see org-wide cash vs app-subset push will look “high” on the snapshot side — that is a discrepancy, not a poll bug. |
| Receipts | HMAC importer | Funding, not spend (`budget-status.ts:1356-1359`). |

`stale_snapshot` remains in `PROVIDER_ALERT_CODES` for historical routing only (`provider-alerts.ts:22`, `:243-247`).  Operators will not be paged when a live adapter last succeeded 36 hours ago.

---

## Missing coverage

### APIs documented but not wired

| Provider | Gap | Source | Suggested upgrade |
|----------|-----|--------|-------------------|
| xAI | Invoice **list** (`GET .../invoices`) | `docs/research/2026-08-05-billing-api-coverage.md` § xAI | Persist finalized invoices; keep preview as `open` only.  Do not sum preview + list. |
| OpenRouter | Per-workspace `/keys`; per-key activity | adapter limitations `:305-308` | Enumerate workspaces or fail closed on `multiWorkspace`. |
| Mistral | Numeric org cash total | schema still unpublished (`mistral.ts:488-489`) | Stay null until a documented field exists. |
| DeepSeek / Voyage / market blinds | Invoice or quota APIs | research 2026-08-05 | Keep blind; Subscription + push. |
| Render | Invoice / included bandwidth | catalog `:266` | Do not invent overage $. |
| Hetzner / Backblaze | Invoice / egress | adapter comments | Keep estimate + caveat; do not drop caveat. |
| GitHub | Plan price, renewal, receipts | catalog `:230` | Manual Subscription. |
| Anthropic / OpenAI consumer | Claude Max / ChatGPT Plus | research doc | Receipt / Subscription only. |
| Resend | Plan quota remaining | headers are used-counts | Do not derive remaining. |
| FinTech Studios | `/usage` | OpenAPI incomplete | Wait for schema. |
| LlamaIndex | Remaining balance / USD | catalog `:522` | Do not convert credits. |

### Adapter files present but not in the poll registry

`vercel.ts`, `oracle.ts`, `tradier.ts`, `alpaca.ts`, `firecrawl.ts`, `intrinio.ts`, `google-cloud-billing.ts`, `google-cloud-monitoring.ts`, `google-service-account.ts`.  Billing/monitoring are libraries for `google-ai`.  The rest are retired/dormant leftovers.  Router will not call them for decommissioned names.

Catalog references `src/lib/adapters/voyage.ts`, `quiver.ts`, `robinhood.ts` — **those files do not exist**.  Blinds live in `index.ts`.  **P3** catalog path drift.

### Test fixtures — present vs missing

| Area | Present | Missing / weak |
|------|---------|----------------|
| OpenAI Costs pagination, non-USD reject, Admin key | `openai.test.ts` | Invoice-less ChatGPT (N/A) |
| Anthropic Admin / blind | `anthropic.test.ts` | Mixed-currency undercount caveat |
| Google AI + Monitoring | two test files | Dedicated Billing export page/empty/multi-project file |
| xAI preview | `xai.test.ts` | Invoice-list vs preview; cycle ≠ calendar month |
| OpenRouter inference vs Management, day-31 withhold | `openrouter.test.ts` | Multi-workspace fail-closed |
| Stripe USD vs EUR, pagination | `stripe.test.ts` **pins amountUsd+EUR** | Downstream “do not sum amountUsd” consumer test |
| Cloudflare subs + PayGo caveat | `cloudflare.test.ts` | — |
| Hetzner FX | `hetzner.test.ts` pins 1.09 / env / live | Catalog-vs-code contract test |
| Backblaze truncate | `backblaze.test.ts` | “truncated still writes totalCost” called out as under-count |
| GitHub enterprise no-fallback | `github.test.ts` | Currency-absent `netAmount` |
| Twilio pages + USD | `twilio.test.ts` | — |
| Twelve Data / UW poll cost | both have tests | Alert unit: daily vs `monthlyRequestLimit` |
| Blinds do not fetch | `non-billable-blind-adapters.test.ts` | voyage/roic/quiver inline blinds |
| Router types | `provider-routing.test.ts` | — |
| `fetchJson` timeout/429 | `fetch-json-resilience.test.ts` | — |
| Custom mapping | **none** | SSRF, string numbers, null vs 0, no costScope |
| Pinecone | `pinecone-security.test.ts` only | Inventory pagination / optional API fail-open |
| Alpaca | none | Retired; equity-as-balance if ever re-enabled |
| Reconciliation / alerts | `provider-reconciliation-maintenance.test.ts`, `provider-alerts.test.ts` | Alert `?? 0` when `trackedSpendUsd` omitted |

---

## Fixes and upgrades (not implemented — report only)

Ordered for a later implementation lane.  Do not steal this into a mixed PR.

### P1

1.  **Hetzner cash contract.**  Either stop writing FX estimates into `totalCost` (keep run-rate in `rawData` / metadata records) **or** update the catalog to say USD-normalized catalog estimates are intentional, require `billingMode: "estimated"`, and keep the caveat.  Kill the silent `1.09` default or make it a hard configuration error when the live rate fails.
2.  **Rename or guard `amountUsd`.**  Persist `amount` + `currency`; only populate `amountUsd` when `currency === "USD"`.  Add a consumer test that summing records without a currency filter is forbidden.  Stripe/Cloudflare tests today **encode the foot-gun**.
3.  **Alert `?? 0`.**  `buildProviderAlertState` should treat null `totalCost` as unknown, not $0, unless `trackedSpendUsd` is passed (budget-status already has coverage flags).
4.  **Request-limit units.**  Do not compare Unusual Whales daily counts or Twelve Data minute usage to `monthlyRequestLimit`.  Either refuse those plans, convert windows, or use `usageUnitLabel` in the alert path.
5.  **xAI invoice list.**  Wire finalized invoices; label preview `open` / non-canonical.  Do not change `totalCost` to a stale closed invoice plus a live preview.
6.  **Anthropic non-USD.**  If any non-USD bucket is skipped, set `costCoverageCaveat` (or fail the total) instead of a quiet partial USD sum.
7.  **Custom adapter fixtures + `costScope`.**  Refuse to set `totalCost` without an explicit scope/currency config.  Add `custom.test.ts`.
8.  **Backblaze truncation.**  When `truncated`, set `totalCost` null (keep lower-bound in rawData) or keep the number only with a stronger incomplete flag that budget-status already maps to partial — today dollars still enter `spentUsd`.

### P2

9.  Refresh catalog `reviewedOn` and Hetzner/OpenRouter/Backblaze/custom text to match code.
10.  OpenAI: do not put limit-derived remainder in `balance`.
11.  OpenRouter: fail the keys sync (or caveat harder) when `workspaceIds.size > 1`.
12.  Apify: do not use `max(base, used)` when one side is missing; return null cash.
13.  GitHub: require a currency field or document USD-only and reject unknown units.
14.  Dedicated `google-cloud-billing` adapter tests (empty, pending, multi-project, page cap).
15.  Pinecone inventory pagination / fail-open fixtures.
16.  Shared pagination helper (cursor, `has_more` consistency, seen-set, cap) adopted by the next new cash adapter.

### P3

17.  Fix catalog `source` paths for voyage / quiver / robinhood.
18.  Alpaca: if ever reactivated, never map equity to `balance`.
19.  Retired adapters can stay for history; do not re-register them.

---

## What this audit did *not* do

- Live calls to production provider APIs or Infisical.
- Re-derivation of LiteLLM / OTLP / ingest cost (separate from poll adapters).
- iOS Local adapters (different binary; some catalog overlap).
- Product copy / chart projection UX (other 2026-08-17 audit).
- Fresh public-docs crawl (Exa MCP rate-limited this run).  API-exists-not-wired items reuse `docs/research/2026-08-05-billing-api-coverage.md` plus in-repo comments.

---

## Apple Notes handoff (local publication)

**Title:** `[UM, Grok] Provider connectors accuracy audit`

**Body:**

Read-only audit of every Usage-Monitor poll adapter (identity, balances, credits, usage, costs, invoices, pagination, currencies, units, rate limits, stale/fallback, discrepancy alerts).  Report: `docs/audits/2026-08-17-providers-accuracy.md` on `cursor/providers-accuracy-audit-9579`.

No P0 silent wrong-invoice on the live USD `totalCost` path for Admin OpenAI, Admin Anthropic, Stripe USD fees, Twilio ThisMonth USD, GitHub enhanced billing, Apify current cycle, Cloudflare USD+PayGo, or Google Billing export.

P1 follow-ups (not implemented): Hetzner EUR→USD catalog estimate in `totalCost` vs catalog text; `amountUsd` holding euros; alert `totalCost ?? 0`; request-limit unit mismatch (Render/B2 MB, UW daily, Twelve Data credits); xAI preview vs invoice list; Anthropic skipped non-USD; custom adapter unscoped cash + no tests; Backblaze truncated inventory still priced.

Keepout: outcomes/projections product audit on `cursor/outcomes-projections-audit-4269`.
