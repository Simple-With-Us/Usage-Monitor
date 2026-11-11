# Oracle A1 deployment (RETIRED — see RETIRED.md at the top of this directory)

> **2026-08-07:** Production Usage Monitor runs on the Coolify fleet host (see private `jaywedgeworth22/fleet-ops:ATTACK-MAP.md`). SSH:
> `ssh coolify`. See `/Users/jay/apps/COOLIFY.md`.
>
> **Do not install the `usage-monitor-auto-deploy.timer` from the install
> block below on any host.**  The timer polls GitHub once per minute and
> starts a writer — that was the live deploy path before 2026-08-07 and is
> not the live path on Hetzner/Coolify.  See `deploy/README.md` for the
> canonical deploy index and `DEPLOY.md` invariant #4 for the Coolify +
> GitHub Actions auto-deploy description.  The install block at the bottom
> of this file is preserved verbatim because it is the historical record,
> not because anyone should run it.
>
> This Oracle runbook is retained for historical preflight/deploy script
> reference only. Do not treat Oracle as the sole writer.

The production candidate is one `VM.Standard.A1.Flex` VM with a separate block
volume mounted at `/data`. `usage-monitor.service` refuses to start unless that
mount exists, preventing SQLite from silently writing to the boot volume. The
unit also sets the mount root to UID/GID `1000:1000`, matching the unprivileged
`node` user in the official Node image; Oracle's Ubuntu login user is normally
UID 1001 and must not own the container's SQLite directory.

Runtime config — secrets **and** non-secrets — lives in the Infisical
`usage-monitor` project (env `prod`, path `/`) as the sole source of truth and
is materialized to tmpfs at `/run/usage-monitor/usage-monitor.env` (mode 0600)
by `usage-monitor-env-sync`; see "Runtime env: Infisical is the source of
truth" below. The legacy disk file `/etc/usage-monitor/usage-monitor.env`
(mode 0600) is kept only as the pre-migration fallback and rollback path.
`/etc/usage-monitor/host.env` now holds exactly one deploy-written state key:

```dotenv
USAGE_MONITOR_REVISION=<exact-main-sha>
```

`USAGE_MONITOR_HOSTNAME` moved into Infisical (set there as
`USAGE_MONITOR_HOSTNAME=usage.jays.services`) and reaches Caddy from the
synced tmpfs env via compose interpolation; `host.env` must never carry it
again. `usage.jays.services` is the public Cloudflare-proxied hostname. Caddy
keeps ports 80 and 443 reachable for its public ACME certificate and disables
the TLS-ALPN challenge because Cloudflare terminates public TLS; renewal
therefore uses HTTP-01. Do not restore the deleted IP-derived fallback. If a
direct-origin alias is also configured, separate the Caddy site addresses
with spaces, not commas, in the Infisical value:
`usage-oracle-origin.jays.services usage.jays.services`.

## Runtime env: Infisical is the source of truth

The host materializes its runtime env from Infisical; it never edits a runtime
`.env` file:

1. **Bootstrap (the one on-disk secret).** Create
   `/etc/usage-monitor/infisical-bootstrap.env`, root-owned mode 0600:

   ```dotenv
   INFISICAL_AUTOMATION_CLIENT_ID=<automation machine identity client id>
   INFISICAL_AUTOMATION_CLIENT_SECRET=<automation machine identity client secret>
   INFISICAL_UM_PROJECT_ID=<usage-monitor project id>
   # Optional overrides (defaults shown):
   # INFISICAL_BASE_URL=https://app.infisical.com
   # INFISICAL_UM_SECRET_PATH=/
   # INFISICAL_ENV=prod
   ```

   The shared `automation` universal-auth machine identity is used because of
   the owner's Infisical machine-identity cap; scope it read-only to this
   project, env `prod`, path `/`.

