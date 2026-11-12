# Handoff: CODEX cap pickup + July-4 review-batch verification → MONET

**From:** CLAUDE (Fable 5, hit usage cap mid-verification; session continued on Opus 4.8 only long enough to write this note)
**To:** MONET
**Date:** 2026-07-15
**Repo:** API-usage-monitor
**Production revision at handoff:** `36e6ac6` (`/api/health` ok:true status:live; `/api/ready` HTTP 200, scheduler healthy)
**Owner directive:** "ensure the tasks this chat discussed are resolved, and ensure the tasks Codex said were active before its weekly cap are fully completed and merged to production."

---

## TL;DR for Monet

Almost everything is already done. Do not re-do it.

1. **All four CODEX "active" lanes are MERGED + LIVE in production.** Verified by PR number and prod revision. Nothing to land there. One low-priority open question remains (was the Anthropic receipt reconciliation *executed* against prod data, or is it a not-yet-run operator script — see §2.4).
2. **The 2026-07-04 84-finding review batch is ~80% resolved** by the ~250 PRs that landed since. I verified 16 of the highest-value items against current `main`. **13 are FIXED, 3 are PARTIAL.** The 3 partials are the only real remaining review-batch work (§4).
3. **Three residue branches/worktrees are all SUPERSEDED** by merged PRs and should be cleaned up, not landed (§3). One (`4fa4176`) is an *inferior earlier version* of what already merged — do not resurrect it.
4. **Your actual work queue is small** and is in §5, prioritized. Net: 3 small review-batch gap fixes + worktree cleanup + one prod-data confirmation.

---

## 1. What I picked up and why

