# Mac Collector Install (installed copy, not ~/Code)

Owner rule: `~/Code/<App>` is the human integration tree and a daemon resets it.
A LaunchAgent that executes `~/Code/Usage-Monitor/scripts/...` runs whatever
that tree happens to hold, and breaks when the tree moves.  The Mac collector
LaunchAgents therefore run from an installed copy:

```
~/apps/usage-monitor-collectors/        (override: UM_COLLECTORS_HOME)
  scripts/                              collector entry points + scripts/lib
  node_modules/zod                      only third-party import the collectors have
  VERSION                               git sha, install time, source checkout
```

## Install or refresh

From any Usage-Monitor lane or checkout that holds the code you want live:

```bash
scripts/install-collectors.sh            # copy files, smoke-check every entry point
scripts/install-collectors.sh --plists   # also repoint + reload the LaunchAgents
```

`--plists` touches only the `com.jays.*collector` LaunchAgents that still
reference a `Usage-Monitor/scripts/` path, plus the Antigravity CLI `statusLine`
hook in `~/.gemini/antigravity-cli/settings.json`.  The script refuses a
destination under `~/Code`.  Re-run it after merging collector changes; the
copy does not update itself.

Check what is live with `cat ~/apps/usage-monitor-collectors/VERSION`.

## Why a collector can sit at HTTP 409 for weeks (UM-1469)

Every v2 event is stamped with `metadata._producerInstanceId`, the sending
host's name.  When macOS renamed this Mac (`jays.services` to
`Mac.Jays.Services`, Sep 17 2026), every collector replay of an older event
differed from its stored row only in that label, ingest answered
`409 idempotency_conflict` for the whole batch, and because collectors advance
their checkpoint only after a clean ack, the same batch was re-sent every 15
minutes until Oct 15.

Fixes now in place:

* Ingest ignores the host label (and a `machine` field that merely echoes it)
  when deciding whether a replay is the same event.  Real content differences
  still collide.
* Collectors isolate a conflicting event by halving the batch, log its
  `eventId`, skip it and let the rest land, so one bad event can no longer
  freeze a stream.  The 409 body is now part of the thrown error.
* Maintenance sends one Pushover per UTC day when a watched
  (`sourceApp`, `metricType`) stream goes quiet (`src/lib/producer-staleness.ts`;
  allowances live in `PRODUCER_STREAM_RULES`, measured from prod gaps (UM-1616:
  `deepseek-dsh` 120h, `opencode` 96h); disable with
  `USAGE_PRODUCER_STALENESS_DISABLED=1`).

## Known non-collector gaps

* `claude-code` quota from this Mac (UM-1616): the subscription-quota collector
  does not read the Keychain itself (PR #1592).  The LaunchAgent now runs
  `scripts/run-subscription-quota-collector.sh`, which reads the login Keychain
  item `Claude Code-credentials` with `/usr/bin/security`, passes it in
  `CLAUDE_CODE_OAUTH_CREDENTIALS_JSON` and execs the collector.  The credential
  is never printed.  If the read fails (denied, locked, item missing, no answer
  to the prompt within 20 seconds) the wrapper logs one line starting
  `[run-subscription-quota-collector] keychain:` to
  `~/Library/Logs/subscription-quota-collector.log` and the collector still runs
  for Codex, Grok and MiniMax.  Owner step, once:
  1. Run `scripts/install-collectors.sh --plists` from a checkout that has this
     change.  It copies the wrapper to the installed collectors and rewrites the
     `com.jays.subscription-quota-collector` LaunchAgent to run it, then reloads
     that agent.
  2. When macOS asks whether `security` may use "Claude Code-credentials", click
     **Always Allow**.  Click it on the first prompt; a Deny or a timeout just
     repeats the one-line log on the next 15 minute pass.
  3. Within one pass `claude-code` `quota` rows resume and the
     "no Claude Code OAuth credential found" line stops.
* `fx` usage: unwatched.  No rows since Sep 16 while the collector stays
  installed; `PRODUCER_STREAM_RULES` has no fx rule until usage resumes.
* `agent-bar` quota: retired.  The app was renamed CodeCaps and reports as
  `codecaps` since Sep 21 2026.
* `com.jays.mac-server-watchdog` still runs from the checkout; it is a host
  heartbeat, not a collector, and is not covered by the installer.

## Harness feeds: DSH, opencode, fx (UM-1594)

Three LaunchAgents feed the harnesses that have no vendor billing API.  Create
each from its template (`scripts/com.jays.<name>-usage-collector.plist.example`),
replacing `/ABSOLUTE/PATH/TO/HOME` with `$HOME`, then `launchctl bootstrap`:

| Label | Source | Producer |
|---|---|---|
| `com.jays.deepseek-usage-collector` | `~/.dsh/sessions` and `~/.clutch/dsh/sessions` (`session.jsonl.zstd` and `session.v3.jsonl.zstd`) | `deepseek-dsh` |
| `com.jays.opencode-usage-collector` | `~/.local/share/opencode/opencode.db`, opened read-only | `opencode` |
| `com.jays.fx-usage-collector` | `~/.fx/usage.jsonl` | `fx` |

All three run on `/opt/homebrew/opt/node@24/bin/node` (opencode needs
`node:sqlite`) and use `USAGE_INGEST_TOKEN` until scoped tokens for `opencode`
and `fx` are added to `USAGE_INGEST_PRODUCER_TOKENS`.  The DSH agent sets
`USAGE_MONITOR_EXCLUDE_BOTFLEET_CHILDREN=1`, because BotFleet already reports
its own workspaces.  A first run backfills 180 days and then keeps a watermark
in `~/.cache/usage-monitor/collector-state/`.
