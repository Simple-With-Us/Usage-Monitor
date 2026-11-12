# Oracle Always Free migration candidate

## Summary

- Adds an ARM64-compatible, checksum-pinned Litestream install path.
- Adds a Docker Compose + Caddy deployment for the Oracle Ampere A1 host. The
  app refuses to start unless the separate `/data` block volume is mounted.
- Adds strict readiness transport semantics at `/api/ready?strict=1` for an
  external monitor while preserving the historical HTTP 200 liveness contract.
- Moves ingest admission ahead of request-body decoding so concurrent retry
  storms are rejected before allocating or parsing multi-megabyte payloads.
- Splits comma-delimited LlamaParse credentials into independently encrypted,
  stable provider rows with per-key previews and server-only fingerprints.
- Defines the Coolify Garage service used as the Oracle database's separate
  Litestream S3 replica. It does not share Render's R2 replica.

## Infrastructure

- Oracle shape: `VM.Standard.A1.Flex`, 2 OCPU, 12 GB RAM.
- Persistent data: separate 100 GB block volume mounted at `/data`.
- Candidate URL: `https://usage-oracle.132.226.90.164.sslip.io`.
- Coolify backup endpoint: the Garage S3 hostname managed by the
  `usage-monitor-backups` service; credentials remain only in protected runtime
  configuration.
- Large backup requests use the dedicated Traefik `garage` TLS entrypoint on
  port 9443 with five-minute read/write deadlines. Hetzner firewall 11282050
  permits that port only from the Oracle VM public address; the shared Coolify
  HTTPS entrypoint keeps its default timeout. The proxy compose change is
  retained under `/data/coolify/proxy/docker-compose.yml` and a timestamped
  pre-change copy under `/data/coolify/proxy/backups/`.
- Oracle (`<TAILSCALE_IP_RETIRED>`) and Coolify (`100.86.49.101`) are peers on the
  existing Tailscale network. Oracle pins the Garage TLS hostname to the
  Coolify Tailscale address in `/etc/hosts`, so normal backup traffic stays on
  that private path while retaining hostname-based certificate validation.
  The public-IP firewall rule is a source-IP-restricted break-glass fallback.
- Production `usage.jays.services` and its Render service remain the rollback
  source until the sole-writer cutover and restore drill are complete.

## Verification

1. Run `npm run verify` on the exact branch revision.
2. Run `docker compose -f deploy/oracle/compose.yaml config` and build the image
   on the ARM64 Oracle host.
3. Start with `USAGE_SCHEDULER_ENABLED=false` and confirm `/api/health` and
   `/api/ready?strict=1` externally.
4. Exercise authenticated generic ingest and OTLP idempotent retries against the
   candidate only.
5. Restore the Coolify Litestream replica to a scratch SQLite file, run
   `PRAGMA integrity_check`, and compare representative row counts.
6. During cutover, stop the incumbent writer before the final restore and
   enable exactly one scheduler. Confirm one healthy scheduler tick before DNS.

## Completed pre-cutover receipts

- Local `npm run verify`: 106 test files / 1,176 tests, TypeScript, lint,
  migration safety, SQLite backup/startup checks, and the production build all
  passed. GitHub CI, CodeQL, and gitleaks also passed on PR 420.
- The Render replica restored into Oracle with `PRAGMA integrity_check = ok`
  and counts of 41 providers, 6,122 usage snapshots, 374,399 external usage
  events, and 3 subscriptions.
- Coolify Garage was seeded from that database. Independent restores through
  Litestream at TXID 1 and again after Oracle's TXID 2 both passed Litestream's
  full integrity check, SQLite integrity check, the same representative row
  counts, and the expected 313,257,984-byte database size.
- The exposed bootstrap S3 key was retired after a newly generated key was
  installed in Coolify and Oracle. The retired key is denied, the replacement
  key can read the existing replica, and protected handoff files were removed.
- The Oracle candidate returns HTTP 200 from strict readiness with database,
  required Litestream backup, and startup checks healthy; its scheduler remains
  intentionally disabled until the sole-writer cutover.
- Free UptimeRobot checks cover production liveness and strict readiness at a
  five-minute interval.

## Follow-ups

- Keep Render stopped-but-retained for the observation window; rollback requires
  restoring the latest verified Oracle replica before restarting it.
- Oracle may reclaim an Always Free A1 instance classified as idle. External
  monitoring detects an outage but does not provide an SLA or automatic failover.
- Rotate the independently identified credentials that were exposed during
  infrastructure discovery; no exposed value is stored in this repository.
