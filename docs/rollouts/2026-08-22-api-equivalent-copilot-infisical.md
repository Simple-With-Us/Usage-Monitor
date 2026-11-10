# Copilot CLI API-equivalent + Infisical project bake (2026-08-22)

Owner: subscriptions yield far more coding usage than the same style on PAYG
API.  #1316 added Codex + Grok Build token × list-price estimates.  This
follow-up adds GitHub Copilot CLI (the remaining local token ledger on this
Mac) and unblocks Coolify deploys of that work.

Two spaces between sentences in this file.

## What landed

- Copilot CLI collector reads `~/.copilot/session-state/*/events.jsonl`
  `session.shutdown` `data.modelMetrics[model].usage`.  Totals are cumulative
  across resume/shutdown; the parser emits the delta so re-ingest cannot
  double-count.  `billingMode=estimated`.  Producer id `github-copilot`.
  Does not open `~/.copilot/data.db` (that file holds GitHub tokens).
- Dashboard API-Equivalent Cost card lists Copilot CLI next to Claude / Codex
  / Grok.
- Restore `INFISICAL_UM_PROJECT_ID` bake in the Dockerfile and
  `start-with-infisical.sh`.  The UUID is a project address, not a secret.
  Coolify stopped storing it (#1211).  #1315 removed the script fallback and
  Coolify rolled back #1315/#1316: Infisical 404 `projectId=undefined`.
  `infisical-run.mjs` now fails closed if the project id is still empty.

## What we will not pretend

- Cursor `ai-code-tracking.db` is line-hash attribution, not tokens.
- Gemini CLI tmp sessions on this Mac have no token fields.
- ccusage also lists OpenCode, Amp, Kimi, Qwen, and others.  Those home
  directories are not on this Mac, so they stay off the card.

## Verify

```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
node --version   # v24.x
npm run test:session-token-collectors
npm run test:startup-config
npx vitest run src/lib/__tests__/subscription-analytics.test.ts src/lib/__tests__/claude-cost-check.test.ts
node scripts/copilot-usage-collector.mjs --dry-run
```

## Follow-ups

- Bootstrap Codex / Grok / Copilot LaunchAgents after this merge is live on
  `usage.jays.services` (same Infisical `USAGE_INGEST_TOKEN` pattern as
  Antigravity).  Point at `~/Code/Usage-Monitor/scripts` on main.
