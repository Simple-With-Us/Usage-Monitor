# 2026-07-15 — MONET pickup of CLAUDE cap handoff: eval sweep + landing batch

**Seat:** MONET (owner-directed pickup; handoff note `/Users/jay/apps/HANDOFF-usage-monitor-eval-CLAUDE-to-MONET.md`, claim transfer ts 1784139104.063869 → MONET claim + landing plan posted to #ag***-s**c with objection window, expired clean.)

## What the audit found (25-agent read-only workflow, wf_1c715807-1c5)

All **105 unmerged branches** dispositioned content-level vs main `36e6ac6` (squash-aware):
**71 CONTENT_MERGED / 17 SUPERSEDED / 10 STALE_ABANDONED / 7 UNLANDED_VALUABLE / 0 UNKNOWN.**
Full table: `docs/audits/2026-07-15-branch-dispositions.md` (this PR).

Key corrections to the handoff's assumptions:
- Every "COMPLETE locally / root landing pending" CODEX candidate was **already merged by CODEX-root** the same morning (#258 #268 #269 #271 #273 #280 #281 #284) — the board rows were stale, not the work.
- The `codex/external-billing-subscription-adoption` **HOLD was stale**: its P1 was remediated, re-reviewed, merged as PR #284, and is live.
- `quiver.ts` untracked in the main checkout is CODEX work (commit `31fe725`), not CURSOR's.

## Landed this session (all: monet/* branch → PR → hosted verify+gitleaks → 0 unresolved threads → squash; merge==live via Render auto-deploy)

| Lane | PR | Merge | What |
|---|---|---|---|
| A1 fintechstudios alias | #302 | `4a758de` | Un-orphans live ST FinTech Studios telemetry (P1 data loss) |
| A4 brand rename | #303 | `19c1175` | Agentic Trading → Socratic Trade (from parked `claude/budget-status` e4dc008) |
| B2 subscription hardening | #305 | `9c9b38d` | Strict boolean autoRenew; thead a11y (from CODEX `residual-audit-hardening`, co-authored) |
| A2 scheduler degraded signal | #309 | `28a69ef` | `provider_fetch_degraded` readiness reason — closes the masked-83%-poll-failure P1 |
| A3 quiver provider | #310 | `c88449f` | Registers Quiver Quantitative blind provider (completes CODEX stub, co-authored) |
| B1 bounded ingest body | #311 | `0bec30f` | Streaming 4 MiB cap + 413 on /api/ingest/usage (P1 security; from CODEX `residual-security-hardening`, co-authored) |
| A5 dark-mode modals | #319 | `30c6763` | Dark-mode support for all modals/drawer/login (P1 UX) |
| B3 maintenance scripts | #313 | `016ee7d` | Transactional secret migration + scoped cost repair (from CODEX `maintenance-script-hardening` b84d340, co-authored; fixes serviceAccountJson classifier parity gap) |

CI notes: #305 hosted verify flaked once on the known transient Prisma-import failure — passed on its one authorized rerun. #312 hit a CI dispatch miss (zero runs on initial push) — retriggered with an empty commit.

## Deliberately NOT landed (parked with board rows)

- `codex-integration-transparency-hardening` — big; predates Next 16 + schema drift; needs full rebase + re-verify (Planned).
- `codex-app-wide-hardening` trailing commits — money-path subscription materialization gate; **ASK_OWNER**.
- `codex-request-window-correctness` — narrow rebuild recommended (Planned).
- Safari extension scaffold (`codexfix-current-screenshot-image` + untracked copy in main checkout) — same lineage as the PR #106→#107 **security revert**; **ASK_OWNER**. The untracked copy in `/Users/jay/Code/API-usage-monitor` should not be re-staged without that decision.
- Favicon/nav brand colors — CODEX WIP per board; keepout.
- `ag/browser-sync-extension` + `ag/safari-extension` — merged-then-reverted for security; DO_NOT_LAND.

## Production verification

Prod healthy on the post-batch revision (`/api/health` ok, `/api/ready` ok, scheduler healthy; deploy chain produced brief 502 restart blips per merge — single-instance Render behavior, each recovered in <1 min).
**Expected new signal:** `/api/ready` `scheduler.providerFetchDegraded` will latch `true` within ~3 ticks — prod genuinely has 5 of 6 attempted provider polls failing; the new signal makes a previously invisible outage visible. **Follow-up Planned row: diagnose the 5 failing providers.**

## Board & coordination

- 12 stale In Progress rows moved to Deployed with receipts; 4 missing rows added (#266 #267 #208 #263); 14 Planned rows filed from eval findings; mirror synced (this PR).
- Fixed a live-board line-concatenation defect (two rows merged into one line; both restored).
- Sibling MONET sessions (cap-pickup + zen-tereshkova) ran in parallel with clean scope separation throughout; their lanes (#300 #304 #306 #307 #301) are theirs.
- CODEX board hygiene verdict from audit: stale (9+ merged lanes still under In Progress — now corrected); AG hygiene: partial (2 missing rows — now added).

## Open items for the owner (also in final report)

1. **Credential rotation P1**: board records an accidental secret-print of `/Users/jay/.secrets/global-api-keys` lines; Usage Monitor admin/ingest credentials should be rotated (coordinate ST/CT sender tokens). Also confirm PR #107's older rotation advice (browser-sync ingest token) was ever acted on.
2. **Safari extension**: decide whether the scaffold (reverted-for-security lineage) should ever ship; until then the untracked copy in the main checkout should not be committed.
3. **Subscription materialization gate** (codex-app-wide-hardening trailing commits): money-path; wants explicit GO.
4. **Receipt `--apply`**: owned by the sibling cap-pickup session; prod apply stays owner-gated.
5. **ST/CT integration end-state**: ST is substantially integrated (pushed priced telemetry + budget feedback + bridge contract-compatible; bridge activation needs only the two Infisical identity pairs). CT pushes telemetry correctly but **never reads /api/budget-status** — no self-throttle loop (Planned row, CT-side work). quota_sync/credit_balance receiver (PR #90) still has zero producers — wire or park.

## Addendum: provider poll outage — diagnosed and resolved same-session (owner-directed)

Live-probed every stale provider via authenticated `POST /api/providers/{id}/fetch`. The tick's 5 failures:
- **tradier** — APP BUG, FIXED (PR #320 `e82766a`): epoch-ms `x-ratelimit-expiry` multiplied by 1000 → year-58507 DateTime → Prisma upsert threw → whole poll failed. Magnitude-based parse + plausibility guard; other `* 1000` adapters audited clean.
- **intrinio** — synced CT `INTRINIO_API_KEY` 401s upstream → OWNER: refresh in CT Infisical.
- **mistral** — synced inference key can't read billing (needs Backoffice Admin key) → OWNER decision (CT now pushes priced Mistral telemetry, blind viable).
- **alpaca** — row missing `apiSecret` → OWNER dashboard edit (paper-vs-live ambiguity documented).
- **xai** — row missing `teamId` → OWNER dashboard edit.
- NOT failures: fmp/finnhub/alphavantage/marketstack/massive/tiingo/anthropic-individual = blind-by-design since PR #119 (correctly skipped).

CI incidents: #305 known transient Prisma-import flake (one rerun); #312→#319 zero-checks root-caused: GitHub silently skips pull_request dispatch on CONFLICTING PRs — rebase fixes it.
