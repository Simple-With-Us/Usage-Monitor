# Gmail ledger corrections (2026-08-21)

Usage Monitor showed August cash that Gmail does not support.  The iCloud
mailbox for the Apple ID has no reader in this environment, so Apple IAP
receipts were not available.

## What Gmail actually shows

- **Massive $29** — Stripe failures 2026-07-23 through 2026-07-30.  No
  August success.  The $29 MTD row was the 2026-08-12 seed materializer.
- **FMP $22** — Paid 2026-06-22 receipt `#2240-0152` ($29 + $2.90 tax =
  $31.90).  July $31.90 failed; API suspended 2026-07-27.  Not paid in August.
- **Anthropic** — 2026-07-02 Pro $21.32, then Max 5x $85.30, then Max 20x
  $106.98.  Max canceled 2026-07-03 (access ended 2026-08-03).  No August
  receipt in Gmail.  The $20 August row was the seed, not an Aug 2 invoice.
- **Kimi** — Seeded $15/$200.  Owner email 2026-08-11: $199 Apple IAP.
  Receipt is on iCloud, not Gmail.
- **Cloudflare** — Invoice `IN-71793926` remainder **$533.00** still unpaid
  after the 2026-08-21 courtesy adjustment (case 02240979).  Not August
  spend.  UM still shows $0, which is correct for paid cash.
- **Unusual Whales** — $50/week API trial started 2026-07-30 and ended
  2026-08-06.  Not a live subscription.
- **UptimeRobot** — paid plan expired 2026-08-19; account is free.
- **Namecheap** — order `#211025634` on 2026-08-13, **$1.18** (Gmail
  receipt).  Ingested 2026-08-21 as `manual-billing-adjustment` and a
  Namecheap Provider row was added so it appears in budget-status.
- **Google AI Ultra / Google One** — Play order `SOP.3385-2372-6310-60006`
  on 2026-08-11, **$105.79** (family `thewedgeworths` account, $99.99 +
  tax).  Household, not a fleet API provider.  Not booked here.
- Receipt-inbox historical forwards on 2026-08-07 were blocked `555`.

## What this change does

- Seed catalog rows as `considering` so a future seed cannot invent cash.
- Materializer stamps unmanaged charges `estimated` / `modeled`.
- Leaving `active` (or deleting the row) retracts those modeled events.
- First maintenance tick pauses the four live seed ghosts and retracts
  their August events.
- Website Receipt Inbox can download/ignore when
  `RECEIPT_INBOX_EVIDENCE_TOKEN` is set, and always lets the owner record
  an expense from a Gmail or iCloud receipt.
- Dashboard hides runaway LiteLLM catalog estimates from the spend tile.

## After deploy

Confirm `/api/subscriptions` shows Massive / FMP / Anthropic / Kimi as
`considering`.  August MTD subscription cash for those four should be $0.
Book Namecheap `$1.18` from the dashboard Record Expense form if ingest
is still token-mismatched.  Add `RECEIPT_INBOX_EVIDENCE_TOKEN` to
Infisical if inbox download/ignore should work from the dashboard.
