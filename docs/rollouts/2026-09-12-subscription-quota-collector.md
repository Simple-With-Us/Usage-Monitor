# Subscription quota collector — percent remaining for every plan

Date: 2026-09-12 (CT)
Branch: `claude/subscription-quota-pct`

## What changed

Until now the dashboard could only answer "how much of my subscription is left?"
for Antigravity.  Every other provider reported tokens and cost but never a
remaining percentage, and the card that displayed Antigravity's numbers was
titled as if it covered the whole fleet.  Worse, that card picked its logo by
string-matching the bucket label, so Antigravity's internal "Claude and GPT
models" routing bucket rendered with the Claude logo and read as the user's own
Claude Max plan.

This rollout adds a real remaining-percent pipeline for Claude, Codex, Grok and
MiniMax, and makes the card honest about which plan each number belongs to.

- `scripts/subscription-quota-collector.mjs` — one Mac-side collector, one
  provider per `--provider` flag (default all four).
- `scripts/lib/quota-event.mjs` — the shared quota-event builder.  `credits` is
  the percent REMAINING, `limit` is always 100, and the reset instant, window
  token, plan type and used percent live in `metadata`.  This is the shape the
  Antigravity collector has emitted since August; it is now written down once.
- `scripts/lib/subscription-quota-parsers.mjs` — four total, pure parsers.
- `src/lib/quota-windows.ts` — windows now carry `providerKey`, `providerLabel`
  and `via`, and the response carries `providerGroups`.
- `src/components/FleetQuotaMatrixCard.tsx` — one section per provider, with a
  `via Antigravity` caption on Antigravity's buckets and a visible empty state
  for any expected provider that has not reported.
- MiniMax is registered in the provider definitions and the integration catalog.

`GET /api/quota-windows` is backward compatible: `windows` and `skipModelTypes`
keep every field they had, and everything above is additive.  The iOS client and
BotFleet need no change.

## Endpoints used

Each of these is the endpoint the vendor's own CLI calls, authenticated with the
OAuth token that CLI already stored on this Mac.  No vendor website is
impersonated and no GPL code is vendored.

| Provider | Credential read | Endpoint |
|---|---|---|
| Claude | `CLAUDE_CODE_OAUTH_CREDENTIALS_JSON` (Zod-validated env JSON), else legacy `~/.claude/.credentials.json` → `claudeAiOauth`.  Modern macOS Keychain is **not** read inside the collector — inject with `scripts/claude-code-oauth-credentials-from-keychain.sh` or `export CLAUDE_CODE_OAUTH_CREDENTIALS_JSON="$(security find-generic-password -s 'Claude Code-credentials' -w)"` in a launchd wrapper. | `GET https://api.anthropic.com/api/oauth/usage` |
| Codex | `~/.codex/auth.json` → `tokens` | `GET https://chatgpt.com/backend-api/wham/usage` |
| Grok | `~/.grok/auth.json` (nested `https://auth.x.ai::<id>.key`, not a flat `access_token`) | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` (`config.creditUsagePercent` is percent USED) |
| MiniMax | `~/.mmx/config.json` | `GET https://api.minimax.io/v1/api/openplatform/coding_plan/remains` (falls back to `api.minimaxi.com`) |

Claude and Codex report percent USED; the collector converts to remaining.
Codex's window labels are derived from `limit_window_seconds`, never from the
`primary`/`secondary` slot name, so a retuned window stays correctly labelled.
MiniMax reports usage counts per model, so remaining is
`(total - usage) / total`, plus one plan-wide headline row.

Two shared-contract details worth knowing before adding a fifth provider, both
caught by `scripts/__tests__/subscription-quota-collector.test.mjs` rather than
in production: `limitWindow` is restricted to `minute|day|month|run`, so a "5h"
or "weekly" token must live in `metadata.quotaWindow` instead, and `credits`
must be a number, so an unreported window omits the field rather than sending
null.  Either mistake fails the whole batch server-side with nothing visible on
the dashboard.

## Why this runs on the Mac

