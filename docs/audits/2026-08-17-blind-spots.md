# Usage Monitor — blind-spots audit (2026-08-17)

**Date:** 2026-08-17
**Panel:** product strategy, test architecture / code quality, billing-finance nuance, receipt / email workflows, privacy (data lifecycle), accessibility, i18n / currencies, vendor lock-in, monitor cost efficiency, documentation, observability, plus leftover domains not owned by sibling reviews.
**Method:** Read-only static review at `8db78b58`.  Findings cite paths and line numbers from this checkout.  No production mutations.  No secret values.

> **[ARCHAEOLOGY / pre-2026-09-22]**  Bundle IDs `services.jays.usage.*` referenced below are the pre-2026-09-22 fleet-wide bundle-ID state and have not been retconned.  Canonical IDs after the fleet-wide rename: `com.simplewithus.usagemonitor.ios` (Client), `com.simplewithus.usagemonitor.local.ios` (Local), App Group `group.com.simplewithus.usagemonitor`.  See `docs/rollouts/2026-09-22-bundle-id-migration.md`.
**Keepout:** Provider-adapter accuracy, backend / SQLite / Litestream durability, auth / token / crypto security, web / iOS UX polish, and burn-rate / EOM / anomaly projection math are owned by concurrent 2026-08-17 audits.  Those topics appear here only when a second-order assumption in *this* panel's domains would otherwise be missed.

**Sibling cloud agents (same day, same repo):** providers accuracy, outcomes / projections, security / privacy (exploit/auth), backend durability, web / iOS parity.

---

## Verdict

The money path is carefully fenced where the code authors already knew the trap (USD rejection, receipt cash excluded from `spentUsd`, plan-fixed vs Subscription exclusivity in budget math, inbox never auto-cashes).  Residual risk is concentrated in **operator workflow gaps**, **test/CI fidelity**, **document/canon drift**, and **accounting assumptions that look like cash**.

The product can still go green while the owner makes a wrong spend decision.  The highest-leverage failures are not missing adapters.  They are: complementary-channel `max()` undercount, receipt inbox that never becomes cash, UTC-month vs card-statement month, Privacy Nutrition labels that deny collection the privacy policy admits, and a verify suite that can stay green while iOS money tests and two local-only scripts never run in CI.

---

## Severity

| Sev | Meaning |
|-----|---------|
| **P0** | Silent money or evidence loss, or a green gate that cannot see the failure |
| **P1** | High-impact trust, legal/review, operator workflow, or second-order under/over-count |
| **P2** | Solidify: polish, documentation, long-horizon lock-in, or incomplete modeling |

---

## Current issues and PRs (2026-08-17)

**Open PRs**

