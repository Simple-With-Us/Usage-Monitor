# 2026-08-20 — GitHub About and current production docs

Docs/metadata only.  No application or deploy-path code.

## Live evidence

- Public surface: `https://usage.jays.services`
- `/api/health` on 2026-08-20 returned `ok: true`, `environment: production`,
  revision `21cbb98fcb33274755813c697c53ed56f2ca2b81` (then `origin/main`)
- `/api/ready` reported SQLite, scheduler, B2 replica, and historic R2 weekly
  archive as configured.  This note does not record provider counts or spend.

## What was stale

- GitHub repository About homepage was empty (`homepage: null`).  Applied
  `https://usage.jays.services` immediately (repo metadata, not a code deploy).
- Public About description said "across 30+ API providers".  Replaced with the
  count-free production sentence documented in `README.md`.
- `AGENTS.md` still described production secrets as the on-disk
  `/etc/usage-monitor/usage-monitor.env` file and called Litestream/R2 the
  off-disk PITR layer
- `docs/api-contract.md` still named the shared package pin as `v2.3.0`
- `docs/litestream.md` still described R2 as the live replica and used older
  snapshot/sync intervals than `litestream.yml`

## Current production facts used

Taken from `DEPLOY.md`, `litestream.yml`, and the live health/ready responses:

- Host: Hetzner NBG1 Coolify (`fleet-hetzner-nbg1`, `<PROD_ORIGIN_IP>`)
- Public hostname: `usage.jays.services`
- Cloudflare: public TLS proxy for that hostname; optional receipt-inbox Worker
- Database: Prisma + SQLite on `/data`
- Litestream replica: Backblaze B2 (`snapshot` 24h / 24h, `sync-interval` 1h)
- Cloudflare R2: weekly archive only
- Oracle Cloud and Render: retired (historical / rollback docs only)

Do not add provider counts or vendor lists to About or the README stack
section beyond the hosting and backup roles above.
