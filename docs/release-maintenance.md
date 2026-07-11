# Release maintenance

Last updated: 2026-07-11.

## Startup policy

Release maintenance is disabled when `RELEASE_MAINTENANCE_PLAN_ID` is unset or
blank. A non-empty value must match an immutable plan in
`scripts/run-release-maintenance.mjs`; an unknown ID fails startup before the
database is touched.

The only registered plan is:

```text
provider-subscriptions-2026-07-10-v1
```

Its reviewed SHA-256 plan hash is
`1faf2328f66698886c2bcc18599e412c7e4525b643f0ab4e8a032d62a1d60cbb`.
The module independently recomputes and verifies this pinned value on load, so
changing the payload without issuing a new plan ID fails before database work.

Startup executes in this order:

1. validate the exact maintenance-plan selection;
2. restore from Litestream when needed;
3. create and integrity-check a transaction-consistent SQLite backup;
4. run additive-only `migrate-safe` schema synchronization;
5. execute the selected maintenance plan;
6. start the app, with Litestream supervising it when configured.

The selected provider/subscription plan performs a write-free preflight, then
repeats preflight in one SQLite transaction and compares a state fingerprint.
It applies only the approved writes, verifies row-level postconditions, runs
`PRAGMA integrity_check` in the same transaction, and inserts a
`ReleaseMaintenanceRun` receipt as the final write. Any conflict or failed
postcondition rolls back all plan writes. A matching receipt makes later
starts a no-op; the same plan ID with a different hash fails closed.

## Provider/subscription plan

All four subscriptions use the fixed billing anchor
`2026-07-10T00:00:00.000Z`, renewal date
`2026-08-10T00:00:00.000Z`, and anchor day `10`:

| Provider | Plan | Status | Monthly USD |
| --- | --- | --- | ---: |
| Massive | Stocks Starter | active | 29 |
| FMP | Starter | active | 22 |
| Tiingo | Power | considering | 30 |
| FMP | Premium | considering | 59 |

Active monthly cost is $51. Considering monthly cost is $89 and is not
materialized as spend. The Tiingo, Twelve Data, Alpha Vantage, and Finnhub
free-tier knob maps are unchanged from the reviewed 2026-07-10 seed.

The plan never creates or changes budgets. It also does not overwrite operator
data:

- duplicate case-insensitive provider or subscription natural keys abort;
- the `alpha-vantage` / `alpha_vantage` near miss aborts rather than silently
  creating `alphavantage`;
- a semantically identical manual subscription is preserved and satisfies the
  target;
- a divergent manual subscription aborts;
- a non-null operator `ProviderPlan.knobEnv` is preserved, while a missing or
  null map receives the reviewed free-tier value.

## Operator runbook

Deploy the code with `RELEASE_MAINTENANCE_PLAN_ID` unset first. In the Render
service shell, inspect the zero-write preflight:

```bash
npm run seed:provider-subscriptions
```

Confirm the expected four subscriptions, $51 active total, $89 considering
total, and any preserved manual rows/maps. Then set this exact Render
environment value and deploy:

```text
RELEASE_MAINTENANCE_PLAN_ID=provider-subscriptions-2026-07-10-v1
```

The deploy log must report the exact plan ID and hash as completed (or
already-completed). Re-run the dry-run command to inspect the durable receipt.
The environment variable may remain set because the receipt makes later
deploys no-ops, or it may be removed after verification.

If preflight reports a conflict, unset the variable to restore normal startup,
inspect the reported rows, and resolve the data deliberately. Do not rename,
delete, or overwrite a production row merely to make the plan pass.

Manual apply is available only with the same exact-plan gate:

```bash
npm run seed:provider-subscriptions -- \
  --apply --plan-id provider-subscriptions-2026-07-10-v1
```

## Claude cumulative-cost repair

`npm run repair:claude-cost` remains intentionally manual and dry-run-first.
Historical OTLP start timestamps were not retained, compacted Claude rollups
can make exact reconstruction impossible, and the expected reduction requires
production review. Its `--apply` mode still requires
`--backup-acknowledged`. It is not registered as startup maintenance and was
not changed by this plan.
