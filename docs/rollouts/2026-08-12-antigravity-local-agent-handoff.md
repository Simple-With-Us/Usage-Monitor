# 2026-08-12 — Handoff to a local agent: finish Antigravity collector + check R2 kill-switch

Written by a cloud/remote session that cannot reach `agy`, Infisical, the
Hetzner host, or Xcode. Everything below needs a session running on the
Mac (local Claude Code, or the owner directly) to finish. Branch:
`claude/antigravity-telemetry-integration-k6tpjf`, PR **#1100** (draft):
https://github.com/jaywedgeworth22/Usage-Monitor/pull/1100

Two unrelated things are bundled on this branch — the Antigravity collector
(the actual task) and a small iOS wording fix for a backup-status card the
owner spotted while reviewing (already committed, just needs the checklist
in Part 2 to close the loop on the underlying flag). Don't split them
unless asked; just track them separately below.

## STATUS — worked 2026-08-12 by a local Claude Code session

**Part 1 (collector): done and live.** Steps 1-8 below are all complete.
`agy` was authenticated; the dry-run did NOT parse cleanly and the fix was
not the "add words to `COLUMN_ALIASES`" one this doc predicted — the real
payload has no header row at all, and carries a fully structured
`command.data.groups[].buckets[]` field the original parser never looked at.
It also meters per model *group* × *window*, not per model, which made the
old group-name-keyed `eventId` collide and would have silently dropped half
of every reading. See the rewritten "Output shape" section of
`2026-08-11-antigravity-usage-collector.md` and commit
`fix(antigravity): parse the real /usage payload, not the guessed one`.
A real batch was sent and verified: `persisted: 4, rejected: 0`, four rows
in `ExternalUsageEvent` under `provider: "google-antigravity"`.

**Part 2 (R2 kill-switch): checked — the picture is slightly different from
what this doc assumed.** The persisted flag file `/data/r2-disabled-70pct.flag`
is **absent**; the kill switch is engaged purely through Coolify env vars
(`LITESTREAM_EMERGENCY_DISABLE=true` and `R2_WRITES_DISABLED=true`, set in
both the production and preview scopes). That matters for the auto-resume
question in item 3: `clearR2AutoDisable()` only mutates `process.env` in the
running process, so it can never durably clear an env-var-sourced switch —
every restart re-injects `true`. The flag is not "stuck because storage is
still ≥70%"; it is stuck because it is pinned in deploy config. Backup health
is unaffected (B2 primary healthy, replica age ~1 min, R2 role `historic`).

---

## Part 1 — Antigravity quota collector (the main task)

Code is done (`scripts/antigravity-usage-collector.mjs`,
`scripts/com.jays.antigravity-usage-collector.plist.example`, rollout doc
at `docs/rollouts/2026-08-11-antigravity-usage-collector.md`). What's left
needs real `agy` + Infisical + the production host, none of which exist in
the cloud sandbox that wrote this.

1. **Pull the branch:**
   ```bash
   cd /path/to/Usage-Monitor
   git fetch origin claude/antigravity-telemetry-integration-k6tpjf
   git checkout claude/antigravity-telemetry-integration-k6tpjf
   ```

2. **Confirm `agy` is authenticated:**
   ```bash
   agy -p "/usage" --output-format json
   ```
   Should return `"status": "SUCCESS"`. If not, `agy` needs an interactive
   login first (headless mode uses cached credentials only).

3. **Dry-run the collector, no Infisical needed yet:**
   ```bash
   node scripts/antigravity-usage-collector.mjs --dry-run --debug
   ```
   Two outcomes:
   - **It parses cleanly** and the printed events look right (real model
     names, sane `credits`/`limit` numbers) → skip to step 4.
   - **It fails** with "did not start with a recognizable header row" → it
     dumped the raw `response` lines in the error. Open
     `scripts/antigravity-usage-collector.mjs`, find `COLUMN_ALIASES` near
     the top, and add whatever the real header words are (lowercased,
     letters only — the matcher strips everything else) to the right
     field's alias list. Re-run until it parses. This is the one thing
     that could not be verified without real `agy` output — see that
     file's header comment and
     `docs/rollouts/2026-08-11-antigravity-usage-collector.md` for the full
     "known gap" writeup.

