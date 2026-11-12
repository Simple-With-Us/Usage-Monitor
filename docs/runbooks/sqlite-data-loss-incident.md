# Runbook: live SQLite database deleted or replaced under the running writer

Audience: the on-call operator on the Oracle A1 production VM.
Trigger: `/api/ready?strict=1` reports `checks.databaseFile.ok=false` with
reason `database_file_unlinked`, `database_file_missing`, or
`database_file_replaced` — or any other evidence that `/data/prod.db` is gone
or has been swapped while the app container is still running.

> ## DO NOT RESTART ANYTHING
>
> While the writer process is alive, its open file descriptors on the deleted
> inode are **the only remaining copy of every write since the last replica
> sync**. `docker stop`, `docker restart`, `systemctl restart usage-monitor`,
> a deploy cutover, or a VM reboot closes those descriptors and the kernel
> frees the inode — **restart-before-descriptor-capture permanently destroys
> the only remaining copy**. `SELECT 1` keeps succeeding against a deleted
> inode, so "the app still answers" is not evidence that anything is safe.

Timeline discipline: steps 1–4 are minutes-critical (anything that stops the
process destroys data). Everything after capture can be slow and careful.

## 1. Freeze the writer — pause, not stop

Pausing (cgroup freeze) halts new writes and timers without closing a single
descriptor. Stopping closes descriptors. Pause.

```bash
sudo docker pause usage-monitor-app-1
```

## 2. Halt everything that could restart or replace the writer

The auto-deploy timer runs every minute and a deploy cutover stops the app
container; the systemd unit can also be restarted by a well-meaning human.
Disable all of it before touching the data:

```bash
sudo touch /etc/usage-monitor/auto-deploy.paused
sudo systemctl stop usage-monitor-auto-deploy.timer
# Tell the other operators/agents an incident is active (Slack #ag***-s**c).
```

Do NOT stop `usage-monitor.service` — it would stop the paused container.

## 3. Locate the live process and its deleted descriptors

```bash
pid="$(sudo docker inspect --format '{{.State.Pid}}' usage-monitor-app-1)"
sudo ls -l "/proc/${pid}/fd" | grep -F '/data/prod.db'
```

You are looking for entries like `-> /data/prod.db (deleted)` plus the
`-wal` / `-shm` sidecars. The container runs several processes (litestream,
node); if the fds are not on the compose top pid, walk the children:
`ps --ppid "${pid}" -o pid,args` and inspect each child's `/proc/<pid>/fd`.
Record every fd number and which file it points at.

## 4. Capture the descriptor contents to root-only storage

Capture to a root-owned mode-0700 directory. `/data` has the headroom (the
deploy gate keeps ≥5 GiB free); use `/root` instead if `/data` itself is
suspect. Check `df -h /data` against the database size first.

```bash
ts="$(date -u +%Y%m%dT%H%M%SZ)"
inc="/data/.incident-${ts}"
sudo install -d -o root -g root -m 0700 "${inc}/raw"
# Staging dir for the replica-restore step below: that container runs as
# uid 1000 and cannot write into the root-owned ${inc}, so give it its own
# 0700 subdirectory now and move the candidate up after it verifies.
sudo install -d -o 1000 -g 1000 -m 0700 "${inc}/restore-staging"

# Substitute the fd numbers found in step 3. The kernel serves the full file
# contents through /proc even though the pathname is gone. Copy the main
# database AND its -wal (and -shm if present) under their proper sidecar
# names, so SQLite can replay the WAL later:
sudo cp "/proc/${pid}/fd/<FD_DB>"  "${inc}/raw/prod.db"
sudo cp "/proc/${pid}/fd/<FD_WAL>" "${inc}/raw/prod.db-wal"
sudo cp "/proc/${pid}/fd/<FD_SHM>" "${inc}/raw/prod.db-shm"   # if present
sudo chmod 0600 "${inc}"/raw/*
sync
```

Only after these copies exist (and `ls -l` shows plausible sizes) has the
"restart destroys everything" window closed.

## 5. Build a transaction-consistent recovery candidate (SQLite backup API)

Never hand the raw copy to the app. Run the backup API against the copy — it
replays the WAL and produces a consistent snapshot; then validate it:

