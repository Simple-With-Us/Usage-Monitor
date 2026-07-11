# Release maintenance safety assessment

Last assessed: 2026-07-11.

## Decision

Do **not** run the historical Claude cumulative-cost repair or the provider
subscription seed automatically from `start-with-litestream.sh` in this
release. An idempotency marker prevents a second execution; it does not prove
the first business-data mutation is correct.

Startup remains limited to infrastructure-safe operations: restore if the DB
is missing, create and verify a transaction-consistent local backup, apply
non-destructive schema synchronization, then start replication and the app.
No budgets, provider plans, subscription rows, or historical usage values are
created or changed by startup.

## Claude cumulative-cost repair

`npm run repair:claude-cost` is intentionally dry-run-first and reports the
candidate row count, reconstructed cost, reduction, reset count, and compacted
Claude rollups. It deliberately repairs only `metricType="cost"` rows; token,
session, code-edit, and other cumulative counters remain untouched because the
approved production correction is historical cost only. Automatic apply is
unsafe because:

- historical OTLP start timestamps were not retained, so a reset to a higher
  counter value cannot be proven after the fact;
- any compacted Claude rollup makes exact reconstruction impossible and causes
  apply to abort;
- the expected dollar reduction must be reviewed against production evidence;
- `--apply` deliberately requires `--backup-acknowledged`.

The importable planner runs before writes, while the applier rechecks for
compacted Claude rollups as its first operation inside the caller-owned
transaction. It never replaces an equal/newer OTLP checkpoint. Repaired rows
are excluded from future candidate selection, so the operation is rerun-safe
after an operator approves the dry-run. The caller must run before the app's
maintenance scheduler starts. It is still not approval-free. A release marker
would add bookkeeping, not the missing semantic approval.

## Provider subscription seed

`scripts/seed-provider-subscriptions.mjs` skips matching subscriptions and
non-null free-tier knob maps, but it is not safe as an unattended release task:

- active Massive/FMP subscriptions use the execution time as `startDate`,
  `currentPeriodStart`, and renewal anchor instead of a verified invoice date;
- an active seed can materialize a recurring charge on the next maintenance
  pass;
- provider creation, subscription creation, and knob-map updates are separate
  writes rather than one transaction;
- production currently has an unrelated Cloudflare subscription, so the
  script has not already established a marker-equivalent target state.

Do not infer budgets or billing anchors from the hard-coded plan prices. Before
any apply, add a real dry-run/plan mode, verify each active plan and renewal
anchor, and review fixed-cost conflicts.

## Requirements for a future automated task

If release maintenance is later automated through a disk-attached service
startup or authenticated app API, require all of the following:

1. A database-backed `ReleaseMaintenanceRun` marker keyed by an immutable task
   version and input-plan hash. A marker file is unsafe because database and
   filesystem restores can move independently.
2. Explicit opt-in for that exact task version; never an open-ended "run all
   pending maintenance" switch.
3. The marker write in the same SQLite transaction as the business-data writes,
   or a fully resumable operation whose partial state converges safely.
4. A verified current backup and a recorded dry-run result whose expected row
   and dollar deltas match the approved values.
5. No budget creation or modification, and no replacement of operator-edited
   subscriptions/provider plans.
6. A post-run audit and a durable receipt before clearing the opt-in.

Until those conditions exist, keep both operations explicit and operator-run.