| PR | Title | Relevance |
|----|-------|-----------|
| [#1233](https://github.com/jaywedgeworth22/Usage-Monitor/pull/1233) | `docs(effort): board hygiene — close stale In Progress [GROK]` | Directly addresses DOC-02.  This audit does not steal that closeout. |

No other product PRs were open at inventory.

**Open issues**

Almost every open issue is an `effort-board` mirror.  Many titles still say COMPLETED/MERGED while labeled `state:in-progress` (#1227, #1222, #1213, #1212, #1208, #1201, …).  That is the same hygiene debt #1233 is closing.

Notable stale signal: **#953** still titles as `[OWNER ACTION REQUIRED] P0 deleted-live-SQLite recovery — ACTIVE INCIDENT`.  The body now says the Oracle inode recovery finished 2026-08-01 and is historical.  A new agent reading the title would freeze deploys on the wrong host.

**Recent merges that touch this panel**

- #1232 `postal-mime` 2.7.6 → 3.0.0 (receipt MIME parser major bump; worker tests exist).
- #1231 grouped npm patch bumps.
- #1230 custom EULA + beta review for Client and Local.

---

## Findings

### 1. Product strategy

#### PS-01 — Three products, one mental model
**Severity:** P1
**Evidence:** `ios/README.md` (Client `services.jays.usage.client.monitor` vs Local `services.jays.usage.local.monitor`); `docs/designs/2026-08-04-mobile-parity-and-phone-self-host.md:132` (multi-tenant SaaS out of scope); `docs/EFFORT-LOG.md` parallel catalog lanes for both iOS apps.
**Second-order risk:** Web + Client + Local must stay honest independently.  A feature that lands on the dashboard (OTLP, receipt inbox, family aggregation, cash-vs-estimate badges) can look “done” while Local still prefills catalog fees and Client still mixes coverage vocabularies.  App Store review, TestFlight ship, and Invalid Binary incidents already hit both binaries (#1149, #1219).
**Improvement:** Publish a one-page parity matrix (web / Client / Local) with a “source of truth” column.  Freeze Local catalog breadth until App Store v1 scope is closed.  Keep ASC copy explicit: Client is a companion to *your* server; Local is a personal device ledger.

#### PS-02 — The product cannot answer “what will my card be charged?”
**Severity:** P1
**Evidence:** Budget math is UTC-calendar MTD accrual (`budget-status.ts:1356-1363`, `subscription-materializer.ts:18-21,143`).  LLM burn is analytics-only (`llm-burn.ts:15-21`).  `ProviderCard.tsx:157-158` falls back `spentUsd ?? latestSnapshot?.totalCost ?? estimatedMonthlyCostUsd`.  Receipt cash is funding, not usage (`budget-status.ts:1356-1359`).
**Second-order risk:** The owner’s actual decision (“pause this provider”, “top up”, “throttle ST”) is a *cash* decision.  The dashboard’s loudest numbers are a mix of accrual, poll snapshots, push subsets, prepaid wallets, and LiteLLM estimates.  Sibling projection audits own the formulas; the product-strategy failure is that no surface states the basis in one sentence.
**Improvement:** Per-provider “cash basis” badge: `reported` / `accrued` / `derived` / `unverifiable`.  Never use an estimate as the primary spend chip.  Block budget-alert enablement when basis is not `reported` or `accrued`.

#### PS-03 — Single-operator tool drifting toward App Store public language
**Severity:** P2
**Evidence:** One `DASHBOARD_PASSWORD` (`src/lib/auth.ts`); privacy policy at `src/app/privacy/page.tsx:25-26` addresses Client, Local, and the public dashboard; design doc rejects multi-tenant SaaS.
**Second-order risk:** Local Monitor’s App Store positioning (“free for anyone”) implies a consumer product.  The server remains a sole-operator ledger with no orgs, no DSR automation, and no tenant isolation.  A curious TestFlight tester pointing Client at `usage.jays.services` is a support and privacy event, not a feature.
**Improvement:** Keep ASC and `/privacy` wording that the fleet instance is the operator’s own monitor.  Do not add “sign up” language.  If Local is the public product, treat the hosted dashboard as out of scope for that listing.

#### PS-04 — Docs and audits outrun product decisions
**Severity:** P2
**Evidence:** 100+ files under `docs/`; `docs/reviews/2026-07-28-full-app-review.md` still ranks “Fix Render-vs-Oracle documentation drift” as action #1; this file is another audit.  `package.json:47` still runs `test:oracle-deploy` in default `verify`.
**Second-order risk:** A new agent following the loudest doc does the wrong host, the wrong backup lineage, or re-litigates a fixed finding (July “no Sentry SDK” is now `src/sentry.server.config.ts`).
**Improvement:** One `docs/CANON.md` index with “supersedes” links.  Banner pre-Hetzner reviews.  Gate `test:oracle-deploy` behind `VERIFY_LEGACY_DEPLOY=1`.

---

### 2. Billing / finance domain nuance

Sibling audits own adapter correctness and EOM formulas.  This section is accounting-domain assumption risk.

#### BF-01 — `max(snapshot, push)` undercounts complementary channels
**Severity:** P1
**Evidence:** `src/lib/budget-status.ts:59-60,1356-1363` — `observedVariableUsageUsd = Math.max(snapshotVariableCostUsd, pushed.usagePushed)` with an explicit comment that one channel is assumed to superset the other.
**Second-order risk:** Correct for “org MTD poll vs app-scoped push.”  Wrong when poll sees platform fees and push sees untagged app tokens, or when two keys report disjoint slices.  Downstream throttle consumers treat the result as authoritative cash MTD.  The failure mode is **under-count**, not double-count — the safer-looking merge is the dangerous one.
**Improvement:** Per-provider channel role (`overlap` vs `complement`).  Sum disjoint slices when complementarity is proven.  Mark `spendCoverage: "assumed_overlap"` until reconciliation confirms the merge.

#### BF-02 — Subscription spend is accrual at period start, not a bank debit
**Severity:** P1
**Evidence:** `src/lib/subscription-materializer.ts:127-154` stamps `occurredAt: periodStart`, `confidence: "actual"`, `billingMode: "manual"`.  Header comment (lines 18-21) says these rows flow through the same MTD sums as metered usage.
**Second-order risk:** A term that starts on the 28th hits this UTC month even if the invoice posts next month or the charge fails and retries.  `confidence: "actual"` overstates certainty.  Paused/canceled rows stop *future* materialization but prior events stay in MTD forever (idempotency).
**Improvement:** Split DTO fields `accruedFixedUsd` vs `cashPaidUsd`.  Relabel UI “accrued this UTC month,” not “spent.”  Use `confidence: "planned"` until external billing confirms the period.

#### BF-03 — Plan-fixed vs Subscription: budget guarded, inventory still lies while `considering`
**Severity:** P2
**Evidence:** Budget path zeros plan fixed when subscription events exist (`budget-status.ts:532-544`).  API exclusivity in `src/lib/provider-plan.ts:5-9`.  Inventory treats `considering` as inactive (`billing-inventory.ts:257-259`) and can still show `provider-plan` fallback (`494-520`).
**Second-order risk:** Owner evaluating a paid tier sees committed recurring spend *and* the candidate row.  Activating the subscription then trips exclusivity.  Planning overstates before the transition.
**Improvement:** Suppress plan-fixed fallback whenever any tracked recurring row exists for that provider, including `considering`.  Surface an explicit `fixedCostConflict` in inventory, not only in budget alerts.

#### BF-04 — Receipt cash no longer inflates spend; it can still inflate “we know usage”
**Severity:** P1
**Evidence:** `budget-status.ts:1356-1359` excludes receipt cash from `spentUsd` (July S2 fixed).  `1423-1426` still sets `hasKnownVariableCost` true when `receiptCash.paidUsd > 0`.
**Second-order risk:** A $500 top-up with $12 of unknown usage can look *covered*.  Project attribution has a special receipt-backed residual path (`2318-2345`).  Coverage language becomes a trust lie even though the dollar is correctly excluded from spend.
**Improvement:** Split `fundingCoverage` vs `usageCoverage`.  Receipt cash alone must not satisfy `hasKnownVariableCost`.

#### BF-05 — Charge-correction fail-open stays additive
**Severity:** P2
**Evidence:** `prisma/schema.prisma:704-708`; `subscription-materializer.ts:311-346`; test “keeps an unrelated same-price cadence and window service additive” in `external-billing-subscription-adoption.test.ts:481`.
**Second-order risk:** Two same-shape subscriptions both materialize until an operator links one to the exact external identity.  Designed for migration safety; the second-order effect is silent double accrual with only an informational conflict.
**Improvement:** Escalate unresolved same-provider / same-period / same-amount collisions to a blocking maintenance-health state and a “merge candidates” queue.

#### BF-06 — Prepaid wallet balance is not consumption, and credits do not expire
**Severity:** P2
**Evidence:** `src/lib/provider-financial-semantics.ts:15-36,76-108` includes OpenRouter / DeepSeek balances in portfolio funds.  No `expiresAt` on credit grants in schema.
**Second-order risk:** Portfolio “funds” can look like runway.  Expiring promotional credits vanish off-model.  Wallet balance must never enter spend or EOM (sibling projection scope); this finding is the missing *credit-grant* object.
**Improvement:** Model `creditGrants` with `expiresAt` and remaining quantity.  Separate “prepaid wallet” from “MTD spend against wallet.”

#### BF-07 — Refunds are a negative subscription hack; chargebacks and credit notes do not exist
**Severity:** P2
**Evidence:** `external-usage-events.ts:1027-1039` (manual negative subscription adjustments); `usage-telemetry.ts:507-514` (floor on negative subscription `costUsd`); receipt importer accepts `api_prepaid_funding` only.
**Second-order risk:** A partial refund that is not a subscription adjustment cannot be booked without distorting the materializer contract.  Net MTD after a chargeback is a manual JSON import.
**Improvement:** First-class `metricType: "refund" | "chargeback"` with a `keyRef` to the invoice / payment id.

#### BF-08 — No operator journal for budget or plan edits
**Severity:** P2
**Evidence:** `BudgetControlEvent` is append-only for *automated* pause / breach actions (`prisma/schema.prisma:78-83`).  `ProviderPlan.monthlyBudgetUsd` mutates in place with `updatedAt` only (`106-130`).
**Second-order risk:** “Why did we think the budget was $X last Tuesday?” is unanswerable.  Distinct from usage accuracy.  Distinct from auth (who is logged in — there is only one password).
**Improvement:** Append-only `OperatorMoneyEditEvent` (field, old, new, timestamp) on plan / subscription / allocation writes.  Optional CSV export.

#### BF-09 — Family aggregation fails closed to null, which understates the portfolio
**Severity:** P2
**Evidence:** `provider-money-aggregation.ts:245-274` returns `spentUsd: null` when account identity is missing or overlap is unproven.
**Second-order risk:** Conservative against double-count.  Portfolio KPIs then *omit* the family.  Multi-key Anthropic / OpenAI setups without `billingAccountIdentity` disappear from the total the owner glances at.
**Improvement:** Show withheld families as a range, not a hole.  Copy: “unproven overlap — total withheld.”

#### BF-10 — No fiscal-year or tax export
**Severity:** P2
**Evidence:** `GET /api/export/daily-rollups` is UTC daily telemetry rollups, max 92 days, 10k rows (`src/app/api/export/daily-rollups/route.ts:8-23`).
**Second-order risk:** Tax prep and 1099-ish vendor totals require a spreadsheet the product cannot produce.  Acceptable for a sole operator today; the gap is that rollups are *ops*, not books.
**Improvement:** `GET /api/export/vendor-spend?year=2026&basis=accrual|cash` with explicit basis metadata.  Do not call it a tax form.

---

### 3. Receipt and email workflows

#### RE-01 — Inbox evidence expires in 180 days with no review nag
**Severity:** P1
**Evidence:** `workers/receipt-inbox/src/index.mjs:14-15,773-801`; `workers/receipt-lifecycle.mjs` (`RECEIPT_RETENTION_DAYS = 180`); `docs/rollouts/2026-07-18-receipt-inbox-operations.md:23-27`.
**Second-order risk:** Inbox never auto-cashes (correct).  Unreviewed mail ages out of R2 and the Durable Object index.  `needsReviewCount` drops to zero.  The fallback mailbox may still hold `.eml`, but Operations does not warn before expiry.
**Improvement:** Ops / Pushover nag when oldest `needs_review` item crosses 30 / 60 / 150 days.  Document fallback-mailbox recovery on the Operations card.

#### RE-02 — MIME inbox and HMAC cash importer are disconnected
**Severity:** P1
**Evidence:** Inbox secrets are `RECEIPT_INBOX_*` (`workers/receipt-inbox/README.md:31-36,144-162`).  Cash importer uses `BILLING_RECEIPT_IDENTITY_KEY` / `BILLING_RECEIPT_HMAC_KEY` (`scripts/import-private-billing-receipts.mjs:174-177`).  Docs state the Worker cannot create money rows (`docs/rollouts/2026-07-18-receipt-inbox-operations.md:8-11`).
**Second-order risk:** Operator marks inbox `reviewed`, never runs `npm run import:billing-receipts`.  Evidence preserved, cash never recorded.  Inbox evidence IDs do not feed import digests.  This is the actual prepaid-cash bottleneck, not parser quality.
**Improvement:** Operations card checklist: evidence curl → JSON → dry-run → apply.  Show truncated evidence id for copy-paste.  Do not auto-cash.

#### RE-03 — Dashboard triage is metadata-thin
**Severity:** P1
**Evidence:** Summary API omits subject (`workers/receipt-inbox/src/index.mjs:670-682`).  `operations-health.ts:23-33,227-240` parses `quarantineReason` but the UI (`OperationsOverview.tsx:148-155`) shows sender domain + attachment counts.
**Second-order risk:** `mime_parse_failed` and a real invoice look identical.  Prioritization requires the operator-only evidence token and CLI.  Privacy boundary (no subject in the summary API) is correct; the workflow is not.
**Improvement:** Show `quarantineReason`, `bodyEvidence`, and truncated id.  Keep subject out of the summary API.

#### RE-04 — Daily quota reject happens before fallback forward
**Severity:** P2
**Evidence:** `workers/receipt-inbox/src/index.mjs:237-255` — `quota_exceeded` calls `setReject` and returns; `message.forward(RECEIPT_FALLBACK_ADDRESS)` runs only after admit.
**Second-order risk:** Burst vendor mail on a heavy day is rejected at Cloudflare with no private copy.  Admitted mail always forwards first.  Asymmetric loss.
**Improvement:** Forward-then-reject on quota exceed with a quarantine flag, or surface quota state on `/health` and Operations.

#### RE-05 — Distinct `receiptId` strings cash the same paper twice
**Severity:** P2
**Evidence:** `scripts/import-private-billing-receipts.mjs:182-186` — digest is HMAC(providerId + receiptId).  Replay of the same pair is idempotent (`retention-integration.test.ts:187-191`).
**Second-order risk:** Idempotency protects replays, not semantic duplicates.  Two human labels for one invoice become two cash events.
**Improvement:** Document “vendor invoice number is `receiptId`.”  Optional pre-import check against existing receipt-cash totals for provider / month.

#### RE-06 — `postal-mime` 3.0.0 is a major parser bump
**Severity:** P2
**Evidence:** `package.json:56`; #1232 merged 2026-08-17; parse options at `workers/receipt-inbox/src/index.mjs:272-276`; `test:receipt-inbox-worker` is in local `verify` and CI (`ci.yml:237-238`).
**Second-order risk:** Attachment extraction / group-dedupe / quarantine reasons can shift without a 500.  Worker tests are the only gate.
**Improvement:** Keep the workerd suite mandatory for any `postal-mime` bump.  Add one nested-multipart + inline-PNG fixture if not already present.

**Sound:** Inbox has no ingest tokens and cannot write `ExternalUsageEvent`.  Resend / Pushover alert mail is a separate channel (`alert-delivery.ts:271-316`).  Apex iCloud vs `receipts.jays.services` MX split is documented (`docs/rollouts/2026-08-14-apex-icloud-receipts-routing.md`).

---

### 4. Test architecture and code quality

#### TQ-01 — Hand-maintained `TEST_SCHEMA_SQL` has no drift guard
**Severity:** P1 (latent P0 if drift occurs)
**Evidence:** `src/lib/__tests__/setup-test-db.ts:3-465` applies a copied SQLite DDL via `sqlite3`, not `prisma db push`.  No `prisma/migrations/` directory.  CI runs `npx prisma validate` only (`ci.yml:206-207`).  No script compares `TEST_SCHEMA_SQL` to `schema.prisma`.  Spot-check of `ProviderPlan` / `ProviderExternalBilling` / `Subscription` columns matches today.
**Second-order risk:** Money-path integration tests (materializer, budget-status, adoption, retention) can stay green on a stale schema.  Failure appears at `db push` / boot, not in the suites that claim to prove persistence.
**Improvement:** Generate the test DB from Prisma, or fail `verify` when the copied DDL disagrees with `schema.prisma`.

#### TQ-02 — CI `verify` job omits two scripts local `npm run verify` runs
**Severity:** P1
**Evidence:** `package.json:47` includes `test:r2-archive` and `test:cf-token-map`.  `.github/workflows/ci.yml:237-280` runs worker, migrate-safe, sqlite-backup, startup, oracle, apple-projects, antigravity, ship-gate, audit, build — not those two.
**Second-order risk:** Weekly R2 archive signer and `cf-token-map.sh` can regress on a green PR.  Local verify is not what GitHub required checks run.
**Improvement:** Add both steps to CI, or drop them from `verify`.  One source of truth.

#### TQ-03 — iOS XCTest never runs in CI
**Severity:** P1
**Evidence:** 27 Swift test files under `ios/UsageMonitor/UsageMonitorKit/Tests/` (including `MoneyScreenTests.swift`).  `.github/workflows/ios-build.yml` is `xcodebuild build` only.  `rg 'xcodebuild test|swift test' .github/workflows` → none.
**Second-order risk:** iOS money-honesty and bearer-header tests can fail on a Mac and still ship.  Web has deep SQLite integration; iOS has URLProtocol mocks that nobody executes on merge.
**Improvement:** Mac-runner `xcodebuild test` for UsageMonitorKit, path-filtered like the build workflow.

#### TQ-04 — Shared telemetry contract is duplicated, not imported
**Severity:** P1
**Evidence:** `package.json:50` pins `@jaywedgeworth22/congress-trading-shared#v2.5.2`.  `usage-telemetry.test.ts:191-193` says hashes “MUST match” the shared package.  Zero test files import the package; vectors are hardcoded hex.
**Second-order risk:** A shared-package bump or producer-side key change desyncs silently.  Green UM CI does not prove wire compatibility with the pin.
**Improvement:** Import shared test vectors (or a `contract-vectors` export) and fail on hash mismatch.

#### TQ-05 — Critical HTTP routes mock away the money layer
**Severity:** P2
**Evidence:** `src/app/api/ingest/usage/__tests__/route.test.ts:11-16` mocks `persistExternalUsageEvents`.  `src/app/api/budget-status/__tests__/route.test.ts:8-10` mocks `@/lib/budget-status`.  Persistence and math are tested in lib suites, not through the handler.
**Second-order risk:** Field-drop / DTO-rename / receipt-cash routing bugs pass route tests.  Lib tests skip middleware and body parsing.
**Improvement:** One real-SQLite ingest test per critical shape (v2 batch, receipt-cash HMAC, negative subscription).  One authenticated budget-status response-schema test.

#### TQ-06 — No browser E2E; UI tests are static HTML
**Severity:** P2
**Evidence:** No Playwright.  Component tests use `renderToStaticMarkup` (`SubscriptionsPanel.test.ts`, `ProviderTable.test.ts`).
**Second-order risk:** Subscription edit → materialized charge visibility, SWR refresh, and form submit paths have no interaction coverage.
**Improvement:** Optional Playwright smoke: login → dashboard spend visible → subscriptions tab.  Keep vitest for units.

#### TQ-07 — God modules concentrate change risk
**Severity:** P2
**Evidence:** `alert-delivery.ts` ~3,736 lines; `infisical-provider-sync.ts` ~2,705; `budget-status.ts` ~2,547; `r2-usage.ts` ~2,245; `external-usage-events.ts` ~1,702; `data-retention.ts` ~1,040.  Matching test files are also huge.
**Second-order risk:** Coverage percentage can stay above the CI gate while a new branch in the same file is untested.
**Improvement:** Extract pure aggregation / DTO / groupKey functions.  Leave the god files as orchestration.

#### TQ-08 — Local `verify` skips the coverage gate CI enforces
**Severity:** P2
**Evidence:** `package.json:47` runs `npm test`.  CI runs `npm run test:coverage` (`ci.yml:218-219`) with thresholds in `vitest.config.ts`.
**Second-order risk:** `npm run verify` can be green locally and red on GitHub, or the reverse for coverage-only drift.
**Improvement:** Align verify with CI, or document that only CI is authoritative.

**Sound:** Layered verify (vitest + workerd receipt inbox + migrate-safe + sqlite-backup + antigravity replay).  Strong web money-path integration tests.  No `@ts-ignore` in `src`.  Zero Vitest `.snap` files.  `usage-telemetry.test.ts` and subscription route tests are the model to copy.

---

### 5. Privacy and data lifecycle

Exploit / token security is a sibling audit.  This is retention, labels, and legal copy.

#### PR-01 — iOS Privacy Nutrition labels claim zero collected data
**Severity:** P1
**Evidence:** `ios/UsageMonitor/App/Resources/PrivacyInfo.xcprivacy:9-10` — `NSPrivacyCollectedDataTypes` is an empty array.  Same empty array in Local and Widget copies.  Web policy at `src/app/privacy/page.tsx:83-133` admits Keychain tokens, on-device usage SQLite, server URL / read token, cached budget summaries, and (for a hosted dashboard) provider credentials.
**Second-order risk:** App Store privacy questionnaire / review mismatch.  The policy is the honest document; the nutrition label is not.  Reviewers can reject on inconsistency.  If Local is ever used by someone other than the owner, the label is also a legal miss.
**Improvement:** Declare collected types per app (credentials, financial info, identifiers / device storage).  Align ASC answers with Client vs Local separately.  Keep “no tracking / no ads” — that part matches.

#### PR-02 — Cost-bearing `rawData` is shallow-redacted and kept 45 days
**Severity:** P1
**Evidence:** `src/lib/data-privacy.ts:35-38` — “Nested payloads are not deep-walked.”  Allowlisted keys include `keys`, `invoices`, `usage`, `organization`.  `data-retention.ts:11-12,198-203` strips diagnostic `rawData` at 14 days but **keeps `rawData` on cost-bearing snapshots until full 45-day snapshot retention**.
**Second-order risk:** Nested emails, account names, or key metadata ride inside allowlisted objects into SQLite and every B2 / Litestream replica.  Intrinio already special-cases email (`adapters/intrinio.ts`), which proves the class of leak is known.
**Improvement:** Deep-redact known PII paths inside allowlisted keys.  Surface “rows still carrying rawData” on an ops field.  Shorten cost-row blob retention once provenance readers do not need the blob.

#### PR-03 — Receipt MIME lives 180 days in a second trust domain
**Severity:** P1
**Evidence:** Full MIME in private R2; 180-day lifecycle (`workers/receipt-lifecycle.mjs`).  Dashboard reads bounded metadata only.  No subject-access or erasure tool.
**Second-order risk:** Billing emails (merchant, address, card hints, PDF) persist off the main DB with a different token.  Acceptable for a sole operator; there is still no “I reviewed this, now purge evidence” path.
**Improvement:** Reviewed-evidence purge command.  Privacy annex listing evidence categories.  Tie the lifecycle audit to a retention policy, not only ops readiness.

#### PR-04 — Tombstones are permanent; the 180-day setting is cosmetic
**Severity:** P2
**Evidence:** `DEFAULT_TOMBSTONE_RETENTION_DAYS = 180` (`data-retention.ts:10`) but `tombstonesPruned = 0` with “Keep them permanently” (`955-961`).
**Second-order risk:** Correct for late-replay double-count prevention.  Unbounded SQLite + backup growth with no digest when cardinality explodes.
**Improvement:** Expose `tombstoneCount` on `/api/ready` observability and in a monthly digest.  Document the trade in `DEPLOY.md`.

#### PR-05 — OTLP drops `user.email` but keeps project names forever in rollups
**Severity:** P2
**Evidence:** `claude-code-mapper.ts` / `mapping-utils.ts` exclude `user.email`; allowlist `project` / `project.name`.  `usage-telemetry.ts` mirrors project into `metadata`.  Rollup `groupKey` includes `projectId` (`data-retention.ts`).
**Second-order risk:** Project names can be repo or client identifiers.  They survive 90-day raw retention and live in rollups indefinitely.
**Improvement:** Treat `metadata.project` as operational attribution in `/privacy`.  Optional env to strip names from long-term rollups while keeping `projectId`.

**Sound:** Receipt cash import stores HMAC digests, not raw receipt IDs.  Web `/privacy` exists and is more accurate than the iOS nutrition labels.  OTLP email exclusion is real.

---

### 6. Accessibility

UX polish is a sibling audit.  These are structural a11y debts that affect money trust.

#### A11Y-01 — `LlmBurnCard` money table is color-and-columns
**Severity:** P1
**Evidence:** `src/components/LlmBurnCard.tsx:136-237` — table with pace chips (`paceTone` 63-85); no caption, no `aria-labelledby`, no row summary, no live region.
**Second-order risk:** VoiceOver / NVDA users get undifferentiated numeric columns.  Pace is mostly emerald / amber / red.  This is the card that claims to generalize ccusage’s 5-hour lesson to every LLM.
**Improvement:** Caption + per-row `aria-label` (provider, window cost, MTD, pace text).  Mirror iOS `SpendPaceChart.accessibilitySummary`.

#### A11Y-02 — `SpendBurnChart` lacks Recharts `accessibilityLayer` and reduced-motion
**Severity:** P2
**Evidence:** `SpendBurnChart.tsx:285` (`ComposedChart` without `accessibilityLayer`).  `UsageChart.tsx:58` already has it.  No `prefers-reduced-motion` in web charts; iOS `SpendPaceChart.swift` honors `accessibilityReduceMotion`.
**Improvement:** Add `accessibilityLayer`.  Gate animations with `@media (prefers-reduced-motion: reduce)`.

#### A11Y-03 — iOS money labels shrink instead of reflowing
**Severity:** P2
**Evidence:** `DashboardHeroCard.swift:24`; `MoneyScreen.swift:199,398` use `minimumScaleFactor`.
**Second-order risk:** Large Dynamic Type truncates the number the user is trying to trust (WCAG 1.4.4 partial).
**Improvement:** `@ScaledMetric` + wrapping on hero money.  Audit Money / Settings at XXXL.

#### A11Y-04 — Operations pills are small gray text on the light default
**Severity:** P2
**Evidence:** `OperationsOverview.tsx:67-99,127-128` — `text-xs text-gray-500` at 10–12px.  Labels exist (not color-only).
**Second-order risk:** Light-theme gray-500 on white often fails WCAG AA at that size.  Fleet default is light (`layout.tsx:51-53`).
**Improvement:** Bump secondary ops copy to `text-gray-600` minimum; verify 4.5:1.

**Sound:** `lang="en"` and a skip link (`layout.tsx:32,57-68`).  iOS primary money surfaces invest in VoiceOver.  `PwaRegistration` is now mounted (`layout.tsx:72`) — July U1 is fixed.

---

### 7. Internationalization and currencies

#### I18N-01 — Month-to-date is UTC, not the owner’s day
**Severity:** P1
**Evidence:** `budget-status.ts:194-195,732`; `format.ts:90-99`; `useDashboardData.ts:119,224` (`timeZone: "UTC"`).  iOS `TimeframeOption.swift` mirrors UTC.
**Second-order risk:** US Central flips the “month” at 6–7 PM local.  Evening spend lands in the next UTC month.  Card statements and mental model disagree with every MTD gate, rollup, and export.  Mid-month provider cycles are already excluded by design (`budget-status-intel.test.ts:325-344`) — that is honest and still surprising.
**Improvement:** Label every MTD control “UTC calendar month.”  Optional `DISPLAY_TIMEZONE` for labels only.  Long-term: parallel cycle-to-date view per provider.

#### I18N-02 — USD is enforced; native-currency metadata can still look like budget
**Severity:** P2
**Evidence:** `subscription-input.ts:141-143` throws unless USD.  Materializer returns `non_usd` (`subscription-materializer.ts:269-276`).  Hetzner catalog carries EUR-ish metadata (`provider-integration-catalog.ts:423-430`).  `currency` columns exist beside `*Usd` (`schema.prisma`).
**Second-order risk:** New rows cannot silently charge EUR as USD (good).  Display of native-currency run-rate can still be read as “in the budget.”  Legacy non-USD rows are omitted from summaries (`billing-inventory.ts:234-246`) rather than shown as excluded.
**Improvement:** Badge “display currency — not in budget.”  Mark omitted rows `coverage: "excluded_fx"` instead of dropping them.  `scripts/audit-subscription-currency.mjs` already exists — surface its count on ready observability.

#### I18N-03 — No VAT, tax-inclusive flag, or FX table
**Severity:** P2
**Evidence:** No tax / VAT handling in `src/`.  Receipt importer requires USD (`import-private-billing-receipts.mjs:138-139`).
**Second-order risk:** Pre-tax API receipts imported as gross cash skew the ledger vs the bank.  EU VAT invoices cannot be modeled.  Out of scope until FX exists; the blind spot is undocumented assumption.
**Improvement:** Document “amounts are operator-entered USD cash, tax treatment unknown.”  Future `taxIncluded` / `invoiceCurrency` metadata.

#### I18N-04 — English-only, no App Store localizations
**Severity:** P2
**Evidence:** `layout.tsx:32` `lang="en"`; no `next-intl`; iOS `CFBundleDevelopmentRegion` only.
**Improvement:** Defer full i18n.  If shipping outside en-US, parameterize `format.ts` locale before translating strings.

---

### 8. Vendor lock-in

#### VL-01 — SQLite + `db push`, no migrations directory
**Severity:** P1
**Evidence:** `README.md` / `AGENTS.md` — intentional absence of `prisma/migrations/`; production is a sole writer on Hetzner `/data` (`DEPLOY.md:26-32`).
**Second-order risk:** Schema evolution is deploy-coupled.  A second region or Postgres port is a project, not a flag.  Escape hatch today is daily-rollups + Litestream PITR (durability owned by sibling).
**Improvement:** Checked-in schema journal or `prisma migrate diff` artifact in CI.  One-page Postgres port checklist.  Do not pretend `db push` is a migration system.

#### VL-02 — Private GitHub pin for the cross-app contract
**Severity:** P1
**Evidence:** `package.json:50` — `github:jaywedgeworth22/congress-trading-shared#v2.5.2`.
**Second-order risk:** GitHub outage, token loss, or repo rename breaks `npm ci`, ingest, and sibling producers together.  Combined with TQ-04 (duplicated vectors), there is no offline contract copy that CI proves.
**Improvement:** Vendored tarball or npm mirror.  Pin SHA in the lockfile with a drift check.  Document v1-only degraded mode.

#### VL-03 — LiteLLM snapshot is 19 days stale at audit time
**Severity:** P2
**Evidence:** `src/lib/pricing/model-pricing.snapshot.json` `fetchedAt: "2026-07-29T19:27:40.120Z"` vs audit date 2026-08-17.  Analytics-only (`model-pricing.ts`).
**Second-order risk:** New models are `unpriced`.  LLM burn and Claude cost-check drift.  Owner may treat derived numbers as cash (PS-02 / BF UI fallback).
**Improvement:** CI warning when snapshot age > 14 days.  Surface `pricingSnapshotAge` on `/api/claude-cost-check` and the telemetry panel.

#### VL-04 — Coolify + Infisical + Cloudflare + B2 + Workers + Next 16 + Node 24
**Severity:** P2
**Evidence:** `package.json:7-8` engines `>=24.14.0 <25`; Next `16.3.1`; production Coolify uuid in `DEPLOY.md:3-8`; Infisical project `<UM_INFISICAL_PROJECT_ID>`; receipt inbox is a Cloudflare Worker + R2 + Durable Object.
**Second-order risk:** Any one vendor price-hike or outage has a known workaround for *some* layers (B2 vs R2 weekly, Pushover vs Resend) and none for others (Coolify writer, Infisical bootstrap, CF Email Routing).  Escape hatches are runbook knowledge, not a product export.
**Improvement:** One “export my monitor state” bundle (rollups + provider list + subscriptions, no secrets) for a migration drill.

---

### 9. Cost efficiency of the monitor itself

#### CE-01 — 15-minute poll across dozens of adapters is self-quota
**Severity:** P1
**Evidence:** Scheduler in `usage-recorder.ts` / `instrumentation.ts`; `src/lib/adapters/index.ts` loads 30+ modules; `provider-definitions.ts` ~53 entries; `ensure-ag***-s**c-provider.ts` seeds `ag***-s**c-relay` inactive at 1440 min to avoid self-poll.
**Second-order risk:** The monitor becomes its own largest API consumer (Cloudflare GraphQL, GitHub, Gemini Monitoring, …).  Rate limits degrade poll quality and trip “degraded” ops that look like vendor outages.
**Improvement:** Per-provider poll budget in Settings.  Default inactive for ops-only rows.  A “monitor self-cost” card from adapter HTTP counts (this app watching itself).

#### CE-02 — Dual iOS ship pipelines burn Mac-runner and review quota
**Severity:** P2
**Evidence:** Two bundle IDs, two TestFlight apps, `ios-ship.yml` cron, Invalid Binary / GM-host incidents in the effort log.
**Second-order risk:** A backend-only commit can still enqueue ship work if the scheduled gate regresses (that gate is now tested in CI — good).  Two review queues double App Store friction.
**Improvement:** Keep the ship gate.  Do not add a third binary.  Freeze Local features that are not in the v1 listing.

---

### 10. Documentation and knowledge

#### DOC-01 — Retired Render runbook still names Oracle as production
**Severity:** P1
**Evidence:** `deploy/render/RETIRED-rollback.md:3-5` — “Production runs on the Oracle A1 VM.”  `DEPLOY.md:3-16` and `deploy/oracle/README.md` say Hetzner Coolify is live and Oracle is not the writer.
**Second-order risk:** Deliberate rollback or a new agent follows the wrong host, wrong backup lineage (Garage vs B2), wrong scheduler gate.
**Improvement:** Rewrite the retired header to “Hetzner is live; Oracle and Render are historical.”  One “where production lives” table at the top of `DEPLOY.md` only.

#### DOC-02 — Effort board In Progress contains COMPLETED/MERGED rows
**Severity:** P1
**Evidence:** `docs/EFFORT-LOG.md:52-58`.  Open issues #1227, #1222, #1213, … still `state:in-progress`.  **PR #1233 already closes this.**  Do not duplicate that edit here.
**Second-order risk:** Agents reserve finished work.  #953 still reads as an active P0 incident from the title.
**Improvement:** Land #1233.  Add a CI lint: fail if `## In Progress` contains `COMPLETED` or `MERGED`.  Retitle #953 to historical.

#### DOC-03 — iOS `ARCHITECTURE-CONTRACT.md` denies APNs that the server now has
**Severity:** P1
**Evidence:** Contract §7 (`ARCHITECTURE-CONTRACT.md:316`) — “remote push (APNs) is NOT implemented… app must not claim `aps-environment`.”  Server sender exists (`src/lib/apns.ts`, `docs/rollouts/2026-08-13-apns-send.md`).  Infisical still lacks `APNS_*` (rollout: sender ready, cannot deliver).  §10.3 still lists LocalStore / Adapters / BudgetEngine as “planned/scaffold” (`379-384`) after Milestone A merged.  §10.1 still says “Oracle host” (`364`).
**Second-order risk:** iOS agents disable APNs work, or re-scaffold Local modules, or claim the wrong host in review notes.  `PushScaffoldTests` may still enforce a contract the server has outgrown.
**Improvement:** Refresh contract statuses.  Split “historical design” from “shipped.”  Point onboarding at `ios/CLAUDE.md`.

#### DOC-04 — AGENTS.md is wrong about daily-rollups middleware
**Severity:** P2
**Evidence:** `AGENTS.md:68-71` says the route is not yet excluded.  `src/middleware.ts:61` already excludes `/api/export/daily-rollups`.
**Second-order risk:** Agents add a duplicate exclusion or debug a bearer 401 that no longer exists.
**Improvement:** Delete the NOTE.  Mirror middleware exclusions in the README endpoint table.

#### DOC-05 — No CHANGELOG; package version is `0.1.0`
**Severity:** P2
**Evidence:** `package.json:4`; no `CHANGELOG*`.  Release history is the effort board and `docs/rollouts/*`.
**Second-order risk:** App Store “What’s New,” support, and agent onboarding have no product-facing history.  Rollouts are excellent and unindexed.
**Improvement:** A short `CHANGELOG.md` for user-visible money/behavior changes only.  Leave rollouts as the engineering record.

---

### 11. Observability

Backup-replica health is a sibling (backend) topic.  This is “does this app tell the truth about itself.”

#### OBS-01 — `/api/health` is always green; `/api/ready` is 200 unless `?strict=1`
**Severity:** P1
**Evidence:** `src/app/api/health/route.ts:12-19` always `{ ok: true, status: "live" }`.  `src/app/api/ready/route.ts:290-318` — `ok` is DB + scheduler + startup wrapper; default HTTP 200 even when `ok: false`; `?strict=1` returns 503.  `disk`, `backup`, `admission`, `usageReadToken` are observability-only (`354-386`).
**Second-order risk:** UptimeRobot on `/api/health` stays green through a stale scheduler, missing read token, or disk warning.  Operators must know the probe matrix.  This is a *product* lie, not a backup-replica lie.
**Improvement:** Document the monitor matrix in `DEPLOY.md`.  Point external uptime at `/api/ready?strict=1`.  Add `checks.summary.degradedReasons[]` for the iOS Server tab.

#### OBS-02 — Self-Sentry is optional; the dashboard reads other apps’ Sentry
**Severity:** P1
**Evidence:** `src/sentry.server.config.ts:12-20` inits only if `SENTRY_DSN` is set; default traces sample 0.  `src/lib/sentry-health.ts` reads `socratic-trade`, `congress-trade`, `fleet-infra` via `SENTRY_READ_TOKEN`.  July review “no SDK” is **fixed in code**; README still frames Sentry as the Health card.
**Second-order risk:** Production can run with zero self-error reporting while the card shows green counts for ST/CT.  A crash-looping UM route is `journalctl` only.
**Improvement:** Set `SENTRY_DSN` in Infisical prod (or accept the gap in writing).  `/api/ready` observability block `selfSentry: { configured }`.  Update README.

#### OBS-03 — No request IDs or structured logs; inbound OTLP only
**Severity:** P2
**Evidence:** Ad-hoc `console.warn` / `console.error` in scheduler, maintenance, R2.  App receives OTLP (`/api/otlp/v1/metrics`) and does not emit outbound traces for itself.
**Second-order risk:** Ingest 503 bursts cannot be tied to a scheduler tick or adapter timeout without grepping the host.
**Improvement:** Middleware request id + JSON logs on ingest / scheduler paths.  Optional `GET /api/self-metrics` from counters already on ready.

#### OBS-04 — iOS has no crash pipeline
**Severity:** P2
**Evidence:** No MetricKit / Crashlytics / Analytics under `ios/`.  Widget and Client depend on server health endpoints.
**Second-order risk:** TestFlight crashes are invisible until a tester reports them.  No correlation with server `revision`.
**Improvement:** Use App Store Connect crash reports.  Optional MetricKit on Client.  Link crashes to deployed revision in the support doc.

---

### 12. Leftover domains

#### LG-01 — Bus factor is one person plus a board that lies
**Severity:** P1
**Evidence:** Single dashboard password; Infisical machine identity; SSH `root@<PROD_ORIGIN_IP>`; Apple team `CC8UTF7ATG`; effort-board issues as the only “issue tracker.”  No succession runbook in-repo beyond fleet docs that live on the owner’s Mac (`/Users/jay/apps/AG***-S**C.md`).
**Second-order risk:** Incapacity or lost laptop is a production outage *and* a knowledge outage.  Agents can operate the repo; they cannot rotate Apple / Infisical / Hetzner without the owner.  #953’s leftover “ACTIVE INCIDENT” title shows how incident state decays.
**Improvement:** A one-page `docs/SUCCESSION.md` (hosts, vault, Apple team, “do not resume Render,” probe URLs) with no secret values.  Close or retitle historical P0 issues.

#### LG-02 — License is Apache-2.0 and `private: true`
**Severity:** P2
**Evidence:** `package.json:4-6`.
**Second-order risk:** Fine for a private operator repo.  Confusing if the App Store listings or a future public mirror imply OSI reuse of adapter code that embeds fleet-specific assumptions.
**Improvement:** One sentence in README: source license vs “this instance is not a multi-tenant service.”

#### LG-03 — Issue tracker is an effort-board mirror, not a product backlog
**Severity:** P2
**Evidence:** `gh issue list` open set is `effort-board` rows.  Real product bugs (UTC month surprise, receipt workflow, PrivacyInfo) have no issues.
**Second-order risk:** GitHub search for “receipt expire” or “privacy label” finds nothing.  Agents file against the board, not against user-visible defects.
**Improvement:** After #1233, file a short Planned list from this audit’s P1s (or accept the board as the only backlog and link this file from it).

#### LG-04 — Feature-flag / kill-switch sprawl
**Severity:** P2
**Evidence:** `OTLP_METRICS_INGEST_ENABLED`, `USAGE_SCHEDULER_ENABLED`, `INGEST_COST_DERIVATION_ENABLED`, R2 emergency disable + `/data/r2-auto-resumed.flag`, `STARTUP_WRAPPER_REQUIRED`, `LITESTREAM_REQUIRED`, Cloudflare legacy handoff UUID, ST Gemini bootstrap flags (AGENTS.md / `.env.example`).
**Second-order risk:** A flag left on (or stuck on, as R2 was) becomes invisible product behavior.  No single “flags in effect” page.
**Improvement:** `/api/ready` already has some of this — add a secret-free `flags[]` list (name + boolean, never values) and render it on the Server tab.

---

## Ranked improvements

1.  **Label the cash basis** on every loud number (PS-02, BF-01, BF-02, BF-04).  Estimate never occupies the primary chip.
2.  **Close the receipt operator loop** (RE-01, RE-02, RE-03) without auto-cashing: nag, checklist, quarantine reason, truncated id.
3.  **Align gates with reality** (TQ-02, TQ-03, TQ-01, TQ-04): CI runs what `verify` claims; iOS tests execute; test schema cannot drift; shared vectors are imported.
4.  **Fix Privacy Nutrition labels** (PR-01) before the next App Store submission.
5.  **Refresh canon** (DOC-01, DOC-03, DOC-04) and land #1233 (DOC-02).  Point uptime at `/api/ready?strict=1` (OBS-01).
6.  **UTC month copy** on every MTD control (I18N-01).
7.  **Deep-redact `rawData`** and show blob residual counts (PR-02).
8.  **Poll budgets + self-cost card** (CE-01).
9.  **LlmBurnCard screen-reader rows** (A11Y-01).
10.  **Succession page + flags list** (LG-01, LG-04).

---

## Sound (do not “fix”)

- Receipt inbox cannot create money rows.  HMAC importer is idempotent on `(providerId, receiptId)`.
- New subscriptions cannot charge non-USD as USD.
- Active-path plan-fixed + Subscription double-count is guarded in `computeBudgetStatus`.
- Prepaid receipt cash is excluded from `spentUsd` (July S2).
- Sentry SDK exists and is DSN-gated (`sentry.server.config.ts`).
- Skip link + `lang="en"` + PWA registration are mounted.
- `test:receipt-inbox-worker` is in CI (was a prior hole).
- Agent-sync provider is seeded inactive.
- Daily-rollups bearer path is already middleware-excluded (doc is stale, code is not).
- iOS Local no longer invents Vercel / Workers / Robinhood fees on seed (`LocalAppModel.swift:151-153`).  Prefill-on-Add remains a nudge (low).

---

## What this panel did not re-litigate

| Owned by | Topics left alone except as second-order mentions |
|----------|---------------------------------------------------|
| Providers accuracy | Adapter coverage, Infisical key mapping, blind polls |
| Outcomes / projections | Linear EOM, burn rate, anomaly σ, free-tier thresholds |
| Security / privacy (exploit) | Token isolation, HMAC strength, raw secret storage, CSP |
| Backend durability | Litestream / B2 / R2 replica truth, SQLite locks, restore drills |
| Web / iOS parity | Visual polish, tap targets, offline cache UX, widget chrome |

---

## Sources

- Checkout `8db78b58ef12ed45ec73df8fdb162596c96b03b4` (2026-08-17).
- `gh issue list` / `gh pr list` the same day.
- Prior in-repo reviews: `docs/audits/2026-07-20-grok3-full-app-expert-review.md`, `docs/reviews/2026-07-28-full-app-review.md` (several July items are fixed; this audit re-verified rather than copying).
- Slack `#ag***-s**c` reservation: 2026-08-17 (thread `1787010129.504599`).
