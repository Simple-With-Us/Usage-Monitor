# Closeout: CODEX cap-pickup handoff — MONET execution (2026-07-15)

**Seat:** MONET (second session on this handoff; split coordinated on #ag***-s**c ts 1784141677)
**Handoff executed:** `docs/rollouts/2026-07-15-pickup-codex-cap-handoff-to-monet.md` (committed to the repo in the same PR as this note — it previously existed only as an untracked file on the `cursor` checkout)
**Owner directive:** complete the work CLAUDE left at the handoff note, using a team of subagents.

---

## 1. Session-split context (why two MONET sessions touched this lane)

The first MONET session claimed the full handoff queue on #ag***-s**c (sync-1, ts 1784139702)
and was actively mid-flight on the three review-batch fix lanes when this second session was
spawned by the owner on the same handoff. To avoid a repeat of the same-day Socratic.Trade
adopt-commit collision, this session posted a split (sync-2, ts 1784141677):

- **First session (zen-tereshkova) kept:** the three review-batch fix lanes.
- **This session executed:** Anthropic receipt `--apply` disposition (read-only), superseded
  residue/worktree cleanup, and this closeout. Both of this session's workstreams ran as
  parallel subagents.

## 2. Review-batch fix lanes (owned by the first MONET session) — state at closeout

| Lane | Branch | State |
|---|---|---|
| `UsageSnapshot @@index([providerId, fetchedAt])` | `monet/usagesnapshot-provider-fetchedat-index` | **MERGED PR #300** → main `0ed5436` (schema-only; deploys via `migrate-safe.mjs` `prisma db push`, additive index) |
| Auth hardening trio (rightmost-XFF trust + global login-limiter backstop; HKDF session-key derivation with optional `DASHBOARD_SESSION_SECRET`, password fallback — no new required env var; hash-then-`timingSafeEqual` for `CRON_SECRET`) | `monet/auth-hardening-trio` | **PR #301 open**, checks green at closeout |
| Dashboard auto-refresh (60s background poll, hidden-tab skip, throttled focus/visibility refetch, overlap guard, no loading flash) | `monet/dashboard-auto-refresh` | WIP in first session's worktree (diff reviewed read-only by this session — sound) |

This session reviewed both in-flight diffs read-only and found no defects; no cross-session
flags were needed.

## 3. Anthropic receipt `--apply` disposition — RESOLVED (read-only): already applied

The handoff's §2.4 open question was whether the merged importer
(`scripts/import-private-billing-receipts.mjs`, PR #271) was ever executed with `--apply`
against production. **It was.** Evidence (full detail in the subagent report):

- Production probe `GET /api/budget-status` (Bearer read token, 18:57:32Z): the live Anthropic
  provider reports **`receiptCashPaidUsd: 63.96`, `receiptCashEventCount: 3`**.
- `receiptCashIdentity()` (`src/lib/receipt-cash.ts`, introduced by PR #271) only counts rows
  with the importer's narrow HMAC-fingerprinted shape (`sourceApp: "billing-receipt-import"`,
  `keyRef: provider:<uuid>:billing-receipt:<64-hex-hmac>`, …). Nothing else in the app can
  produce such rows, and the field did not exist before PR #271 merged (05:30 CDT).
- The dollar/count totals match the receipts fixture the superseded CODEX lane smoke-tested
  against a disposable SQLite (3 events / $63.96), i.e. the same real receipts were later run
  through the merged importer for real. The private input exists at
  `~/.secrets/anthropic-api-receipts.json` (mode 600, mtime 05:33 CDT — minutes after the PR
  #271 merge). Contents were never read or printed.
- The importer's ingest route requires `BILLING_RECEIPT_INGEST_TOKEN` /
  `BILLING_RECEIPT_IDENTITY_KEY` / `BILLING_RECEIPT_HMAC_KEY`, all `sync: false` in
  `render.yaml` — so those three secrets were also already provisioned manually on Render.

**Traceability gap (owner FYI):** no board row, rollout doc, commit, or shell history records
who ran the apply. Nothing suggests it was wrong — the data is idempotency-keyed and matches
the known receipts — but nobody has done row-level verification of the 3 events
(`/api/usage-events` needs dashboard-session auth, out of this session's credential scope).
Re-running the importer with the same input is a safe idempotent no-op; the dry-run/apply
runbook is in the script's docblock and in the subagent report.

**No prod writes were made by this session.**

## 4. Residue/worktree cleanup — DONE (archive-first)

Backups (git bundles, dirty-tree diffs, untracked-file tars) + `manifest.md`:
`/Users/jay/apps/backups/worktree-prune-2026-07-15/`.

- **Removed, worktree + local branch (handoff §3 named residues, after novelty checks):**
  `codex-anthropic-receipt-import` (7964785; superseded by PR #271's importer) and
  `codex/scheduler-admission-current-main` (dirty; superseded by PR #251/#253's reentrant
  admission lease). Remote refs untouched.
- **Verified pre-completed by a predecessor session:** the other two §3 residues
  (`api-usage-monitor-infisical-provider-sync`, `api-usage-monitor-scheduler-admission`) were
  already archived + removed; archives confirmed present in the backup dir.
- **Removed, worktree only (branches kept for the eval-sweep content audit):** 10
  content-merged squash lanes — merged PRs #91, #284, #214, #275, #199, #168, #181, #277,
  #293, #211.
- **Left REPORT-ONLY (no removal):** 5 dirty worktrees (`alert-persistence-corrective`,
  `alert-summary-tag`, `litestream-emergency-disable`, `readiness-grace`, `render-readiness`)
  and 17 clean worktrees whose branches have unique commits but no PR trail — handed to the
  eval-sweep MONET lane's 105-branch disposition audit.
- **Hard exclusions untouched:** CODEX's ACTIVE `cloudflare-explicit-renewal-handoff`
  worktree/branch, every lane on the eval-sweep coordination list, locked worktrees, running
  sessions' worktrees, and the dirty `cursor` main checkout.
- **Anomaly for the record:** `api-usage-monitor-scheduler-gate` (dirty) vanished mid-session
  without any action from this lane — some concurrent process removed it; its local branch
  remains. Also, two empty duplicate branches this session briefly created before discovering
  the sibling's lanes (`monet/usage-snapshot-index`, `monet/auth-hardening`) were deleted with
  zero commits lost.

Full disposition table: see `manifest.md` in the backup dir (same content was posted with the
closeout).

## 5. Verification commands actually run

- `curl https://usage.jays.services/api/health` → `ok:true, status:live` (revision tracked
  main throughout); `/api/ready` → HTTP 200.
- `gh pr list --state open/--state merged` before claiming, before splitting, and at closeout
  (receipts for #300 merged / #301 open).
- `git merge-base --is-ancestor`, `git cherry origin/main <branch>`, and
  `gh pr list --head <branch> --state merged` per pruned worktree (recorded in manifest).
- Read-only diffs of the sibling session's `auth-hardening` / `dashboard-auto-refresh` trees.
- `GET /api/budget-status` authenticated probe for the receipt verdict (token loaded via shell
  substitution only; never printed).

## 6. Follow-ups

1. **PR #301 + the auto-refresh PR** — first MONET session lands these; adopt per pickup-seat
   protocol only if that session caps out (standing offer posted on #ag***-s**c).
2. **Eval-sweep MONET lane** — owns dispositioning the 22 REPORT-ONLY worktrees/branches and
   the broader board/mirror reconciliation.
3. **Owner decision (low priority):** whether to do row-level verification of the 3 applied
   receipt events, and whether future receipt applies should require a logged board entry
   (recommended).
