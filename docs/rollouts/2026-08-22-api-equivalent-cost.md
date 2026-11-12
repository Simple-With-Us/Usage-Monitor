# API-equivalent cost for subscription seats (2026-08-22)

Owner: using Claude / Codex / Grok subscriptions to their fullest is far more
usage than the same coding style on PAYG API.  Claude's existing estimate is
in the right ballpark.  Usage Monitor only surfaced that number for Claude
Code OTLP.  This change adds the same **estimated** (never billed) token ×
list-price number for every seat that has an official, OSS, or local-log
method.

Two spaces between sentences in this file.

## What landed

- Discriminator `isSubscriptionAnalyticsTelemetry` covers Claude Code, Grok
  Build (`grok-build`), Codex CLI (`openai-codex`), and Antigravity CLI.
  Those rows never enter cash spend, budgets, or alerts.
- `GET /api/api-equivalent-cost` + dashboard **API-Equivalent Cost** card
  (replaces the Claude-only cross-check).  Claude still shows OTLP vs catalog
  drift.  Codex/Grok show catalog estimate from ingested tokens.
- Runtime xAI list prices for `grok-4.6-build` / `grok-4.5-build` (LiteLLM
  snapshot from 2026-07-29 has no 4.5/4.6 keys).  docs.x.ai 2026-08-21:
  grok-4.6 $2 / $0.50 cached / $6 per 1M below 200k.
- Mac collectors (ccusage-compatible layouts):
  - `scripts/codex-usage-collector.mjs` reads `~/.codex/sessions` JSONL
    `event_msg/token_count` `last_token_usage`.
  - `scripts/grok-usage-collector.mjs` reads `~/.grok/sessions/**/updates.jsonl`
    `turn_completed` + `usage.modelUsage` and `costUsdTicks`.
- Launchd templates: `scripts/com.jays.codex-usage-collector.plist.example`
  and `scripts/com.jays.grok-usage-collector.plist.example`.  Cadence 15 min.
  Listed on `~/apps/MAC-LOCAL-PROCESSES.md`.

## What we will not pretend

- Cursor `~/.cursor/ai-tracking/ai-code-tracking.db` is line-hash attribution,
  not tokens.  Team Admin API can return tokenUsage; this owner seat is not
  that.  Card copy says Cursor has no local token ledger.
- Antigravity `/usage` is quota remaining %, not per-model tokens.  The
  existing quota collector stays.  Conversation `.db` files are not parsed.
- SuperGrok remaining-credits is still MANUALLY ONLY.  Grok Build session
  logs are a different product path.

## Verify

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
node --version   # v24.x
npm run test:session-token-collectors
npx vitest run src/lib/__tests__/subscription-analytics.test.ts src/lib/__tests__/claude-cost-check.test.ts src/lib/__tests__/model-pricing.test.ts src/lib/__tests__/external-usage-summary.test.ts
node scripts/codex-usage-collector.mjs --dry-run
node scripts/grok-usage-collector.mjs --dry-run
```

Live ingest needs `USAGE_INGEST_TOKEN` via `infisical run` (same as
Antigravity).  Producer ids are `openai-codex` and `grok-build`.  Unscoped
`USAGE_INGEST_TOKEN` is enough unless `USAGE_INGEST_REQUIRE_SCOPED_TOKENS` is
on.

## Follow-ups

- Bootstrap the two LaunchAgents after this merge, pointing at
  `~/Code/Usage-Monitor/scripts` on main (same pattern as Antigravity).
- Optional Gemini CLI collector if `~/.gemini/tmp` grows real token logs.
- Cursor Enterprise Admin API only if the owner later has a team token.