```bash
sudo sqlite3 "${inc}/raw/prod.db" ".backup '${inc}/candidate-fd.db'"
sudo sqlite3 "${inc}/candidate-fd.db" 'PRAGMA integrity_check;'    # expect: ok
sudo sqlite3 "${inc}/candidate-fd.db" 'PRAGMA foreign_key_check;'  # expect: no output
```

If `.backup` or the integrity check fails, keep the raw copies untouched and
retry with `sqlite3 ... ".recover"` into a fresh file; escalate to the owner
before proceeding with a `.recover` result.

## 6. Assemble the comparison candidates

Produce the alternatives, so the choice of restore source is evidence, not
hope:

- **R2/Litestream replica** (`usage-monitor-prod-v3` on Cloudflare R2 — never a
  retired Garage or legacy bucket lineage): the app container is paused, so run
  the restore from a disposable container using the accepted image and runtime
  env (mirrors the deploy transaction's offline pattern):

  ```bash
  rev="$(sudo awk -F= '$1=="USAGE_MONITOR_REVISION"{print $2}' /etc/usage-monitor/host.env)"
  sudo docker run --rm --pull=never --read-only \
    --network oracle_internal \
    --env-file /run/usage-monitor/usage-monitor.env \
    --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
    -v /data:/data \
    --entrypoint /app/bin/litestream \
    "usage-monitor:${rev}" \
    restore -config /app/litestream.yml -o "/data/.incident-${ts}/restore-staging/candidate-replica.db" /data/prod.db
  sudo mv "${inc}/restore-staging/candidate-replica.db" "${inc}/candidate-replica.db"
  ```

  (The `-o` path goes through the uid-1000 `restore-staging` dir created in
  step 4 — the container user cannot write into the root-owned `${inc}`
  directly. If `/run/usage-monitor/usage-monitor.env` is missing, run
  `sudo /usr/local/sbin/usage-monitor-env-sync` first.)
- **Pre-migration / deploy backups** already on disk:
  `/data/.deploy-backups/` (offline cutover snapshots) and the
  `backup-sqlite-before-migrate.mjs` snapshots — newest first.

## 7. Validate and compare every candidate

For each candidate (`candidate-fd.db`, `candidate-replica.db`, newest deploy
backup), record the results side by side:

```bash
db=<candidate>
sudo sqlite3 "${db}" 'PRAGMA integrity_check;'
sudo sqlite3 "${db}" 'PRAGMA foreign_key_check;'
# Schema shape matches the running release's expectations (compare the hash
# across candidates; it must also match a known-good deploy backup):
sudo sqlite3 "${db}" '.schema' | sha256sum
# Volume + recency of the hottest tables:
sudo sqlite3 "${db}" 'SELECT count(*), max(fetchedAt) FROM "UsageSnapshot";'
sudo sqlite3 "${db}" 'SELECT count(*), max(occurredAt) FROM "ExternalUsageEvent";'
# Money totals — the numbers this product exists to keep correct:
sudo sqlite3 "${db}" 'SELECT round(sum(totalCost), 6) FROM "UsageSnapshot";'
sudo sqlite3 "${db}" 'SELECT round(sum(costUsd), 6) FROM "ExternalUsageEvent";'
sudo sqlite3 "${db}" 'SELECT round(sum(latestTotalCost), 6) FROM "UsageSnapshotDailyRollup";'
```

Decision rule: prefer the candidate with the most recent committed data that
passes integrity + foreign keys — normally `candidate-fd.db` (it contains
writes the replica had not shipped yet), with `candidate-replica.db` expected
to trail it by at most the replication lag. If the descriptor candidate is
*behind* the replica, or money totals diverge between candidates by more than
the lag window explains, stop and get an owner decision before restoring —
you may be looking at a replaced/foreign database, not simple deletion.
`database_file_replaced` incidents additionally require deciding what the
imposter file at the pathname is; preserve it into `${inc}/` too.

## 8. Stop the writer — now safe — and restore the pathname atomically

Only after the chosen candidate is validated:

```bash
# The paused process's data is captured; it may now die.
sudo docker unpause usage-monitor-app-1
sudo systemctl stop usage-monitor
sudo docker update --restart=no usage-monitor-app-1 || true

# Preserve whatever sits at the pathname today (imposter or nothing):
[ -e /data/prod.db ] && sudo mv /data/prod.db "${inc}/replaced-pathname.db"
sudo rm -f /data/prod.db-wal /data/prod.db-shm   # stale sidecars must not pair with the restored file

# Stage on the SAME filesystem, then atomic rename into place:
sudo cp "${inc}/candidate-fd.db" /data/.prod.db.restore-staging
sudo chown 1000:1000 /data/.prod.db.restore-staging
sudo chmod 0600 /data/.prod.db.restore-staging
sync
sudo mv /data/.prod.db.restore-staging /data/prod.db
sync
```

`mv` within `/data` is a rename(2): the pathname flips to the restored inode
in one step and no process can ever observe a half-written database.

## 9. Staged re-enable — backup, then scheduler, then traffic, then deploys

Bring layers back one at a time, each verified before the next:

1. **Backup layer.** Decide the replica lineage with the owner: if the
   restored file diverges from what R2 holds (candidate-fd ahead of the
   replica is normal and fine; a `.recover` result or an older-than-replica
   restore is not), seed a fresh bucket (the `usage-monitor-prod-v3` seeding
   is precedent) rather than letting two histories interleave in one prefix.
   Then start the app with the scheduler still disabled (set
   `USAGE_SCHEDULER_ENABLED=false` in Infisical, `sudo
   /usr/local/sbin/usage-monitor-env-sync`, `sudo systemctl start
   usage-monitor`) and confirm replication resumes: litestream `replica sync`
   lines in `sudo docker logs usage-monitor-app-1`, a fresh
   `/data/.litestream-replica-status.json`, and
   `checks.backup.replicaOk=true`.
2. **Readiness.** `curl -fsS https://usage.jays.services/api/ready?strict=1`
   must show `checks.database.ok=true` and `checks.databaseFile`
   `{ok:true, checked:true}` — the file-identity baseline re-captures at boot.
3. **Scheduler.** Set `USAGE_SCHEDULER_ENABLED=true` (Infisical → sync →
   `sudo systemctl restart usage-monitor`), watch one tick complete
   (`checks.scheduler.lastTickSucceeded=true`) and spot-check that money
   totals via the API match step 7's chosen candidate.
4. **Traffic.** Traffic follows the app behind Caddy/Cloudflare; with strict
   readiness green, confirm UptimeRobot/uptime workflows recover.
5. **Deploys last.** `sudo systemctl start usage-monitor-auto-deploy.timer`
   and `sudo rm /etc/usage-monitor/auto-deploy.paused` only after a full
   scheduler tick and fresh replica heartbeat — a deploy re-runs its own
   preflight integrity gates and must never race the recovery.

   **Host prep before the first post-recovery deploy:** current `main`
   requires the replica heartbeat (`env_active_unverified` fails strict
   readiness). If the probe + timer + updated compose from
   `deploy/oracle/` are not installed on the host yet, the first deploy of
   a heartbeat-gated revision will fail readiness three times — each a full
   build + writer-stop cutover + rollback — and latch the breaker. Install
   the probe first and confirm `/data/.litestream-replica-status.json` is
   fresh, or set `LITESTREAM_REPLICA_VERIFICATION_REQUIRED=false` in
   Infisical for exactly one deploy (see "Rollout ordering" in
   `deploy/oracle/README.md`).

## 10. Afterwards

- Keep `${inc}/` (raw fd copies, all candidates, the replaced-pathname file)
  root-only for at least 30 days.
- Write a `docs/rollouts/YYYY-MM-DD-sqlite-data-loss-incident.md` note: what
  deleted/replaced the file, timeline, chosen candidate, row/money deltas,
  lineage decision.
- Verify the next deploy's `preflight_current_production` passes and the
  fleet-sentry weekly restore drill stays green.

## Why this works (background)

On Linux, `unlink()` removes a pathname, not the file: the inode lives until
the last open descriptor closes. SQLite (and therefore Prisma and `SELECT 1`)
keeps operating on the open inode indefinitely, which is exactly why the
deletion was silent before `/api/ready` grew the `databaseFile` identity
check, and exactly why the running process is simultaneously the incident's
victim and its only backup of the unshipped tail. `/proc/<pid>/fd/<n>` is a
first-class handle to that inode, so `cp` from it recovers the full contents
— but only while the process lives. Hence: pause first, capture second,
restart never (until step 8).
