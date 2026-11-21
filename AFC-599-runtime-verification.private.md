# AFC-599 Runtime And Local Backup Verification

Private task evidence draft for the parent session, November 3, 2026.  Do not publish this file to the public Usage-Monitor repository.  Scope preserves the Backblaze investigation hold: no new provider inventory, restore, download, cap, schedule or retention change, pruning, deletion, service stop, deployment or credential change.

## Verified Current Runtime

- Fetched published `origin/main` and created the owned `codex/afc599-runtime-verify` lane at revision `23fa597184b68d34dad9c23de1deb2248e5caa60`.  No application code or tracked configuration was changed.
- Public liveness and strict readiness passed at 5:07 AM.  Revision matched the published lane, SQLite probe took 7 ms, database-file continuity passed, scheduler last tick succeeded with zero consecutive failures, startup wrapper was active, and required backup replication was healthy.
- Current app container was running and healthy with zero restarts.  The local process tree contained Litestream supervising `npm start` and Next.js; no process environment was read.
- Local replica side-channel reported success at 5:04 AM with the latest LTX age 1,323 seconds.  This reads a pre-existing status file; no provider probe was triggered by this worker.
- Root filesystem had 97 GiB available at 67% used; the extra volume had 96 GiB available at 59% used.
- Landing route returned 307 to the login route, and login returned 200 with HTML and Next.js chunk references.  A representative referenced JavaScript chunk was checked separately.

## Local Backup Evidence

Installed `/etc/cron.d/fleet-backups` preserves the supplied wall-clock slots: Socratic.Trade at 6:30 AM and 7:30 PM, Congress.Trade at 6:00 AM and 8:00 PM, Usage Monitor at 8:30 PM.  Host timezone is America/Chicago.  Executable lines use `FLEET_BACKUP_KEEP_COUNT=1` and `FLEET_BACKUP_KEEP_DAYS=3650`.  On November 3, the parent session obtained the owner's direct decisions to keep one local dump per app and then to keep all current settings because the owner changed them.  All installed runtime and backup settings therefore remain authorized and unchanged, including the absent mirror and hourly Litestream interval; the earlier four/four/two proposal is superseded and must not be applied or published.  No owner-policy decision remains pending for these settings.

| App | Current Local Snapshot Size | November 2 Local Job Completion |
| --- | ---: | --- |
| Socratic.Trade | 18,460,311,552 bytes | 9:05 PM |
| Congress.Trade | 3,065,745,408 bytes | 8:16 PM |
| Usage Monitor | 5,249,589,248 bytes | 8:54 PM |

Each latest per-run local log records its dump integrity success before local job completion, and the dump files have checksum sidecars.  These are observed job results, distinct from a new independent verification.

The app's reported one local snapshot aged four days is a different layer: `getLocalBackupRuntimeStatus` in `src/lib/runtime-health.ts:948` only enumerates the database directory's `.pre-migration-backups`, with a 14-day age threshold.  It never enumerates the scheduled host dumps.  The pre-migration snapshot is 4,398,886,912 bytes and was last modified October 29 at 9:41 PM.  This explains the app-versus-host discrepancy without changing either layer.

## Restore Evidence And Bounded Check Limits

Existing `/var/log/fleet-backup/cron-weekly.log:111` records the October 31 11:30 PM Usage Monitor drill.  It passed local-dump integrity plus a nonempty schema query, local-dump SHA-256, and Litestream restored-database integrity plus a nonempty schema query; the run finished `fail=0`.  Inspection of `/usr/local/sbin/fleet-backup-verify-weekly.sh` confirms those operations.  This is historical restore proof for that run and its recovery points; it does not prove the current latest replica or each scheduled provider checkpoint.

The initial independent read-only checksum and SQLite checks on the current Usage Monitor host dump reached their 45-second limits with no result and exit 124.  The parent subsequently authorized one sequential retry of each with 180-second bounds, `nice -n 19` and idle I/O priority.  The current dump's SHA-256 check passed.  The longer immutable read-only SQLite `quick_check` plus table/provider counts reached its 180-second bound with no output and exit 124; no table/provider counts were obtained.  This is a verification limit rather than a corruption finding.  No further retry, live database integrity scan or full application test suite was run.

