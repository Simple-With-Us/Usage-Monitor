# Expenses site (expenses.jays.services)

Business expense dashboard backed by Cloudflare Workers + D1.  The account is on Workers Paid, so usage past the included amounts is billed: nothing outside this Worker's own guards stops a runaway.  On Free, D1 returns errors past the daily limits, which would break every database on the account.  Either way the guards below are what keep a bug cheap.

## Data flow

Usage Monitor's owner-expense ledger (`POST /api/owner-expenses`) is the system of record.  This worker keeps a D1 read cache:

- `GET /api/owner-expenses` on Usage Monitor (dashboard session or `USAGE_READ_TOKEN`) lists the ledger with cursor pagination.
- The worker's scheduled cron (every hour, at 7 minutes past) calls `syncExpenses`.  It reads the whole ledger, then compares a SHA-256 of the response text, the category rules and the suppression list with the hash stored after the last complete sync.  If they match, the run writes only `last_sync_at` and the write counter.
- If they differ, it compares each row with the mirror and upserts only the rows that changed, keyed by idempotency key.  Re-runs never duplicate.
- The dashboard and `/api/expenses` read D1 only: the Usage Monitor app is never in the page-load path.

`category` is stored per row at sync time (see `src/categories.mjs`) so a future add/edit UI can override it without a migration.  `synced_at` records when a row was first mirrored; updates leave it alone.

`suppressed_expenses` lists idempotency keys the dashboard must never render.  It lives only in D1, so rebuilding the database from `schema.sql` loses it.  Editing it changes the hash, so the next run does a full pass and purges any newly suppressed row.

Rows deleted upstream are not removed from the mirror.

## Guards

Every guard is checked before the write it protects.  A tripped guard fails the run, so it shows as an exception in Workers analytics, and the cron does not retry.

| Guard | Limit | What happens |
| --- | --- | --- |
| Pages per run | 3 (1000 rows each) | Abort with no writes.  A ledger past 3000 rows stops syncing until this is raised. |
| Repeated cursor, or `hasMore` with no cursor | Any | Abort with no writes. |
| Upstream rows per run | 5000 | Abort with no writes. |
| Changed rows per run | 300 | Write the first 300, leave `last_sync_at` and the hash alone, and fail the run.  Later runs finish the rest. |
| D1 rows written per UTC day | 5000 | Refuse before any write, until the day resets at 6 PM Chicago (7 PM during daylight saving).  The count comes from `meta.rows_written`, and a run reserves its worst case first, so a killed run still counts. |
| `POST /api/sync` | Once per 60 s | Answer 429 with no sync and no write.  A failed sync holds the slot too. |
| Upstream fetch | 20 s | Abort the run. |
| Zero upstream rows over a non-empty mirror | Any | Fail the run and do not advance `last_sync_at`, so the page footer shows the true age of the data. |
| `limits` in `wrangler.jsonc` | 100 ms CPU, 60 subrequests | Backstop, enforced by Cloudflare. |
| `GUARD_MODE=off` | Set by the account watchdog | Every route answers 503, including `/health`, and the cron does nothing. |

## Operations

Force a full pass, for example after editing `expenses` by hand:

```bash
wrangler d1 execute expenses-site --remote --command "DELETE FROM sync_state WHERE key = 'upstream_hash'"
```

Check today's write count (`rows_written_today` holds `YYYY-MM-DD:count`, UTC):

```bash
wrangler d1 execute expenses-site --remote --command "SELECT key, value FROM sync_state"
```

A malformed counter fails closed.  Deleting that row clears it, and also clears the day's count.

Bump `SYNC_SHAPE_VERSION` in `src/sync.mjs` whenever `mapUpstreamExpense`, `dedupeUpstreamRows` or the logic of `categorizeExpense` changes what is stored.  Category rule edits force a full pass by themselves.

## Secrets (never in the repo)

- `USAGE_READ_TOKEN`: worker secret (`wrangler secret put USAGE_READ_TOKEN`), read from Usage Monitor's Infisical `prod` env.  Gates the upstream read and the manual `POST /api/sync` trigger.

## Access

The hostname sits behind Cloudflare Access ("Jay emails only"), same as the other internal dashboards.  The worker itself performs no identity checks.

`GET /health` runs `SELECT 1` and returns only `{ "ok": true }`, for a probe that can pass Access.  It stays behind Access, with no public bypass, so a caller needs a Service Auth policy on the Access app.  `scripts/worker-targets.json` does not point at it.

## Local dev

```bash
wrangler dev --config workers/expenses-site/wrangler.jsonc
```

## D1

```bash
wrangler d1 create expenses-site
# put the returned id in wrangler.jsonc, then:
wrangler d1 execute expenses-site --remote --file workers/expenses-site/schema.sql
```

`schema.sql` describes a new database.  The deploy workflow does not touch schema, so apply each numbered file in `migrations/` to the live database by hand.

## Moving to Workers Free

Not ready yet.  Lower `limits.subrequests` to 50 or less and check whether Free accepts `limits.cpu_ms`.  Measure CPU first: Free allows 10 ms, a sync that changes rows parses and categorizes the whole ledger, and `GET /` measured 19-30 ms before this change.

## Tests

Offline unit tests: `npx vitest run workers/expenses-site`, and `npm run test:budget-guard` for the shared guard, which uses Node's own test runner.
