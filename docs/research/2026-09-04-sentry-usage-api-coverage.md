# Sentry Usage API coverage (2026-09-04)

**Question:** What official Sentry APIs can Usage Monitor poll for **Usage**, and is there any public API for prepaid credit / remaining sponsored balance / reserved quota / PAYG / invoice?

**Short answer:** Measurable usage is org `stats_v2` (and the compact `stats-summary` companion).  There is **no** public Sentry API for prepaid credit remaining, the $5k sponsored balance, reserved quota remaining, PAYG, or invoices.  Do not invent Balance or Credits fields.  Spans and logs are not on the public `stats_v2` category whitelist — label **Transactions**, not Spans.

Two spaces between sentences in this file.

## Binding split

| Surface | In this app? | Why |
|---|---|---|
| **Sentry Usage** (this work) | Providers → Sentry / Provider-Reported Billing, optional dashboard **Sentry Usage** card | Official stats quantities |
| **Sentry Health** | `SentryHealthCard` / `GET /api/sentry-health` | Unresolved issue counts only.  Never money or usage |
| **Budget hero / LLM Quotas** | No | Sentry is not cash and not an LLM seat |

Secrets: reuse the existing provider poll token (`SENTRY_AUTH_TOKEN`) plus `orgSlug` / `SENTRY_ORG`.  Scope `org:read`.  No new `SENTRY_BILLING_TOKEN`.  No Infisical keys added.

## Measurable (official)

Sources:

- [Retrieve Event Counts for an Organization (v2)](https://docs.sentry.io/api/organizations/retrieve-event-counts-for-an-organization-v2/) — `GET /api/0/organizations/{org}/stats_v2/`
- [Retrieve an Organization's Events Count by Project](https://docs.sentry.io/api/organizations/retrieve-an-organizations-events-count-by-project/) — `GET /api/0/organizations/{org}/stats-summary/`
- [Product stats outcomes](https://docs.sentry.io/product/stats/)

`stats_v2` field `sum(quantity)` is **bytes** for attachments, **milliseconds** for profile duration, and **events** for everything else.  Do not mix those units.

### Categories (stats_v2 whitelist)

| API category | Display label | Unit |
|---|---|---|
| `error` | Errors | events |
| `transaction` | Transactions | events |
| `replay` | Replays | events |
| `attachment` | Attachments | bytes |
| `profile`, `profile_chunk`, `profile_chunk_ui` | Profiles | events |
| `profile_duration`, `profile_duration_ui` | Profiles | milliseconds |
| `monitor` | Monitors | events |

`stats-summary` filter names include `replays` / `profiles` (plural) and a shorter list.  Adapter totals always come from per-project `stats_v2`.  `stats-summary` is an optional companion only; a 403/404 does not fail the poll.

### Outcomes

`accepted`, `filtered`, `rate_limited`, `invalid`, `abuse`, `client_discard`, `cardinality_limited`.  The dashboard headline is **Accepted** and **Rate Limited**.

## Blocked (no public API)

Do **not** add these fields, even as `--` that looks like a live probe:

- Prepaid credit remaining
- Sponsored / $5k balance remaining
- Reserved quota remaining
- PAYG on/off
- Invoice list or invoice spend
- Plan quota remaining as a request limit

The poll therefore keeps `balance = null`, `totalCost = null`, `credits = null`, and `capabilities.billingCost = false`.  Unknown vendor cost must not appear as $0.

## Not on the public stats_v2 whitelist

- **Spans** — not a `stats_v2` category.  Transaction events stay **Transactions**.
- **Logs** — not a `stats_v2` category.  Do not invent a Logs row.

If an unexpected category string appears, it is stored as family `Other` rather than promoted to a first-class Usage row.

## Adapter contract (this PR)

- Discover accessible projects, then query `stats_v2` per project grouped by `category` + `outcome` for UTC calendar month-to-date.
- Aggregate `rawData.categories.byCategory` (survives the Sentry rawData allowlist: `stats`, `categories`).
- External billing `serviceName` uses Title Case labels (`Project 101: Errors (Accepted)`).
- Optional `stats-summary` is nested under `rawData.stats.statsSummary` and never feeds cash math.
- Sentry Health card is unchanged.
