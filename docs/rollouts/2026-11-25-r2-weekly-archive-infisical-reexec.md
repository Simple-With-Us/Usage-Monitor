# Weekly R2 archive: the cron lost its credentials to `docker exec`

**Date:** 2026-11-25  **Seat:** MM  **Session:** `mvs_a255082786034a6ebcb6fbcb898ae99f`
**Files:** `scripts/ops/r2-weekly-archive.mjs`, `scripts/test-r2-weekly-archive.mjs`

## Symptom

The weekly second-vendor DR copy stopped silently while the app itself was healthy. 
`/data/.r2-archive-status.json` held:

```json
{ "ok": false, "reason": "credentials_missing", "checkedAt": "2026-11-22T05:00:01.267Z" }
```

The 2026-11-15 run had verified and pruned normally, so earlier runs were fine and only
the 2026-11-21 11:00pm run wrote a failure receipt.  Readiness stayed `ok: true` because
backup layers never gate `/api/ready`, so nothing paged: the only symptom was an amber
`r2Historic` row and a growing gap in the historic freeze. 

## Root cause

The host job is:

```cron
0 23 * * 6 root flock -n /var/lock/um-r2-weekly-archive.lock -c \
  "docker exec yagelvqux9e8l1kztif7bf2o node /app/scripts/ops/r2-weekly-archive.mjs"
```

`docker exec` gives the child **the container-config environment**, not the environment
the container's own entrypoint built. `scripts/start-with-infisical.sh` injects the
project's secrets into the app's process tree through `scripts/infisical-run.mjs`, and that
is where `R2_ARCHIVE_ENDPOINT`, `R2_ARCHIVE_ACCESS_KEY_ID` and
`R2_ARCHIVE_SECRET_ACCESS_KEY` live.  The container config carries only the bootstrap
identity (`INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_ENV`,
`INFISICAL_UM_PROJECT_ID`). 

Measured live on the running container, booleans only and no values:

| Process shape | Bootstrap present | Archive keys missing | Would re-exec |
| --- | --- | --- | --- |
| plain `docker exec node ...` | yes | 3 | yes |
| `docker exec node scripts/infisical-run.mjs -- node ...` | yes | 0 | no |

The job therefore kept running, kept reading `/data/prod.db`, and failed at the first
credential read.  Nothing in the archive script was wrong; it was handed an environment no
other in-container process has.  The earlier good runs predate the container recreate that
left `R2_ARCHIVE_*` out of the container config, which is why this looked like a
regression in the script rather than in the launch path. 

## Fix

The entrypoint now hands off to the same injector the container entrypoint uses when, and
only when, the archive keys are absent but a bootstrap identity is present:

- `infisicalBootstrapPresent(env)` mirrors `scripts/start-with-infisical.sh` exactly,
  accepting `INFISICAL_UM_READ_TOKEN`, `INFISICAL_TOKEN`, or the
  `INFISICAL_CLIENT_ID` / `INFISICAL_UM_CLIENT_ID` plus secret pairs. 
- `needsInfisicalReexec(env)` is true only when the keys are missing, a bootstrap identity
  exists, and neither the one-shot guard `R2_ARCHIVE_INFISICAL_REEXEC=1` nor the operator
  opt-out `R2_ARCHIVE_INFISICAL_REEXEC_DISABLE=1` is set. 
- `buildInfisicalReexec({...})` builds `node scripts/infisical-run.mjs -- node
  scripts/ops/r2-weekly-archive.mjs <argv>`, forwarding the original argv so `--dry-run`
  and `--keep` behave the same either way. 
- The child inherits the guard, so a grant that genuinely lacks the keys still ends in an
  honest `credentials_missing` receipt instead of a fork loop.  A failure to start the
  injector also writes that receipt rather than inventing a success. 
- A handled hand-off writes **no** status file, so a healthy hand-off cannot be mistaken
  for a credential failure in the window before the child finishes. 

No host cron edit and no Coolify environment change are required: the deployed image
carries the fix, and the existing `docker exec` line starts resolving credentials on its
next run.  An operator who wants the old fail-fast behaviour inside a shell can set
`R2_ARCHIVE_INFISICAL_REEXEC_DISABLE=1`. 

## Verification actually run

- `node scripts/test-r2-weekly-archive.mjs` — **36 passed, 0 failed**: the 29 existing
  cases plus 7 new ones (keys present, identity only, no identity, guard loop, opt-out,
  argv forwarding, and an end-to-end run against a stub injector proving the hand-off
  happens once, carries `--dry-run`, and writes no failure receipt). 
- Live probe inside the running container against the patched script, booleans only:
  `{"phase":"plain","bootstrapPresent":true,"missingCount":3,"needsReexec":true}` and
  `{"phase":"injected","missingCount":0,"needsReexec":false}`, where the injector the
  entrypoint calls reported `Injecting 179 Infisical secrets`. 
- `npm run verify` on the lane under the pinned runtime, run as separate steps because this
  host cannot complete the aggregate command.  Passed: `test:node-runtime`,
  `test:xcode-write-hook`, `test:sentry-ci-report`, `test:security-ancestry`, `lint`,
  `typecheck`, `test` (vitest, 308 files / 3,764 tests passed, 1 skipped),
  `test:receipt-inbox-worker`, `test:expenses-worker`, `test:migrate-safe`,
  `test:sqlite-backup`, `test:r2-archive`, `test:startup-config`, `test:oracle-deploy`,
  `test:apple-projects`, `test:antigravity-collector`, `test:session-token-collectors`,
  `test:cf-token-map`, `test:replica-status-probe`, `test:quota-wrapper`, `test:audit-ci`
  and `build` (compiled in 18.1s). 
  Two steps are host-environment failures unrelated to this change and both predate it:
  `test:backup-concurrent-startup` never prints anything and hangs on this server, and
  `test:collector-runtime` fails its own assertion `Git executable mode validates under a
  restrictive checkout umask` inside a temporary repo the test builds itself.  CI on
  `ubuntu-latest` remains the authoritative gate for both, and the portability gap is
  tracked as UM-1681 so the next server lane does not rediscover it. 

## Follow-ups

1.  Confirm the next scheduled run — Saturday 2026-11-28 11:00pm — writes `ok: true` with a
   fresh `weekly/prod-*.db.gz` key, and that `r2Historic` turns green on `/api/ready`. 
2.  If the container is ever recreated with a bootstrap identity that cannot read `/`, the
   receipt stays `credentials_missing` and an operator runs the job by hand through
   `docker exec ... node /app/scripts/infisical-run.mjs -- node
   /app/scripts/ops/r2-weekly-archive.mjs`. 
3. `backupLayers.local = no_verified_backups` is unrelated and expected: the pre-migration
   snapshot directory only receives a promoted file when
   `backup-sqlite-before-migrate.mjs --if-schema-changed` actually sees a schema change, and
   startup logs `database schema is already in sync; pre-migration backup not required`. 
