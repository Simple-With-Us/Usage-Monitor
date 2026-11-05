# Mapped Worker deploy automation

Default off: set WORKER_DEPLOY_ENABLED=true only after credentials, exact-version
receipts, and functional probes are reviewed.  No secrets are rotated by this
workflow.  CLOUDFLARE_FLEET_API_TOKEN is the existing scoped deploy credential, and
it also needs Account Analytics Read for the telemetry probe.  Receipt inbox also
needs its existing read token and lifecycle audit token.  Do not widen access or
publish private receipt data to satisfy a probe.

The job tests current main, serializes deployments, rechecks main immediately
before mutation, tags the Worker version with the exact SHA, verifies 100%
production routing to that version, then runs the functional probe.  Wrangler
uses --keep-vars and --strict, except right after a script API change (see below).
Existing schema, bindings and migrations remain owned by each Worker's reviewed
configuration.  A half-hour drain catches merges made with bot tokens.
Already-live revisions still get a health check.

The pre-deploy HTTP probe fails closed: if the live Worker is unhealthy, or the probe
credentials do not work, the job stops before any upload.  A telemetry target only has
to prove its read works before an upload, because that probe looks back a whole day.  Fix-forward for a
Worker whose HTTP probe already fails is a manual deploy, not this job.

A rollback does not hold on its own.  The live tag then differs from main, so the next
half-hourly run redeploys main.  Before rolling back, set WORKER_DEPLOY_ENABLED to false
or revert the commit on main.

## Targets and order

The matrix runs usage-monitor-receipt-lifecycle-auditor, then expenses-jays-services,
then usage-monitor-receipt-inbox.  The auditor goes first because the inbox reads it
over a service binding.  The inbox also refuses to deploy while the auditor is behind
on Worker-relevant paths, so a failed auditor run holds the inbox back.  Ambiguous
start-jays-services, fleet-share-api and BotFleet broker are not included.  No iOS
workflow is changed.

## Probes

A target with `health` is called over HTTP.  The inbox uses this, with its read token.

A target with `"probe": "telemetry"` is checked from Cloudflare's invocation analytics
and takes no Worker request, D1 row or Access credential.  It fails on any failed
invocation of the live version in the last day, and on no invocations at all in that
window, so one failure leaves the run red until it ages out or a new version ships.  Straight after an upload the second half is skipped, because the new version has
not met a cron yet; the next half-hourly run applies both.  A failed read of the
analytics (including a rate limit) fails closed and the next run tries again.

The auditor has no route, so it uses telemetry.  Expenses uses it too.  Its old probe,
GET /api/expenses, could not pass: that hostname's Access app has no service-auth policy,
so a runner would get the login page.  The call would also have fetched the whole
financial list and used about 500 D1 rows every half hour.  No Access policy has to change
and WORKER_HEALTH_ACCESS_CLIENT_ID/SECRET are no longer passed.

The limit of telemetry: it sees exceptions, not a run that fails and returns normally.
The expenses scheduled handler catches its own errors today, so a failed sync reads as
success until that handler rethrows.  The auditor catches its own audit errors too, so its
telemetry only shows that the cron ran.  The audit result itself is covered by the inbox
/health probe, which answers lifecycle_unverified when the audit is not good.

## Stopped Workers and rotated secrets

The job refuses a Worker whose live deployment or release carries a message starting
GUARD-TRIPPED, both at the start and again just before upload, because a redeploy would
undo the account watchdog's stop.  Re-arming is manual.  The refusal fails the run, so a
stopped Worker shows red every half hour until someone re-arms it.

A secret change makes a new untagged version of the same code, so the receipt walks back
through secret-only versions to the last tagged one.  It stops at any other untagged
version, and also when the tagged version found is not the one deployed before the secret
change (after a rollback, or an upload never deployed).  The job then deploys once, which
restores the tag.  A settings or limits
PATCH is one of those: Cloudflare records it as an upload with a new script hash, so it
cannot be told apart from a code upload.

Wrangler 4.156 aborts under --strict in CI when a Worker was last changed through the
script API, and a settings PATCH counts as that.  The job drops --strict for that one
case, and the next deploy clears the state.  Any other last source, including a dashboard
edit, keeps --strict.

## Limits and registry check

scripts/check-worker-guards.py fails a pull request when a wrangler config is not in
scripts/worker-targets.json, a registry entry has no valid `guard` (status of `auto`,
`gated`, `frozen` or `retire`, plus ceilings), a limit is over its ceiling, or a config
has no explicit head_sampling_rate.  This is the local form of the fleet check; it does
not check preview_urls or scan for unguarded binding calls.

Wrangler sends limits only when the config has them, so a config without them could drop
the live limits; whether Cloudflare keeps them in that case has not been checked.  So the
deploy job runs the check with --require-limits and stops first.  `limits_pending` lets a
pull request pass while the limits land in that Worker's config, and it must be removed
once they have.  It never excuses a value over the ceiling, and it is ignored by the deploy
job.  Some ceilings are paid-plan values: the documented Free maximum is 50 subrequests,
and expenses is at 200, so a move to Free needs a config and ceiling change first.

## Credentials

CI reads the scoped Cloudflare token from Infisical through the existing
automation identity; its location is recorded in the private operations
inventory maintained outside this public repository.  Repository bootstrap names:
INFISICAL_AUTOMATION_CLIENT_ID and INFISICAL_AUTOMATION_CLIENT_SECRET.  Provisioning
those CI bootstrap secrets is a separate approved setup step; activation remains
off until cutover.
