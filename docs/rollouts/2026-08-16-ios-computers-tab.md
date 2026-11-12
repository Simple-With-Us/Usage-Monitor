# iOS Computers tab + UM 503 recovery

## Computers tab

The web Operations page already had `MacHealthCard` on `/api/health/mac`.
The iOS client did not.  This adds a pin-able **Computers** destination
(under More by default) that shows Mac CPU / memory / disk, issue flags
(offline heartbeat, high load, stopped/degraded launchd rows), and process
status from the existing heartbeat.

Hetzner host usage stays on Server / Settings.  This tab is the Mac.

## UM 503 on 2026-08-16

Public `usage.jays.services` returned `503 no available server`.  Coolify
was `running:unhealthy`.  Latest webhook deploy of `b090be44` failed in 3s
because `/tmp` tmpfs was **100% full** (`no space left on device` writing
`/tmp/runc-process…`).

Cause: leftover restore-drill SQLite copies
(`/tmp/fleet-restore-drill` 2.9 GiB plus three ~1.5 GiB recovered DBs from
2026-08-07).  Deleted those plus stale litestream/gitleaks tarballs.
`/tmp` went 7.7G/7.7G → 27M used.  Coolify restart brought the last good
container back (`revision` `28f05d61`, `/api/ready` ok).

## Receipts worker

Independent of Coolify.  Unauthenticated `/health` is 401 (correct).
Authenticated summary: `configured: true`, `status: receiving`,
`needsReviewCount: 17`, latest item `2026-08-13T18:38:47Z`.  MX still
`receipts.jays.services` → Cloudflare, apex → iCloud.

## CF → B2 + weekly R2

Live `backupLayers`: `litestreamUsesR2: false`, R2 role `historic`,
`weeklyArchive.ok: true` (age ~1h, pruned 0).  That is the completed
design: continuous replica on B2, weekly verified archive on R2.

After the restart, B2 `replicaOk` briefly reported `no_parseable_ltx`
with a ~5 minute replica age — writing, but the LTX parser had not
caught up yet.
