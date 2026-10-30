# Startup And Backup Recovery

The October 29 recovery addressed separate startup, SQLite responsiveness, and replica integrity failures.  A healthy process or a fresh backup object alone does not prove that the dashboard responds or that the database can be restored.

- PR1821 skips the full pre-migration snapshot only after a successful no-drift schema comparison; real migrations still require a verified snapshot.
- PR1828 pins the Docker runtime to Node 24 and adds the quota and month-to-date scan indexes.
- PR1830 forwards shutdown signals through the Infisical wrapper, separates replacement Litestream metadata from the retired chain, and provides an explicit repair for legacy integer timestamps in the two alert delivery tables.
- PR1832 moves the cold maintenance tombstone count into a bounded read-only child process and improves month-to-date keyset seeks.  The dashboard follow-up replaces its long raw usage aggregates with bounded keyset scans that yield between pages.

The old replica failed restored-database integrity checks despite a fresh heartbeat and a successful restore plan.  The replacement chain passed two independent restores with SQLite quick integrity checks: first the full baseline, then the caught-up baseline plus deltas.  Both restored databases contained 35 tables and 32 providers.  The second restored database was 5,239,009,280 bytes.  This verifies those restore points; later replica freshness must still be checked separately.

The latest daily host snapshot passed its SHA-256 check, and the weekly restore drill had independently passed dump checksum, restored-database integrity, and schema queries.  The R2 weekly archive status records successful download, checksum, decompression, and integrity verification.  Current policy keeps the primary Litestream history for 72 hours and two weekly R2 archives.

Production deployment must serialize access to the shared SQLite volume: use a consistent container name and allow the configured shutdown grace period.  Restore automatic deployment before releasing a merge hold, then verify the deployed revision and actual queue rather than assuming the webhook ran.

For cold-start verification, exercise the normal authenticated dashboard request concurrently with health, strict readiness, and quota reads through the first scheduler tick.  Check the replacement replica after deployment.  Remove temporary timing probes before final verification.
