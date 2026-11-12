# Agent seat plans and Codex lookback (2026-09-03)

Owner: the Agents page showed cheap-tier seats (Anthropic ~$20/$30, Grok $30)
while the live plans are Claude Max 20x **$200** and SuperGrok Heavy **$300**
(promo billed **$100** for one more month).  Codex API-equivalent tokens were
far too low because the 15-minute collector defaulted `since` to UTC month
start, so a 1 September tick only re-read September JSONL and never ingested
June–August `~/.codex/sessions` (35 local files dating to 2026-06-15).

Two spaces between sentences in this file.

## What landed

- Agents window chips are compact `5h` / `24h` / `7d` / `30d` / `All Time`,
  each on one line, with `gap-4` between them.
- Seat **cash** comes from receipts / active Subscriptions.  Codex **plan
  name** is observed from the local Codex login JWT (`chatgpt_plan_type`),
  which is Plus $20, not a guessed Pro $200.  Copilot is not billed.  Cursor
  Ultra (list $200) is included with SuperGrok Heavy.  MiniMax Code waits on
  a receipt.  Claude Max 20x and SuperGrok Heavy stay as owner-confirmed
  fallbacks until a receipt lands.
- EasyCLIProxyAPI-style consumer OAuth (chatgpt.com backend usage, unofficial
  Claude/xAI quota) is **not** called from Usage Monitor servers.  Local
  login claims and receipts are the supported path.
- `computeAgentsOverview` uses the same raw-event / daily-rollup split as
  `summarizeExternalUsageEvents` so a backfill cannot double-count the same
  days.
- Collectors default to a 180-day lookback instead of UTC month start.
  `--days` and `--since` still override.  `postUsageBatches` retries HTTP 429/503
  and spaces batches by 120ms so a 400-day backfill does not trip the ingest
  identity limiter (10 req / 1s).
- Live backfill 2026-09-03: Codex `--days 400` received 18,591 / persisted
  8,174 (June–August history that month-start ticks had dropped).  Grok
  received 1,698 / persisted 0 (August was already ingested).

## What we will not pretend

- These seats are still estimated API-equivalent, never cash.  Do not
  materialize $200/$300 `Subscription` charges from this catalog (that was
  the 2026-08 Gmail-ghost incident).
- Codex JSONL is CLI session tokens only.  ChatGPT web / Codex cloud usage
  is not in `~/.codex/sessions`.
- SuperGrok remaining-credits stays MANUALLY ONLY.

## Verify

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
node --version   # v24.x
npx vitest run src/lib/__tests__/agent-seat-plans.test.ts src/lib/__tests__/agents-overview.test.ts
npm run test:session-token-collectors
node scripts/codex-usage-collector.mjs --days 400 --dry-run
```

Live: `GET /api/agents-overview?window=all` should show Claude Max 20x $200
and SuperGrok Heavy $300, and Codex tokens should include June–August after
the backfill ingest.

Board `b866649c`.  GitHub #1407.
