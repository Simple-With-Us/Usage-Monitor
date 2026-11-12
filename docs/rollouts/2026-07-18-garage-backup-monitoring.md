# Garage backup monitoring

## Summary

The existing Mac `fleet-sentry-monitor` singleton now performs an independent,
authenticated check of Oracle's Litestream replica in Coolify Garage. This
closes the gap where `/api/ready` could report `LITESTREAM_ACTIVE=true` while
uploads or restores were failing after process startup.

## Checks

- Every 15 minutes: authenticated all-level LTX listing and restore dry-run
  through Oracle's runtime credentials and private Tailscale-routed endpoint.
- After Oracle becomes the scheduler: alert when the newest replica object is
  more than one hour old. Scheduler-disabled staging does not enforce age.
- Every 15 minutes: Garage container health plus Coolify Docker-filesystem free
  space (15 GiB warning / 8 GiB error).
- Weekly: scratch restore with `litestream restore -integrity-check full`, with
  exact-path cleanup in a trap.
- External alerting: Sentry events plus Cron monitor slug
  `usage-monitor-garage-backup`; the pre-existing `fleet-host-monitor` missing
  check covers loss of the Mac singleton itself.

## Verification receipts

- Oracle authenticated probe parsed Garage through TXID
  `0000000000000003`; its newest LTX object was current during verification.
- Coolify reported Garage `running healthy`; the Docker filesystem had about
  31 GiB free during the first automated pass.
- A full restore drill completed successfully with Litestream's full integrity
  check, and the fixed scratch database plus `-wal`/`-shm` sidecars were absent
  afterward.
- The live PM2 singleton emitted successful Sentry Cron check-ins for
  `usage-monitor-garage-backup` on two consecutive scheduled cycles.
- Usage Monitor's GitHub `Uptime Monitor` scheduled workflow also completed
  successfully against exact production revision
  `3aa573fbd7e5e4bdc7df123099ac447c29824b5a` during this audit.

## Boundaries

No DNS, scheduler/writer authority, production SQLite data, Garage objects,
credentials, or server firewall rules changed. The weekly drill writes only an
exact scratch path on Oracle and removes it before returning.
