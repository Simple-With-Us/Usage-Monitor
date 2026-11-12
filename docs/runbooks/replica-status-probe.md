# Replica status probe (Coolify / Hetzner)

Operator runbook for the Litestream LTX side-channel that feeds
`/api/ready` `checks.backup`.  Architecture and B2 setup stay in
`docs/litestream.md`.  This page covers **how the probe decides**,
**why Coolify needs a host fallback**, and **how to read the reasons**.

Verified against `scripts/replica-status-heartbeat.sh`,
`deploy/coolify/replica-status-probe.sh`, `src/lib/runtime-health.ts`
`getBackupRuntimeStatus`, and `src/app/api/ready/route.ts` as of
#1354 / #1355 (`cfd532b`); host-probe cost trim (drop the always-failing
`docker exec --once` attempt, adaptive level-0-first escalation, 30min
cadence) as of 2026-08-31 (PR #1378).

## Intent

Prove the off-site replica is advancing without making product readiness
depend on B2 listing.  The money-truth is live SQLite on `/data`.
Backup health is **observability only**: it never flips overall
`/api/ready` `ok`, and `?strict=1` uses that same `ok`
(database + databaseFile + scheduler + startup).

The probe writes `/data/.litestream-replica-status.json` (override with
`LITESTREAM_REPLICA_STATUS_PATH`).  JSON contract:

```json
{"ok": true, "checkedAt": "2026-08-25T15:00:00Z", "ltxAgeSeconds": 420, "reason": null}
```

- `checkedAt` drives staleness in Next.js (`LITESTREAM_REPLICA_MAX_AGE_SECONDS`, default 10800).
- `ltxAgeSeconds` is operator detail.  A frozen LTX age with a fresh `checkedAt` still passes the file-age gate.
- The heartbeat **omits** `ageSeconds` on purpose so a frozen file cannot pass forever.

## Architecture

Two writers, one status file:

| Path | Who | Credentials | When |
|---|---|---|---|
| Looping heartbeat | `scripts/replica-status-heartbeat.sh` (child of `start-with-litestream.sh`) | Inherits Infisical from the process tree | Every `LITESTREAM_REPLICA_HEARTBEAT_INTERVAL_SECONDS` (default 600) |
| Host oneshot | `deploy/coolify/replica-status-probe.sh` as `/usr/local/sbin/usage-monitor-replica-status` | Host env-file fallback (below) | 30-minute systemd timer, 1-5 LTX calls per tick (adaptive, see below) |

Coolify injects Infisical into the **running process tree only**.
`docker exec` does not see those vars, so a bare `litestream ltx` inside
`docker exec` fails with "bucket required" / `replica_credentials_missing`.

### Host oneshot order (2026-08-31, superseding #1355)

The host oneshot goes **straight to the env-file fallback** — it no longer
attempts `docker exec … replica-status-heartbeat.sh --once` first. That
attempt was structural dead weight, not a real fallback candidate: a bare
`docker exec` on Coolify never carries the Infisical-injected
`LITESTREAM_S3_*` env, so it failed with `replica_credentials_missing` on
every single tick and the host script always fell through anyway. Removing
it drops one wasted `docker exec` + bash spawn per tick.

1. Read the litestream `replicate` PID environ via `docker top` +
   `/proc/<pid>/environ`.
2. Write a mode-0600 env file, `docker exec --env-file` for `-level 0` then
   `-level 9`, then delete the env file.

#1355's history (trust an in-container `--once` write only when it exits 0
**and** `reason` is not `replica_credentials_missing`) is retained here for
context — that logic no longer exists in the script.

### Secret constraint (#1354)

Never pass `LITESTREAM_S3_*` (or `AWS_*` replica keys) as
`docker exec -e KEY=VALUE`.  systemd journals capture argv.
Host fallback uses `--env-file` only.

## What it lists

Both heartbeat and host fallback call:

```text
litestream ltx -json -config /app/litestream.yml -level N /data/prod.db
```

| Writer | Levels queried | Pick rule |
|---|---|---|
| Looping heartbeat (in-container) | 0–3 continuous + 9 snapshot, every tick | Newest timestamp among successful non-empty continuous lists; snapshot (9) used only when 0–3 are empty, `reason=snapshot_only` |
| Host oneshot (2026-08-31) | **Adaptive: 0 first, then 1-3, then 9** | Try level 0 alone (the common case — replication actively writing — resolves in this single call). Only escalate to 1-3 when 0 comes back empty/erroring/timed-out: litestream's default L0 retention is brief, so a compaction can legitimately leave L0 empty for a beat with no new writes since, while the true continuous tip already sits at L1-L3 — skipping straight to a snapshot in that case would misreport a healthy replica as stale. Level 9 is queried only when no continuous tip was found at any level. Net: 1 Backblaze Class C LIST call/tick in steady state, up to 5 only during the rare escalation |

