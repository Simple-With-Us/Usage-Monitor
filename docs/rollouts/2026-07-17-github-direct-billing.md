# GitHub direct billing, budget, and Copilot usage

## Scope

The GitHub adapter now uses documented REST billing endpoints only. It does not
read browser state, repository content, issue data, budget alert recipients, or
payment pages.

For one configured billing boundary it reads:

- Enhanced-billing current-month usage summary (`netAmount`, product/SKU,
  quantity, and unit) as the canonical cash-spend total.
- The detailed usage report only for organization/personal boundaries when the
  summary preview endpoint is unavailable; repository names in that fallback
  are never stored. Enterprise usage never falls back because its summary is
  the all-cost-center view while the detailed endpoint requires a cost center.
- Read-only organization/enterprise spending budgets, including amount and
  `prevent_further_usage` setting. Exact documented metered product/SKU IDs
  are represented in USD. Known license counts and unknown-unit amounts stay
  labeled in metadata; neither is stored as a request limit. Most license
  budgets cannot stop further usage, so only metered budgets and the three
  exact documented GitHub Advanced Security SkuPricing license IDs may be
  labeled enforced; ProductPricing `ghas` remains active.
  Enterprise `multi_user_cost_center` is accepted. GitHub does not document a
  personal-user budget-list endpoint, so that state is explicitly
  `not_exposed` for user accounts.
- Copilot AI-credit and premium-request usage as separate product/model
  breakdowns. These are never added to the canonical summary a second time.

The configured account type is `organization` (the backwards-compatible
default), `user`, or `enterprise`. Existing `org`/`orgSlug` configuration
continues to select the account login; new rows may use `account`. GitHub.com
is the default API origin; a GHE.com enterprise can provide an exact,
allowlisted `https://api.<enterprise>.ghe.com` origin.

## Credential boundaries

- Organization: a fine-grained PAT, GitHub App user token, or installation
  token with **Organization Administration: read**, used by an organization
  admin or billing manager.
- Personal user: a token with **Plan: read**.
- Enterprise: a classic PAT. GitHub explicitly says enterprise billing
  endpoints do not work with fine-grained PATs or GitHub App user or
  installation tokens.

An unavailable optional surface is persisted as a bounded capability state:
`permission_unavailable` (403), `not_available` (404),
`upstream_unavailable` (5xx), or `error`. It is never interpreted as `$0` and
does not prune the last successfully synced records from that independent
source.

Budget pruning requires collection proof: every page must contain a
nonnegative safe-integer `total_count`, that count must remain stable across
pages, and the final accumulated record count must match it exactly. A mixed
summary/fallback failure also retains a retryable summary transport/5xx error
instead of replacing it with a later 403/404.

## Explicitly unavailable from GitHub billing REST

GitHub does not document a general REST feed for base-plan price, renewal date,
receipt history, payment method, or broad subscription status. The adapter
marks those facts as `not_exposed`; it does not infer them from legacy user
plan metadata or Marketplace publisher endpoints.

## References

- https://docs.github.com/en/rest/billing/usage
- https://docs.github.com/en/rest/billing/budgets
- https://docs.github.com/en/enterprise-cloud@latest/rest/billing/budgets
- https://docs.github.com/en/billing/reference/product-and-sku-names
- https://docs.github.com/en/billing/concepts/budgets-and-alerts
- https://docs.github.com/en/billing/tutorials/automate-usage-reporting
