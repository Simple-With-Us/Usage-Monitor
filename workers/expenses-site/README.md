# Expenses site (expenses.jays.services)

Business expense dashboard backed by Cloudflare Workers + D1, on the free
tier with no paid plan attached.  Free-tier limits throttle instead of
billing, so the app cannot generate overage charges.  Queries stay bounded
(6-month rolling window, `LIMIT 1000`, indexed by date) to stay far under
free limits.

## Data flow

Usage Monitor's owner-expense ledger (`POST /api/owner-expenses`) is the
system of record.  This worker keeps a D1 read cache:

- `GET /api/owner-expenses` on Usage Monitor (dashboard session or
  `USAGE_READ_TOKEN`) lists the ledger with cursor pagination.
- The worker's scheduled cron (every 15 minutes) calls `syncExpenses`,
  which upserts every upstream row into D1 keyed by idempotency key.
  Re-runs never duplicate.
- The dashboard and `/api/expenses` read D1 only — the Usage Monitor app is
  never in the page-load path.

`category` is stored per row at sync time (see `src/categories.mjs`) so a
future add/edit UI can override it without a migration.

## Secrets (never in the repo)

- `USAGE_READ_TOKEN` — worker secret (`wrangler secret put USAGE_READ_TOKEN`);
  read from Usage Monitor's Infisical `prod` env.  Gates the upstream read
  and the manual `POST /api/sync` trigger.

## Access

The hostname sits behind Cloudflare Access ("Jay emails only"), same as the
other internal dashboards.  The worker itself performs no identity checks.

## Local dev

```bash
wrangler dev --config workers/expenses-site/wrangler.jsonc
```

## D1

```bash
wrangler d1 create expenses-site
# put the returned id in wrangler.jsonc, then:
wrangler d1 execute expenses-site --file workers/expenses-site/schema.sql
```

## Tests

Pure unit tests (offline): `npx vitest run workers/expenses-site`
