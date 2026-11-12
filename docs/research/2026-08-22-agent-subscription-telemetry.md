# Agent subscription telemetry vs API PAYG (2026-08-22)

**Question:** Can Usage Monitor pull token/model counts for Grok, Antigravity, and Codex *subscriptions*, and what would the same work cost on enterprise API-only PAYG?

**Short answer:** There is no official, stable billing API for those consumer/IDE seats. Community tools reconstruct *session* tokens from local logs or unofficial quota endpoints. SuperGrok / Grok Build, Codex ChatGPT, and Antigravity quota are **MANUALLY ONLY** in Usage Monitor. Do not add a Provider row that looks fetchable. xAI **Management API** (already wired) is API-team prepaid/postpaid cash, not SuperGrok.

Two spaces between sentences in this file.

## Split that keeps confusing the dashboard

| Product | What you actually have | Official usage API? | UM today |
|---|---|---|---|
| xAI API (console.x.ai teams) | Prepaid credits / postpaid invoice | **Yes** — Management Billing (`management-api.x.ai`) | Poll adapter `xai` when Team ID + Management key exist |
| SuperGrok / Grok.com / Grok Build CLI | Weekly shared subscription pool | **No public API.** Unofficial `cli-chat-proxy.grok.com/v1/billing?format=credits` and gRPC-web `GetGrokCreditsConfig` (CodexBar, pi-grok, oh-my-pi) | **MANUALLY ONLY.** Do not pretend the xAI connector can fetch this |
| ChatGPT Plus/Pro + Codex CLI | 5h / 7d rate windows, not API org spend | **No.** Codex `/status` and Settings → Usage are product UI. Session JSONL is local | **MANUALLY ONLY.** OpenAI adapter is Organization Costs API only |
| Google Antigravity / Gemini Code Assist consumer | Per-group weekly + 5h buckets | **No billing API.** CLI `agy -p "/usage"` JSON is local. SDK `usage_metadata` is per-run | **Push collector already exists** (`scripts/antigravity-usage-collector.mjs`). Not a pollable Provider |
| Claude Max / Pro | Plan bars in Claude Code `/usage` | **No.** Individual Admin/Usage APIs do not exist | Already **MANUALLY ONLY** unless an org Admin key is set |

If a coverage badge says anything other than **Manually only** for those seats, that is a product bug. This change closes that.

## Repos that already reverse-engineered quota (semi-accurate)

Use these as *research*, not as something to scrape from the server. Auth is user OAuth/CLI tokens on the Mac, not Infisical API keys.

### Grok / SuperGrok / Grok Build