Owner ruling on issue #1411 (2026-09-03): "Mac collectors: Codex /status or
local quota probe, Grok credits, Claude /usage remaining — still laptop jobs."
These credentials are local CLI OAuth tokens.  A server-side connector that
impersonated a product website would still be out of bounds, and nothing here
does that.

The collector never prints, logs or posts a credential.  The only
credential-derived value it emits is the plan name, e.g. `max_20x`, which is not
a secret.  Raw HTTP response bodies are never printed under any flag, because
they can carry account identifiers.

Scripts load Claude OAuth material only from `process.env` (`CLAUDE_CODE_OAUTH_CREDENTIALS_JSON`) or the legacy credentials file — never from a Keychain subprocess inside `subscription-quota-collector.mjs`.  `scripts/lib/claude-code-oauth-credentials.mjs` validates injected JSON with Zod at the parse boundary and logs only a generic schema failure.

## How to install

```bash
cp scripts/com.jays.subscription-quota-collector.plist.example \
   ~/Library/LaunchAgents/com.jays.subscription-quota-collector.plist
# replace every /ABSOLUTE/PATH placeholder, then:
launchctl bootstrap gui/$(id -u) \
   ~/Library/LaunchAgents/com.jays.subscription-quota-collector.plist
launchctl kickstart -k gui/$(id -u)/com.jays.subscription-quota-collector
```

Runs every 15 minutes (`StartInterval 900`), same node path and env pattern as
the existing collectors.  It reads `USAGE_INGEST_TOKEN` through the shared
`resolveCollectorToken` helper, which falls back to `~/.secrets/global-api-keys`.

Uninstall: `launchctl bootout gui/$(id -u)/com.jays.subscription-quota-collector`

This is a **scheduled** job (`StartInterval 900`), same class as the Codex /
Grok / Copilot session collectors, not a KeepAlive daemon.  Use
`/opt/homebrew/bin/node` (Node 26): Node 24 `fetch` ETIMEDOUTs against the
Grok and MiniMax hosts.  Add its row to `/Users/jay/apps/MAC-LOCAL-PROCESSES.md`
and refresh the `⭐️ Background Jobs Master List` note when it is actually loaded.

## How to verify

Dry run, redacted — prints only numbers, window labels, ISO dates and the plan
type, and posts nothing:

```bash
node scripts/subscription-quota-collector.mjs --dry-run --redacted
```

One provider at a time:

```bash
node scripts/subscription-quota-collector.mjs --provider claude --dry-run --redacted
```

Against a fixture, with no network call and no credential read:

```bash
node scripts/subscription-quota-collector.mjs --provider claude \
  --fixture scripts/__tests__/fixtures/claude-oauth-usage.json --dry-run --redacted
```

Once it looks right, drop `--dry-run` to post, then check the dashboard card and
`GET /api/quota-windows`.

## What is unverified

The endpoint shapes are best-known from community CLIs (CodexBar, pi-grok,
ccusage-style trays, minimax-usage), not from published vendor contracts, and
this branch was built and tested against fixtures only.  The session that wrote
it was blocked from running the collector against real credentials, so **no
live response has been seen yet**.  Specifically:

- Grok's field names are the least certain of the four.  The parser accepts
  several spellings and falls back to `used`/`limit` credit counts; when nothing
  matches it reports the window as `remainingUnknown` and the collector DROPS it
  instead of posting.  That is deliberate: the read path scores a missing
  remaining percent as "exhausted" (an Antigravity ruling, owner 2026-09-04), so
  posting an unreadable Grok window would tell the owner their plan was used up
  when the collector had simply failed to parse it.  A provider with nothing
  postable shows the honest "No quota report yet" row instead, and the collector
  logs how many windows it parsed but could not read.
- MiniMax's credential key names in `~/.mmx/config.json` are unconfirmed; the
  resolver tries `api_key`, `apiKey`, `key`, `token` and `auth.api_key`, and
  logs only WHICH name matched, never the value.
- Codex fallback: if `wham/usage` is retired, the local `codex app-server`
  JSON-RPC also exposes rate limits.  That is a TODO, not implemented here.

The first live run may need a field-name tweak in
`scripts/lib/subscription-quota-parsers.mjs`.  Run it with `--debug` to see
which credential key name matched, then adjust the parser and its fixture.