2. **Sync.** `usage-monitor-env-sync` (installed from
   `deploy/oracle/infisical-env-sync.sh`) performs universal-auth login
   (credentials passed via environment, never argv), exports the project as
   JSON with the JWT passed explicitly via `--token` (the CLI's in-export
   auto-login fails with "Unable to parse domain url"), validates the required
   keys — reporting only missing key NAMES on failure — and atomically writes
   raw `KEY=value` lines to `/run/usage-monitor/usage-monitor.env` plus a
   value-free `/run/usage-monitor/sync-metadata.json`. Raw unquoted lines are
   deliberate: `docker run --env-file` treats quotes literally, and compose
   `env_file` never executes shell, so spaces, `$`, quotes, and backslashes
   survive verbatim; multi-line values are rejected. `/run` is tmpfs: nothing
   secret touches disk, and every boot starts from a fresh sync.

3. **Boot wiring.** `usage-monitor-env-sync.service` is `Requires`/`Before`
   `usage-monitor.service` (compose `env_file` fails against a missing file,
   so the app must never start before a sync succeeds) and
   `Wants`/`After` for `usage-monitor-auto-deploy.service` (the deploy
   transaction re-syncs itself with a bounded fallback, so a failed sync unit
   must not block deployments). `usage-monitor-env-sync.timer` re-syncs every
   15 minutes so a container restart between deploys sees recent config. On
   hosts without the bootstrap file the sync unit is condition-skipped and
   every unit behaves exactly as before.

4. **Fallback.** During a deploy, a failed sync falls back to the previous
   tmpfs file only when it is younger than 25 hours — container restarts
   between deploys survive an Infisical outage, but an arbitrarily stale file
   is never trusted; otherwise the transaction fails closed before preflight.
   A failed boot-time sync stops `usage-monitor.service` instead of booting
   the app on stale/missing config.

5. **Changing config.** Edit the value in Infisical, then run
   `sudo /usr/local/sbin/usage-monitor-env-sync` (or wait for the timer), then
   recreate the container (`sudo systemctl restart usage-monitor`) or let the
   next deploy pick it up. `USAGE_MONITOR_REVISION` is deploy-written host
   state and stays in `host.env`, never in Infisical.

6. **Rollback.** Remove `/etc/usage-monitor/infisical-bootstrap.env`: the
   deploy transaction and the sync unit immediately fall back to the legacy
   `/etc/usage-monitor/usage-monitor.env` with no other change. Keep that
   legacy file (renamed `usage-monitor.env.legacy`, root-owned mode 0600)
   until the Infisical path has survived several deploys, and keep the
   previous release's systemd units and compose file in git history for a
   full revert.


## Automatic production deployment

Oracle polls GitHub once per minute and deploys only when all of these are true:

1. the target is still the exact `main` SHA;
2. GitHub marks the commit signature/verification as valid;
3. the commit belongs to a merged PR whose base is `main`;
4. the exact SHA's GitHub Actions `verify`, `gitleaks`, and
   `Analyze JavaScript and TypeScript` checks all completed successfully under
   the official GitHub Actions app;
5. the current Oracle database, sole scheduler, Cloudflare R2 Litestream
   replica, separate `/data` block volume, disk headroom, and public readiness
   all pass preflight;
   before the disk check, the transaction removes only unreferenced
   `usage-monitor:<40-hex revision>` images while preserving the running and
   target revisions, both revisions in the last deployment receipt, and every
   image still referenced by a container. It then prunes only unused BuildKit
   cache with explicit 8 GB maximum, 12 GB free-space target, and 4 GB retained
   cache floor; it never runs an unbounded Docker or build-cache prune;
6. the root-owned Render retirement proof records a user-suspended service,
   disabled auto-deploy, and `USAGE_SCHEDULER_ENABLED=false`, while the former
   public health endpoint remains unavailable. Oracle also verifies those
   service and environment settings live through Render's API on every deploy.