An earlier version of this trim queried only levels {0, 9} unconditionally,
on the (wrong) assumption that levels 1-3 could never hold a freshness
signal level 0 didn't already have. Caught by code review before merge
(PR #1378) — see `scripts/test-replica-status-probe.sh`'s escalation
self-test, which execs the real embedded Python against mocked
`subprocess.run` responses specifically to keep this regression from
coming back silently.

Timeouts are 60s (heartbeat) / 70s (host).  TLS / ListObjectsV2 hangs
classify as `list_timeout`, not `no_parseable_ltx`.

## Operator reasons

Written on the status file and passed through `checks.backup.reason`
when `replicaOk` is false (except file-age, which becomes
`replica_status_stale`).

| Reason | Meaning | Typical next step |
|---|---|---|
| `null` | Continuous LTX tip within budget | None |
| `snapshot_only` | Only level 9 has a tip; still `ok=true` if age ≤ budget | Confirm L0–L3 are not wedged; not an outage by itself |
| `ltx_age_exceeds_budget` | Newest tip older than 10800s | Check `litestream replicate` logs / B2 writes |
| `list_timeout` | ListObjectsV2 / TLS / deadline | B2 or network; retry; do not treat as missing creds |
| `list_error` | Non-timeout list failure | Logs + endpoint / bucket name |
| `empty_ltx` | All listed levels returned `[]` | Fresh replica or wrong prefix |
| `no_parseable_ltx` | No usable timestamp and no more specific class | Inspect raw `ltx -json` |
| `replica_credentials_missing` | `LITESTREAM_S3_*` incomplete **in that process** | Only the looping in-container heartbeat can report this now — a real config problem worth checking Infisical/env for. The host oneshot no longer attempts a bare `docker exec` and cannot hit this reason itself |
| `litestream_not_running` | Host fallback found no `litestream replicate` PID | Container / entrypoint |
| `litestream_binary_missing` | `/app/bin/litestream` not executable | Image build / `fetch-litestream.sh` |
| `r2_free_tier_disabled` | R2 endpoint + kill flag / `R2_WRITES_DISABLED` | Intentional pause; ignored on B2 |
| `invalid_ltx_timestamp` | JSON timestamp would not parse | Litestream version / listing format |
| `replica_status_missing` | Next.js: status path set, file absent | Timer not installed or volume mismatch |
| `replica_status_stale` | Next.js: `checkedAt` older than budget | Probe not refreshing |
| `replica_status_unreadable` | Next.js: read/parse failed, or host could not read PID environ | Permissions / JSON |
| `env_active_unverified` | Next.js: no `LITESTREAM_REPLICA_STATUS_PATH` | Set the path; `envOnly=true` |

## Pitfalls

- **Don't re-add an in-container `docker exec --once` attempt to the host
  script.**  It was removed 2026-08-31 because it always failed on Coolify
  (`replica_credentials_missing`) and always fell through anyway — it only
  ever cost a wasted `docker exec` + bash spawn per tick.
- **Don't drop levels 1-3 from the host oneshot's escalation path to save
  calls.**  Level 0 alone is *usually* sufficient, but litestream's L0
  retention is brief; querying only {0, 9} unconditionally can report a
  healthy replica as stale (or worse, `empty_ltx`) whenever a compaction
  has just cleared L0 with no new writes since.  Escalate to 1-3 before
  falling back to the snapshot — see "What it lists" above.
- **Host script exit 0 is not "replica healthy".**  After a verdict is
  written, the oneshot exits 0 so systemd does not disable the timer.
  Read the JSON `ok` / `reason`.
- **Do not `docker exec -e LITESTREAM_S3_SECRET_ACCESS_KEY=…`.**  Journal leak.
- **`/api/ready` `ok` staying true is not backup-healthy.**  Watch
  `checks.backup.replicaOk` and Settings / iOS `backupLayers`.
- **Do not require `reason=null`.**  `snapshot_only` is a healthy
  continuous-empty / snapshot-present state.
- **UUID container + volume names.**  Prefix comes from
  `USAGE_MONITOR_COOLIFY_UUID` / fleet-ops, not `usage-monitor-app-1`.
- **#1353 leftover.**  Do not rematch the pre-`--env-file` argv-leak PR.

## Install / verify (Coolify host)

sudo install -o root -g root -m 0755 deploy/coolify/replica-status-probe.sh \
  /usr/local/sbin/usage-monitor-replica-status
sudo install -o root -g root -m 0644 deploy/coolify/usage-monitor-replica-status.service \
  /etc/systemd/system/usage-monitor-replica-status.service
sudo install -o root -g root -m 0644 deploy/coolify/usage-monitor-replica-status.timer \
  /etc/systemd/system/usage-monitor-replica-status.timer
sudo systemctl daemon-reload
sudo systemctl enable --now usage-monitor-replica-status.timer
sudo /usr/local/sbin/usage-monitor-replica-status
# journal: expect "using host env-file LTX fallback" then either
# "replica healthy: age=...s" or an explicit reason line;
# never a leftover -e KEY=value in TimeoutExpired.cmd

curl -fsS https://usage.jays.services/api/ready | jq '{ok, backup: .checks.backup}'
```

Offline:

```bash
bash scripts/test-replica-status-probe.sh
bash scripts/replica-status-heartbeat.sh --self-test
```