The inherited handoff's paused download-and-decompress verification remains distinct from the later successful weekly Litestream restore.  No new restore or download was performed in this task.  Authenticated dashboard cold-route behavior was not re-tested; the parent requested public landing/login/static checks without obtaining credentials.

## Remaining Observations

- Public readiness reports the historic R2 weekly archive as `archive_failed` with no successful key or age.  That layer does not gate overall readiness, and the Backblaze/provider hold was preserved; no provider-side diagnosis was attempted.
- The cron header claims an hourly root-drive mirror, but `/backups`, `/usr/local/sbin/fleet-backup-mirror.sh` and `/etc/cron.d/fleet-backup-mirror` are absent.  The remaining `cron-mirror.log` records one October 31 3:17 PM completion.  The owner has now directed preservation of all current settings, including the absent mirror; the stale comment does not create a required repair.  Nothing was recreated or edited.
- No clear safe runtime fix was established.  Current services, local backup jobs, and Litestream replication remain active.  Do not interpret green readiness as proof of authenticated dashboard performance, every backup layer, or all remote restore points.

## Follow-Up Runtime Evidence

The live container's `/app/litestream.yml` has `sync-interval: 1h`.  The existing replica side-channel's 1,323-second LTX age at 5:04 AM is within that configured hourly cadence.  A source WAL modification at 5:12 AM proves ongoing local writes; it does not establish their replication.  A successful heartbeat means the existing inventory probe passed, rather than proving a new upload or current restore.  No provider operation was started by this worker.

The final bounded local container log sample contained 654 lines, including 573 Go-style severity records, with zero WARN or ERROR severity records.  Two generic error-keyword occurrences were outside that severity format and remained unclassified; these were not claimed as clean application-error coverage.  No download-cap, upload-cap, storage-cap or checksum-mismatch keyword appeared.  The pre-existing R2 archive status stores only `ok=false`, `reason=archive_failed` and an October 31 11:14 PM check time; it does not retain an underlying exception.  The private `local-runtime-log-summary.json` contains counts and classifications without raw log messages.  Public liveness passed again at 5:15 AM on the same revision.

## Superseded Retention Proposal

The parent's requested decision preparation produced a mode-0600 installed before-image, proposed file, exact diff, verification metadata and generator in this lane.  The installed before-image SHA-256 is `80e056fb71ae47abe25be83221fcbb8ae7930a28a4ee732c981fdb9aac545baf`.  The unapplied four/four/two candidate's SHA-256 is `0a27216aca86938ccf3a6a8b0cf2bb5f0f2e3188dd3ad6b3d934eac21237fc88`.  All executable cron rows passed `bash -n`; schedules, locks, remote flags, health and weekly verification rows were preserved.  The installed digest was rechecked unchanged.

**Rejected by the owner's current decision: do not apply or publish `fleet-backups.local-retention.patch` or `fleet-backups.proposed`.**  Preserve current one-copy retention.  The candidate exists only as private decision-preparation evidence; it made no host configuration change.

## Source References

- Original handoff: `/mnt/fleet-extra/Code/Docs/Fleet-OPS/documents/docs/reports/2026-10-30-document-library-and-app-recovery-handoff.md`.
- Published implementation context: `docs/rollouts/2026-10-29-startup-backup-recovery.md`; original PR #1839 revision `9a43d65b793c4f8f6433edbe81ddaa6842be01e0`.
- Installed local cron and scripts: `/etc/cron.d/fleet-backups`, `/usr/local/sbin/fleet-sqlite-backup.sh`, `/usr/local/sbin/fleet-backup-verify-weekly.sh`.
- Current per-run logs: `/var/log/fleet-backup/sqlite-20261103T013001Z.log`, `/var/log/fleet-backup/sqlite-20261103T020001Z.log`, `/var/log/fleet-backup/sqlite-20261103T023001Z.log`.
- Current local host dumps: `/mnt/fleet-extra/backups/{socratic,congress,usage-monitor}/`; `/data/backups` remains a symlink to that root.