4. **Add the Infisical secret.** Project `usage-monitor`
   (`<UM_INFISICAL_PROJECT_ID>`), env `prod`, key
   `USAGE_INGEST_PRODUCER_TOKENS`, value `antigravity-cli:<token>`. First
   check whether that key already has other `producerId:token` pairs
   (comma-separated) — if so, append rather than overwrite.

   > **This step originally pasted a literal 64-hex token here in plaintext,
   > in a doc that was committed and pushed.** Don't do that — a value that is
   > about to become a live production ingest credential must never be written
   > into the repo. Mint it where it is used and write it straight to the
   > secret store. That particular token was never installed anywhere, so
   > there is nothing to rotate; it is a dead string, and the live credential
   > is a different one minted locally on 2026-08-12.

   Note the collector also needs the token half on its own, as
   `ANTIGRAVITY_INGEST_TOKEN` — the original checklist missed this, and
   without it step 6's `infisical run` invocation injects nothing and the
   script exits on its missing-token guard.

5. **Restart the usage-monitor app** (Coolify restart is enough, no
   redeploy needed) so `scripts/start-with-infisical.sh` re-injects the
   updated `USAGE_INGEST_PRODUCER_TOKENS` into the running process — it's
   read once at startup, not hot-reloaded.

6. **Send for real and verify:**
   ```bash
   infisical run --projectId <UM_INFISICAL_PROJECT_ID> --env prod -- \
     node scripts/antigravity-usage-collector.mjs
   ```
   Check the printed ack (`persisted` should be > 0, `rejected` should be
   0), then confirm in the dashboard or `GET /api/usage-events` that a
   `provider: "google-antigravity"` event landed.

7. **Install the launchd job:**
   ```bash
   cp scripts/com.jays.antigravity-usage-collector.plist.example \
     ~/Library/LaunchAgents/com.jays.antigravity-usage-collector.plist
   ```
   Edit the 4 `/ABSOLUTE/PATH/TO/...` placeholders (`which node`,
   `which infisical`, this repo's path, `$HOME`), then:
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jays.antigravity-usage-collector.plist
   ```
   Check `~/Library/Logs/antigravity-usage-collector.log` after the next
   4h tick.

8. **Mark PR #1100 ready for review and land it** once 3 and 6 are
   confirmed working (repo norm is commit → PR → merge without waiting to
   be asked, per `AGENTS.md` "Always commit + open PR + land").

---

## Part 2 — R2 free-tier kill-switch: stale flag check

Separate from the task above. While reviewing, the owner noticed the iOS
"R2 Historic" backup-status row read **"weekly freeze · writes paused"**
next to a green OK badge and asked if that's really fine.

**Already fixed and pushed** (commit `b6354c8` on this branch): the iOS
`r2Detail()` in `ServerStatusStore.swift` was appending "writes paused"
whenever the free-tier kill-switch flag was set, *regardless of role* —
but that flag is only meaningful while R2 is the live litestream target
(role `"active"`). Once B2 became primary and R2 moved to `"historic"`
(frozen, no longer written to, by design — see
`docs/rollouts/2026-08-06-backup-steady-state-policy.md`), the flag is
inert, and showing "writes paused" there was just confusing, not
inaccurate about anything real. Gated it on `role == "active"`, added a
regression test (`testR2HistoricDetailIgnoresStaleKillSwitchFlag` in
`SettingsFeatureTests.swift`). **Could not run `xcodebuild`/`swift test`
from the cloud sandbox — please build and run the iOS test suite once to
confirm it compiles and passes.**

What's still worth checking, because the wording bug only fired because
the underlying flag really is engaged in production right now:

1. SSH to the Hetzner host (`root@<PROD_ORIGIN_IP>`, `~/.ssh/hetzner` per
   `AGENTS.md`) and check:
   ```bash
   ls -la /data/r2-disabled-70pct.flag  # present?
   ```
   and check the Coolify env for `LITESTREAM_EMERGENCY_DISABLE` /
   `R2_WRITES_DISABLED`.
2. This traces back to `docs/rollouts/2026-08-04-r2-free-tier-prune-and-killswitch.md`,
   which called `LITESTREAM_EMERGENCY_DISABLE=true` a **temporary**
   measure "until the next deploy is live and storage is confirmed under
   70% after re-seed." That was over a week ago — worth confirming it
   wasn't just left on.
3. There IS an auto-resume path (`src/lib/r2-usage.ts`, `clearR2AutoDisable()`
   called when live storage % drops under `R2_RESUME_STORAGE_PCT`) — check
   whether that maintenance cycle has actually been running, or whether the
   flag is stuck because storage genuinely is still ≥70% (a real, separate
   cost concern worth knowing about even though it doesn't affect backup
   health anymore).
4. **This is not urgent** — since R2 is already `"historic"` (B2 is the
   real live backup target, checked with a real 3h freshness threshold,
   currently healthy per the "B2 Backup / replica 3m ago" row), the flag
   being stuck engaged has zero effect on actual backup health today. It's
   just worth clearing for hygiene if storage is comfortably under
   threshold, since a stale emergency flag from a resolved incident is the
   kind of thing that causes confusion later.
