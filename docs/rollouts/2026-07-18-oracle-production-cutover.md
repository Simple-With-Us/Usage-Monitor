# Oracle production cutover receipt

Date: 2026-07-18

## Final topology

- Production: `usage.jays.services` on Oracle Cloud Always Free A1
  (`132.226.90.164`), running ARM64 image
  `usage-monitor:80d79e522826c5676d9ad3defa3418c7561b9920`.
- Persistent SQLite: `/data/prod.db` on the separate `/dev/sdb` 100 GB ext4
  block volume, uid/gid 1000, mode 0600.
- Off-site SQLite replica: Litestream 0.5.13 to the Coolify Garage bucket
  `usage-monitor-prod-v3` over the private Tailscale path.
- Rollback host: Render retained in the suspended state with maintenance mode
  enabled, scheduler disabled, auto-deploy disabled, and no running instance.

## Sole-writer cutover

1. Render was redeployed at the frozen production revision with
   `USAGE_SCHEDULER_ENABLED=false`. Strict readiness proved the scheduler was
   disabled while database, startup, and the Render R2 backup remained healthy.
2. Render maintenance mode blocked public reads and writes with HTTP 503 while
   SSH and Litestream stayed available. SQLite counts/watermarks and R2 stopped
   changing at terminal TXID `0x135bb`.
3. Render was suspended. The R2 TXID remained stable in two post-suspension
   listings.
4. Oracle restored the terminal R2 image with Litestream's full integrity
   check. SQLite integrity returned `ok`, foreign-key violations were zero, and
   the exact stopped-Render counts/watermarks matched:

   | Table | Terminal rows |
   | --- | ---: |
   | `Provider` | 48 |
   | `UsageSnapshot` | 6,315 |
   | `ExternalUsageEvent` | 416,715 |
   | `Subscription` | 3 |

5. With both Render and the Oracle staging app stopped, Oracle preserved the
   previous database, WAL/SHM files, and protected environment files, promoted
   the terminal database, enabled the sole scheduler, and selected a fresh
   Garage bucket.

## Backup correction and proof

The first production seed into `usage-monitor-prod-v2` failed the independent
restore check. DNS remained unchanged. The invalid v2 lineage was retained for
diagnosis rather than trusted or silently repaired in place.

Oracle then stopped the app, created and verified a transaction-consistent
SQLite backup, promoted that clean image, reset only Litestream's local LTX
cache, and selected a new empty `usage-monitor-prod-v3` bucket. The v3 lineage
uploaded a full baseline followed by post-start transactions. A separate full
restore passed Litestream and SQLite integrity checks, returned zero foreign-key
violations, and exactly matched the live post-tick database:

| Table | Live rows | Restored rows |
| --- | ---: | ---: |
| `Provider` | 48 | 48 |
| `UsageSnapshot` | 6,337 | 6,337 |
| `ExternalUsageEvent` | 416,715 | 416,715 |
| `Subscription` | 3 | 3 |

Production traffic subsequently advanced the v3 LTX sequence beyond that proof.
The Garage authenticated dry-run and Coolify container/disk probes are green.

## DNS, TLS, and monitoring

- Cloudflare changed `usage.jays.services` from the Render CNAME to an
  unproxied A record for `132.226.90.164`, TTL 60.
- Cloudflare's API plus `1.1.1.1`, `8.8.8.8`, and `9.9.9.9` agree on the Oracle
  address.
- Caddy obtained a public Let's Encrypt certificate whose SAN contains exactly
  `DNS:usage.jays.services`.
- Public `/api/health` and `/api/ready?strict=1` return HTTP 200 at the frozen
  revision. Database and startup are healthy; backup is required and active;
  the scheduler is required and its first Oracle tick completed successfully.
- GitHub Uptime Monitor run
  [29663357832](https://github.com/jaywedgeworth22/Usage-Monitor/actions/runs/29663357832)
  passed immediately after the DNS flip.
- The Sentry `usage-monitor-garage-backup` recovery check-in returned HTTP 200.
  Existing free UptimeRobot liveness and strict-readiness monitor definitions
  target the unchanged production URLs; their account-side state was not
  independently queried during cutover.

## Observation and release boundary

- The controlled maintenance window lasted approximately 25 minutes, from the
  Render HTTP 503 gate through public Oracle TLS/readiness confirmation.
- Strict readiness remained green at the 22:39 UTC independent check. The
  first post-cutover provider-fetch tick had zero successes, four failures, and
  42 skips; the next had one success, four failures, and 41 skips. That was two
  consecutive degraded ticks against an alert threshold of three. This is an
  operational follow-up, not a failed cutover.
- Production remains intentionally pinned to
  `80d79e522826c5676d9ad3defa3418c7561b9920`. At cutover completion,
  repository `main` had advanced one commit after the freeze. Future releases
  need an Oracle ARM64 build/deploy and rollback workflow; Render auto-deploy is
  not the production release path.

## Rollback boundary

Never reverse DNS to Render's suspended database. Render does not expose SSH
while suspended. A rollback must:

1. quiesce Oracle and verify a terminal v3 Garage restore;
2. keep production DNS on Oracle;
3. resume Render only with its persisted maintenance mode and scheduler-disabled
   settings;
4. stage, integrity-check, and promote the latest Oracle/Garage database before
   enabling Render traffic;
5. verify Render locally, then stop Oracle, transfer scheduler authority, change
   DNS, and finally disable Render maintenance mode.

Preserved Oracle databases, protected environment snapshots, the successful v3
restore proof, and the suspended Render service remain in place for the
observation window.
