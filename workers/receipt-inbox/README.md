# Receipt inbox Worker

Forward vendor receipts to any address on the dedicated Cloudflare-routed
subdomain `receipts.jays.services` (for example `receipts@receipts.jays.services`
or a high-entropy `rcpt-…@receipts.jays.services`). Cloudflare Email Routing
should deliver that subdomain to this Worker (catch-all or explicit rules).
Do **not** onboard or change the apex `jays.services` MX records: they continue
delivering to iCloud (`mx01`/`mx02.mail.icloud.com`, SPF `include:icloud.com`).
Email Routing stays enabled only so `receipts.jays.services` can keep its own
Cloudflare MX.  The dashboard will show the apex as misconfigured; do **not**
click Repair / Enable on apex DNS or iCloud stops receiving `*@jays.services`.

Cloudflare exposes **one** Catch-all toggle, labeled on the apex domain page.
Leave it pointed at this Worker — that is the `*@receipts.jays.services`
catch-all (Cloudflare never receives apex mail).  Apex catch-all is Apple's
**Allow All** switch under iCloud+ → Custom Email Domain → `jays.services`.
See `docs/rollouts/2026-08-14-apex-icloud-receipts-routing.md`.
The Worker stores each complete MIME message in a private R2 bucket and keeps a
chronological, transactional review index in a Durable Object. It exposes only
bounded, non-content metadata to Usage Monitor. This Worker never receives the
billing-receipt ingest token, billing identity key, or billing HMAC signing key
and cannot create a money event.

Every admitted email is first forwarded to a verified private fallback mailbox.
Relay rejections (for example iCloud CS01 policy) are logged and intake
continues into R2 so the Worker-held original is not lost.  When forwarding
succeeds, that copy preserves the original even if lifecycle verification, MIME
parsing, R2, or the index fails afterward. Receipt processing remains explicit: the dashboard only
shows a needs-review item; it does not turn email into spend automatically.

Required public intake Worker secrets:

- `RECEIPT_INBOX_IDENTITY_KEY` — stable 32+ character HMAC key used only to
  derive a non-reversible, repeatable evidence ID.
- `RECEIPT_INBOX_READ_TOKEN` — 32+ character bearer token for the sanitized
  summary endpoint.
- `RECEIPT_INBOX_EVIDENCE_TOKEN` — separate 32+ character operator token for
  downloading an unreviewed `.eml`; never configure this token in the Usage
  Monitor app env (Hetzner/Coolify or the retired Render rollback host).
- `RECEIPT_INBOX_ADDRESS` — any configured identity on
  `receipts.jays.services` (short or high-entropy), used for readiness/health.
  Intake accepts **any** local-part on that domain; apex and other domains are
  rejected before the MIME stream is read.
- `RECEIPT_INBOX_RETENTION_ACK` — set exactly to
  `receipt-evidence-lifecycle-configured-v1` only after the 180-day R2 lifecycle
  rule below is confirmed.
- `RECEIPT_FALLBACK_ADDRESS` — a private, Cloudflare-verified destination. The
  Worker forwards each admitted original here before parsing or storage work.
- `RECEIPT_NO_FORWARD_LOCAL_PART` — optional reserved local-part on
  `receipts.jays.services` whose intake is filed **without** fallback
  forwarding. Use it for agent-forwarded originals, where the forwarder already
  holds a copy and a forwarded duplicate would only add noise to the owner's
  mailbox. Keep the value a Worker secret and out of the repo; when unset, all
  intake forwards as before.

Required private lifecycle-auditor Worker secrets:

- `CLOUDFLARE_ACCOUNT_ID` — the exact 32-hex account containing the bucket.
- `RECEIPT_LIFECYCLE_AUDIT_TOKEN` — a distinct token with Cloudflare's
  account-scoped **Workers R2 Storage Read** permission. Cloudflare does not
  offer configuration-only R2 lifecycle scope: this permission can read/list
  R2 objects across the account. It is therefore bound only to the no-route,
  `workers_dev=false` auditor and never to the public intake Worker or the
  Usage Monitor app env.

Provision/deploy, then onboard only the dedicated receipt subdomain in
Cloudflare Email Routing (not the apex). Prefer a catch-all (or short
`receipts@…` plus any high-entropy addresses you still use) so vendors can
forward without memorizing a long local-part:

```bash
npm exec -- wrangler r2 bucket create usage-monitor-receipts
npm exec -- wrangler r2 bucket lifecycle add usage-monitor-receipts receipt-retention evidence/ --expire-days 180
npm run receipt-inbox:verify-lifecycle
npm exec -- wrangler secret put RECEIPT_INBOX_IDENTITY_KEY --config workers/receipt-inbox/wrangler.jsonc
npm exec -- wrangler secret put RECEIPT_INBOX_READ_TOKEN --config workers/receipt-inbox/wrangler.jsonc
npm exec -- wrangler secret put RECEIPT_INBOX_EVIDENCE_TOKEN --config workers/receipt-inbox/wrangler.jsonc
npm exec -- wrangler secret put RECEIPT_INBOX_ADDRESS --config workers/receipt-inbox/wrangler.jsonc
npm exec -- wrangler secret put RECEIPT_INBOX_RETENTION_ACK --config workers/receipt-inbox/wrangler.jsonc
npm exec -- wrangler secret put RECEIPT_FALLBACK_ADDRESS --config workers/receipt-inbox/wrangler.jsonc
# Optional: reserved local-part that files without fallback forwarding
# (agent-forwarded originals). Keep the value out of the repo.
npm exec -- wrangler secret put RECEIPT_NO_FORWARD_LOCAL_PART --config workers/receipt-inbox/wrangler.jsonc
npm exec -- wrangler secret put CLOUDFLARE_ACCOUNT_ID --config workers/receipt-lifecycle-auditor/wrangler.jsonc
npm exec -- wrangler secret put RECEIPT_LIFECYCLE_AUDIT_TOKEN --config workers/receipt-lifecycle-auditor/wrangler.jsonc
npm run receipt-inbox:deploy
```

## Git repository and deploys

Do **not** make a separate GitHub repo.  Source is already in
`Simple-With-Us/Usage-Monitor` (`workers/receipt-inbox` plus
`workers/receipt-lifecycle-auditor`).  Both workers import
`workers/receipt-lifecycle.mjs` and take `postal-mime` / `wrangler` from the
repo-root `package.json`, so wrangler must run from the repo root.

**Workers Builds does not deploy this Worker.**  The inbox's trigger was bound
to the repository's old owner, and its last build was October 1, 2026.  Merges to
`main` since then have produced no build.  Do not reconnect it: it would deploy
the inbox alone, skipping the auditor-first ordering and the 180-day lifecycle
gate.

Deploy from the repo root with `npm run receipt-inbox:deploy`, which verifies the
live R2 rule and lands the auditor first.  `npm run receipt-inbox:deploy-auditor`
deploys the auditor alone.

## Runaway guards

- **Mail loop.**  Every fallback forward carries `X-Receipt-Inbox-Hop`.  A message
  that arrives with that header, or with more than 8 `Received` headers including
  at least 2 Cloudflare Email Routing passes, is dropped silently before any Durable
  Object call: no forward, no admission, no bounce, and a
  `receipt_mail_loop_dropped` log line.  Each trip around the fallback mailbox adds
  about 5 `Received` headers and one Cloudflare pass.  A long chain with only one
  Cloudflare pass is a first delivery, so it is filed as usual and logged as
  `receipt_long_received_chain`, because a corporate relay can add many hops and a
  drop leaves no copy anywhere.  Anyone can send the hop header to the public MX,
  but doing so only suppresses their own message.
- **Daily intake.**  100 messages and 100 MiB per UTC day in total.  Public mail
  may use 60 messages and 60 MiB of that, and one sender domain may use 20 messages
  and 25 MiB, so the no-forward path always keeps 40 messages.  No-forward mail
  skips the public and sender limits.  The sender limit stops one looping or runaway
  sender, not a deliberate one: Email Routing requires SPF or DKIM to pass, but
  anyone can pass them on many subdomains of their own domain.  Such a sender can use
  up the public part, and public mail then bounces until the next UTC day, with
  `receipt_quota_exceeded` and scope `public` in the logs.  The cost stays bounded
  and the no-forward path keeps working.
- **Storage budget.**  Each event may make one R2 put or one R2 read, and each
  isolate allows 60 puts and 120 reads per clock minute.  The minute is a counter that
  resets, not a rolling window, so a burst across a boundary can reach twice that.
  Past the put limit, a message with a fallback copy is left there, and one without
  is rejected so the sender knows.  Past the read limit, the route answers 429.
- **`GUARD_MODE=off`.**  Set as a Worker secret on either Worker to pause it, so a
  deploy does not clear it.  HTTP answers 503, alarms and the auditor cron do
  nothing, and mail is forwarded to the fallback (no-forward mail too, because
  nothing else would store it).  Mail is rejected only when no fallback copy can
  be made.
