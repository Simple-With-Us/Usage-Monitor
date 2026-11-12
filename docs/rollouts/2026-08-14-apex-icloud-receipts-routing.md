# 2026-08-14 — Apex iCloud mail + receipts worker routing

## Outcome

Apex `jays.services` inbound mail now goes to iCloud Custom Email Domain.
`receipts.jays.services` inbound mail stays on Cloudflare Email Routing and
lands on the `usage-monitor-receipt-inbox` Worker.

This is the designed split from PR #724 / the receipt-inbox README.  Cloudflare
Email Routing had later taken the **apex** MX, so `*@jays.services` was no
longer delivered to Apple.

## Live state (verified 2026-08-14)

| Host | MX | SPF | What receives mail |
| --- | --- | --- | --- |
| `jays.services` (apex) | `mx01.mail.icloud.com` / `mx02.mail.icloud.com` priority 10 | `v=spf1 include:icloud.com ~all` | iCloud Custom Email Domain |
| `receipts.jays.services` | `route{1,2,3}.mx.cloudflare.net` | `v=spf1 include:_spf.mx.cloudflare.net ~all` | Email Routing → Worker |

Unchanged and still required for iCloud:

- TXT `apple-domain=…` on the apex
- CNAME `sig1._domainkey` → `sig1.dkim.jays.services.at.icloudmailadmin.com`

Email Routing on the zone is still **enabled** so the receipts subdomain can
keep its locked CF MX.  The dashboard will show the **apex** as
`misconfigured`.  That is expected.  Do **not** click Repair / Enable / sync
on apex DNS — that would steal MX back from iCloud.

## Routing rules

Kept the existing literal Worker rules for
`receipts@receipts.jays.services`, `mail@receipts.jays.services`, and the
existing high-entropy `rcpt-…@receipts.jays.services` address.

Changed the catch-all from forwarding to a personal mailbox to the
`usage-monitor-receipt-inbox` Worker.  After the apex MX change, Cloudflare
only receives `receipts.jays.services` (plus any other CF-MX host).  The
Worker already rejects non-`receipts.jays.services` recipients before reading
MIME.

## What was wrong

Public MX for both the apex and `receipts.jays.services` pointed at
`route*.mx.cloudflare.net`.  The catch-all (`type: all`) forwarded unmatched
mail, including every `*@jays.services` address, to a verified personal
destination.  iCloud verification records were present, but Apple never saw
the apex mail.

Cloudflare Email Routing has no matcher for “all local-parts on one hostname
only.”  The only way to send apex mail to iCloud and subdomain mail to a
Worker is the MX split.

## Do not

- Disable Email Routing on the zone.  That can drop the receipts subdomain.
- Re-enable / repair apex Email Routing DNS.
- Point apex MX back at Cloudflare if you still want native iCloud addresses
  (`mail@jays.services` in Mail.app).
- Put receipt intake on `*@jays.services`.  The Worker rejects apex
  recipients.

## Two catch-alls (apex iCloud + receipts Worker)

Cloudflare Email Routing allows **one** catch-all per zone.  The API rejects a
second `type: all` rule (HTTP 409).  The dashboard therefore shows a single
Catch-all control, and it is labeled on the apex domain page even when the
apex MX is iCloud.

That is a UI label, not where the mail goes:

| Catch-all | Where it lives | Destination |
| --- | --- | --- |
| `*@jays.services` | iCloud Custom Email Domain | Apple Mail |
| `*@receipts.jays.services` | the one Cloudflare Catch-all (`usage-monitor-receipts-catchall` → Worker) | `usage-monitor-receipt-inbox` |

Cloudflare only receives `receipts.jays.services` (its MX).  Selecting
`receipts.jays.services` in Email Routing lists the three literal addresses
and hides the zone catch-all, so the receipts catch-all looks missing.  It
is not: any unmatched `*@receipts.jays.services` address is what that
zone catch-all is for.  The Worker already admits any local-part on that
host.

Do **not** retarget the Cloudflare catch-all to iCloud.  That would send
receipt intake to Mail instead of the Worker.

### Apex catch-all (owner, Apple)

Unknown `*@jays.services` local-parts need Apple's own toggle, not Cloudflare:

1. Open [icloud.com/icloudplus](https://www.icloud.com/icloudplus) and sign in.
2. Select **Custom Email Domain**, then `jays.services`.
3. Scroll down and turn on **Allow All**.

Apple's steps: [Allow all incoming emails to a custom email domain](https://support.apple.com/guide/icloud/allow-all-incoming-emails-mm9e3ee0680f/icloud).
If Allow All is off, iCloud only accepts addresses you created and bounces
the rest.

## Verification

```bash
dig +short MX jays.services
# 10 mx01.mail.icloud.com.
# 10 mx02.mail.icloud.com.

dig +short MX receipts.jays.services
# route1/2/3.mx.cloudflare.net

dig +short TXT jays.services | grep spf
# "v=spf1 include:icloud.com ~all"
```

Send a test to a known iCloud custom-domain address (for example
`mail@jays.services`) and confirm it appears in Apple Mail.  Send a test to
`receipts@receipts.jays.services` and confirm a `needs_review` row on
`https://receipt-inbox.jays.services`.
