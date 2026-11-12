# 2026-07-18 — Forwarded receipt inbox and Socratic operations view

## Outcome

- Added an optional Cloudflare Email Routing Worker that accepts one dedicated
  receipt address, buffers raw MIME once, enforces a 10 MiB application limit,
  parses with `postal-mime`, checks PDF/PNG/JPEG magic bytes, and stores the
  complete message in a private R2 bucket.
- Every received message starts as `needs_review`. The Worker has no
  usage-ingest, receipt-ingest, receipt-identity, or receipt-signing credential
  and cannot create an `ExternalUsageEvent` or any other money row.
- Exact duplicate MIME derives the same HMAC evidence ID and overwrites the
  same R2 object instead of creating another inbox entry. A supported
  attachment-content digest also deduplicates common forwarding-wrapper
  changes.
- A Durable Object transaction maintains the chronological review queue and
  enforces 100-message and 100-MiB daily limits. The handler rejects any
  recipient other than the configured high-entropy alias before reading MIME.
- The new namespace is SQLite-backed. Intake is a recoverable two-phase
  protocol: a non-visible reservation is followed by the idempotent R2 write
  and then a visible commit. Retries resume pending writes instead of silently
  suppressing evidence after a partial failure.
- Pending reservations expire after one day. Committed review, dedupe, group,
  and sender-domain metadata expire after 180 days alongside R2 evidence;
  Durable Object alarms drain cleanup without traffic. The deploy command and
  a 12-hour read-only API audit both require one exact, non-conflicting
  lifecycle rule; readiness fails closed when audit or cleanup is stale.
- The read-only summary API returns no subject, body, filename, full sender
  address, account identifier, provider credential, or host IP. Raw `.eml`
  download requires a separate operator-only evidence token that is never
  configured in Render.
- Added one compact dashboard `/api/operations` request and an Operations
  section with separate Receipt inbox and Socratic Trade infrastructure cards.
  Details are mounted only while expanded; polling is once per minute and
  pauses while the tab is hidden. A 30-second server cache and single-flight
  promise deduplicate overlapping dashboard tabs without retaining histories.
- Socratic status reads the bounded public `/api/health` contract and allowlists
  release, DB, scheduler, trading counts, failed dependency names, storage, and
  Litestream state. A failed refresh preserves the last successful snapshot as
  explicitly stale. It never consumes `/api/ops/snapshot` or account rows.

Cloudflare's current Email Routing limit is 25 MiB; the Worker deliberately
uses 10 MiB to bound parse memory. Cloudflare documents the `email()` handler's
single-use raw stream and supports routing a specific address directly to a
Worker. R2 lifecycle rules should expire evidence after the owner-selected
retention period before real mail is accepted:

- https://developers.cloudflare.com/email-service/platform/limits/
- https://developers.cloudflare.com/email-service/api/route-emails/email-handler/
- https://developers.cloudflare.com/r2/buckets/object-lifecycles/

## Routing-domain correction (2026-07-21)

Production evidence shows apex `jays.services` MX remains on iCloud and
Cloudflare Email Routing is disabled. Do not enable or alter apex Email Routing.
Instead, create a dedicated routed subdomain such as
`receipts.jays.services`, set its Cloudflare Email Routing MX records there,
and use an exact high-entropy address such as
`receipts-secret-123@receipts.jays.services`. The intake Worker rejects apex
addresses by design. This preserves personal iCloud email delivery while keeping
receipt evidence isolated.

## Live MX split restored (2026-08-14)

Email Routing later took the apex MX, so `*@jays.services` stopped reaching
iCloud.  Apex MX/SPF were put back on iCloud; `receipts.jays.services` stayed
on Cloudflare MX with the catch-all pointed at
`usage-monitor-receipt-inbox`.  Full receipt:
`docs/rollouts/2026-08-14-apex-icloud-receipts-routing.md`.  Do not repair
apex Email Routing DNS.

## Production prerequisites

Before enabling real receipt intake:

1. Create private bucket `usage-monitor-receipts` and set a 180-day lifecycle
   rule on the `evidence/` prefix.
2. Set seven Worker secrets: stable inbox identity, summary-read,
   operator-only evidence-download, exact high-entropy recipient, retention
   acknowledgement, account ID, and a distinct read-only R2-configuration
   lifecycle-audit token.
3. Deploy `usage-monitor-receipt-inbox` and attach exactly
   that high-entropy `@receipts.jays.services` recipient in Email Routing;
   onboard only the receipt subdomain and keep catch-all disabled.
4. Configure Render only with `RECEIPT_INBOX_READ_TOKEN`; the summary endpoint
   is fixed to `https://receipt-inbox.jays.services` and rejects redirects.
5. Send a harmless fixture email and verify one `needs_review` row. Do not
   convert it into a billing event.

Reviewed receipt amounts still use the existing private HMAC importer. Only
exact USD API prepaid-funding receipts fit that accounting path; subscriptions,
postpaid invoices, refunds, taxes, and non-USD evidence stay review-only until
separate semantics are implemented.

## Verification

- Focused Node Vitest: 3 files / 18 tests passed, including recovery from
  failures before and after the R2 evidence write.
- Workerd integration: 6 tests cover concurrent quota serialization,
  committed-only newest-first ordering, exact pending recovery, attachment-group
  isolation, pending alarms, and 180-day metadata cleanup.
- TypeScript and scoped ESLint passed with zero warnings. Wrangler production
  bundle dry run passed: 134.26 KiB raw / 31.75 KiB gzip.
- Full `npm run verify` passed: ESLint, TypeScript, 109 files / 1,186 Node
  tests, 6 Workerd integration tests, additive/destructive migration checks,
  SQLite backup, startup checks, and production build.
- Dashboard route table includes `/api/operations`; the dashboard first-load
  JS remains 149 kB.
- `git diff --check` passed.

## Deferred

- The Worker supports operator-only `reviewed`/`ignored` status changes, but a
  dashboard approval/import workflow is intentionally absent. A human reviews
  evidence offline and uses the existing dry-run-first importer. This prevents
  a compromised or spoofed email from becoming spend.
- Socratic's original `/admin/server` provider-metrics panel has its own repair
  lane. The Usage Monitor card does not iframe or proxy that panel and remains
  useful when its Coolify/Hetzner provider calls fail.
