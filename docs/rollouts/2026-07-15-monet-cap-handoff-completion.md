# Rollout: MONET completion of the 2026-07-15 CLAUDE cap handoff

**Seat:** MONET (owner-directed pickup of `docs/rollouts/2026-07-15-pickup-codex-cap-handoff-to-monet.md`)
**Date:** 2026-07-15
**Coordination:** #ag***-s**c `[MONET->FLEET] sync-1` claim; live-board In Progress row under CLAUDE's handoff row.
**Owner mid-run directives honored:** "integrate (if appropriate)" the two novel-content residues; "fix all P0, P1, P2, and P3."

## Outcome summary — every handoff queue item is closed

### 1. Anthropic receipt reconciliation (§2.4) — ALREADY APPLIED to prod; verified; no action needed
Live `/api/budget-status` (read-token GET) shows canonical Anthropic provider
`45b10ffc-684e-465d-822d-f3839c78c456` with `receiptCashPaidUsd: 63.96`, `receiptCashEventCount: 3`.
The owner-staged input `/Users/jay/.secrets/anthropic-api-receipts.json` (chmod 600, mtime 3 minutes
after PR #271 merged) holds exactly 3 × $21.32 July `api_prepaid_funding` purchases = $63.96, and an
offline dry-run reproduced `receiptCount: 3, totalUsd: 63.96` for that provider. Someone ran
`--apply` right after the merge without leaving a board receipt — this note is that receipt after
the fact. The owner authorized dry-run→apply; the re-apply was skipped as redundant (data already
present and exact; a re-run only proves idempotency while risking double-count iff the identity key
had rotated).

### 2. July-4 review-batch partials — all three closed, plus all review findings of every severity
| PR | Merge | Content |
|---|---|---|
| #300 | `0ed5436` | `UsageSnapshot @@index([providerId, fetchedAt])` (schema-only; `prisma db push` startup path is the migration). Review: LAND, zero findings, incl. an end-to-end deploy simulation proving the index is created and used by the dominant query plan. |
| #301 | `5a6a8a7` | Auth trio: login limiter off spoofable leftmost XFF (tuple keying + backstop + record-on-failure-only), session HMAC key HKDF-derived (optional `DASHBOARD_SESSION_SECRET`; one-time session invalidation), constant-time `CRON_SECRET` compare. No new REQUIRED env vars. |
| #306 | `ab47923` | Dashboard 60s background poll (no loading flash), focus/visibility refetch throttled 15s, paused while hidden, overlap guard; P2 (background polls blanked the warnings banner) fixed pre-merge. |
| #307 | `bd5af33` | Salvaged admission-release regression test (see §4). |
| #314 | `3c9a213` | P2 from #301 re-review: in the real Cloudflare→Render topology the per-hop backstop collapsed to Cloudflare's shared egress IP — ~4 CF-proxied attackers could 429 the owner's correct-password login. Fixed via `cloudflare-ip-ranges.ts` CIDR trust check keying the backstop per CF-Connecting-IP for genuine CF traffic, per-peer otherwise. Includes the P3 comment/test-coverage corrections. (#301's merge stranded this fix on the closed branch; cherry-picked and re-landed.) |
| #315 | `8a0ad7f` | P3 on #307: try/finally guard so a failed assertion can't leave the mocked fetch/delivery promise pending. |
| #316 | `8a6fee1` | P3 on #306: manual Refresh/Retry during an in-flight background fetch now "upgrades" it (refreshing/loading feedback + foreground clear semantics) instead of silently no-opping. |

Every finding raised by the adversarial reviews — one P2 + two P3 (auth), one P2 + one P3
(dashboard), one P3 (salvaged test) — is fixed and merged. All PRs passed local full
`npm run verify` plus hosted verify/gitleaks/CodeQL.

With CLAUDE's 13 pre-verified FIXED items, **all 16 verified high-value July-4 review items are
resolved.**

### 3. Residue + worktree cleanup — registry 74 → 42-ish, everything archived first
- 20 census-verified clean+merged worktrees removed (fresh `git status --porcelain` +
  `git cherry origin/main` recompute immediately before each removal); 3 handoff-named superseded
  residues force-removed after tracked/untracked diff archives + branch bundles; 2 worktrees with
  identical spurious root-file deletions (LICENSE/litestream.yml/next.config.js/render.yaml)
  restored via checkout, re-verified merged-equivalent, then removed.
- Archives: `/Users/jay/apps/backups/worktree-prune-2026-07-15/` (25+ artifacts: patches, untracked
  tarballs, branch bundles). Local branches deleted only after bundling; **no origin refs touched,
  no codex/* pushes.**
- Superseded scheduler residues `4fa4176` / `22dc8a8` were confirmed inferior to main's landed
  #251/#253 admission implementation and deleted per the handoff (bundles retained).
- ~28 clean-but-unmerged worktrees (other seats' unlanded lanes) were deliberately NOT pruned —
  per-lane disposition belongs to the separate post-Codex/AG evaluation handoff row.

### 4. The two overturned "superseded" verdicts — both integrated appropriately
Independent re-verification overturned CLAUDE's expectation on two residues:
- **Admission-release regression test** (uncommitted in the CODEX scheduler worktree): genuinely
  novel coverage; adapted to main's delegate-wrapping admission architecture and landed as **PR
  #307** (test-only, CODEX lane credited), hardened by #315.
- **Claude receipt evidence** (hardcoded in the predecessor reconcile script, branch
  `codex-anthropic-receipt-import` 7964785): recovered from its bundle and preserved to
  **`/Users/jay/.secrets/claude-subscription-receipts-2026-07-15.json`** (chmod 600) with
  provenance + disposition notes. Money state: the 3 API-credit purchases are already applied as
  receipt cash; the Anthropic-billed subscription chain (Pro $21.32 + Max 5x $85.30 + Max 20x
  $106.98 = $213.60) is already modeled — prod `subscriptionMonthToDateUsd` matches to the cent.
  **Not imported as receipt cash by design**: the merged importer only accepts
  `kind=api_prepaid_funding`, and subscription cash would double-count the modeled subscriptions.
  **Open owner decision:** the Apple-billed chain is NOT modeled — notably the active Claude Max
  20x Monthly at **$268.11 paid through 2026-07-20**. If that family spend should be tracked, add
  it as a manual Subscription in the dashboard (session-authed write; not something an agent does).

## Production verification
Baseline at pickup: `36e6ac6`, health ok, ready 200. Mid-run: live at `016ee7d` (all four original
PRs deployed). Final main head after this lane: `8a6fee1` (#316). Render auto-deploys each main commit; final live-revision check recorded on the live effort board.

## Notes for the fleet
- A concurrent session under the same GitHub account merged green PRs within minutes throughout
  this run (#301/#306/#307 merged mid-workflow; also landed #305, #309–#313). Check
  `gh pr view --json state` before pushing remediation commits to a PR branch.
- OPEN OWNER ACTION (pre-existing, board line ~224): a CODEX session earlier leaked secret lines
  from `/Users/jay/.secrets/global-api-keys` into a shell transcript — rotate the Usage Monitor
  admin/ingest credentials (and consider the `BILLING_RECEIPT_*` trio) when convenient.
