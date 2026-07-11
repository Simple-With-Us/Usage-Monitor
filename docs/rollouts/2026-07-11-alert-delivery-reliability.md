# 2026-07-11 — alert-delivery channel reliability

## Summary

- Added additive `ProviderAlertChannelDelivery` state keyed by notification plus a one-way
  destination fingerprint. Trigger attempts/successes and PagerDuty resolution attempts/successes
  are persisted per channel without storing webhook URLs, routing keys, or API keys.
- A failed channel is retried on the next maintenance tick while channels that already succeeded
  wait for their own reminder interval. One email/webhook outage therefore no longer replays Slack
  every 15 minutes.
- Each HTTP attempt has a hard timeout and only transient failures (network/timeout, 408, 425, 429,
  or 5xx) receive bounded exponential retry.
- PagerDuty trigger events use the stable key
  `api-usage-monitor:<providerId>:<alertCode>`. Cleared alerts send `event_action: "resolve"` with
  the same key; a failed resolve leaves the local notification open so maintenance retries it.

## Why

`ProviderAlertNotification.lastSentAt` previously advanced only when every configured channel
succeeded. If Slack succeeded and email failed, `lastSentAt` stayed null and every maintenance tick
resent Slack along with email. PagerDuty also omitted `dedup_key` and never emitted a resolve event,
so repeated triggers could create alert noise and a recovered provider could remain incident-open.

PagerDuty's maintained client documentation demonstrates resolving an Events API v2 alert by the
same deduplication key returned or supplied at trigger time, and PagerDuty's event-management guide
states that matching `dedup_key` values deduplicate into one incident:
https://pagerduty.github.io/python-pagerduty/user_guide.html#events-api-v2 and
https://support.pagerduty.com/main/docs/event-management.

## Files

- `.env.example`
- `DEPLOY.md`
- `prisma/schema.prisma`
- `src/lib/alert-delivery.ts`
- `src/lib/__tests__/alert-delivery.test.ts`
- `src/lib/__tests__/setup-test-db.ts`
- `docs/EFFORT-LOG.md`
- `/Users/jay/apps/API-USAGE-MONITOR-EFFORT-LOG.md` (live board)

## Verification

- `npx prisma format` — pass.
- `DATABASE_URL=file:./dev.db npx prisma validate` — pass. The first validation attempt omitted
  `DATABASE_URL` and failed with Prisma P1012 before schema validation; rerunning with a disposable
  SQLite URL validated the schema.
- `npm test -- src/lib/__tests__/alert-delivery.test.ts` — 6/6 pass under Node 24.
- `npx tsc --noEmit` — pass under Node 24.
- Scoped ESLint over alert delivery and its focused test/schema fixture — pass.
- `npm run test:migrate-safe` after the isolated commit — all three scenarios pass: additive diff
  applies, already-current schema is a no-op, and a destructive diff with data is refused without
  changing the database.
- Full repository gate deliberately deferred to integration.
- `npm run test:migrate-safe` was attempted before commit and correctly refused because its safety
  harness temporarily replaces `prisma/schema.prisma` and requires a clean committed schema; the
  post-commit run above passed.

## Follow-ups / residual risk

- Delivery is at-least-once around the external-call/database-write boundary: a process crash after
  a provider accepts a request but before SQLite records success can replay it. PagerDuty remains
  deduplicated by its stable key; generic Slack/email/webhook endpoints have no common idempotency
  contract.
- If a PagerDuty trigger succeeded and the routing key is later removed before resolution, the local
  notification remains open with an explicit delivery error until a routing key is restored. This
  preserves the retry handle rather than silently abandoning an external incident.
- PagerDuty incidents triggered before this change had no stable dedup key and cannot be correlated
  automatically by the new resolver.
