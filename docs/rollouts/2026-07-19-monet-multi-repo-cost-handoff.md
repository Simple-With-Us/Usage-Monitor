# Handoff: MONET multi-repo session — cap pickup, Cloudflare gap, Congress.Trade cost fires

**Seat:** MONET
**Session span:** 2026-07-15 → 2026-07-19 (UTC), one continuous conversation
**Repos touched:** API-usage-monitor (primary), Congress.Trade, Socratic.Trade (read-only)
**Status at handoff:** stopping on explicit owner instruction. Two items are genuinely urgent and unowned — see §7.

**⚠️ Staleness caveat, discovered while writing this note:** my local worktree at `/Users/jay/Code/API-usage-monitor` went missing between my last active check and now (no `.git`, contents wiped — likely another concurrent seat's cleanup during this long session; not investigated further per the stop instruction). A fresh clone shows `main` has moved well past everything below — recent rollout docs (`2026-07-18-oracle-always-free-migration.md`, `2026-07-18-oracle-production-cutover.md`, `2026-07-18-garage-backup-monitoring.md`, `2026-07-18-extension-credential-containment.md`, `2026-07-17-github-direct-billing.md`) imply a hosting migration off Render happened after my last verification, entirely outside this thread. **Do not trust the `usage.jays.services` / Render-deploy assumptions in §7's verification commands without rechecking current prod location first** — everything else in this note (PR numbers, commit SHAs, code-level facts) was verified against the repo state at the time I did the work and should still be accurate history, just not necessarily "where prod is right now."

---

## 1. API-usage-monitor: CLAUDE cap-handoff pickup — COMPLETE

Picked up `docs/rollouts/2026-07-15-pickup-codex-cap-handoff-to-monet.md` (CLAUDE hit its Fable weekly cap mid-verification). Fully closed out:

- **PRs merged:** #300 (`UsageSnapshot` composite index), #301 (auth trio: XFF-spoofable rate-limit key, plaintext-password-derived session HMAC, non-constant-time `CRON_SECRET`), #306 (dashboard auto-refresh), #307 (salvaged CODEX admission-release regression test), #314 (P2 remediation: Cloudflare shared-egress owner-lockout in the login backstop), #315/#316 (P3 sweep), #317 (rollout note + board mirror). Final `main` after this batch: `8a7bd3f`.
- **Anthropic receipt reconciliation:** confirmed already applied to prod pre-session (provider `45b10ffc-684e-465d-822d-f3839c78c456`, `receiptCashPaidUsd: 63.96`, 3 events) — no action needed, documented for the record.
- **Worktree/branch cleanup:** ~25 stale registrations pruned with pre-removal re-verification; full archives at `/Users/jay/apps/backups/worktree-prune-2026-07-15/`. Two residues initially flagged "superseded" were independently re-verified as holding *novel* content and deliberately kept (a Claude-subscription receipt worktree, an admission-release regression test — the latter was salvaged into PR #307 instead of discarded).
- Full detail: `docs/rollouts/2026-07-15-monet-cap-handoff-completion.md` and `docs/rollouts/2026-07-17-apple-claude-billing-adjustments.md`.

### 1a. Apple-billed Claude subscription chain — COMPLETE
Owner-directed: model the Apple-billed Claude Pro→Max5x→Max20x prior-tier chain as expenses, with each upgrade's pro-rated refund as a negative expense.

- **PR #372** (`monet/manual-subscription-adjustments`, merged `ff9b244`): new narrowly-scoped negative-`costUsd` ingest path (metricType=`subscription` only, $1,000/event magnitude cap, materializer-sourceApp forgery blocked at the HTTP boundary), a refund-aware fixed-charge dedupe fix (`subscriptionPushedManualUsd`, clamped ≥0), a dry-run-first operator script (`scripts/import-manual-subscription-events.mjs`), and a frozen-clock money-math proof test.
- **Applied to prod** via the script against `https://usage.jays.services`: +$21.45 Pro (2026-06-13, actual), +$124.99 Max 5x (2026-06-16, actual), −$19.15 Pro refund (2026-06-16, **estimated** — owner-approved day-count proration, no refund receipt located), −$104.16 Max 5x refund (2026-06-21, **estimated**). Net June effect: +$23.13. `accepted:4`; idempotency re-run confirmed `accepted:0`.
- Private evidence preserved: `/Users/jay/.secrets/claude-subscription-receipts-2026-07-15.json` and `/Users/jay/.secrets/apple-claude-billing-adjustments-2026-07.json` (both chmod 600).
- **Open, not acted on:** the Apple-billed **Claude Max 20x Monthly at $268.11/mo** (paid through 2026-07-20) is still not modeled as an active Subscription row — the owner never gave a go-ahead for that one specifically (only the prior-tier chain + refunds were authorized). If wanted, it's a one-off dashboard-session `POST /api/subscriptions` — not something to do headlessly.

---

## 2. API-usage-monitor: Cloudflare cost-visibility fix — COMPLETE, DEPLOYED

Owner discovered a $1,221+ Cloudflare bill (D1 usage-based billing) that the dashboard never flagged, despite believing Cloudflare cost $5-10/mo.

**Root cause (confirmed by reading the adapter):** Cloudflare exposes three billing surfaces — fixed subscriptions (reliable, this is the $5-10/mo the owner saw), PayGo metered usage (an "alpha, restricted to select accounts" endpoint — this is where the real D1/R2/Queues/Workers overage lives), and optional D1/R2/KV/Queue fields that are explicitly metadata-only probes, not cost sources. When the PayGo endpoint fails, `src/lib/adapters/cloudflare.ts` correctly falls back to subscription-only cost rather than failing the whole provider — but the resulting degraded-coverage state was recorded only in an internal `rawData` diagnostic field that **no UI component ever read**. The dashboard showed an accurate-looking number with zero indication it was structurally incomplete.

**Fix — PR #389** (`monet/cloudflare-cost-coverage-warning`, merged `f0891dc`, confirmed deployed, `/api/ready` 200):
- New adapter-agnostic `costCoverageCaveat` field on `UsageResult`, persisted additively inside the existing `rawData` JSON blob (no schema migration), derived server-side in `/api/providers` and `/api/providers/[id]`.
- Rendered as a visible orange warning on all four live UI surfaces: `DashboardProviderWorkspace` (main dashboard), `ProviderTable` (`/settings`), `/providers/[id]` (the repo's own Codex review bot caught this fourth surface — I'd missed it), and `ProviderCard` (currently dead code, not mounted anywhere, but future-proofed).
- Adversarial review caught and fixed: a staleness bug (the family-level badge didn't filter `isActive`, so a deactivated Cloudflare provider's warning would freeze on screen forever since deactivated providers are never re-polled) and a docs-accuracy overstatement. Both remediated pre-merge.

---

## 3. Congress.Trade: the actual $1,221 root cause — ALREADY FIXED BY ANOTHER SEAT, VERIFIED

Investigated why Cloudflare D1 billed $1,153 for 1.15B writes + $54.95 for ~80B reads against a database that only rests at ~1.5M rows (700-750x write amplification — churn, not growth).

**Root cause:** `scripts/backfill-market.sh` polled an admin endpoint in a loop until a "pending tickers" count hit zero — but ~544 delisted/foreign/non-equity tickers can never satisfy that count, so **the loop never terminated**. Every pass re-fetched and re-upserted each eligible ticker's entire multi-year price history (instead of just new days) plus a full S&P 500 re-upsert, and the pending-count query itself did a full-table `LEFT JOIN` scan every pass.

**This was already fixed and deployed before I could act on it** — commit `b039d2f` (PR #551), merged same-day by a concurrent Congress.Trade seat. Its own commit message estimates "~1.15B rows written / ~80B read / ~$1,153," matching the bill almost exactly. I confirmed it's genuinely live in production (not just merged to git — this repo's Cloudflare deploy is a manual `workflow_dispatch` gate, not auto-deploy-on-merge): a real deploy fired 48 seconds after the merge, with several more deploys since.

A **secondary, smaller** write-churn bug (unconditional per-poll `UPDATE`s on already-known filings in `app/src/ingestion/watcher.ts`, no `WHERE`-guard checking whether a value actually needed to change) is fixed on **PR #557** (`antigravity/fix-massive-db-writes-3`, another seat's branch) — I independently verified it with a scratch SQLite reproduction proving the fix eliminates no-op writes without any data-loss path, and posted that verification as a PR comment rather than opening a competing PR or pushing to a branch I don't own. **Not merged. Not by me — this is the PR owner's/owner's call.**

Reads investigation independently confirmed `b039d2f` also eliminated ~90-98% of the read volume (same mechanism drove both metrics — this was re-derived and verified from the actual diff, not assumed).

---

## 4. Congress.Trade: D1 read-cost remainder — VERIFIED, PUSHED, **NOT MERGED (blocked, see §7)**

The residual ~2-10% of read cost had a complete fix already open as **PR #559** (`monet/d1-read-cost-control`, another concurrent seat + Opus co-author): a missing `idx_tx_doc` index (eliminates full-table-scan correlated `doc_id` subqueries in ingestion), 3-6x longer analytics KV cache TTLs plus newly-caching the previously-uncached `/api/members` full-corpus query, a new opt-in `shared/d1Budget.ts` D1 row-budget meter with Sentry alerting (fails open everywhere, disabled-by-default enforcement — real defense-in-depth against this exact failure mode recurring), and Workers log-volume trimming.

I independently re-verified this **twice** (two separate review passes, each redoing the diffs/tests from scratch rather than trusting the other): `npm run typecheck` clean, 135/135 files / 1420/1420 tests pass, every changed file hand-diffed and confirmed behavior-preserving, new admin endpoint checked for SQL-injection safety, confirmed zero file-overlap against the 6 other open PRs at the time.

**What I did:** its only real blocker was a trivial merge conflict — two agents appending different bullet lines to the same anchor in `docs/EFFORT-LOG.md` (an append-only mirror doc, not app code; confirmed via `git merge-tree` that every actual code file merges clean). I resolved it additively (kept both sides' bullets, in an isolated worktree at `/Users/jay/apps/backups/` — not the shared checkout), reran the full test suite post-merge (still 135/135 · 1420/1420 green), and pushed the merge commit (`c74ebb8` → `ad1d0d2`) to `origin/monet/d1-read-cost-control`. **I did not merge the PR itself.**

---

## 5. Congress.Trade: GitHub Actions cost — ROOT CAUSE FIXED (config), monitoring not yet built

Owner asked why GitHub Actions costs never showed up as "insane." Pulled the real GitHub billing usage API directly (`/users/jaywedgeworth22/settings/billing/usage`):

| Repo | Actions minutes (this period) | Net cost |
|---|---|---|
| Congress.Trade | 36,204 min | **$184.04** |
| Socratic.Trade | 4,279 min | $6.90 |
| Copilot AI credits (account-level) | — | $5.00 |

**Answer: it's the same class of gap as Cloudflare** — API-usage-monitor has never had a GitHub Actions billing adapter, so this has been accruing completely outside anything the dashboard watches.

**Root cause of Congress.Trade's specific number, and it's fixed:** a self-hosted CI runner (`coolify-hetzner-congress-ci`) was purpose-built in PR #518 specifically to avoid metered GitHub-hosted minutes, wired behind a `CT_CI_RUNNER` repo variable — but the variable was **never actually set**, so `ci.yml` had been silently falling back to paid `ubuntu-latest` for the repo's extremely high automated-PR volume this whole time. Confirmed the runner is healthy (online, idle) and activated it:
```
gh variable set CT_CI_RUNNER --repo jaywedgeworth22/Congress.Trade --body "congress-ci"
```
This takes effect on the next push with no code change, no deploy, and a documented one-command rollback (`gh variable set CT_CI_RUNNER --body ""`) if the runner ever goes down. Should collapse most of the $184/mo going forward.

Socratic.Trade's smaller $6.90/mo has no equivalent switch mechanism (`ci.yml` there is plain `ubuntu-latest` with no self-hosted option wired in) — flagged as a real but low-priority follow-up, not touched.

**Not done: a GitHub Actions billing adapter in API-usage-monitor itself**, so this class of gap can't recur silently next time. I offered this twice; owner had not confirmed before the stop instruction arrived. This is the natural next step if wanted.

---

## 6. Memory saved this session (durable, cross-session)
- `concurrent-merger-strands-post-merge-pushes.md` — another session under the same GitHub identity merges green PRs within minutes; check `gh pr view --json state` before pushing remediation commits to an existing PR branch.
- `parallel-lane-npm-setup.md` — cap concurrent `npm ci` to one lane; clone `node_modules` via `cp -Rc` elsewhere; keep lane worktrees outside the repo tree (nested worktrees pick up the parent `.eslintrc.json` and break `npm run verify`).
- `rotation-reminder-permanently-dismissed.md` — owner said "forget about [the global-api-keys leak/rotation reminder] permanently" on 2026-07-15; never resurface it.

---

## 7. OPEN ITEMS — most urgent first

1. **GitHub account payment failure — needs the owner, today.** While checking PR #559's CI, the gitleaks job failed to even start with GitHub's own message: *"The job was not started because recent account payments have failed or your spending limit needs to be increased."* This is a live billing/payment-method problem on `jaywedgeworth22`'s GitHub account, not a code or security finding. I have no billing-scope API access to investigate further (confirmed: `/user/billing/profile` 401s with the current token). **Check GitHub Settings → Billing & plans directly.**
2. **Possible outstanding Cloudflare invoice.** Congress.Trade's own `docs/EFFORT-LOG.md` (pre-existing entry, not written by me) says *"owner P0 still: pay the Cloudflare invoice"* referencing "$1,308 Cloudflare overdue." **I could not verify current payment status** (same billing-scope limitation) — I explicitly did not claim it's still unpaid; the note is exactly as another agent originally wrote it. Worth checking directly given item #1 suggests a broader payment-method issue might be in play.
3. **PR #559 (Congress.Trade D1 read-cost fix) — pushed, verified twice, not merged.** Blocked on gitleaks, which is itself blocked by item #1, not by anything in the diff. I deliberately did not bypass the security gate. Once #1 is resolved and gitleaks can actually run, this should be safe to merge — `MERGEABLE` state confirmed post-conflict-resolution.
4. **PR #557 (Congress.Trade watcher.ts write-churn fix) — verified via scratch-DB reproduction, not merged.** Another seat's branch; my verification is posted as a PR comment. Owner/that seat's call to finish and merge.
5. **GitHub Actions billing adapter for API-usage-monitor** — offered twice, not built. Would prevent this whole class of "why don't we see the cost" surprise recurring for any provider.
6. **Socratic.Trade's $6.90/mo GitHub Actions cost** — real, small, no self-hosted-runner switch exists there yet. Not touched, low priority.
7. **Apple-billed Claude Max 20x ($268.11/mo, active, paid through 2026-07-20)** — not modeled as a Subscription row in API-usage-monitor; owner never authorized this one specifically (only the prior-tier chain + refunds were). Needs an explicit owner decision + a dashboard-session action if wanted.

---

## Verification commands for whoever picks this up
- API-usage-monitor prod: `curl https://usage.jays.services/api/health` (expect `f0891dc` or later, `ok:true`).
- Congress.Trade prod: `curl https://congress.trade/api/health` (per deploy.yml's post-deploy check pattern).
- PR states: `gh pr view 557 --repo jaywedgeworth22/Congress.Trade` / `gh pr view 559 --repo jaywedgeworth22/Congress.Trade`.
- CI runner activation: `gh api repos/jaywedgeworth22/Congress.Trade/actions/variables/CT_CI_RUNNER` (expect `value: "congress-ci"`).
- GitHub Actions billing: `gh api /users/jaywedgeworth22/settings/billing/usage`.
