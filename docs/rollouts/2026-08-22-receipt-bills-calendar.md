# Receipt inbox review fields, owner expenses, Bills calendar

## Why

Forwarded vendor mail was sitting in the receipt Worker as `needs_review` with
only a sender domain.  The owner could not see what arrived, and April 2026+
receipts were not on the ledger or on a calendar.

## What landed

- Inbox summary includes a bounded subject, amount, service, and kind.  Raw
  MIME, cards, and mailbox local-parts stay off the dashboard.
- `POST /api/owner-expenses` accepts `usage` plus optional `dueDate`,
  `nextDueDate`, `cancelledNoRenew`, and `calendarSort`.  Dashboard session or
  `OWNER_EXPENSE_TOKEN` only — Worker intake classifies for review and does
  not POST cash.  The MX is public (`*@receipts.jays.services`) and Ignore
  does not retract a ledger row.
- Unlisted Apple Calendar feed: `GET /api/bills.ics?token=` with
  `BILLS_CALENDAR_TOKEN`.  Event titles are `$price - Service - sort`.
- Domain renewals file as `dev-expense`.  FMP/Massive file a historical paid
  receipt and never a next due date.  Postdated usage invoices file on the date
  received.

- Worker intake classifies with rules, then Grok (`XAI_API_KEY`), then
  DeepSeek (`DEEPSEEK_API_KEY`).  Classification stays review metadata.
  Intake still does not POST cash.
- Active subscriptions get a one-month `nextDueDate` unless cancelled.
  FMP/Massive stay historical only.

## Verify

```bash
npm test -- src/lib/__tests__/owner-expense.test.ts src/lib/__tests__/bills-calendar.test.ts src/lib/__tests__/operations-health.test.ts src/__tests__/middleware.test.ts workers/receipt-inbox/index.test.mjs workers/receipt-inbox/classify.test.mjs
```

## Follow-ups

- Bind `XAI_API_KEY` and `DEEPSEEK_API_KEY` on the receipt Email Worker
  (Infisical / wrangler secrets).  Without them, classification stays rules-only.
- `BILLS_CALENDAR_TOKEN` is live in prod (unlisted ICS returns 401 without the
  token).  Keep it off GitHub.
- File remaining local April JSON with `scripts/file-owner-receipt-expenses.mjs`
  if any receipts are still only in `/tmp`.  Amounts stay out of git.
