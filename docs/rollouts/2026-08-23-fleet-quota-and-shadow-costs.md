# 2026-08-23 — Fleet Quota Windows & Shadow API Equivalent Cost Ingestion

## Summary
Implements unified fleet quota and session token collectors across all local and cloud coding agent seats:
- **Google Antigravity**: Quota sliding windows (5h burst & 7d rolling) via `agy -p "/usage"` + session transcripts in `~/.gemini/antigravity/brain/`.
- **Claude Code & Monet**: Session JSONL token breakdown, thinking tokens, and fast mode in `~/.claude/projects/`.
- **OpenAI Codex CLI**: Ingests `~/.codex/sessions/` with cache-read/cache-creation split.
- **Grok Build**: Ingests `~/.grok/sessions/` turn updates & cost ticks.
- **GitHub Copilot CLI**: Ingests `~/.copilot/session-state/` shutdown deltas.
- **DeepSeek Harness**: Ingests `~/.dsh/sessions/` token metrics.
- **Cursor Cloud**: Ingests local bridge and session metadata.

## What Ships
- `scripts/lib/session-token-collectors.mjs`: Added `parseAntigravityTranscriptJsonl`, `parseClaudeSessionJsonl`, `parseDeepSeekSessionJsonl`, and `parseCursorSessionJsonl`.
- `scripts/antigravity-session-collector.mjs`: Local transcript collector for Antigravity.
- `scripts/claude-usage-collector.mjs`: Local session collector for Claude Code.
- `scripts/fleet-usage-collector.mjs`: Master unified collector for all fleet platforms.
- `scripts/com.jays.fleet-usage-collector.plist.example`: LaunchAgent template running every 30m.
- `src/lib/pricing/model-pricing.ts`: Added runtime overrides for Gemini 3.6/3.7 Flash, Gemini 2.5 Pro, Claude Opus 5, and DeepSeek v4.
- `src/components/ApiEquivalentCostCard.tsx`: Expanded seat labels, model coverage, and explicit data provenance notes distinguishing shadow developer workload costs from OpenRouter production app calls.
