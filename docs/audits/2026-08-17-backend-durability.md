# Usage Monitor — backend / storage / ops durability audit

**Date:** 2026-08-17
**Owner:** CURSOR (Grok) — read-only
**Branch:** `cursor/backend-durability-audit-c46b`
**Method:** Static review of `origin/main` at `8db78b5` plus recent rollouts.  Three specialist explorers (storage/restore, ingest/concurrency/cache, jobs/alerts/deploys) then lead verification of cited lines.  No production mutations, no live restore, no env/secret reads.

**Verdict:** The money-path writer is carefully fail-closed where it matters (inode identity, admission `finally`, additive migrate, weekly R2 round-trip proof, B2 restore PASS on 2026-08-14).  Residual risk is concentrated in **operator-facing lies** (Oracle-era runbook and `DEPLOY.md` vs Coolify/B2), **a proven `/tmp` outage path that the weekly archive still uses**, **a hung-tick readiness hide**, and **Retry-After values that can recreate the historical producer storm**.  Backup, disk, replica lag, and alert-send failures are mostly observability.  They do not page.

---

## Scope and keepouts

This audit covers API/backend request paths, SQLite + Litestream + B2 + weekly R2, archive/restore proof, jobs, concurrency, caching, latency, failure recovery, alerting, deploys, and operational durability.

**Keepout (parallel 2026-08-17 UM report-only lanes — do not steal):**

| Lane | Branch / PR | Why disjoint |
|------|-------------|--------------|
| Outcomes / projections | `cursor/outcomes-projections-audit-4269` #1238 | Product math, not storage/ops |
| Provider-connector accuracy | `cursor/providers-accuracy-audit-9579` #1234 | Adapter truth / fixtures |
| Security / privacy | `cursor/security-privacy-audit-f36a` #1235 | Secrets, PII, authz (overlap noted, not duplicated) |
| Web / iOS parity | `cursor/web-ios-parity-audit-fc87` #1237 | Client UX |
| Blind spots | `cursor/blind-spots-audit-60bb` #1236 | Cross-cutting product gaps |
| Board hygiene | `grok/board-hygiene-2026-08-17` #1233 | Effort-log closeout |

**Board work this audit accounts for (already landed or in flight):**

- #1180 restore-proof + honest `gatesOverallOk` (`docs/rollouts/2026-08-14-backup-restore-proof.md`)
- #1223 R2 weekly-archive-only; historic LTX deleted from `usage-monitor-prod-v3`
- #1226 / #1228 ST compaction-tier visibility + Host Usage; ST Litestream 503 is a peer-health issue, not a UM replica bug
- 2026-08-16 Grok `/tmp` restore-drill fill → Coolify `503 no available server` (`docs/rollouts/2026-08-16-ios-computers-tab.md`)
- Monet #1144 R2 kill-switch persistence + `FETCH_LITESTREAM_REQUIRED` deploy-freeze fix
- Claude #1131 PagerDuty alert correctness (unverifiable zero-telemetry, stale-snapshot watermark, resolve-before-delete)

---

## How the system is supposed to work

Usage Monitor is a **sole SQLite writer** on Coolify/Hetzner NBG1 (`<PROD_ORIGIN_IP>`, app uuid `<UM_COOLIFY_APP_UUID>`, volume `/data`).  Three durability layers:

1. **Live file** `/data/prod.db` — WAL, Prisma `connection_limit=1`, process-global ingest admission.
2. **Continuous replica** — Litestream 0.5.13 → Backblaze B2 (`api-usage-monitor/prod.db`), `sync-interval: 1h`, snapshot interval/retention `24h`.  One replica only.
3. **Weekly verified archive** — gzip to Cloudflare R2 `usage-monitor-prod-v3` prefix `weekly/`.  The job downloads, rehashes, gunzips, and `integrity_check`s before pruning.  This is the only automated restore proof.

Same-disk pre-migration snapshots (Online Backup API + integrity) exist for schema rollback at deploy, not disk death.

Write APIs (`POST /api/ingest/usage`, `POST /api/otlp/v1/metrics`) take a reject-not-queue lease.  Internal poll/maintenance queues FIFO.  Reads use 60s SWR for budget status and a 5s MTD memo behind an exclusive aggregation lease (the 512 MiB OOM lesson).

`/api/ready` `ok` is **database SELECT 1 + inode identity + scheduler (if enabled) + startup wrapper**.  Backup, disk, admission, and `USAGE_READ_TOKEN` are observability only.  Default transport is HTTP 200 even when `ok=false` so a host probe cannot kill the sole writer.  Independent monitors must use `?strict=1`.

---

## Severity rubric