- **`limits` in each `wrangler.jsonc`.**  CPU and subrequests per invocation.
  Recheck `cpu_ms` before any move to the Free plan, because the documentation
  describes it as a Paid setting.  The inbox's 200 ms can stop a message of several
  MiB, which the 10 MiB intake limit still admits: a cold parse measured about 200 ms
  at 4 MiB and 365 ms near 10 MiB, in Node rather than the Workers runtime.  Its
  fallback copy is sent first, but no-forward mail has no copy here.  The largest
  message stored so far is 664 KB.

## Email routing rules

```bash
# Wrangler resolves this positional value as a Cloudflare zone, so use the apex zone here.
# Example short address (also keep any existing high-entropy rule):
npm exec -- wrangler email routing rules create jays.services --name usage-monitor-receipts \
  --match-type literal --match-field to --match-value receipts@receipts.jays.services \
  --action-type worker --action-value usage-monitor-receipt-inbox
# Catch-all for the routing subdomain (Dashboard: Email Routing → Catch-all → Worker)
# or Cloudflare API email_routing/rules with matchers type "all".
```

Confirm the exact current CLI flags with `wrangler email routing rules create
--help` before applying the final rule. Confirm the routing domain is
`receipts.jays.services`, never `jays.services`. Usage Monitor uses the fixed
`https://receipt-inbox.jays.services/v1/receipts/summary` endpoint; configure
the app with only the summary-read token. The handler fails closed unless the
retention acknowledgement and fallback are present. Every deploy re-checks the
live lifecycle rule. A SQLite-backed Durable Object transaction admits at most
100 delivery attempts and 100 MiB per UTC day, with the sub-limits under Runaway
guards, before raw buffering or MIME parsing; over-quota email is rejected
without forwarding or reading the body.

The isolated auditor re-reads the exact lifecycle rule through Cloudflare's API
every 12 hours and stores the result in its own Durable Object.  Intake reads that
result only when its local copy is not ok or predates the latest cron slot, and
asks for a fresh audit when local readiness state reaches 24 hours.  Readiness
fails closed if the audit is stale, if a conflicting enabled delete rule
overlaps `evidence/`, or if the exact 180-day rule is missing. The same exact
parser gates deployment. The auditor is deployed first, so the intake service
binding never has a missing target.

Both `/health` and the sanitized summary endpoint require the summary-read
token, so unauthenticated probes cannot generate R2/Durable Object reads.
Only `/health` probes R2, with a head on one fixed key.  On the intake path an
email's own put proves R2, and a failed put releases its reservation.
The summary now includes a bounded subject, amount, service, and kind so the
dashboard can show what arrived.  It still never returns raw MIME, card
numbers, or mailbox local-parts.

Classification is review metadata only.  Email intake still cannot use the
HMAC cash importer and does not POST `/api/owner-expenses`.  The MX accepts
any `*@receipts.jays.services` local-part, so ledger writes stay on the
dashboard session / `OWNER_EXPENSE_TOKEN` form after a human reviews.

After fallback forwarding, intake is recoverable across R2/index partial
failures: the index first creates
a non-visible `pending` reservation, the Worker writes evidence idempotently,
and a second transaction commits the visible review row. A failed put releases
the reservation, so a resend is not refused as busy; a retry resumes any other
pending reservation. Pending rows expire after one day; committed review,
dedupe, sender-domain, and group metadata expire after 180 days in step with the
R2 evidence lifecycle. Durable Object alarms perform cleanup even when no mail
or dashboard request arrives, retrying every 30 seconds while a backlog remains;
readiness fails closed only when a backlog is over a day old.  Summary results
include committed, unexpired rows only.

An operator can download one unreviewed message for offline review without
giving Usage Monitor access to message content:

```bash
curl --fail --location --output receipt.eml \
  --header "Authorization: Bearer $RECEIPT_INBOX_EVIDENCE_TOKEN" \
  "https://<worker-host>/v1/receipts/<64-hex-id>/evidence"
```

After review, remove the item from the pending count while retaining evidence
until lifecycle expiry:

```bash
curl --fail --request PATCH \
  --header "Authorization: Bearer $RECEIPT_INBOX_EVIDENCE_TOKEN" \
  --header "Content-Type: application/json" \
  --data '{"status":"reviewed"}' \
  "https://receipt-inbox.jays.services/v1/receipts/<64-hex-id>/status"
```
