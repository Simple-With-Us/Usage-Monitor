# Startup And Backup Recovery

The October 29 recovery addressed separate startup, SQLite responsiveness, and replica integrity failures.  A healthy process or a fresh backup object alone does not prove that the dashboard responds or that the database can be restored.

- PR1821 skips the full pre-migration snapshot only after a successful no-drift schema comparison; real migrations still require a verified snapshot.
- PR1828 pins the Docker runtime to Node 24 and adds the quota and month-to-date scan indexes.
- PR1830 forwards shutdown signals through the Infisical wrapper, separates replacement Litestream metadata from the retired chain, and provides an explicit repair for legacy integer timestamps in the two alert delivery tables.
- PR1832 moves the cold maintenance tombstone count into a bounded read-only child process and improves month-to-date keyset seeks.  The dashboard follow-up replaces its long raw usage aggregates with bounded keyset scans that yield between pages.

The old replica failed restored-database integrity checks despite a fresh heartbeat and a successful restore plan.  The replacement chain passed two independent restores with SQLite quick integrity checks: first the full baseline, then the caught-up baseline plus deltas.  Both restored databases contained 35 tables and 32 providers.  The second restored database was 5,239,009,280 bytes.  This verifies those restore points; later replica freshness must still be checked separately.

The second restored database also passed the full SQLite integrity check.  After deployment, 164 concurrent health probes completed without failures through the initial scheduler tick and dashboard reads.  However, transferring all bounded raw rows through Prisma still produced a 49-second cold portfolio response, exceeding the UI's 30-second timeout.  A follow-up aggregated each materialized 2,000-row page inside SQLite and returned only its groups and continuation cursor.  This kept health responsive, but portfolio responses still exceeded 30 seconds during a concurrent restore.

The final implementation runs the four large native aggregates in read-only child processes.  The process-global reader pool allows two active workers and eight queued requests; each worker has a 25-second deadline, 64 MiB Node heap, 8 MiB output limit, and a fail-closed 10,000-result-row cap.  Workers receive only the database path, validated dates, a static query mode, PATH and NODE_ENV.  Receipt validation and cash/estimate folding remain in the parent.  Native packed timestamp/ID maxima preserve latest non-null limit provenance across tied timestamps.  A production exercise of all four modes with two simultaneous readers completed in 5.95 seconds; 47 relevant tests passed.  Actual cold-start route timing remains a required deployment check.

Two further replacement-chain restores passed quick integrity checks across deployment and diagnostic restarts, with 35 tables and 32 providers.  The latest restored database was 5,263,912,960 bytes.  Temporary query timing was removed before the clean runtime verification.

The latest daily host snapshot passed its SHA-256 check, and the weekly restore drill had independently passed dump checksum, restored-database integrity, and schema queries.  The R2 weekly archive status records successful download, checksum, decompression, and integrity verification.  Current policy keeps the primary Litestream history for 72 hours and two weekly R2 archives.

Production deployment must serialize access to the shared SQLite volume: use a consistent container name and allow the configured shutdown grace period.  Restore automatic deployment before releasing a merge hold, then verify the deployed revision and actual queue rather than assuming the webhook ran.

For cold-start verification, exercise the normal authenticated dashboard request concurrently with health, strict readiness, and quota reads through the first scheduler tick.  Check the replacement replica after deployment.  Remove temporary timing probes before final verification.