| Sev | Meaning |
|-----|---------|
| **P0** | Next incident or already-proven path can lose the live DB, take the origin down, or make an operator destroy the only copy |
| **P1** | High-impact silent failure, documented lie that will mis-operate, or retry/contention that has already burned money |
| **P2** | Real gap, bounded blast radius, or missing page on a secondary signal |
| **P3** | Docs drift, hygiene, or polish that does not change the next-hour outcome |

---

## P0 — Fix first

### 1. Data-loss runbook still operates Oracle, not Hetzner

**Evidence:** `docs/runbooks/sqlite-data-loss-incident.md:3` addresses “the Oracle A1 production VM”.  Step 1 pauses `usage-monitor-app-1` (line 28).  Step 2 writes `/etc/usage-monitor/auto-deploy.paused` and stops `usage-monitor-auto-deploy.timer` (lines 38–39).  Later restore text still points at R2 `usage-monitor-prod-v3` as the continuous replica.

**Current truth:** Production is Coolify UUID `<UM_COOLIFY_APP_UUID>-…` on Hetzner.  Continuous replica is **B2**.  R2 is weekly gzip only (#1223).  There is no in-repo Coolify equivalent of `auto-deploy.paused`.

**Failure mode:** An unlinked-inode incident is minutes-critical.  Following the runbook pauses the wrong container name, fails to freeze Coolify auto-deploy, and can restore from the wrong vendor (weekly archive, not the 1h B2 tip).  The **pause-don’t-restart** rule itself is still correct (`runtime-health.ts` comments at the `databaseFile` check; runbook lines 9–17).

**Fix:** Rewrite the runbook for Coolify/B2: `docker pause` the live UUID container, disable Coolify auto-deploy (document the exact UI/API lever), restore from B2 via `scripts/litestream-restore.sh` to a scratch path, integrity-check, then swap.  Keep the inode-capture steps.  Add a one-line “do not use Oracle compose names” banner.

### 2. `/tmp` tmpfs is still the weekly-archive workdir after a proven outage

**Evidence:** 2026-08-16 public `usage.jays.services` returned `503 no available server` because Hetzner `/tmp` tmpfs was 100% full of leftover restore-drill SQLite copies (`docs/rollouts/2026-08-16-ios-computers-tab.md:15–24`).  Coolify could not write `runc-process` files.

`scripts/ops/r2-weekly-archive.mjs:237` still does `mkdtempSync(join(tmpdir(), "r2-weekly-archive-"))`.  Manual drills documented under `/tmp/fleet-restore-drill` have no cleanup gate.

**Failure mode:** A weekly job (snapshot + gzip + download + gunzip + integrity) or another restore drill re-fills the ~7.7 GiB tmpfs.  Coolify cannot start or recycle containers.  Origin 503s even though `/data` has tens of GiB free.  Disk-on-`/data` ready check does not see this.

**Fix:** Pin weekly workdir and restore-drill scratch to `/data/.scratch` (or another volume path) with explicit cleanup in `finally`.  Add a host `/tmp` free-bytes check to ops/ready (observability is enough if it pages).  Document “never leave restore copies on tmpfs”.

### 3. Overlapping scheduler ticks hide `tick_stalled`

**Evidence:** `startUsagePollingScheduler` uses `setInterval(..., POLL_INTERVAL_MS)` with no in-progress guard (`usage-recorder.ts:711–717`).  Every invocation of `runUsagePollingSchedulerTick` calls `markTickStarted()` first (`usage-recorder.ts:680`), which overwrites `lastTickStartedAt` (`runtime-health.ts:152–155`).  `tick_stalled` is `tickInProgress && now - lastTickStartedAt > 45min` (`runtime-health.ts:214–226`).

Fetch and maintenance coalesce separately (`fetchAllInFlight`, `maintenanceInFlight`).  A tick hung in maintenance releases the fetch lock, so the next interval can start a **new** provider poll while still resetting the stall clock.

**Failure mode:** A wedged SQLite/admission hold can last hours while `/api/ready` stays `ok: true`.  Docker `HEALTHCHECK` curls `/api/health`, which is always `{ok:true,status:"live"}` (`src/app/api/health/route.ts:11–21`, `Dockerfile:72–73`).  Coolify will not recycle.  Uptime `?strict=1` also stays green.

**Fix:** If `tickInProgress`, do not call `markTickStarted()` again.  Optionally refuse to start a second tick.  Surface `tickOverlapCount` on ready.  Consider a watchdog that pages on `httpHoldMs` / waiter depth, not only on `ok`.

---

## P1 — High impact

### 4. `Retry-After: 5` is shorter than the work it protects

**Evidence:** HTTP overlap returns `503` + `Retry-After: 5` (`ingest-admission.ts:82`, ingest/OTLP metrics routes).  Persist transactions are **30s**.  A documented MTD `groupBy` is ~11.4s and occupies the only Prisma connection (`connection_limit=1`, `prisma.ts:46–49`).  `busy_timeout` default is **5s** (`prisma.ts:122, 162–167`).

Historical context (2026-07-20 audit + effort log): OOM → clients ~35/s → bandwidth + Congress.Trade D1 overage.  The reject-not-queue design is correct (`ingest-admission.ts:128–131`).  The advertised backoff is not.

**Failure mode:** Compliant exporters retry at 5s into a still-held 30s lease or an 11s scan, amplifying `httpRejects`.  Unscoped `USAGE_INGEST_TOKEN` shares one 10 req/s bucket across all producers.

**Fix:** Advertise `Retry-After` ≥ remaining lease estimate, or a floor of 30s (match txn timeout).  Prefer scoped producer tokens in production (`USAGE_INGEST_REQUIRE_SCOPED_TOKENS`).  Add a windowed 503/429 rate on `/api/ready` `checks.admission` (not just lifetime averages).

### 5. Operator docs still claim ready gates backup, and Litestream numbers are stale

**Evidence:**

| Claim | Reality |
|-------|---------|
| `DEPLOY.md:233–234` — `LITESTREAM_REQUIRED` makes readiness fail if the replica is absent/unhealthy | `ready/route.ts:279–294` — backup is **not** part of `ok` (owner 2026-08-05) |
| `docs/litestream.md:68–69, 200` — `retention: 6h`, `sync-interval: 2h` | `litestream.yml:27–51` — `retention: 24h`, `sync-interval: 1h` |
| AGENTS.md / comments — pre-migration default retention **3** | `backup-sqlite-before-migrate.mjs:38` — `DEFAULT_RETENTION = 1` (`.env.example:22` comments `"3"`) |
| `DEPLOY.md:261–269` — fleet-sentry-monitor 15-min dry-run as if current | Oracle-era singleton; Coolify path is in-container heartbeat + weekly job |

**Failure mode:** An on-call reading `DEPLOY.md` believes backup failure takes the product down (it will not page via ready).  An on-call reading `docs/litestream.md` plans RPO as 2h/6h when config is 1h/24h.  Pre-migration default 1 means a bad migrate has one rollback image unless Infisical overrides.

**Fix:** Align the three docs to `litestream.yml` + `ready/route.ts`.  State RPO explicitly: **about 1 hour + WAL tip** (2026-08-14 drill: live 68531 pages vs restore 68015).  If Infisical does not set retention 3, either set it or stop documenting 3.

### 6. Auto-restore on a wiped volume is not integrity-checked

**Evidence:** `scripts/start-with-litestream.sh` restores only when `/data/prod.db` is **absent**.  An existing empty/corrupt file skips restore.  The auto path does not run `PRAGMA integrity_check` before `migrate-safe.mjs`.  Manual `scripts/litestream-restore.sh` writes `/data/prod.db.restored` and tells the operator to verify; its activate path uses `cp` on a live SQLite file (contradicts `migrate-safe.mjs` “do not raw-cp a live DB”).

**Failure mode:** Fresh-disk disaster recovery can migrate and serve a corrupt B2 tip.  A leftover zero-byte `prod.db` after a volume glitch blocks restore forever.  `cp` activate can snapshot a torn WAL.

**Fix:** Integrity-check auto-restore before migrate; fail closed.  Treat empty/unopenable `prod.db` as absent.  Activate via Online Backup API or stop-the-writer + copy, never `cp` a live file.

### 7. R2 kill-switch has three disagreeing implementations

**Evidence:** Canonical precedence is flag file > env unless `/data/r2-auto-resumed.flag` (`r2-usage.ts`, `start-with-litestream.sh:90–107`).  Monet #1144 added the resume marker because env-only clear died on restart (stuck kill 2026-08-04 → 2026-08-12).

Divergences:

- `r2FreeTierKillEngaged()` in `runtime-health.ts:384–393` **ignores the resume marker** — env kill still paints backup inactive.
- `replica-status-heartbeat.sh` kill check also ignores the resume marker.
- Weekly archive (`r2-weekly-archive.mjs:136–138`) checks **env only**, not the flag file.  Flag-only kill still lets the weekly PUT run; env kill + resume marker still blocks the weekly job unless `R2_ARCHIVE_IGNORE_KILL_SWITCH=true`.

On B2 (current primary), kill **does not stop replication** (`start-with-litestream.sh` R2-endpoint-only).  That is correct.  The UI/heartbeat can still lie.

**Fix:** One shared helper (or identical bash/JS predicates) for flag/env/resume.  Weekly job should read the same predicate.  Ready/heartbeat must not report `r2_free_tier_disabled` when the endpoint is B2.

### 8. Alert *send* failures do not flip `maintenanceHealthy`

**Evidence:** `isUsageMaintenanceHealthy` (`usage-maintenance.ts:95–107`) checks adoption degradation, Cloudflare handoff enum, alert **persistence** degradation, and OpenRouter verify `degraded`.  Channel HTTP errors land in `alerts.errors` only.  Reconciliation is catch-and-log (`usage-maintenance.ts` around the reconcile stage).  Pushover-configured ⇒ email dropped (`alert-delivery.ts`); only PagerDuty receives `resolve`.

**Failure mode:** Pushover/PD/Slack 4xx/5xx → dashboard and ready look healthy → no page that paging is broken.  A cleared budget warning will not un-notify Pushover.  OpenRouter missing key or a stuck `CLOUDFLARE_LEGACY_HANDOFF_SUBSCRIPTION_ID` **does** fail ready after 3 ticks (~45 min) via generic uptime PD, with no dedicated billing-sync alert.

**Fix:** Count consecutive alert-delivery failures and expose `alertsDeliveryDegraded` on ready (observability + optional page).  Do not fold a single webhook blip into `ok`.  Confirm Infisical handoff id is `disabled|handed_off|already_managed` or unset.

### 9. Disk, replica lag, and weekly archive never page

**Evidence:** `checks.disk` (5 GiB warn), `checks.backup`, `backupLayers`, `usageReadToken` are “observability only — never part of `ok`” (`ready/route.ts:354–386`).  Uptime workflow pages only on `?strict=1` failure 3× (`uptime-monitor.yml`).  Release drift ≥120 min opens a GitHub issue, not PD.  R2 70% kill pages **Pushover only**.

**Failure mode:** B2 heartbeat dies (`env_active_unverified`), weekly archive skips 8+ days, or `/data` falls under 5 GiB, and no human is paged.  The 2026-08-16 outage was `/tmp`, which this check would not have seen anyway (see P0.2).

**Fix:** Add a dedicated monitor (UptimeRobot keyword or GH workflow) on `gatesOverallOk==false` and `disk.ok==false` without flipping product `ok`.  Keep the sole-writer restart protection.

### 10. `llm-burn` bypasses the exclusive aggregation lease

**Evidence:** Budget MTD scans use `withExclusiveExternalUsageCostAggregation` so two ~11s result sets cannot coexist.  `src/lib/llm-burn.ts` has **no** such lease and **no** SWR.  Five parallel `groupBy`s on `occurredAt` compete for `connection_limit=1`.  Session-gated, but a dashboard poll plus a budget refresh serializes ingest behind them.

**Failure mode:** Dashboard open on LLM Burn during a month-boundary cold compute → admitted ingest holds the HTTP lease while waiting on the single connection → producers 503/5s (P1.4 amplification).

**Fix:** Put `llm-burn` on the exclusive lease and a short memo (30–60s).  Do not add a second connection without re-proving native-memory pragmas (`prisma.ts` documents the split-pool risk).

### 11. Internal admission waiters are unbounded and untimed

**Evidence:** `internalWaiters` is an array with only a high-water `maxWaiterDepth` (`ingest-admission.ts:174–185`).  HTTP `tryAcquire` rejects if any waiter exists (line 134).  Retention `ANALYZE` (default-on after prune) and optional `VACUUM` take the internal lease (`data-retention.ts:973–989`).  Comment on VACUUM: can livelock readiness on a large disk.

**Failure mode:** A slow retention/ANALYZE/VACUUM chain queues internals forever and starves HTTP ingest for the whole window.  No waiter timeout.  Process restart is the only escape — and restart is dangerous if the inode is unlinked.

**Fix:** Cap waiter depth; timeout waiters; never enable VACUUM in production without a documented exclusive window.  Page on `waiterDepth` above N.

---

## P2 — Bounded but real

### 12. Boot auto-restore vs existing file; heartbeat age is file mtime, not LTX

`getBackupRuntimeStatus` reports `replicaAgeSeconds` from status-file `checkedAt`, not LTX age (`runtime-health.ts`).  UI “replica 10m ago” means the heartbeat wrote.  LTX freshness is only inside the heartbeat’s `ok` boolean (max **10800s**).  A frozen-but-rewritten status file cannot pass forever (heartbeat omits `ageSeconds` — good).  A heartbeat that writes `ok:true` with stale LTX parse (`no_parseable_ltx` after the 2026-08-16 restart) can still confuse operators.

### 13. Local backup layer goes red after 14 days without a deploy

`LOCAL_BACKUP_MAX_AGE_SECONDS` is 14 days.  Snapshots are created **only at deploy**.  No deploy for a fortnight → `local.ok=false` → `gatesOverallOk=false` even if B2 + weekly are fine.  That is an honest-but-noisy gate, the inverse of the old hard-coded `false` lie (#1180).

**Fix:** Either take a periodic local snapshot (not only at migrate) or stop ANDing local into `gatesOverallOk` when primary+historic are green.

### 14. Historic R2 `ok: true` when monitor creds are missing

`getR2HistoricBackupStatus`: if weekly-monitor creds are unset, reason `r2_monitor_unconfigured` and **`ok: true`**.  Second vendor can be absent and still look green.  When creds exist, ready only reads the job’s JSON (8-day freshness) — it does not ListObjects.

### 15. OTLP logs limiter is the old shared-egress failure mode

`POST /api/otlp/v1/logs` is accept-and-drop (correct).  Rate limit is **20 / 1000ms keyed by `getClientIp`** with **no `Retry-After`** (`logs/route.ts:36–46`).  Ingest/metrics already moved to identity keys because Cloudflare egress is shared.  One noisy logs exporter can 429 every other Claude Code client.  No SQLite risk (drop path).

### 16. `OtlpMetricState` and tombstones grow forever

Tombstones are never pruned by design (`data-retention.ts:955–962`) — expiring one lets a late retry double-count.  `OtlpMetricState` is never age-pruned (`964–967`); series cap **100_000** then 503 `Retry-After: 900`.  Capacity is sticky until manual delete.  No disk SLO besides the 5 GiB free warn.

### 17. `/api/health` always live; ready 200 on not-ready

Both are **intentional** sole-writer protections (`health/route.ts:4–8`, `ready/route.ts:314–318, 398–403`).  Docker HEALTHCHECK uses health, not `?strict=1`.  Uptime workflow uses strict.  UptimeRobot public URL is Cloudflare edge.  Split brain: edge-only outage pages UptimeRobot; origin-only outage pages GH PD (`usage-monitor-oracle-origin-readiness` — key name is leftover, title says Hetzner).

Do not point Coolify at `?strict=1`.  A CF-handoff or OpenRouter verify blip would restart the writer.

### 18. Scheduler is green before the first tick and on `USAGE_SCHEDULER_ENABLED=false`

After `markSchedulerStarted()`, before the first tick completes: `ok: true` (`runtime-health.ts:204–274`).  Boot delay 30s + first poll (up to 10 min budget) is a green window.  GH deploy observer requires `lastTickSucceeded==true`; Uptime/`?strict=1` does not.  Preview hosts disable the scheduler (`ok: true`, `readinessReason: disabled`) — correct to avoid a second writer, silent if left on in production.

### 19. `provider_fetch_degraded` never flips `ok`

Deliberate (`usage-recorder.ts:685–692`, `runtime-health.ts:252–265`).  Majority-fail for 3 ticks (~45 min) is visible on ready and does not page.  Push-primary providers (Anthropic, Voyage, Robinhood) are skip, not failure.

### 20. Sentry Health card fail-open

Fetch error → `unresolvedCount: 0` plus an `error` field (`sentry-health.ts`).  Card can look empty/healthy during a Sentry outage.  Dashboard-only; never pages.  Matches the owner split (errors in Sentry, usage here).

### 21. Receipt-inbox storage is a separate fail-closed store

Not a DB replica.  Evidence prefix 180 days; auditor fails closed after 24h without the exact lifecycle rule.  Intake refuses mail if the audit is stale.  Independent of `/data/prod.db`.  2026-08-16: worker stayed up while Coolify 503’d.  Keep it that way.

### 22. Export daily-rollups middleware exclusion is now present

AGENTS.md still says bearer access “additionally needs a one-line `isPublicPath` exclusion”.  `src/middleware.ts:58–61` already excludes `GET /api/export/daily-rollups`.  Docs lag only (P3).

---

## P3 — Hygiene

- `SchedulerRuntimeStatus` is **in-process memory** (`runtime-health.ts`).  Restart wipes tick history.  Ready cannot prove “last week’s ticks succeeded”.
- Uptime PD dedup key remains `usage-monitor-oracle-origin-readiness`.  Renaming forks open incidents; document the alias.
- Drift copy still teaches `sudo /usr/local/sbin/usage-monitor-auto-deploy --retry-blocked`.
- `.env.example` documents `/data/litestream-replica-status.json` (no leading dot); runtime default is `/data/.litestream-replica-status.json`.
- `docs/litestream.md` still says “Oracle Dockerfile” for `fetch-litestream.sh`.
- Manual restore-script activate `cp` (see P1.6).
- Hetzner volume snapshots are mentioned in Pushover copy as a “~24h floor” with no in-repo enforcer.
- B2 `hetzner/` full dumps are inventoried at 18h max age in fleet-backup-status; the rclone job is not in this repo.

---

## SLO gaps

No numeric SLOs are encoded.  Implicit thresholds only:

| Implicit SLO | Threshold | In `ok`? | Pages? | Hole |
|--------------|-----------|----------|--------|------|
| Process live | `/api/health` always 200 | n/a | UptimeRobot (edge) | Never sees SQLite/scheduler |
| Product ready | DB + inode + scheduler + wrapper | yes | GH PD after 3×5 min `?strict=1` | Hung overlapping ticks; 200 default |
| Scheduler tick success | 3 consecutive failures (~45 min) | yes | Via strict ready | Overlap resets start time |
| Tick freshness | 45 min | yes | Via strict ready | Same hide |
| Provider poll majority-fail | 50% or all-fail, 3 ticks | **no** (`ok` stays true) | **no** | Upstream outage is silent |
| Ingest admit | reject overlap, `Retry-After: 5` | no | no | Lifetime counters only; no p50/p99 |
| Persist txn | 30s | no | no | Timeout → 500 / Retry-After 30 |
| Budget read | SWR 60s; cold ~11s | no | no | First hit after boot unpaid |
| Replica LTX age | 3h (heartbeat) | no | no | Age shown is heartbeat file |
| B2 RPO | ~1h sync + WAL tip | no | no | 2026-08-14: 516 pages behind |
| Weekly R2 archive | 8 days | no | no | JSON only; unconfigured → ok |
| Local snapshot | 14 days | no (gatesOverallOk only) | no | No deploy → local red |
| Disk free (`/data`) | 5 GiB | no | no | `/tmp` invisible |
| Alert delivery | 24h reminder | no | only if first send worked | Failed send + healthy maintenance |
| Deploy exact SHA | observer 240 min; drift issue 120 min | n/a | drift = GH issue | No Coolify freeze in this repo |
| Receipt lifecycle | 24h audit freshness | n/a (worker) | mail refused | Separate from UM ready |
| Subscription charge latency | none | n/a | no | Idempotent, but no “charged within N min” |
| PD resolve after clear | none | n/a | residual strand paths | #1131 fixed the known watermark bug |

**Missing SLIs worth adding (observability, not `ok`):** ingest p95, HTTP 503 rate per producer, Prisma/SQLite busy count, MTD `groupBy` duration, SWR refresh-fail, `llm-burn` duration, `/tmp` free bytes, weekly job last success (already in JSON — page it).

---

## Failure-mode catalog

| # | Trigger | What happens | User-visible | Data risk |
|---|---------|--------------|--------------|-----------|
| F1 | Unlinked `/data/prod.db` | `SELECT 1` still works; `databaseFile` `unlinked` | Ready `ok=false` if anyone uses strict | **Restart destroys the only copy** |
| F2 | Coolify deploy / docker restart during F1 | Descriptors close | Origin bounce | **Permanent loss since last B2 sync (~1h)** |
| F3 | Operator follows Oracle runbook | Wrong pause / wrong replica | Confusion | Restore from weekly or nothing |
| F4 | `/tmp` full | Coolify cannot start | Public 503 | Live DB on `/data` intact |
| F5 | Weekly job + restore drill on tmpfs | Same as F4 | Public 503 | Same |
| F6 | Hung tick + 15 min interval | `lastTickStartedAt` reset | Ready green | Writer wedged; ingest 503 |
| F7 | Overlapping producers | 503 / Retry-After 5 | Producers retry | Duplicate-safe; cost/bandwidth |
| F8 | 11s MTD + ingest | Single connection blocks persist | 503 while lease held | None if clients honor idempotency |
| F9 | Wiped volume, leftover empty `prod.db` | Auto-restore skipped | App may fail migrate or serve empty | Replica unused |
| F10 | Wiped volume, bad LTX tip | Auto-restore + migrate, no integrity | App serves corrupt | Silent |
| F11 | Heartbeat dies | `env_active_unverified` | Settings backup yellow | Replica may still run |
| F12 | No deploy for 14 days | `local.ok=false`, `gatesOverallOk=false` | Humans think backup failed | B2+weekly may be fine |
| F13 | Missing weekly-monitor creds | `r2Historic.ok=true` | False green | Second vendor unknown |
| F14 | Alert channel down | `maintenanceHealthy=true` | No page | Money path still writes |
| F15 | OpenRouter verify 401 / CF handoff stuck | Tick unhealthy ×3 | Generic origin PD | Serving continues |
| F16 | `USAGE_SCHEDULER_ENABLED=false` in prod | Ready green, no polls/alerts/charges | Stale dashboard | Ingest still works |
| F17 | Materializer/renewal/retention throw | Tick fails; alerts skipped that cycle | Ready after 3 fails | Charges idempotent on retry |
| F18 | Adoption transaction fail | Rollback; existing materialize still runs | Degraded; ready after 3 | No partial adopt |
| F19 | R2 env kill leftover + resume flag | JS/bash run B2; ready/heartbeat may lie | Backup looks disabled | B2 still replicating |
| F20 | `OtlpMetricState` at 100k | 503 Retry-After 900 | Exporters back off 15 min | Sticky until manual cleanup |
| F21 | VACUUM enabled | Exclusive lock + internal lease | Ready livelock risk | Intentional opt-in |
| F22 | Second Coolify replica on `/data` | Process-local admission bypassed | Undefined | Dual writer |
| F23 | Image CDN flake (pre-#1144) | Green build, crash-loop | Deploy freeze on SHA | Mitigated by `FETCH_LITESTREAM_REQUIRED` |
| F24 | Edge down, origin up | UptimeRobot pages; GH PD quiet | Split signal | None |
| F25 | Origin down, edge cache | Inverse of F24 | Split signal | None |

---

## Recommended fixes (report only — do not implement here)

**Do now (docs / runbook — no money-path code):**

1. Rewrite `docs/runbooks/sqlite-data-loss-incident.md` for Coolify + B2 + pause-the-UUID-container.
2. Fix `DEPLOY.md` `LITESTREAM_REQUIRED` sentence and `docs/litestream.md` 6h/2h vs 24h/1h.
3. Document `/tmp` ban for restore drills; point weekly workdir at `/data`.
4. Note Uptime PD key alias and “never point Coolify at `?strict=1`”.

**Do next (small, high leverage):**

5. Stop resetting `lastTickStartedAt` on overlapping ticks.
6. Floor ingest/OTLP `Retry-After` at 30s (or remaining-hold).
7. One kill-switch predicate shared by JS, start script, heartbeat, weekly job.
8. Auto-restore: integrity-check + treat empty file as absent.
9. Page `gatesOverallOk==false` and `disk.ok==false` (and `/tmp` free) without flipping product `ok`.
10. Put `llm-burn` on the exclusive aggregation lease + short memo.

**Consider:**

11. Periodic local snapshot so the 14-day layer is not deploy-coupled.
12. Internal waiter cap/timeout; never VACUUM in prod by default (already opt-in — keep it).
13. OTLP logs identity limiter + `Retry-After`.
14. Alert-delivery degraded streak on ready.
15. Tombstone/OtlpMetricState size on disk check.
16. Confirm Infisical: `CLOUDFLARE_LEGACY_HANDOFF_SUBSCRIPTION_ID` healthy enum, `USAGE_READ_TOKEN` set, `SQLITE_PRE_MIGRATION_BACKUP_RETENTION` actually 3 if that is the intent.

---

## What is already solid

Do not “fix” these without a new incident:

- **Inode identity** as part of `ok` — the only signal that sees `SELECT 1` on a deleted file.
- **Default ready HTTP 200** — protects the sole writer from restart loops.
- **HTTP ingest reject-not-queue** with `finally` release — correct vs queuing timed-out exporters.
- **Internal ALS reentry** — nested maintenance does not deadlock.
- **Additive `migrate-safe`** — never `--accept-data-loss`; Litestream `_litestream_*` tables externally managed.
- **Pre-migration Online Backup API + integrity + fsync + atomic rename.**
- **`FETCH_LITESTREAM_REQUIRED=true` + `test -x`** — the 2026-08-13 green-image crash-loop cannot recur the same way.
- **Weekly archive round-trip proof** (hash + gunzip + integrity before prune).
- **2026-08-14 UM B2 restore PASS** (integrity ok; WAL tip ahead of 1h sync — expected).
- **`gatesOverallOk` = AND of three layers** (#1180) — no longer hard-coded false.
- **R2 is weekly-only; B2 is frequent** (#1223) — Litestream 0.5 cannot dual-write.
- **v2 ingest ACK semantics** — `persisted` is new inserts only; tombstones block replay double-count.
- **Materializer idempotency** `(subscriptionId, periodStart)` + watermark.
- **Adoption fail-closed transaction** — money-correct; paging is the gap, not the write.
- **#1131 PD correctness** — zero telemetry is `unverifiable`; stale-snapshot clear watermark; resolve-before-delete.
- **Resume-flag kill-switch** (#1144) — env-only clear cannot stick across restart *if all predicates match* (P1.7 is the remaining split).
- **Export daily-rollups** already on `isPublicPath` (AGENTS.md stale).
- **Receipt inbox** fail-closed lifecycle, no billing tokens on the worker.

---

## Proven vs claimed (backup / ready)

| Claim | What is actually measured |
|-------|---------------------------|
| Product ready | `SELECT 1` ≤2s + inode matches boot baseline + scheduler (if required) + `APP_STARTUP_WRAPPER=start-with-litestream-v2` |
| `checks.backup.ok` | `LITESTREAM_ACTIVE` (minus R2-kill-if-R2) **and** status-file `ok` with `checkedAt` ≤10800s |
| `gatesOverallOk` | `local.ok && primary.ok && r2Historic.ok` — UI only |
| Local layer | A `.backup.db` under `.pre-migration-backups` with mtime ≤14 days.  No read-time integrity |
| Primary layer | Heartbeat file, not a restore |
| Historic R2 | Weekly status JSON ≤8 days **if** creds configured; else `ok: true` |
| Weekly “verified” | Proven **by the job**.  Ready trusts the JSON |
| B2 restore | Proven 2026-08-14.  Not re-proven on ready |
| Litestream “continuous” | 1h sync, 24h snapshot window |
| `LITESTREAM_REQUIRED` fails ready | **False** in code.  True in `DEPLOY.md` |
| Pre-migration default 3 | **False** in code (1).  Commented 3 in `.env.example` |

---

## Open questions (not answered from this tree)

1. Is production `LITESTREAM_S3_ENDPOINT` still B2?  Docs/yml say yes (2026-08-07).  This audit did not read live Infisical.
2. Is `SQLITE_PRE_MIGRATION_BACKUP_RETENTION` set to 3 in Infisical?
3. Does Coolify still run `r2-weekly-archive` and the host replica timer?  Status-file presence is the only in-app proof.
4. Is `CLOUDFLARE_LEGACY_HANDOFF_SUBSCRIPTION_ID` still set, and is its last status a healthy enum?
5. Is OpenRouter generation-read scope present?  Missing key degrades every tick.
6. Is `ALERT_PAGERDUTY_ROUTING_KEY` set on the GH uptime workflow?  Empty → PD steps no-op.
7. Is the Oracle `auto-deploy.timer` fully disabled on every host that still has those scripts?
8. How large are tombstones + `OtlpMetricState` vs the 5 GiB `/data` headroom?
9. Does fleet-sentry-monitor still run 15-min restore dry-runs against Coolify, or did that die with Oracle?

---

## Sources consulted

- Source control: this tree at `8db78b5`; PRs #1180, #1144, #1131, #1223, #1226, #1228; open report-only #1233–#1238 (keepout).
- Long-form: `docs/litestream.md`, `DEPLOY.md`, `docs/runbooks/sqlite-data-loss-incident.md`, rollouts 2026-08-12 PD, 2026-08-13 Pushover, 2026-08-14 restore-proof, 2026-08-15 weekly R2, 2026-08-16 Computers/`/tmp`, AGENTS.md, 2026-07-20 full-app review.
- Effort board: `docs/EFFORT-LOG.md` In Progress / Deployed (R2 weekly-only, restore-proof, kill-switch, `/tmp` 503, ST peer Litestream).
- Fleet coordination channel: claim posted 2026-08-17; parallel UM audits reserved the same hour.  No prior “backend durability” claim after 2026-08-15.
- Issue tracker: GitHub MCP unavailable this run; `gh pr list` used instead.
- Infra observability / Sentry / analytics warehouse: no live prod queries (read-only code audit).  Live restore numbers taken from dated rollouts, not re-measured.

---

## Apple Notes handoff (local publication)

**Title:** `[UM, Grok] Backend durability audit`

**Body (second row is local stamp — helper refreshes):**

Read-only audit at `docs/audits/2026-08-17-backend-durability.md`.  P0: rewrite Oracle data-loss runbook for Coolify/B2; stop using `/tmp` for weekly/restore (already took the site down 2026-08-16); overlapping ticks hide `tick_stalled`.  P1: Retry-After 5 vs 30s txn; DEPLOY.md still says backup gates ready; auto-restore has no integrity_check; kill-switch predicates disagree; alert-send failures look healthy; disk/replica never page; llm-burn skips the aggregation lease.  B2 restore PASS 2026-08-14 and weekly R2 proof still stand.  Report-only PR; no product-code edits.