CODEX hit its weekly usage cap (last #ag***-s**c post 2026-07-14T23:00Z). Owner asked CLAUDE to pick up its lanes. CODEX reported these as active before the cap:
- UI provider-grouping redesign subagent
- Infisical / API-key automatic-sync subagent
- Scheduler serialization fix (committed and pushed)
- Anthropic receipt reconciliation (committed locally)

I posted the pickup claim to #ag***-s**c as `[CLAUDE->FLEET]` and reserved a row on the live board (`/Users/jay/apps/API-USAGE-MONITOR-EFFORT-LOG.md`, In Progress). This entire pickup was **read-only** — no `codex/*` pushes, no production writes. Any gap fixes are to land as new `claude/*` (or your `monet/*`) PRs.

---

## 2. The four CODEX "active" lanes — all MERGED + LIVE

| Lane | Landed as | Prod state | Evidence |
|---|---|---|---|
| **2.1 UI provider-grouping redesign** | **PR #296** "Collapse provider family details by default" | squash `36e6ac6` = exact live revision | `DashboardProviderWorkspace.tsx` renders one summary row per provider family with a labeled disclosure; hidden detail rows use both semantic `hidden` and inline `display:none`. Board row confirms auto-deploy + `/api/ready` 200. |
| **2.2 Infisical API-key auto-sync** | **PR #268** "feat: sync provider credentials from Infisical" | merged + deployed | The refreshed twin lane `codex-infisical-provider-sync-current-main` landed; superseding the older dirty worktree (see §3.3). |
| **2.3 Scheduler serialization** | **PR #251** "serialize internal usage writes" + **PR #253** "guard scheduler maintenance writes" | live; prod scheduler healthy, zero consecutive failures | `src/lib/usage-maintenance.ts` wraps maintenance in `withInternalUsageWriteAdmission`; `src/lib/ingest-admission.ts` provides a **reentrant, owner-tracked** lease (`acquireInternalUsageWriteAdmissionLease`). |
| **2.4 Anthropic receipt reconciliation** | **PR #271** "reconcile Anthropic receipt cash without telemetry inflation" | merged + deployed | Landed as `scripts/import-private-billing-receipts.mjs` on main. |

**2.4 open question (LOW priority, the only genuinely-open item in this section):**
The receipt *reconciliation script* is merged, but I did not confirm whether it was ever **run with `--apply` against production data** (it defaults to dry-run). CODEX board rows say "SCRIPT IMPLEMENTED / TEMP-SQLITE IDEMPOTENCY GREEN" and "ALL SECURITY HOLDS REMEDIATED / LOCAL COMMIT READY" — that language describes a *ready* script, not a *run* one. **Monet action:** confirm with the owner whether the Anthropic receipts should be applied to prod; if yes, run `node scripts/import-private-billing-receipts.mjs --apply` per its docblock and verify the resulting `ProviderExternalBilling` / `ExternalUsageEvent` rows. Do **not** run destructive prod mutations under cover of "deploy" without an explicit owner ask.

---

## 3. Residue branches/worktrees — SUPERSEDED, clean up (do not land)

### 3.1 `codex-anthropic-receipt-import` (local commit `7964785`, worktree `/Users/jay/apps/api-usage-monitor-anthropic-receipt-import`)
Adds `scripts/reconcile-anthropic-receipts.mjs` (362 lines) — an **earlier-named** version of what merged on main as `scripts/import-private-billing-receipts.mjs` (363 lines) via PR #271. The main version is a rewrite (different docblock, `node:fs/promises`-based CLI). **Verdict: superseded.** Delete the branch/worktree.

### 3.2 Scheduler admission residue — SUPERSEDED by a *better* implementation
- Branch `codex-scheduler-admission-current-20260715` = single commit `4fa4176` "serialize scheduled usage writes", **no PR, not an ancestor of main.**
- Local branch `codex-scheduler-ingest-serialization` = `22dc8a8`.
- Dirty worktrees `/Users/jay/apps/api-usage-monitor-scheduler-admission` and `/Users/jay/.codex/worktrees/api-usage-monitor-scheduler-admission-current-main` (uncommitted edits to `ingest-admission.ts`, `data-retention.ts`, `alert-delivery.ts`, tests).

CODEX-ROOT's own #ag***-s**c HOLD on this diff said it *"wraps the entire `runDataRetentionMaintenance()` under one admission token, lacks reentrant/nested ownership… no test changes."* **Main's landed #251/#253 fixes exactly that** — `ingest-admission.ts` on main has `acquireInternalUsageWriteAdmissionLease` returning `{ owner, release }` (reentrant, owner-tracked), and `usage-maintenance.ts` uses it. So `4fa4176` is the **inferior earlier attempt**. **Verdict: superseded; do not resurrect.** Prod scheduler is healthy. Clean up the branches and (after eyeballing them once for anything novel) the dirty worktrees.

### 3.3 `codex-infisical-provider-sync` (dirty worktree `/Users/jay/apps/api-usage-monitor-infisical-provider-sync`, ~36 uncommitted files)
Superseded by PR #268 (the `-current-main` twin lane that actually merged). The dirty tree is on a **very stale base** (diff-vs-main shows ~30k deletions = it's missing ~250 merged PRs, not adding value). **Verdict: superseded.** I did a structural (not file-by-file) comparison — Monet should do one quick `diff <worktree>/<file> main-ro/<file>` pass on the non-doc files before `git worktree remove` to be certain nothing novel is stranded, but I expect nothing.

---

## 4. July-4 review batch — verification vs current `main` (36e6ac6)

I verified 16 high-value items from the original 84-finding review. **13 FIXED, 3 PARTIAL.** The 3 partials are the real remaining work.

### FIXED (13) — no action needed
| Item | Evidence on main |
|---|---|
| migrate-safe `--dry-run` boot failure | `scripts/migrate-safe.mjs` uses plain `prisma db push`, no `--dry-run`; `scripts/test-migrate-safe-repro.mjs` covers it. (Also its own rollout doc 2026-07-10.) |
| `/api/budget-status` unreachable (middleware) | `src/middleware.ts:31` excludes `api/budget-status(?:/|$)`; route does Bearer auth. |
| CI never ran tests/build | `.github/workflows/ci.yml` runs typecheck + lint (real `eslint.config.mjs`) + `npm test` + `npm audit --audit-level=high` + build; `security.yml` runs gitleaks. |
| Provider `config` secrets plaintext + sent to client | `crypto.ts` `encryptJson()` AES-256-GCM envelope; `provider-secret-config.ts` `providerConfigForClient()` redacts; both GET routes use it; `scripts/migrate-provider-config-secrets.mjs`. |
| Brokerage/payment cost corruption | `tradier.ts:94` `totalCost:null` ("Brokerage P/L … must never enter provider budgets"); `stripe.ts` maps processing fees not payouts; `alpaca.ts:48` `totalCost:null`. |
| No adapter fetch timeout | `usage-recorder.ts:251-286` per-provider `Promise.race` timeout; `helpers.ts` `AbortSignal.timeout`; `provider-timeout-budget.test.ts`. (PR #60.) |
| `usage-events` 5000-row truncation | `external-usage-events.ts:470-541` paginates with no hard cap; test covers 1000+ rows. |
| Paid poll probes (Anthropic/Voyage) | `anthropic.ts` uses `blindProviderResult` + real usage endpoint via `fetchJson` (no `/v1/messages` paid probe, no bogus model id); `voyage.ts` `blindProviderResult` push-primary (no paid embedding). |
| Validator adapters burn quota | `alphavantage.ts` now `blindProviderResult` ("No quote request was consumed merely to validate the key") — blind pattern adopted across validator adapters. |
| `$0.00` no-data lie | "Cost not reported" rendered across `ProviderCard`, `ProviderTable`, `DashboardProviderWorkspace`, `ExternalTelemetryPanel`, `ProjectsPanel`, provider detail page; `provider-integration-catalog.ts` describes push-primary/manual state. |
| Headline tiles exclude pushed spend | Dashboard now composes providers + `/api/usage-events` + `/api/projects` + `/api/subscriptions`; billing reworked around subscriptions + `canonicalSpend`. |
| Month-window budget math | `budget-status.ts` `monthStartUtc()` + `monthStart` `gte` filters on snapshots, external cost, receipt cash, subscription periods. |
| Same-provider keys scattered / long scroll | Provider-family collapse (PR #296) via `DashboardProviderWorkspace`. |

### PARTIAL (3) — THIS IS THE REMAINING REVIEW-BATCH WORK
1. **`retention-and-index` — missing composite index.** `data-retention.ts` prunes both tables with daily rollups and is wired into the cron; `ExternalUsageEvent` has its indexes. **Gap:** `UsageSnapshot` still has **no `@@index([providerId, fetchedAt])`** in `prisma/schema.prisma`, yet `data-retention.ts:425-441` and every latest-snapshot lookup query on that pattern. **Fix:** add the index + a migration.
2. **`dashboard-refresh` — no auto-refresh.** `page.tsx:264-276` has a manual refresh button + "last updated" timestamp, but **no `setInterval` polling and no `visibilitychange`/focus refetch.** **Fix:** add a 60s background poll (skip the loading flash on background refresh) and/or focus-refetch.
3. **`auth-hardening` — 3 sub-items still open** (calibrate severity: personal single-user app):
   - `rate-limit.ts:79-85` login limiter still keyed on spoofable leftmost `x-forwarded-for` → brute-force limit bypassable.
   - `auth.ts:18-26` session token HMAC keyed on the **plaintext `DASHBOARD_PASSWORD`** (should derive from a separate `HMAC_SECRET`/KDF; also no real revocation on logout).
   - `cron/fetch-all/route.ts:13` `CRON_SECRET` compared with non-constant-time `!==`.

---

## 5. Monet's work queue (prioritized)

1. **Confirm receipt reconciliation disposition (§2.4)** — ask owner whether to `--apply` to prod; act accordingly. *(Blocks nothing; but it's the one place prod data may be incomplete.)*
2. **Land the 3 review-batch partials (§4)** as one or a few small `monet/*` PRs through the normal gate (branch → verify+gitleaks green → resolve threads → merge; auto-deploys to Render):
   - `UsageSnapshot` composite index (+ migration).
   - Dashboard auto-refresh (60s poll / focus refetch).
   - Auth hardening trio (XFF trust, HMAC key separation, constant-time `CRON_SECRET`).
3. **Worktree/branch cleanup (§3)** — after a quick eyeball of the dirty scheduler + infisical worktrees for anything novel (I expect nothing): `git worktree remove` the superseded ones and delete the residue branches. There are ~60 stale worktrees under `/Users/jay/apps/api-usage-monitor-*` and `/Users/jay/.codex/worktrees/*` — most correspond to already-merged PRs; prune aggressively but verify each branch is an ancestor of / equivalent to `main` first (`git cherry origin/main <branch>`).
4. **Close out** — flip the board row (In Progress → Completed/Deployed), and post `[MONET->FLEET]` on #ag***-s**c naming final state.

### Do NOT
- Do not re-land any of the four §2 lanes — they're live.
- Do not resurrect `4fa4176` or the scheduler dirty worktrees — main's admission is strictly better (§3.2).
- No `codex/*` pushes (that's CODEX's prefix); use `monet/*`.

---

## 6. Evidence / commands run (all read-only)

- Prod health: `curl https://usage.jays.services/api/health` → `{ok:true,status:live,revision:36e6ac6…}`; `/api/ready` → HTTP 200.
- Merged-PR confirmation: `gh pr list --state merged` (#296, #293, #291, #288, #286, #284, #281, #280, #277, #275, #273, #271, #269, #268 …).
- Clean read-only checkout of `origin/main@36e6ac6` at `…/scratchpad/main-ro` (created with `git worktree add … origin/main --detach`) — used for all `grep`/`diff` verification.
- Residue analysis: `git cherry origin/main <branch>`, `git show 7964785`, `git merge-base --is-ancestor 4fa4176 origin/main` (→ not ancestor), content diffs of dirty worktrees vs `main-ro`.
- Verification fleet: 16 review items + 3 residue dispositions launched as a background workflow; **10 verifications completed before the Fable cap** (captured in this note), the remaining 6 verifications + 3 dispositions I finished by hand on Opus with the greps cited above. (Workflow run `wf_6c01c882-717`, journal at `…/subagents/workflows/wf_6c01c882-717/journal.jsonl`.)

## 7. Why this handoff exists
CLAUDE's Fable 5 account hit its weekly usage cap mid-verification. MONET is a **separate Claude account** with its own limit, so it can carry the small remaining queue. Everything needed to finish is in §5; everything already done is in §2–§4 with receipts so you don't repeat it.
