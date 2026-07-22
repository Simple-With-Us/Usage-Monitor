# Usage Monitor

Tracks API usage and cost across providers via **poller snapshots**, **pushed telemetry**, and **Claude Code OTLP metrics**, with **per-project cost attribution** and **recurring-subscription tracking**. Deployed at `usage.jays.services`.

## Key endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/ingest/usage` | Ingest shared usage-telemetry v2 events from sibling apps (bearer token); durable `eventId`, typed ACK/errors, optional `project`; legacy v1 remains replay-only |
| `GET` | `/api/budget-status` | Per-provider and per-project month-to-date spend vs monthly budget (read token) |
| `POST` | `/api/otlp/v1/metrics` | Receive OTLP metrics from Claude Code (same bearer token as ingest); reads the `project` resource attribute |
| `GET` | `/api/usage-events` | Usage summary grouped by source/provider/**project** (`?projectId=` filter) |
| `GET` `POST` | `/api/subscriptions` | List / create recurring subscriptions (fixed fee + renewal cycle) |
| `PUT` `DELETE` | `/api/subscriptions/:id` | Update / delete a subscription |
| `GET` | `/api/sentry-health` | Per-project unresolved-issue counts from Sentry (dashboard-gated) |
| `GET` | `/api/health` | Public process liveness plus version and deployed revision |
| `GET` | `/api/ready` | Public SQLite, scheduler, startup-entrypoint, and backup readiness |

## Per-project attribution & subscriptions

- **Per-project cost:** tag usage with a project so spend rolls up per project. Claude Code:
  `OTEL_RESOURCE_ATTRIBUTES=project=<name>` (per-repo via direnv). Other apps: a top-level `project`
  field on the ingest contract. Names resolve case-insensitively to a `Project`; create the Project
  (with a budget) in Settings → Projects.
- **Subscriptions:** track recurring fixed fees (e.g. a Claude plan) with an interval and renewal
  date in Settings → Subscriptions. A maintenance job materializes each billing period's fee as a
  usage event, so subscriptions count toward provider and project budgets automatically.

## Quick start

```bash
npm ci
cp .env.example .env          # fill in required values
npx prisma db push             # this repo intentionally has no migrations directory
npm run dev -- --turbopack
```

The webpack `next dev` path is affected by an upstream instrumentation-bundling
bug in this project. Turbopack is required for local development; production
`next build` / `next start` are unaffected.

## Verify

```bash
npm run verify
```

`verify` runs lint, TypeScript, unit/integration tests, the real SQLite safe-
migration reproduction, transaction-consistent pre-migration backup and
retention tests, startup/backup configuration tests, and a production Next.js
build. CI uses the same pinned Node version from `.node-version`.

## Tech stack

- **Next.js** (App Router) — web framework
- **Prisma** (SQLite) — ORM + database (persistent disk on Render)
- **Render** — deployment (see `DEPLOY.md`)
- **Sentry** — error monitoring (Sentry Health card)

## Docs

- **[AGENTS.md](AGENTS.md)** — agent-facing guide (schema, auth, ingest flows, env vars)
- **[DEPLOY.md](DEPLOY.md)** — Render deployment instructions
- **[docs/litestream.md](docs/litestream.md)** — backup and restore runbook
- **[docs/release-maintenance.md](docs/release-maintenance.md)** — why one-time
  data repairs/seeds remain explicit and what safe marker automation requires
- **[docs/direct-billing-integrations.md](docs/direct-billing-integrations.md)** — provider billing/API connection matrix (when present)