This pull model intentionally stores no production SSH key or cloud credential
in GitHub. `.github/workflows/production-deploy-verify.yml` is an independent
receipt: after exact-main CI succeeds, it uses `curl --resolve` with the pinned
reserved Oracle IP while retaining `usage.jays.services` for SNI/certificate
validation, waits for production to report that exact revision, and fails
visibly if the deployment does not arrive. This direct-origin path avoids
Cloudflare's HTTP 403 challenge for GitHub-hosted runner IPs. The root deploy
transaction still samples the Cloudflare-proxied public URL, and UptimeRobot
independently monitors both public health and strict readiness.

The root-owned installation is separate from every fetched release:

```bash
sudo install -o root -g root -m 0644 deploy/oracle/compose.production.yaml /etc/usage-monitor/compose.yaml
sudo install -o root -g root -m 0644 deploy/oracle/Caddyfile /etc/usage-monitor/Caddyfile
sudo install -o root -g root -m 0600 deploy/oracle/render-retired.production.json /etc/usage-monitor/render-retired.json
sudo install -o root -g root -m 0755 deploy/oracle/deploy-production.sh /usr/local/sbin/usage-monitor-deploy
sudo install -o root -g root -m 0755 deploy/oracle/infisical-env-sync.sh /usr/local/sbin/usage-monitor-env-sync
sudo install -o root -g root -m 0755 deploy/oracle/auto-deploy.sh /usr/local/sbin/usage-monitor-auto-deploy
sudo install -o root -g root -m 0755 deploy/oracle/replica-status-probe.sh /usr/local/sbin/usage-monitor-replica-status
sudo install -o root -g root -m 0644 deploy/oracle/usage-monitor.service /etc/systemd/system/usage-monitor.service
sudo install -o root -g root -m 0644 deploy/oracle/usage-monitor-env-sync.service /etc/systemd/system/usage-monitor-env-sync.service
sudo install -o root -g root -m 0644 deploy/oracle/usage-monitor-env-sync.timer /etc/systemd/system/usage-monitor-env-sync.timer
sudo install -o root -g root -m 0644 deploy/oracle/usage-monitor-auto-deploy.service /etc/systemd/system/usage-monitor-auto-deploy.service
sudo install -o root -g root -m 0644 deploy/oracle/usage-monitor-auto-deploy.timer /etc/systemd/system/usage-monitor-auto-deploy.timer
sudo install -o root -g root -m 0644 deploy/oracle/usage-monitor-replica-status.service /etc/systemd/system/usage-monitor-replica-status.service
sudo install -o root -g root -m 0644 deploy/oracle/usage-monitor-replica-status.timer /etc/systemd/system/usage-monitor-replica-status.timer
sudo systemctl daemon-reload
sudo systemctl enable --now usage-monitor-env-sync.timer
# 2026-09-18: do NOT `enable --now usage-monitor-auto-deploy.timer` on
# any host.  The timer polls GitHub once per minute and starts a writer;
# production runs on Hetzner/Coolify and uses GitHub Actions for deploys,
# not this timer.  See `deploy/README.md` and `DEPLOY.md` invariant #4.
sudo systemctl enable --now usage-monitor-replica-status.timer
```

## Replica heartbeat (backup readiness side-channel)

`/api/ready` fails a **required** backup unless the replica side-channel proves
the R2 replica is advancing: the startup-only `LITESTREAM_ACTIVE=true` env
claim is set once at boot and stays true even when Litestream has been timing
out against R2 for hours. `usage-monitor-replica-status` (installed above,
driven by its 10-minute timer) lists the newest LTX object through the app
container's authenticated Litestream binary — same per-level tip strategy as
the deploy gate, never `-level all` — and atomically writes
`/data/.litestream-replica-status.json`:

```json
{"ok": true, "checkedAt": "2026-08-01T12:00:00Z", "ltxAgeSeconds": 42, "reason": null}
```