- [steipete/CodexBar `docs/grok.md`](https://github.com/steipete/CodexBar/blob/main/docs/grok.md) — Grok Build CLI OAuth (~7 day tokens), ACP JSON-RPC `x.ai/billing`, credits path.
- [stnly/pi-grok](https://github.com/stnly/pi-grok) — `/xai-usage` hits `/user` then `/billing?format=credits`. Percentage, used vs monthly limit, prepaid, on-demand, tier. Does not persist the raw body.
- [kenryu42/pi-grok-cli](https://github.com/kenryu42/pi-grok-cli) — `/grok-cli-usage` weekly allowance + reset.
- [can1357/oh-my-pi #4874 / #4945](https://github.com/can1357/oh-my-pi/issues/4945) — SuperGrok usage vs Grok Build *chat* path. Billing host `cli-chat-proxy.grok.com`; Build inference is a different product path than `api.x.ai`. Mixing them burns API quota.
- [diegosouzapw/OmniRoute #6844](https://github.com/diegosouzapw/OmniRoute/issues/6844) — same CodexBar endpoints independently verified (gRPC-web `GetGrokCreditsConfig`, proto3 omitted-field-means-zero).

Accuracy: good for **percent of weekly credits remaining**, not a token ledger by model. No official token×price invoice for SuperGrok.

### Codex CLI (ChatGPT subscription)

- Official: in-session `/status`; Codex Settings → Usage (5h / 7d remaining). Not the OpenAI API usage dashboard.
- Local logs: Codex CLI session JSONL (same family as Claude Code transcripts). Token counts per session/model.
- Trackers: [itvincent-git/codex-usage-desktop](https://github.com/itvincent-git/codex-usage-desktop), [anaralabs/tokenleader](https://github.com/anaralabs/tokenleader), `ccusage` (Claude + Codex reports), [mbogdan0/codex-usage](https://github.com/mbogdan0/codex-usage).
- OpenTelemetry opt-in on Codex CLI (Dynatrace ingest) — tokens/cost **if the CLI emits them**, still not ChatGPT billing.

Accuracy: session logs are the best *token and model* source. Rate-limit percent from `/status` is quota, not dollars. Do not use platform.openai.com API usage as a Codex subscription stand-in.

### Antigravity

- Already in this repo: `scripts/antigravity-usage-collector.mjs` parses real `agy -p "/usage" --output-format json` (`command.data.groups[].buckets[]`). Group × window (Gemini Models / Claude and GPT models, weekly + 5h). Ingests `provider: "google-antigravity"` events. LaunchAgent example in `scripts/com.jays.antigravity-usage-collector.plist.example`.
- [google-antigravity/antigravity-sdk-python](https://github.com/google-antigravity/antigravity-sdk-python) — `usage_metadata` prompt/candidate/cached/thinking tokens per turn. That is SDK-run telemetry, not subscription remaining.
- Gemini Code Assist org dashboard exists for **Workspace/enterprise licenses**, not the consumer Antigravity seat.

Accuracy: the local collector is the honest path we already have. Do not add a Google AI Provider row for Antigravity quota.

## PAYG “if this were a company API-only account”

There is no vendor invoice that says “your SuperGrok week would have been $X on API.” The workable estimate:

1. Sum **input / output / cache / thinking tokens by model** from local session logs (Codex JSONL, Claude Code OTLP we already ingest, Antigravity collector, Grok CLI session if present).
2. Multiply by the **public API list price** for that model (xAI, OpenAI, Gemini, Anthropic).
3. Label the number **estimated API-equivalent**, never “what I was billed.”

That is the same idea as UM’s existing `estimatedApiEquivalentUsd` on subscription seats.

Order-of-magnitude (list prices move; treat as illustration, not a quote):

- Frontier coding agents with large contexts (Grok 4.x, GPT-5-class, Gemini 3.x Pro, Claude 4.x) are typically **a few dollars per million input tokens** and **higher per million output**, plus cache-write premiums.
- A heavy agent day (many tool loops, 200k–1M+ tokens of context replay) lands in **tens to hundreds of USD/day per seat** on PAYG. A $20–$200/mo consumer plan is cheaper *because it is a product cap*, not because the tokens are cheap.
- Enterprise PAYG also adds: no weekly “reset,” overage at list, data-processing agreements, and often higher cache/tool prices. Efficiency (smaller models, cache hits, shorter transcripts) is the only lever that actually cuts the bill.

If you want this number on the dashboard later: keep it as a **derived estimate from pushed telemetry**, never as a poll of SuperGrok/Codex/Antigravity. Those products still have no invoice API.

## EasyCLIProxyAPI / CPA OAuth (2026-09-03)

Apps like [EasyCLIProxyAPI](https://github.com/router-for-me/EasyCLIProxyAPI)
and [tokenuse](https://tokenuse.app/docs/development/tools/codex-subscription/)
read ChatGPT / Codex quota by completing **consumer OAuth** or pasting a
`chatgpt.com` session cookie, then calling unofficial hosts such as
`/backend-api/wham/usage`.  That response includes `plan_type` (plus/pro)
and 5h / 7d used-percent.  It is the same family of private product APIs
this repo already labeled **MANUALLY ONLY**.

Usage Monitor will:

- Read `chatgpt_plan_type` from the **local** Codex `id_token` already on
  disk (`~/.codex/auth.json`).  That is how we know Plus vs Pro without
  guessing.
- Keep billed cash on **receipts** / Subscription rows.
- Not ship a server-side ChatGPT/Claude/xAI consumer OAuth connector that
  impersonates the product website.

A later Mac collector may add 5h/7d gauges from Codex `/status` or a
user-triggered local quota probe.  That is still a laptop job, not a
pollable Provider.

## What we will not do

- Seed Provider rows for Grok Build, Codex, or Antigravity “because we use the seat.”
- Show **Needs sync** / **Waiting for first fetch** for a connector that cannot poll.
- Call SuperGrok remaining-credits an xAI Management API snapshot.

## Follow-ups (this PR, 2026-08-22 GROK)

Landed in `grok/api-equivalent-cost`: Codex JSONL collector, Grok Build
`updates.jsonl` collector, dashboard API-Equivalent Cost card, xAI 4.5/4.6
runtime prices.  Follow-up `grok/api-equivalent-more`: Copilot CLI
`session.shutdown` `modelMetrics` collector.  Cursor
`~/.cursor/ai-tracking/ai-code-tracking.db` is still line hashes, not tokens.
Gemini CLI tmp sessions on this Mac have no token fields.  ccusage also
covers OpenCode/Amp/Kimi/Qwen/etc.; those homes are absent here so they
are not faked.  LaunchAgents (Codex/Grok/Copilot) bootstrap after the
Infisical project-id bake is live.