The app reads it via `LITESTREAM_REPLICA_STATUS_PATH` (set in the root-owned
compose file, not Infisical). `ok:false`, a missing file, or `checkedAt` older
than `LITESTREAM_REPLICA_MAX_AGE_SECONDS` (default 10800s / 3h, matching the deploy
gate's LTX budget) fails strict readiness — so a dead probe fails closed
instead of freezing a healthy verdict. `ageSeconds` is deliberately not
written: the app would prefer it over `checkedAt` and a stale file would then
pass forever.

**Rollout ordering (one-time):** an app revision carrying the strict backup
gate reports `not_ready` (`env_active_unverified`) until the heartbeat exists.
Install the probe + timer and the updated compose file, confirm
`/data/.litestream-replica-status.json` is fresh, and only then deploy that
revision — or set `LITESTREAM_REPLICA_VERIFICATION_REQUIRED=false` in
Infisical for exactly one deploy and remove it once the heartbeat is observed.
That same opt-out is the standing escape hatch for disposable/rollback hosts
that intentionally run without the probe.

**Infisical cutover sequencing:** the installed root-owned copies are
authoritative, never the fetched revision. To migrate an existing host,
preserve the legacy file first
(`sudo cp -a /etc/usage-monitor/usage-monitor.env /etc/usage-monitor/usage-monitor.env.legacy`),
create `/etc/usage-monitor/infisical-bootstrap.env`, run
`sudo /usr/local/sbin/usage-monitor-env-sync` once by hand to populate the
tmpfs env, and only then install the updated compose file and systemd units
above and `systemctl daemon-reload` before restarting
`usage-monitor.service`. Ordering matters: the updated compose file and
`usage-monitor.service` reference the tmpfs env file, which exists only after
a successful sync. The deploy transaction and the sync unit themselves are
safe to install at any time — without the bootstrap file they follow the
legacy disk-env path exactly.

`/etc/usage-monitor/render-api.curl.conf` is a root-owned mode-0600 curl config
containing the Render authorization header. Provision it through the protected
secret handoff, never Git or GitHub Actions. A missing/revoked token defers the
deployment without touching production; a live service, enabled auto-deploy,
or scheduler value other than exactly `false` fails the sole-writer gate.

Keep `/etc/usage-monitor/auto-deploy.paused` present during bootstrap or a
planned freeze. Removing it enables the next timer pass. A failed revision is
retried at most three times, then recorded in
`/var/lib/usage-monitor-deploy/blocked-sha` with a machine-readable
`blocked-sha.json` beside it (`blockedRevision`, `reason` —
`max_failures` or `terminal_eligibility` — and `blockedAt`); a new main
revision resets that circuit automatically. Host-environment preflight
failures (unmounted or wrong `/data` volume, disk floors, live SQLite
integrity/foreign-key checks, runtime-env invariants) exit with the dedicated
status 79 and are retried every timer pass **without** consuming the
three-strike budget — they are properties of the box, not of the revision, so
freeing the disk is enough; no `--retry-blocked` is needed for them. While a
revision is latched, the poller deliberately exits non-zero on every pass so
`systemctl is-failed usage-monitor-auto-deploy.service` is a reliable wedge
signal (it previously reported success while latched, which repainted the unit
green a minute after the wedge). Mount-gated app recovery still runs before
the breaker check, so a latched deploy pipeline never blocks restarting the
accepted writer. A failed required GitHub check is re-evaluated every
five minutes so a successful same-SHA rerun can recover without a new PR. After
an operator fixes a transient external condition,
`sudo /usr/local/sbin/usage-monitor-auto-deploy --retry-blocked` explicitly
rearms the same SHA.

The app container permanently keeps Docker restart policy `no`. This prevents
the Docker daemon from starting the SQLite writer against a boot-disk `/data`
directory before the block volume mounts. Only `usage-monitor.service` starts
the app, with mount conditions enforced; the timer can recover a stopped
accepted revision through that unit even while new deployments are paused.
Recovery and deployment use the same host lock, so the timer cannot revive the
previous writer during a manual transaction's intentional cutover stop.

Each transaction builds in a root-owned exact-SHA release checkout while the
old app remains live. It validates a target-image migration against a
transaction-consistent scratch database before stopping anything. The brief
cutover stops and replaces only the app container, never Caddy. Acceptance
requires exact-revision strict readiness, a fresh scheduler tick, three public
readiness samples, R2 Litestream TXID advancement beyond a stable watermark
captured only after the previous writer has fully stopped,
and a full authenticated R2 restore whose SQLite integrity, foreign keys,
and schema match production. The restore gets a bounded 15-minute transfer and
quick-check window, followed by exactly one bounded 30-minute full SQLite
integrity scan. This keeps acceptance fail-closed for a growing database
without duplicating the same full scan inside Litestream and SQLite. Both the
in-container restore process and the Docker client have ordered TERM/KILL
bounds; scratch cleanup first proves no matching restore remains. The systemd
transaction ceiling is four hours so it exceeds the declared serial step
budgets, while its separate stop grace still reserves time for rollback.

The previous full-SHA image and up to five verified offline SQLite snapshots
are retained. Automatic rollback changes code/image only and never replaces
SQLite: restoring an older database after traffic resumes could discard writes
and fork the Litestream lineage. If both candidate and prior images fail, the
transaction stops every app writer instead of risking a second or divergent
writer. Inspect receipts and logs with:

```bash
sudo cat /var/lib/usage-monitor-deploy/current.json
sudo cat /var/lib/usage-monitor-deploy/blocked-sha.json
sudo journalctl -u usage-monitor-auto-deploy.service --since today
systemctl list-timers usage-monitor-auto-deploy.timer
systemctl is-failed usage-monitor-auto-deploy.service
```

Production Litestream targets **Cloudflare R2** (not Hetzner/Coolify Garage —
retired in PR #869). Confirm Infisical `LITESTREAM_S3_ENDPOINT` is
`https://<account-id>.r2.cloudflarestorage.com` and the bucket name matches the
env preflight (`jays-usage-monitor-eu` B2 primary; historic R2 allowed during cutover). Free-tier storage (R2 card) is **account-wide**
across every R2 bucket; see `docs/litestream.md`.

## Backup monitoring

The machine-level singleton at
`/Users/jay/apps/fleet-sentry-monitor/monitor.py` verifies this backup path
without adding another daemon or another alert credential to either server.
Every 15 minutes it:

- SSHes to Oracle and runs authenticated `litestream ltx` tip listing plus a
  no-write `litestream restore -dry-run` against the **R2** replica.
- Enforces a one-hour maximum replica-object age only after
  `USAGE_SCHEDULER_ENABLED=true`; staging with its scheduler disabled still
  verifies authentication and restorability without false stale alerts.
- Reports a Sentry Cron check-in for backup health; the existing
  `fleet-host-monitor` check-in detects absence when the Mac-side singleton
  itself stops.

Once a week the same singleton restores to a fixed Oracle scratch path with
Litestream's `full` integrity check, then removes the database and SQLite
sidecars in a trap. It never overwrites `/data/prod.db` or writes backup
objects. Persistent failures are fingerprint-deduplicated to one Sentry event
per hour.

The pre-cutover candidate started with `USAGE_SCHEDULER_ENABLED=false` and a
separate Litestream target. The completed production migration verified:

1. `/api/health` and `/api/ready?strict=1` from an external network.
2. Authenticated generic ingest and OTLP retry/idempotency probes.
3. A transaction-consistent Litestream restore into a scratch SQLite file,
   `PRAGMA integrity_check`, and representative row-count comparison.
4. One scheduler tick after the sole-writer cutover; never run both schedulers.

The one-time cutover quiesced Render, restored its terminal backup into Oracle,
enabled the sole Oracle scheduler, and then changed DNS. Render remains
suspended as a rollback host. Never reverse DNS to its stale database: a host
rollback requires quiescing Oracle and restoring the latest verified **R2**
lineage before transferring scheduler/writer authority.
